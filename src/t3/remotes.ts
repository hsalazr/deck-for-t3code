/**
 * Threads in linked environments (the user's other machines).
 *
 * T3 Code's local server lists its links (`t3_environment_links`) and forwards
 * `t3_thread_list` / `t3_project_list` to a linked machine when given its
 * `environmentId`. The plugin only ever talks to the local loopback server;
 * the local server makes the network call with its own link credential.
 *
 * Linked environments is a Labs setting in T3 Code. While it is off, the links
 * tool is hidden or refuses, and the deck simply shows local threads.
 *
 * Remote threads get status from polling only: the shell stream and context
 * usage come from the local server and describe local threads. So each machine
 * is polled on its own cadence: often while something runs there, less often
 * while it is idle or failing, counted from when its last answer came back so
 * a slow link is never asked faster than it answers.
 */
import { ACTIVE_STATUSES, type ThreadSummary } from "../model.ts";
import { ToolError } from "./mcp.ts";

export type ToolCall = <T>(name: string, args: Record<string, unknown>) => Promise<T>;

export interface LinkedEnvironment {
	environmentId: string;
	label: string;
	/** "reachable" | "unreachable" | "expired" (as T3 reports it). */
	status: string;
}

/** Active list of a linked machine with something running, at most this often (each call is a network round trip). */
export const REMOTE_BUSY_MIN_MS = 3_000;
/** Active list of a linked machine that is idle or failing, at most this often. */
export const REMOTE_ACTIVE_MIN_MS = 10_000;
/** Links and recent roots, this often. Recent roots also right after one leaves the active list. */
export const REMOTE_FULL_MS = 30_000;
/** Look for links again this often while the feature is off or the answer was unusable. */
export const LINKS_RETRY_MS = 60_000;
/** A machine that has failed (or been unreachable) this long loses its tiles. */
export const REMOTE_DROP_AFTER_MS = 2 * 60_000;
const PROJECTS_REFRESH_MS = 60_000;
const RECENT_LIMIT = 100;
const MAX_PAGES = 5;

interface RemoteEnv {
	label: string;
	active: ThreadSummary[];
	recent: ThreadSummary[];
	projects: Map<string, string>;
	projectsAt: number;
	fullAt: number;
	/** When its last active-list call came back, answered or failed. */
	polledAt: number;
	/** First failure (or unreachable report) of the current streak. */
	failingSince?: number;
	/** It has answered at least once. */
	answered: boolean;
}

/**
 * Checks a `t3_environment_links` result. Returns null when it isn't one.
 * Leaves out the local environment itself.
 */
export function linksOf(result: unknown): LinkedEnvironment[] | null {
	if (!result || typeof result !== "object" || !Array.isArray((result as { links?: unknown }).links)) return null;
	const r = result as { environmentId?: unknown; links: unknown[] };
	const out: LinkedEnvironment[] = [];
	for (const l of r.links) {
		if (!l || typeof l !== "object") continue;
		const { environmentId, label, status } = l as Record<string, unknown>;
		if (typeof environmentId !== "string" || environmentId === "" || environmentId === r.environmentId) continue;
		out.push({ environmentId, label: typeof label === "string" ? label : environmentId, status: typeof status === "string" ? status : "unknown" });
	}
	return out;
}

export class RemoteEnvironments {
	readonly #call: ToolCall;
	readonly #log: (message: string) => void;
	readonly #now: () => number;
	readonly #envs = new Map<string, RemoteEnv>();
	#linksAt = Number.NEGATIVE_INFINITY;
	#linksOk = false;
	#lastLog = new Map<string, string>();

	constructor(call: ToolCall, log: (message: string) => void, now: () => number = Date.now) {
		this.#call = call;
		this.#log = log;
		this.#now = now;
	}

