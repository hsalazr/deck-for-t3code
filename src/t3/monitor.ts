/**
 * Keeps the deck's picture of T3 Code's threads and publishes snapshots.
 *
 * Thread status comes from T3's MCP endpoint (`t3_thread_list`), as two lists:
 * - every active thread, subagents included, so they fold into their root.
 *   Polled shortly after T3's shell stream reports a change (and no more often
 *   than "Refresh every"), or every "Refresh every" seconds while that stream
 *   is down;
 * - the 100 most recently updated unsettled top-level threads (roots only, so
 *   busy subagents can't push idle roots with unseen results off the deck).
 *   Fetched on connect, then with the full poll every 30 s, and early (just
 *   the newest few) when a root leaves the active list because its run ended.
 * Background work, visits, run timing and limit pauses come from the shell
 * stream; context usage from the context watcher, for threads on keys only.
 *
 * Threads on linked machines (T3 Code's Labs → Linked environments) come from
 * the same local server, which forwards the list calls; see `remotes.ts`.
 * They are polled on their own, slower timer.
 */
import { EventEmitter } from "node:events";

import { ACTIVE_STATUSES, ackKeyOf, buildCards, isActive, isWorking, rootOf, seenAfterRun, type ThreadCard, type ThreadSummary } from "../model.ts";
import {
	defaultTokens,
	locate,
	readServerOrigin,
	SignedOutError,
	T3Error,
	type ConnectionReason,
	type SignOutResult,
	type T3Location,
	type TokenStore,
} from "./auth.ts";
import type { ContextUsage, WatchTarget } from "./context-watcher.ts";
import { discoverHome } from "./app.ts";
import { AuthRejectedError, McpClient, ToolError, UnreachableError } from "./mcp.ts";
import { RemoteEnvironments } from "./remotes.ts";
import { waitingLabel, type PendingTask, type ShellView } from "./shell-stream.ts";

export type { ConnectionReason };

export interface MonitorSettings {
	/** "Refresh every": how stale the deck may get while the shell stream is down, and the least time between polls. */
	pollSeconds: number;
	/** Idle threads stay on the deck this long after their last update. */
	recentHours: number;
	showSnoozed: boolean;
	flashOnDone: boolean;
	flashOnFailed: boolean;
	t3Home?: string;
	/** "T3 app bundle id": the app to open, for builds detection misses. */
	t3AppBundleId?: string;
}

export const DEFAULT_SETTINGS: MonitorSettings = {
	pollSeconds: 2,
	recentHours: 8,
	showSnoozed: false,
	flashOnDone: true,
	flashOnFailed: true,
};

/** Allowed "Refresh every" range, in seconds. */
export const POLL_SECONDS_MIN = 2;
export const POLL_SECONDS_MAX = 30;

export type Connection =
	| { kind: "connecting" }
	| { kind: "ok" }
	| { kind: "offline"; detail: string; reason?: ConnectionReason }
	| { kind: "error"; detail: string; reason?: ConnectionReason };

export interface Snapshot {
	connection: Connection;
	/** Every known root thread, folded. */
	cards: Map<string, ThreadCard>;
	/** Roots that belong on auto keys: active, needing attention, or recent. */
	visible: ThreadCard[];
	projectNames: Map<string, string>;
}

/** What the property inspector's status row shows. */
export interface MonitorStatus {
	connection: Connection["kind"];
	reason: ConnectionReason | null;
	detail: string | null;
	actionsTokenPresent: boolean;
	signedOut: boolean;
}

/** The shell stream as the monitor uses it. */
export interface ShellSource extends ShellView {
	on(event: "change", listener: () => void): unknown;
	/** Reconnect now if down (fresh backoff). */
	kick?(): void;
	/** Drop the socket and reconnect. */
	restart?(): void;
}

/** The context watcher as the monitor uses it. */
export interface ContextSource {
	on(event: "change", listener: () => void): unknown;
	get(threadId: string): ContextUsage | undefined;
	watch(targets: ReadonlyMap<string, WatchTarget>): void;
	retryNow?(): void;
}

export interface MonitorOptions {
	tokens?: TokenStore;
	/** Replaces the MCP client (tests): answers `t3_thread_list` / `t3_project_list`. */
	call?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
	now?: () => number;
	discoverHome?: (base: T3Location) => Promise<T3Location | "default" | undefined>;
}

interface ThreadListResult {
	threads: ThreadSummary[];
	nextCursor: number | null;
}

interface ProjectListResult {
	projects: { id: string; name?: string; title?: string; workspaceRoot?: string }[];
	nextCursor: number | null;
}

const RECENT_LIMIT = 100;
/** Newest roots fetched when one leaves the active list between full polls. */
const HEAD_LIMIT = 20;
const MAX_ACTIVE_PAGES = 5;
const MAX_RECENT_PAGES = 5;
/** How long a main thread stays "working" after its background work finishes. */
const SUBAGENT_GRACE_MS = 30_000;
const PROJECTS_REFRESH_MS = 60_000;
/** The linked-machines timer checks at least this often whether a remote poll is due, */
const REMOTE_TICK_MS = 2_000;
/** and sooner when one comes due before that, but never closer together than this. */
const REMOTE_TICK_MIN_MS = 250;
/** Both lists, regardless of the shell stream. */
export const FULL_POLL_MS = 30_000;
/** Shell changes are gathered this long before polling. */
const SHELL_DEBOUNCE_MS = 250;
/** Shell and context changes are gathered this long before rebuilding cards. */
const REBUILD_DEBOUNCE_MS = 150;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 30_000;