	/** Linked machines with threads on the deck right now. */
	get environments(): ReadonlyMap<string, { label: string; failing: boolean }> {
		return new Map([...this.#envs].map(([id, e]) => [id, { label: e.label, failing: e.failingSince !== undefined }]));
	}

	/** Every remote thread, stamped with its environment id; active entries win over recent ones. */
	threads(): ThreadSummary[] {
		const out: ThreadSummary[] = [];
		for (const [environmentId, env] of this.#envs) {
			const byId = new Map<string, ThreadSummary>();
			for (const t of env.recent) byId.set(t.threadId, t);
			for (const t of env.active) byId.set(t.threadId, t);
			for (const t of byId.values()) out.push({ ...t, environmentId });
		}
		return out;
	}

	projectNames(): Map<string, string> {
		const names = new Map<string, string>();
		for (const env of this.#envs.values()) for (const [id, name] of env.projects) names.set(id, name);
		return names;
	}

	/** Drops everything (sign-out, T3 home changed). */
	clear(): void {
		this.#envs.clear();
		this.#linksAt = Number.NEGATIVE_INFINITY;
	}

	/** Milliseconds until a poll would do something (0: now); `force` asks for links and recent roots too. */
	dueIn(now: number, pollMs: number, force = false): number {
		if (force) return 0;
		let at = this.#linksAt + (this.#linksOk ? REMOTE_FULL_MS : LINKS_RETRY_MS);
		for (const env of this.#envs.values()) at = Math.min(at, env.polledAt + activeEvery(env, pollMs));
		return Math.max(0, at - now);
	}

	/** Whether a poll at `now` would do anything. */
	due(now: number, pollMs: number, force = false): boolean {
		return this.dueIn(now, pollMs, force) === 0;
	}

	/**
	 * One round: links (when due), then the active list of each reachable machine
	 * that is due, and its recent roots and project names when due. Never throws; a
	 * machine that fails keeps its last threads until it has failed for REMOTE_DROP_AFTER_MS.
	 * Resolves with the machines that answered for the first time.
	 */
	async poll(opts: { now: number; pollMs: number; showSnoozed: boolean; force?: boolean }): Promise<Set<string>> {
		const { now } = opts;
		const firstSeen = new Set<string>();
		const linksDue = opts.force || now - this.#linksAt >= (this.#linksOk ? REMOTE_FULL_MS : LINKS_RETRY_MS);
		let reachable: Set<string> | undefined;
		let links: LinkedEnvironment[] | null | undefined;
		if (linksDue) {
			this.#linksAt = now;
			links = await this.#discover();
			if (links === null) {
				this.#linksOk = false;
				this.#envs.clear();
				return firstSeen;
			}
		}
		if (links) {
			this.#linksOk = true;
			const listed = new Set(links.map((l) => l.environmentId));
			for (const id of this.#envs.keys()) if (!listed.has(id)) this.#envs.delete(id);
			reachable = new Set();
			for (const link of links) {
				let env = this.#envs.get(link.environmentId);
				if (!env && link.status !== "reachable") continue;
				if (!env) {
					env = { label: link.label, active: [], recent: [], projects: new Map(), projectsAt: Number.NEGATIVE_INFINITY, fullAt: Number.NEGATIVE_INFINITY, polledAt: Number.NEGATIVE_INFINITY, answered: false };
					this.#envs.set(link.environmentId, env);
				}
				env.label = link.label;
				if (link.status === "reachable") reachable.add(link.environmentId);
				else {
					env.failingSince ??= now;
					this.#note(link.environmentId, `linked environment ${link.label} is ${link.status}`);
				}
			}
		}
		// A round with the links asks every reachable machine; otherwise only the ones whose turn it is.
		const targets = [...this.#envs].filter(([id, env]) => (reachable ? reachable.has(id) : linksDue || now - env.polledAt >= activeEvery(env, opts.pollMs)));
		await Promise.all(
			targets.map(async ([id, env]) => {
				const before = env.answered;
				await this.#pollEnv(id, env, opts, linksDue);
				if (!before && env.answered) firstSeen.add(id);
			}),
		);
		for (const [id, env] of this.#envs) {
			if (env.failingSince !== undefined && now - env.failingSince >= REMOTE_DROP_AFTER_MS) this.#envs.delete(id);
		}
		return firstSeen;
	}

	/**
	 * The links, or null when the feature is off here (the tool is hidden or
	 * refuses, or answers in a shape this version doesn't know). Undefined when
	 * this machine's server didn't answer: keep what we have and try again.
	 */
	async #discover(): Promise<LinkedEnvironment[] | null | undefined> {
		try {
			const links = linksOf(await this.#call<unknown>("t3_environment_links", {}));
			if (links === null) this.#note("links", "linked environments: unexpected answer from t3_environment_links; showing this machine only");
			else this.#note("links", `linked environments: ${links.length === 0 ? "none" : links.map((l) => `${l.label} (${l.status})`).join(", ")}`);
			return links;
		} catch (error) {
			const message = (error as Error)?.message ?? String(error);
			if (!(error instanceof ToolError)) {
				this.#note("links", `linked environments: ${message}`);
				return undefined;
			}
			// Tool hidden or capability_denied while Labs → Linked environments is off.
			this.#note("links", `linked environments unavailable (${message}); showing this machine only`);
			return null;
		}
	}

	async #pollEnv(environmentId: string, env: RemoteEnv, opts: { now: number; showSnoozed: boolean }, full: boolean): Promise<void> {
		try {
			const active = await this.#pages(environmentId, { includeSubagents: true, statuses: ACTIVE_STATUSES, limit: 100 }, Number.POSITIVE_INFINITY);
			env.polledAt = this.#now();
			// A root that left the active list just finished; its entry in the recent list is stale or missing.
			const activeIds = new Set(active.map((t) => t.threadId));
			const departed = env.active.some((t) => t.relationshipToParent !== "subagent" && !activeIds.has(t.threadId));
			let recent = env.recent;
			if (full || departed || opts.now - env.fullAt >= REMOTE_FULL_MS) {
				recent = await this.#pages(
					environmentId,
					{ includeSubagents: false, settled: false, ...(opts.showSnoozed ? {} : { snoozed: false }) },
					RECENT_LIMIT,
				);
				env.fullAt = opts.now;
			}
			env.active = active;
			env.recent = recent;
			env.answered = true;
			env.failingSince = undefined;
			this.#note(environmentId, "");
		} catch (error) {
			env.polledAt = this.#now();
			env.failingSince ??= opts.now;
			this.#note(environmentId, `linked environment ${env.label}: ${(error as Error)?.message ?? String(error)}`);
			return;
		}
		if (opts.now - env.projectsAt >= PROJECTS_REFRESH_MS) {
			try {
				const names = new Map<string, string>();
				for (let cursor: number | null = 0, page = 0; cursor !== null && page < 10; page++) {
					const result: { projects?: unknown; nextCursor?: unknown } | undefined = await this.#call<{ projects?: unknown; nextCursor?: unknown } | undefined>("t3_project_list", { environmentId, cursor, limit: 100 });
					for (const p of Array.isArray(result?.projects) ? (result.projects as { id?: unknown; name?: string; title?: string; workspaceRoot?: string }[]) : []) {
						if (p && typeof p.id === "string") names.set(p.id, p.name || p.title || basename(p.workspaceRoot));
					}
					cursor = typeof result?.nextCursor === "number" ? result.nextCursor : null;
				}
				env.projects = names;
				env.projectsAt = opts.now;
			} catch {
				env.projectsAt = opts.now - PROJECTS_REFRESH_MS / 2; // retry in 30 s
			}
		}
	}

	async #pages(environmentId: string, args: Record<string, unknown>, limit: number): Promise<ThreadSummary[]> {
		const out: ThreadSummary[] = [];
		for (let page = 0, cursor: number | null = 0; page < MAX_PAGES && cursor !== null && out.length < limit; page++) {
			const pageLimit = Math.min(100, limit - out.length);
			const result = await this.#call<unknown>("t3_thread_list", { allProjects: true, environmentId, ...args, limit: pageLimit, cursor });
			const r = result as { threads?: unknown; nextCursor?: unknown } | undefined;
			if (!r || !Array.isArray(r.threads)) throw new Error("t3_thread_list: unexpected result");
			for (const t of r.threads) {
				if (t && typeof t === "object" && typeof (t as ThreadSummary).threadId === "string" && typeof (t as ThreadSummary).status === "string") out.push(t as ThreadSummary);
			}
			cursor = typeof r.nextCursor === "number" ? r.nextCursor : null;
		}
		return out;
	}

	/** Logs a line per source only when it changes (empty clears it). */
	#note(source: string, message: string): void {
		if (this.#lastLog.get(source) === message) return;
		this.#lastLog.set(source, message);
		if (message) this.#log(message);
	}
}

/** How often a machine's active list is asked for: often while something runs there and it answers. */
const activeEvery = (env: RemoteEnv, pollMs: number): number =>
	Math.max(pollMs, env.failingSince === undefined && env.active.length > 0 ? REMOTE_BUSY_MIN_MS : REMOTE_ACTIVE_MIN_MS);

const basename = (p?: string): string => (p ? p.split("/").filter(Boolean).pop() ?? "" : "");