const DISCOVER_TIMEOUT_MS = 2_000;
/** Threads not seen for this long are forgotten (and their acks with them). */
export const SEEN_TTL_MS = 24 * 3600_000;

export class Monitor extends EventEmitter<{ change: [Snapshot]; log: [string] }> {
	readonly #tokens: TokenStore;
	readonly #transport: MonitorOptions["call"];
	readonly #now: () => number;
	#settings: MonitorSettings = { ...DEFAULT_SETTINGS };

	#base: T3Location = locate();
	#location: T3Location = this.#base;
	readonly #discover: MonitorOptions["discoverHome"];
	/** The lookup in flight, with the base and stop count it was started for. */
	#finding: { base: T3Location; stops: number; done: Promise<void> } | undefined;
	#pinned = false;
	#stops = 0;
	#stopped = false;
	#discovering: { base: T3Location; answer: Promise<T3Location | "default" | undefined> } | undefined;
	#client: McpClient | undefined;
	#clientOrigin: string | undefined;
	#running = false;
	#startedAt: number;

	#pollTimer: NodeJS.Timeout | undefined;
	#pollAt = 0;
	#inflight: Promise<void> | undefined;
	/** A change arrived while a poll was running; poll again after it. */
	#again = false;
	/** The next poll fetches both lists (connect, reconnect, errors, key presses). */
	#needFull = true;
	#lastFullAt = 0;
	#lastPollAt = 0;
	#failures = 0;
	#lastFailure = "";
	#rebuildTimer: NodeJS.Timeout | undefined;
	#shellWasConnected = false;

	#threads: ThreadSummary[] = [];
	/** This machine's threads from the last poll (recent and active merged). */
	#local: ThreadSummary[] = [];
	readonly #remotes: RemoteEnvironments;
	#remoteTimer: NodeJS.Timeout | undefined;
	#remoteInflight: Promise<void> | undefined;
	/** This machine's project names (remote ones are merged on top). */
	#localProjectNames = new Map<string, string>();
	/** The last recent-roots list (refreshed by full polls and early head fetches). */
	#recent: ThreadSummary[] = [];
	/** Roots in the last active list: when one leaves, its run ended. */
	#activeRoots = new Set<string>();
	#projectNames = new Map<string, string>();
	#projectsAt = 0;
	/** threadId → ack key the user has seen (or that predates the plugin). */
	#acked = new Map<string, string>();
	/** threadId → last time a poll listed it. */
	#seen = new Map<string, number>();
	/** Initial acks are seeded from the first successful poll only. */
	#seeded = false;
	/** Live background work per thread, from T3's shell stream. */
	#shell: ShellSource | undefined;
	#deckThreads = new Set<string>();
	#context: ContextSource | undefined;
	/** Roots that had background work at the last rebuild. */
	#hadBackground = new Set<string>();
	/** Root thread id → when its background work finished. */
	#backgroundEndedAt = new Map<string, number>();

	snapshot: Snapshot = { connection: { kind: "connecting" }, cards: new Map(), visible: [], projectNames: this.#projectNames };

	constructor(opts: MonitorOptions = {}) {
		super();
		this.#tokens = opts.tokens ?? defaultTokens;
		this.#transport = opts.call;
		this.#now = opts.now ?? Date.now;
		this.#discover = opts.discoverHome ?? (opts.call ? undefined : (base) => discoverHome(base));
		this.#startedAt = this.#now();
		this.#remotes = new RemoteEnvironments((name, args) => this.#call(name, args), (message) => this.emit("log", message), () => this.#now());
	}

	configure(settings: Partial<MonitorSettings>): void {
		const s = stripUndefined(settings);
		const next: MonitorSettings = {
			pollSeconds: clamp(Number(s.pollSeconds ?? DEFAULT_SETTINGS.pollSeconds) || DEFAULT_SETTINGS.pollSeconds, POLL_SECONDS_MIN, POLL_SECONDS_MAX),
			recentHours: clamp(Number(s.recentHours ?? DEFAULT_SETTINGS.recentHours) || 0, 0, 24 * 14),
			showSnoozed: (s.showSnoozed ?? DEFAULT_SETTINGS.showSnoozed) === true,
			flashOnDone: (s.flashOnDone ?? DEFAULT_SETTINGS.flashOnDone) !== false,
			flashOnFailed: (s.flashOnFailed ?? DEFAULT_SETTINGS.flashOnFailed) !== false,
			...(typeof s.t3Home === "string" && s.t3Home.trim() ? { t3Home: s.t3Home.trim() } : {}),
			...(typeof s.t3AppBundleId === "string" && s.t3AppBundleId.trim() ? { t3AppBundleId: s.t3AppBundleId.trim() } : {}),
		};
		const rehome = next.t3Home !== this.#settings.t3Home;
		const relocate = rehome || next.t3AppBundleId !== this.#settings.t3AppBundleId;
		const refilter = next.showSnoozed !== this.#settings.showSnoozed;
		this.#settings = next;
		if (rehome) {
			this.#base = locate(next);
			this.#pinned = false;
			this.#moveTo(this.#base);
		} else if (relocate) {
			this.#base = locate(next);
			this.#location = { ...this.#location, ...(this.#base.appBundleId ? { appBundleId: this.#base.appBundleId } : {}) };
			if (!this.#base.appBundleId) delete this.#location.appBundleId;
		}
		if (relocate || refilter) {
			this.#needFull = true;
			this.#request(0);
		}
		// Snoozed threads shown or hidden: linked machines' recent lists change too.
		if (refilter && !relocate) void this.#pollRemotes(true);
		this.#rebuild();
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#stopped = false;
		this.#startedAt = this.#now();
		this.#needFull = true;
		void this.#findHome().finally(() => this.#retryRevokes());
		this.#request(0);
		this.#scheduleRemotes(REMOTE_TICK_MS);
	}

	stop(): void {
		this.#running = false;
		this.#stopped = true;
		this.#stops++;
		this.#dropClient();
		clearTimeout(this.#pollTimer);
		clearTimeout(this.#rebuildTimer);
		clearTimeout(this.#remoteTimer);
		this.#pollTimer = undefined;
		this.#rebuildTimer = undefined;
		this.#remoteTimer = undefined;
	}

	/** Stop done/failed flashing for this thread's current run. */
	ack(threadId: string): void {
		const card = this.snapshot.cards.get(threadId);
		if (!card) return;
		this.#acked.set(threadId, card.ackKey);
		this.#rebuild();
	}

	ackAll(): void {
		for (const card of this.snapshot.cards.values()) this.#acked.set(card.threadId, card.ackKey);
		this.#rebuild();
	}

	/**
	 * Poll both lists now (e.g. after a key press or a thread action), then
	 * linked machines if they are due. Resolves when this machine's poll is
	 * done; linked machines (network round trips) finish on their own.
	 */
	async refresh(): Promise<void> {
		if (!this.#running) return;
		this.#needFull = true;
		clearTimeout(this.#pollTimer);
		this.#pollTimer = undefined;
		await this.#tick();
		void this.#pollRemotes(false);
	}

	/** Links, then every linked machine's lists, now (tests; the timer does this on its own). */
	refreshRemotes(): Promise<void> {
		return this.#pollRemotes(true);
	}

	/** Linked machines with threads on the deck. */
	get linkedEnvironments(): ReadonlyMap<string, { label: string; failing: boolean }> {
		return this.#remotes.environments;
	}

	/** Background work (subagents, commands, monitors, PR watches) comes from T3's shell stream. */
	attachShell(shell: ShellSource): void {
		this.#shell = shell;
		this.#shellWasConnected = shell.connected;
		shell.on("change", () => this.#onShellChange());
	}

	/** Context-window fill for the threads on the deck. */
	attachContext(context: ContextSource): void {
		this.#context = context;
		context.on("change", () => this.#scheduleRebuild());
	}

	/** Threads on Thread keys right now. Context usage is fetched for exactly these. */
	setDeckThreads(ids: Iterable<string>): void {
		this.#deckThreads = new Set(ids);
		this.#syncContext();
	}

	/**
	 * Revokes every token this plugin minted (best effort; failures are
	 * retried on later starts) and deletes the credential files. Nothing is
	 * minted again until `signIn()` or a plugin restart.
	 */
	async signOut(): Promise<SignOutResult> {
		this.#dropClient();
		this.#remotes.clear();
		this.#compose();
		const result = await this.#tokens.signOut(this.#location);
		this.#setConnection(connectionFor(new SignedOutError()));
		this.#shell?.restart?.();
		this.emit("log", result.ok ? `signed out: revoked ${result.revoked} token(s)` : `signed out; ${result.failed} token(s) will be revoked later: ${result.detail ?? ""}`);
		return result;
	}

	/** Undo `signOut()`: mint fresh tokens on the next poll. */
	signIn(): Promise<void> {
		this.#tokens.signIn();
		this.#shell?.kick?.();
		return this.refresh();
	}

	get signedOut(): boolean {
		return this.#tokens.signedOut;
	}

	async status(): Promise<MonitorStatus> {
		const c = this.snapshot.connection;
		return {
			connection: c.kind,
			reason: c.kind === "offline" || c.kind === "error" ? (c.reason ?? null) : null,
			detail: c.kind === "offline" || c.kind === "error" ? c.detail : null,
			actionsTokenPresent: await this.#tokens.has("operate"),
			signedOut: this.#tokens.signedOut,
		};
	}

	/** Resolves once the T3 home is settled for now (found, kept, or the lookup timed out). */
	located(): Promise<void> {
		return this.#findHome();
	}

	get location(): T3Location {
		return this.#location;
	}

	get settings(): Readonly<MonitorSettings> {
		return this.#settings;
	}

	get tokens(): TokenStore {
		return this.#tokens;
	}

	/** Schedules a poll in `delayMs` unless one is already due sooner. */
	#request(delayMs: number): void {
		if (!this.#running) return;
		const delay = Math.max(0, delayMs);
		const at = Date.now() + delay;
		if (this.#pollTimer && this.#pollAt <= at) return;
		clearTimeout(this.#pollTimer);
		this.#pollAt = at;
		this.#pollTimer = setTimeout(() => {
			this.#pollTimer = undefined;
			void this.#tick();
		}, delay);
	}

	/** Least wait before a change-driven poll: the debounce, and "Refresh every" since the last poll. */
	#gap(): number {
		return Math.max(SHELL_DEBOUNCE_MS, this.#lastPollAt + this.#settings.pollSeconds * 1000 - Date.now());
	}

	#onShellChange(): void {
		this.#scheduleRebuild();
		const connected = this.#shell?.connected === true;
		const flipped = connected !== this.#shellWasConnected;
		this.#shellWasConnected = connected;
		if (!this.#running) return;
		if (flipped) {
			// (Re)connected: reconcile both lists. Disconnected: fall back to polling every "Refresh every".
			if (connected) this.#needFull = true;
			this.#request(connected ? SHELL_DEBOUNCE_MS : this.#settings.pollSeconds * 1000);
			return;
		}
		if (connected) this.#request(this.#gap());
	}

	#tick(): Promise<void> {
		if (this.#inflight) {
			this.#again = true;
			return this.#inflight;
		}
		const run = this.#runPoll().finally(() => {
			this.#inflight = undefined;
			this.#afterPoll();
		});
		this.#inflight = run;
		return run;
	}

	async #runPoll(): Promise<void> {
		const startedAt = this.#now();
		this.#lastPollAt = Date.now();
		try {
			await this.#findHome();
			const full = this.#needFull || startedAt - this.#lastFullAt >= FULL_POLL_MS - 100;
			this.#needFull = false;

			if (!(await this.#poll(full, startedAt))) return;
			// A poll that started before a sign-out mustn't report the connection as fine.
			if (this.#tokens.signedOut) throw new SignedOutError();
			this.#failures = 0;
			if (this.#location.discovered) this.#pinned = true;
			this.#lastFailure = "";
			const before = this.snapshot.connection.kind;
			if (before !== "ok") {
				this.#setConnection({ kind: "ok" });
				// T3 is back: don't leave the shell stream or context fetches waiting out their backoff.
				this.#shell?.kick?.();
				if (before !== "connecting") this.#context?.retryNow?.();
				// Revokes that failed while T3 was away can go through now.
				if (before === "offline" || before === "error") this.#retryRevokes();
			}
		} catch (error) {
			this.#failures++;
			this.#needFull = true;
			if (!(error instanceof ToolError)) this.#dropClient();
			const connection = connectionFor(error);
			this.#setConnection(connection);
			const message = (error as Error)?.message ?? String(error);
			if (message !== this.#lastFailure) this.emit("log", `poll failed: ${message}`);
			this.#lastFailure = message;
		}
	}

	#findHome(): Promise<void> {
		const discover = this.#discover;
		if (!discover || this.#pinned || this.#stopped || this.#base.custom) return Promise.resolve();
		// A lookup started for another base, or before a stop, would bow out without looking: start a fresh one.
		const current = this.#finding;
		if (current && current.base === this.#base && current.stops === this.#stops) return current.done;
		const finding = {
			base: this.#base,
			stops: this.#stops,
			done: this.#lookUpHome(discover).finally(() => {
				if (this.#finding === finding) this.#finding = undefined;
			}),
		};
		this.#finding = finding;
		return finding.done;
	}

	async #lookUpHome(discover: NonNullable<MonitorOptions["discoverHome"]>): Promise<void> {
		const base = this.#base;
		const stops = this.#stops;
		if (this.#discovering?.base !== base) {
			const lookup = {
				base,
				answer: discover(base)
					.catch((error: unknown) => {
						this.emit("log", `looking for T3 home next to ~/.t3 failed: ${(error as Error)?.message ?? String(error)}`);
						return undefined;
					})
					.finally(() => {
						if (this.#discovering === lookup) this.#discovering = undefined;
					}),
			};
			this.#discovering = lookup;
		}
		const pending = this.#discovering.answer;
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), DISCOVER_TIMEOUT_MS)));
		const found = await Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
		if (stops !== this.#stops || base !== this.#base || found === undefined) return;
		if (found === "default") this.#pinned = true;
		const next = found === "default" ? base : found;
		if (next.home === this.#location.home) return;
		this.#moveTo(next);
		this.#rebuild();
		this.#shell?.restart?.();
		this.emit("log", `using T3 home ${next.home}${next.discovered ? " (found next to ~/.t3; set T3 home in the key settings to pin it)" : ""}`);
	}

	#moveTo(loc: T3Location): void {
		this.#location = loc;
		this.#dropClient();
		this.#remotes.clear();
		this.#recent = [];
		this.#activeRoots = new Set();
		this.#local = [];
		this.#projectsAt = 0;
		this.#needFull = true;
		this.#seeded = false;
		this.#compose();
	}

	/** Tokens whose revoke failed earlier (replaced, or signed out while T3 was away). */
	#retryRevokes(): void {
		this.#tokens
			.retryRevokes(this.#location)
			.then((r) => {
				if (r.revoked > 0) this.emit("log", `revoked ${r.revoked} old T3 token(s)`);
				if (r.failed > 0) this.emit("log", `${r.failed} old T3 token(s) still to revoke: ${r.detail ?? ""}`);
			})
			.catch((error: unknown) => this.emit("log", `revoke retry failed: ${(error as Error).message}`));
	}

	#afterPoll(): void {
		if (!this.#running) return;
		const pollMs = this.#settings.pollSeconds * 1000;
		if (this.#failures > 0) {
			const c = this.snapshot.connection;
			// Missing files are cheap to check; anything that talks to T3 or the CLI backs off.
			const cheap = (c.kind === "offline" || c.kind === "error") && (c.reason === "not-running" || c.reason === "not-installed" || c.reason === "signed-out");
			this.#request(cheap ? RETRY_MIN_MS : Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (this.#failures - 1)));
		} else {
			const fullIn = Math.max(0, this.#lastFullAt + FULL_POLL_MS - this.#now());
			this.#request(this.#shell?.connected ? fullIn : Math.min(fullIn, pollMs));
		}
		if (this.#again) {
			this.#again = false;
			this.#request(this.#gap());
		}
	}

	#dropClient(): void {
		this.#client?.close();
		this.#client = undefined;
		this.#clientOrigin = undefined;
	}

	#clientFor(origin: string, token: string): McpClient {
		if (this.#client && this.#clientOrigin === origin && this.#client.token === token) return this.#client;
		this.#dropClient();
		this.#client = new McpClient(origin, token);
		this.#clientOrigin = origin;
		return this.#client;
	}

	async #call<T>(name: string, args: Record<string, unknown>): Promise<T> {
		if (this.#transport) return (await this.#transport(name, args)) as T;
		const loc = this.#location;
		const origin = await readServerOrigin(loc);
		// Any loopback origin may use the stored token; only a 401/403 re-mints (after re-reading the file).
		return this.#tokens.withToken(
			loc,
			origin,
			"mcp",
			(token) => this.#clientFor(origin, token).callTool<T>(name, args),
			(error) => error instanceof AuthRejectedError,
		);
	}

	async #list(args: Record<string, unknown>): Promise<ThreadListResult> {
		const result = await this.#call<unknown>("t3_thread_list", { allProjects: true, ...args });
		return threadListOf(result);
	}

	async #listActive(): Promise<ThreadSummary[]> {
		const active: ThreadSummary[] = [];
		for (let page = 0, cursor: number | null = 0; page < MAX_ACTIVE_PAGES && cursor !== null; page++) {
			const result = await this.#list({ includeSubagents: true, statuses: ACTIVE_STATUSES, limit: 100, cursor });
			active.push(...result.threads);
			cursor = result.nextCursor;
		}
		return active;
	}

	/** The most recently updated unsettled top-level threads, newest first. */
	async #listRoots(limit: number): Promise<ThreadSummary[]> {
		const roots: ThreadSummary[] = [];
		for (let page = 0, cursor: number | null = 0; page < MAX_RECENT_PAGES && cursor !== null && roots.length < limit; page++) {
			const result = await this.#list({
				includeSubagents: false,
				settled: false,
				...(this.#settings.showSnoozed ? {} : { snoozed: false }),
				limit: Math.min(100, limit - roots.length),
				cursor,
			});
			roots.push(...result.threads);
			cursor = result.nextCursor;
		}
		return roots;
	}

	async #poll(full: boolean, startedAt: number): Promise<boolean> {
		const home = this.#location.home;
		const active = await this.#listActive();
		const activeIds = new Set(active.map((t) => t.threadId));
		// A root that left the active list just finished; its entry in the recent list is stale.
		const departed = [...this.#activeRoots].filter((id) => !activeIds.has(id));
		let fetchedFull = full;
		let recent = this.#recent;
		if (full) {
			recent = await this.#listRoots(RECENT_LIMIT);
		} else if (departed.length > 0) {
			const head = await this.#listRoots(HEAD_LIMIT);
			const inHead = new Set(head.map((t) => t.threadId));
			if (departed.every((id) => inHead.has(id))) recent = mergeById(recent, head);
			else {
				recent = await this.#listRoots(RECENT_LIMIT);
				fetchedFull = true;
			}
		}
		if (this.#location.home !== home) return false;
		this.#recent = recent;
		this.#activeRoots = new Set(active.filter((t) => t.relationshipToParent !== "subagent").map((t) => t.threadId));

		const byId = new Map<string, ThreadSummary>();
		for (const t of this.#recent) byId.set(t.threadId, t);
		for (const t of active) byId.set(t.threadId, t);
		this.#local = [...byId.values()];
		this.#compose();
		if (fetchedFull) this.#lastFullAt = startedAt;
		this.#absorb(this.#local, this.#now());
		await this.#refreshProjects();
		this.#rebuild();
		return true;
	}

	/** First sight of each thread: decide whether its latest result counts as news. Then forget threads gone for a day. */
	#absorb(threads: readonly ThreadSummary[], now: number, seedAll = false): void {
		const shell = this.#liveShell();
		const firstPoll = seedAll || !this.#seeded;
		for (const t of threads) {
			const known = this.#seen.has(t.threadId);
			this.#seen.set(t.threadId, now);
			if (known) continue;
			const seed = shouldSeed({ firstPoll, active: isActive(t.status), completedAt: completedAtOf(t, shell), startedAt: this.#startedAt, now });
			if (seed) this.#acked.set(t.threadId, ackKeyOf(t));
		}
		this.#seeded = true;
		pruneSeen(this.#seen, this.#acked, now - SEEN_TTL_MS);
	}

	async #refreshProjects(): Promise<void> {
		if (this.#now() - this.#projectsAt < PROJECTS_REFRESH_MS) return;
		try {
			const names = new Map<string, string>();
			for (let cursor: number | null = 0, page = 0; cursor !== null && page < 10; page++) {
				const result: ProjectListResult | undefined = await this.#call<ProjectListResult>("t3_project_list", { cursor, limit: 100 });
				for (const p of Array.isArray(result?.projects) ? result.projects : []) {
					if (p && typeof p.id === "string") names.set(p.id, p.name || p.title || basename(p.workspaceRoot) || "");
				}
				cursor = typeof result?.nextCursor === "number" ? result.nextCursor : null;
			}
			this.#localProjectNames = names;
			this.#mergeProjectNames();
			this.#projectsAt = this.#now();
		} catch (error) {
			this.#projectsAt = this.#now() - PROJECTS_REFRESH_MS / 2; // retry in 30s
			this.emit("log", `project list failed: ${(error as Error).message}`);
		}
	}

	/** This machine's threads plus linked machines' (this machine's win on an id clash). */
	#compose(): void {
		const byId = new Map<string, ThreadSummary>();
		for (const t of this.#remotes.threads()) byId.set(t.threadId, t);
		for (const t of this.#local) byId.set(t.threadId, t);
		this.#threads = [...byId.values()];
	}

	#mergeProjectNames(): void {
		this.#projectNames.clear();
		for (const [id, name] of this.#remotes.projectNames()) this.#projectNames.set(id, name);
		for (const [id, name] of this.#localProjectNames) this.#projectNames.set(id, name);
	}

	#scheduleRemotes(delayMs: number): void {
		if (!this.#running) return;
		clearTimeout(this.#remoteTimer);
		this.#remoteTimer = setTimeout(() => {
			this.#remoteTimer = undefined;
			void this.#pollRemotes(false).finally(() => {
				// Still due right after trying means nothing could be asked (T3 away, signed out): wait a whole tick.
				const dueIn = this.#remotes.dueIn(this.#now(), this.#settings.pollSeconds * 1000);
				this.#scheduleRemotes(dueIn > 0 ? Math.min(REMOTE_TICK_MS, Math.max(REMOTE_TICK_MIN_MS, dueIn)) : REMOTE_TICK_MS);
			});
		}, delayMs);
	}

	/**
	 * Linked machines, on their own cadence (see `remotes.ts`). Only while this
	 * machine's server answers: it is the one forwarding the calls. Never throws.
	 */
	#pollRemotes(force: boolean): Promise<void> {
		if (this.#remoteInflight) return this.#remoteInflight;
		const now = this.#now();
		if (!this.#running || this.snapshot.connection.kind !== "ok" || this.#tokens.signedOut) return Promise.resolve();
		if (!this.#remotes.due(now, this.#settings.pollSeconds * 1000, force)) return Promise.resolve();
		const run = this.#remotes
			.poll({ now, pollMs: this.#settings.pollSeconds * 1000, showSnoozed: this.#settings.showSnoozed, force })
			.then((firstSeen) => {
				if (!this.#running) return;
				this.#compose();
				// A machine's first answer is like the first poll: results that are already there don't flash.
				const remote = this.#remotes.threads();
				this.#absorb(remote.filter((t) => !firstSeen.has(t.environmentId!)), this.#now());
				this.#absorb(remote.filter((t) => firstSeen.has(t.environmentId!)), this.#now(), true);
				this.#mergeProjectNames();
				this.#rebuild();
			})
			.catch((error: unknown) => {
				this.emit("log", `linked environments poll failed: ${(error as Error)?.message ?? String(error)}`);
			})
			.finally(() => {
				this.#remoteInflight = undefined;
			});
		this.#remoteInflight = run;
		return run;
	}

	/** The shell stream, only while it is connected: its picture is meaningless otherwise. */
	#liveShell(): ShellView | undefined {
		return this.#shell?.connected ? this.#shell : undefined;
	}

	#scheduleRebuild(): void {
		if (this.#rebuildTimer) return;
		this.#rebuildTimer = setTimeout(() => {
			this.#rebuildTimer = undefined;
			this.#rebuild();
		}, REBUILD_DEBOUNCE_MS);
	}

	#rebuild(): void {
		clearTimeout(this.#rebuildTimer);
		this.#rebuildTimer = undefined;
		const shell = this.#liveShell();
		// Seen in T3: opening the thread after its run ended clears done/failed, no key press needed.
		// Only when the shell describes the same run the thread list does.
		if (shell) {
			for (const t of this.#threads) {
				if (isActive(t.status) || !t.latestRunId) continue;
				const extras = shell.extras(t.threadId);
				if (!extras || extras.latestRunId !== t.latestRunId) continue;
				if (seenAfterRun(extras.lastVisitedAt, extras.latestRunCompletedAt)) this.#acked.set(t.threadId, ackKeyOf(t));
			}
		}
		const threads = shell ? reparent(this.#threads, (id) => shell.rootOf(id)) : this.#threads;
		const pending = shell?.pendingByRoot() ?? new Map<string, PendingTask[]>();
		for (const id of linkedBackground(threads, this.#remotes.held())) pending.set(id, [LINKED_BACKGROUND]);
		const background = backgroundByRoot(threads, pending);
		const cards = buildCards(threads, {
			acked: this.#acked,
			flashOnDone: this.#settings.flashOnDone,
			flashOnFailed: this.#settings.flashOnFailed,
			background,
			subagentGrace: this.#graceRoots(background),
		});
		const now = this.#now();
		// Questions and approvals: on the thread itself or on one of its subagents.
		if (shell) {
			const known = new Map(threads.map((t) => [t.threadId, t] as const));
			for (const t of threads) {
				if (!shell.extras(t.threadId)?.pendingInput) continue;
				const card = cards.get(rootOf(t.threadId, known));
				if (!card || card.state === "input") continue;
				card.state = "input";
				card.inputFromSubagent = card.threadId !== t.threadId;
			}
		}
		for (const card of cards.values()) {
			const extras = shell?.extras(card.threadId);
			// What a background-only thread is waiting on.
			if (card.background > 0) card.waitingOn = waitingLabel(pending.get(card.threadId) ?? []);
			// Paused by a usage limit.
			const resetAt = extras?.limitResetAt;
			if (resetAt && resetAt > now && !isActive(card.ownStatus) && (card.state === "idle" || card.state === "failed" || card.state === "done")) {
				card.state = "paused";
				card.pausedUntil = resetAt;
			}
			if (extras?.activeRunId) card.activeRunId = extras.activeRunId;
			const context = this.#context?.get(card.threadId);
			if (context) card.context = context;
		}
		const byId = new Map(threads.map((t) => [t.threadId, t] as const));
		const cutoff = now - this.#settings.recentHours * 3600_000;
		const visible = [...cards.values()].filter((card) => {
			const t = byId.get(card.threadId);
			if (!t) return false;
			if (t.settled) return false;
			// A subagent only gets its own key when its main thread isn't loaded (e.g. settled)
			// AND it needs you; idle or finished orphans would just be clutter.
			if (t.parentThreadId && card.state !== "input" && card.state !== "failed") return false;
			if (t.snoozed && !this.#settings.showSnoozed && card.state !== "input") return false;
			return card.state !== "idle" || card.updatedAt >= cutoff;
		});
		this.snapshot = { connection: this.snapshot.connection, cards, visible, projectNames: this.#projectNames };
		this.emit("change", this.snapshot);
	}

	/** Tells the context watcher exactly which threads are on keys, and whether each is mid-run. */
	#syncContext(): void {
		if (!this.#context) return;
		const shell = this.#liveShell();
		const targets = new Map<string, WatchTarget>();
		for (const id of this.#deckThreads) {
			const card = this.snapshot.cards.get(id);
			// Context usage comes from this machine's server; it knows nothing about a linked machine's threads.
			if (!card || card.environmentId) continue;
			const extras = shell?.extras(id);
			targets.set(id, {
				runKey: card.ackKey,
				completedAt: extras?.latestRunCompletedAt ?? null,
				working: isWorking(card.ownStatus) || !!extras?.activeRunId,
			});
		}
		this.#context.watch(targets);
	}

	#graceRoots(background: ReadonlyMap<string, number>): Set<string> {
		const now = this.#now();
		for (const id of this.#hadBackground) if (!background.has(id)) this.#backgroundEndedAt.set(id, now);
		for (const id of background.keys()) this.#backgroundEndedAt.delete(id);
		this.#hadBackground = new Set(background.keys());
		const grace = new Set<string>();
		for (const [id, at] of this.#backgroundEndedAt) {
			if (now - at < SUBAGENT_GRACE_MS) grace.add(id);
			else this.#backgroundEndedAt.delete(id);
		}
		return grace;
	}

	#setConnection(connection: Connection): void {
		if (connectionKey(connection) === connectionKey(this.snapshot.connection)) return;
		this.snapshot = { ...this.snapshot, connection };
		this.emit("change", this.snapshot);
	}
}

const connectionKey = (c: Connection): string => (c.kind === "ok" || c.kind === "connecting" ? c.kind : `${c.kind}|${c.reason ?? ""}|${c.detail}`);

/**
 * The property inspector's reply to "sign out". `ok` means the plugin is signed out
 * (credentials deleted, nothing minted until sign-in); `failed` counts tokens T3 Code
 * didn't revoke yet, which are retried later. `SignOutResult.ok` alone would be false
 * in that case, which the inspector used to show as a failed sign-out.
 */
export function signOutReply(result: SignOutResult): { type: "signedOut"; ok: boolean; revoked: number; failed: number } {
	return { type: "signedOut", ok: true, revoked: result.revoked, failed: result.failed };
}

/** Why a poll failed, as the keys show it. */
export function connectionFor(error: unknown): Connection {
	const detail = error instanceof Error ? error.message : String(error);
	if (error instanceof T3Error) return { kind: error.offline ? "offline" : "error", detail, reason: error.reason };
	if (error instanceof UnreachableError) return { kind: "offline", detail, reason: "not-running" };
	if (error instanceof AuthRejectedError) return { kind: "error", detail, reason: "sign-in-failed" };
	return { kind: "error", detail, reason: "server-error" };
}

/**
 * Does a thread's latest result predate us, so it shouldn't flash?
 * Everything idle in the first successful poll does. A thread first seen
 * later only does if its run ended before the plugin started (or more than a
 * day ago: then it was seen and forgotten); otherwise it ended while we were
 * watching and lights up.
 */
export function shouldSeed(o: { firstPoll: boolean; active: boolean; completedAt: number | null; startedAt: number; now: number }): boolean {
	if (o.active) return false;
	if (o.firstPoll) return true;
	if (o.completedAt === null) return true;
	return o.completedAt < Math.max(o.startedAt, o.now - SEEN_TTL_MS);
}

/** When the thread's latest run ended: the shell's time for that run, else the thread's last update. */
export function completedAtOf(t: ThreadSummary, shell: Pick<ShellView, "extras"> | undefined): number | null {
	const extras = shell?.extras(t.threadId);
	if (extras && t.latestRunId && extras.latestRunId === t.latestRunId && extras.latestRunCompletedAt !== null) return extras.latestRunCompletedAt;
	const updated = Date.parse(t.updatedAt);
	return Number.isFinite(updated) ? updated : null;
}

/** Drops threads last seen before `cutoff`, and acks of threads no longer known. */
export function pruneSeen(seen: Map<string, number>, acked: Map<string, string>, cutoff: number): void {
	for (const [id, at] of seen) if (at < cutoff) seen.delete(id);
	for (const id of acked.keys()) if (!seen.has(id)) acked.delete(id);
}

/**
 * A subagent whose parent isn't loaded (an idle intermediate subagent, now
 * that the recent list is roots only) folds into its root when the shell
 * knows the root and the root is loaded.
 */
export function reparent(threads: readonly ThreadSummary[], rootOf: (threadId: string) => string | undefined): ThreadSummary[] {
	const ids = new Set(threads.map((t) => t.threadId));
	return threads.map((t) => {
		if (!t.parentThreadId || ids.has(t.parentThreadId)) return t;
		const root = rootOf(t.threadId);
		return root && root !== t.threadId && ids.has(root) ? { ...t, parentThreadId: root } : t;
	});
}

/**
 * A linked machine has no task list to show: all the plugin learns is that a
 * finished thread there still waits on background work.
 */
export const LINKED_BACKGROUND: PendingTask = { taskId: "linked-machine-background", kind: "background_task", description: "background" };

/**
 * Which of the `held` threads get that stand-in task: only a linked machine's
 * own threads, and not one with a subagent that is listed as running, which
 * the key already counts.
 */
export function linkedBackground(threads: readonly ThreadSummary[], held: ReadonlySet<string>): string[] {
	if (held.size === 0) return [];
	const byId = new Map(threads.map((t) => [t.threadId, t] as const));
	const busyRoots = new Set<string>();
	for (const t of threads) if (t.parentThreadId && isActive(t.status)) busyRoots.add(rootOf(t.threadId, byId));
	return [...held].filter((id) => byId.get(id)?.environmentId && !busyRoots.has(id));
}

/** Root → number of background tasks, minus children whose own thread status already counts them. */
export function backgroundByRoot(threads: readonly ThreadSummary[], pending: ReadonlyMap<string, readonly PendingTask[]>): Map<string, number> {
	const out = new Map<string, number>();
	const statusOf = new Map(threads.map((t) => [t.threadId, t.status] as const));
	for (const [root, tasks] of pending) {
		const n = tasks.filter((task) => !(task.childThreadId && isActive(statusOf.get(task.childThreadId) ?? ""))).length;
		if (n > 0) out.set(root, n);
	}
	return out;
}

/** Checks a `t3_thread_list` result; drops entries that aren't threads. */
export function threadListOf(result: unknown): ThreadListResult {
	if (!result || typeof result !== "object" || !Array.isArray((result as { threads?: unknown }).threads)) {
		throw new ToolError("t3_thread_list: unexpected result");
	}
	const r = result as { threads: unknown[]; nextCursor?: unknown };
	const threads = r.threads.filter(
		(t): t is ThreadSummary =>
			!!t && typeof t === "object" && typeof (t as ThreadSummary).threadId === "string" && typeof (t as ThreadSummary).status === "string",
	);
	return { threads, nextCursor: typeof r.nextCursor === "number" ? r.nextCursor : null };
}

const mergeById = (base: readonly ThreadSummary[], updates: readonly ThreadSummary[]): ThreadSummary[] => {
	const byId = new Map(base.map((t) => [t.threadId, t] as const));
	for (const t of updates) byId.set(t.threadId, t);
	return [...byId.values()];
};

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const basename = (p?: string): string => (p ? p.split("/").filter(Boolean).pop() ?? "" : "");
function stripUndefined<T extends object>(o: T): Partial<T> {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")) as Partial<T>;
}
