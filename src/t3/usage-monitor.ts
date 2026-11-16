/**
 * Reads provider usage limits from T3 Code.
 *
 * Usage limits aren't on the MCP endpoint; T3's UI gets them from the
 * `server.getConfig` RPC on the `/ws` socket (Effect RPC, JSON frames).
 * Each refresh: POST /api/auth/websocket-ticket with a read-only bearer
 * token, open /ws?orchestrationProtocol=2&wsTicket=…, send one request,
 * take the Exit frame, close. T3 itself only re-probes usage every few
 * minutes, so this polls every 5 minutes, and backs off further while T3's
 * `checkedAt` doesn't move. Pressing a Usage key refreshes at once.
 *
 * Hub accounts (CLIProxyAPI) are not in `server.getConfig`; T3 sends them only
 * as `usageLimitSourcesUpdated` events on `subscribeServerConfig` when asked
 * with `usageLimitSources: true`. Each refresh therefore opens that stream
 * instead, takes the snapshot (the same providers `getConfig` returns) and
 * the first sources event (the server emits the current set right after the
 * snapshot), and closes. No socket stays open between refreshes. If the
 * stream fails, the refresh falls back to `server.getConfig`.
 */
import { EventEmitter } from "node:events";

import { hubKey, type HubAccount, type HubStatus, type ResetCredits, type UsageProvider, type UsageUnavailable, type UsageWindow } from "../usage.ts";
import { closeQuietly, handleFrame, request, type RpcAccess } from "./rpc.ts";

export const REFRESH_MS = 5 * 60_000;
/** Longest wait while T3 keeps reporting the same `checkedAt`. */
export const REFRESH_MAX_MS = 20 * 60_000;
const RETRY_MS = 30_000;
const RPC_TIMEOUT_MS = 15_000;
/** The config snapshot waits on T3's editor probes, so the stream gets longer than a plain request. */
const STREAM_TIMEOUT_MS = 20_000;
/** After the snapshot, how long to wait for the sources event; the server sends it straight away, from a cache. */
const HUB_GRACE_MS = 4_000;

/** Next delay: back to 5 min when T3 re-probed since last time, doubled (up to 20 min) when it didn't. */
export function nextRefreshDelay(previousDelay: number, previousChecked: string | undefined, checked: string): number {
	if (previousChecked === undefined || previousChecked !== checked) return REFRESH_MS;
	return Math.min(REFRESH_MAX_MS, Math.max(REFRESH_MS, previousDelay * 2));
}

/** One string for every provider's `checkedAt`, to tell whether T3 re-probed. */
export const checkedKey = (providers: readonly UsageProvider[]): string =>
	providers.map((p) => `${p.instanceId}=${p.checkedAt ?? ""}`).sort().join(",");

export interface UsageSnapshot {
	ok: boolean;
	detail?: string;
	/** T3's own providers first, then hub accounts (those have `hub` set). */
	providers: UsageProvider[];
	/** Hubs T3 reported, with whether each failed. */
	hubs?: HubStatus[];
	fetchedAt: number;
}

/** What one refresh learned. `hub` is undefined when T3 didn't say (older server, or the sources event was late). */
export interface UsageRead {
	providers: UsageProvider[];
	hub?: { accounts: UsageProvider[]; hubs: HubStatus[] };
}

export class UsageMonitor extends EventEmitter<{ change: [UsageSnapshot]; log: [string] }> {
	readonly #rpc: RpcAccess;
	#timer: NodeJS.Timeout | undefined;
	#running = false;
	#busy = false;
	/** Only poll while a Usage key is on the deck. */
	#wanted = false;
	#delay = REFRESH_MS;
	#checked: string | undefined;
	readonly #hubGraceMs: number;
	/** Last hub accounts T3 reported, kept when a refresh can't tell. */
	#hub: { accounts: UsageProvider[]; hubs: HubStatus[] } = { accounts: [], hubs: [] };

	snapshot: UsageSnapshot = { ok: false, detail: "Loading…", providers: [], fetchedAt: 0 };

	constructor(rpc: RpcAccess, opts: { hubGraceMs?: number } = {}) {
		super();
		this.#rpc = rpc;
		this.#hubGraceMs = opts.hubGraceMs ?? HUB_GRACE_MS;
	}

	setWanted(wanted: boolean): void {
		if (wanted === this.#wanted) return;
		this.#wanted = wanted;
		if (wanted) this.refresh();
	}

	start(): void {
		this.#running = true;
		if (this.#wanted) void this.#tick();
	}

	stop(): void {
		this.#running = false;
		clearTimeout(this.#timer);
	}

	/** Refresh now (a Usage key press, or a Usage key appeared). */
	refresh(): void {
		if (!this.#running) return;
		clearTimeout(this.#timer);
		this.#delay = REFRESH_MS;
		void this.#tick();
	}

	async #tick(): Promise<void> {
		if (this.#busy || !this.#wanted) return;
		this.#busy = true;
		let delay = REFRESH_MS;
		try {
			const read = await this.#fetch();
			if (read.hub) this.#hub = read.hub;
			const providers = [...read.providers, ...this.#hub.accounts];
			this.snapshot = { ok: true, providers, hubs: this.#hub.hubs, fetchedAt: Date.now() };
			const checked = checkedKey(providers);
			delay = this.#delay = nextRefreshDelay(this.#delay, this.#checked, checked);
			this.#checked = checked;
		} catch (error) {
			delay = RETRY_MS;
			this.snapshot = { ...this.snapshot, ok: false, detail: (error as Error).message };
			this.emit("log", `usage refresh failed: ${(error as Error).message}`);
		} finally {
			this.#busy = false;
			this.emit("change", this.snapshot);
			if (this.#running && this.#wanted) this.#timer = setTimeout(() => void this.#tick(), delay);
		}
	}

	async #fetch(): Promise<UsageRead> {
		// Failing to open (T3 down, token refused) is the same for both calls, so it isn't retried.
		const ws = await this.#rpc.open();
		try {
			return await readConfigStream(ws, this.#hubGraceMs);
		} catch (error) {
			this.emit("log", `usage stream failed, using server.getConfig: ${(error as Error).message}`);
		}
		const plain = await this.#rpc.open();
		return { providers: parseProviders(await rpcOnce(plain, "server.getConfig", {})) };
	}
}

/**
 * Opens `subscribeServerConfig` with `usageLimitSources: true`, collects the
 * snapshot and the first sources event, and closes. The snapshot is required;
 * the sources event is waited for `graceMs` and may be missing. Chunks are
 * acked by `handleFrame`, as the server's window requires.
 */
export function readConfigStream(ws: WebSocket, graceMs = HUB_GRACE_MS): Promise<UsageRead> {
	return new Promise((resolve, reject) => {
		let config: unknown;
		let sources: unknown;
		let grace: NodeJS.Timeout | undefined;
		let done = false;
		const timer = setTimeout(() => finish(new Error("subscribeServerConfig timed out")), STREAM_TIMEOUT_MS);
		function finish(error: Error | null): void {
			if (done) return;
			done = true;
			clearTimeout(timer);
			clearTimeout(grace);
			closeQuietly(ws);
			if (error && config === undefined) return reject(error);
			// With the snapshot but no sources: T3 didn't say, so the caller keeps what it had.
			const hub = Array.isArray(sources) ? parseHubs(sources) : undefined;
			resolve({ providers: parseProviders(config), hub });
		}
		ws.onopen = () => {
			try {
				ws.send(request("1", "subscribeServerConfig", { usageLimitSources: true }));
			} catch (error) {
				finish(error as Error);
			}
		};
		ws.onmessage = (event) => {
			try {
				const frame = handleFrame(ws, event.data);
				if (frame?.requestId !== "1") return;
				if (frame._tag === "Chunk") {
					for (const item of Array.isArray(frame.values) ? frame.values : []) {
						const e = item as { type?: unknown; config?: unknown; payload?: { sources?: unknown } } | null;
						if (e?.type === "snapshot" && config === undefined && e.config && typeof e.config === "object") {
							config = e.config;
							grace = setTimeout(() => finish(null), graceMs);
						} else if (e?.type === "usageLimitSourcesUpdated" && sources === undefined) sources = e.payload?.sources;
					}
					if (config !== undefined && Array.isArray(sources)) finish(null);
				} else if (frame._tag === "Exit") {
					finish(new Error(`subscribeServerConfig ended: ${JSON.stringify(frame.exit?.cause ?? frame.exit ?? null).slice(0, 200)}`));
				}
			} catch (error) {
				finish(error as Error);
			}
		};
		ws.onerror = () => finish(new Error("subscribeServerConfig: WebSocket error"));
		ws.onclose = (event) => finish(new Error(`subscribeServerConfig: socket closed (${event.code})`));
	});
}

/** One RPC request on a fresh socket; resolves with the Exit value. */
export function rpcOnce(ws: WebSocket, tag: string, payload: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error(`${tag} timed out`)), timeoutMs);
		let done = false;
		function finish(error: Error | null, value?: unknown): void {
			if (done) return;
			done = true;
			clearTimeout(timer);
			closeQuietly(ws);
			if (error) reject(error);
			else resolve(value);
		}
		ws.onopen = () => {
			try {
				ws.send(request("1", tag, payload));
			} catch (error) {
				finish(error as Error);
			}
		};
		ws.onmessage = (event) => {
			try {
				const frame = handleFrame(ws, event.data);
				if (frame?._tag !== "Exit" || frame.requestId !== "1") return;
				if (frame.exit?._tag === "Success") finish(null, frame.exit.value);
				else finish(new Error(`${tag} failed: ${JSON.stringify(frame.exit?.cause ?? frame.exit ?? null).slice(0, 200)}`));
			} catch (error) {
				finish(error as Error);
			}
		};
		ws.onerror = () => finish(new Error(`${tag}: WebSocket error`));
		ws.onclose = (event) => finish(new Error(`${tag}: socket closed (${event.code})`));
	});
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

/** Names for the drivers T3 Code ships (`PROVIDER_DISPLAY_NAMES` in its contracts); the server normally sends a `displayName` too. */
export const DRIVER_NAMES: Record<string, string> = {
	claudeAgent: "Claude",
	codex: "Codex",
	cursor: "Cursor",
	opencode: "OpenCode",
	antigravity: "Antigravity",
	grok: "Grok",
	fx: "fx",
	kiro: "Kiro",
	muse: "Muse Code",
	pi: "Pi",
	acpRegistry: "ACP Registry",
};

/** A driver T3 knows about and this plugin doesn't: "someNewAgent" → "Some New Agent". */
export function driverName(driver: string): string {
	const known = DRIVER_NAMES[driver];
	if (known) return known;
	const words = driver.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_-]+/).filter(Boolean);
	return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || "Provider";
}

/** Windows with a string id and a finite percentage; everything else T3 might add is dropped. */
function parseWindows(raw: unknown): UsageWindow[] {
	const out: UsageWindow[] = [];
	for (const w of Array.isArray(raw) ? raw : []) {
		if (!isObject(w)) continue;
		const id = str(w.id);
		if (!id || typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent)) continue;
		const modelIds = Array.isArray(w.modelIds) ? w.modelIds.filter((m): m is string => typeof m === "string") : [];
		out.push({
			id,
			label: str(w.label) ?? id,
			usedPercent: w.usedPercent,
			...(str(w.kind) ? { kind: str(w.kind) } : {}),
			...(str(w.resetsAt) ? { resetsAt: str(w.resetsAt) } : {}),
			...(typeof w.windowDurationMins === "number" && Number.isFinite(w.windowDurationMins) ? { windowDurationMins: w.windowDurationMins } : {}),
			...(modelIds.length > 0 ? { modelIds } : {}),
		});
	}
	return out;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const validTime = (v: unknown): string | undefined => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : undefined);

/**
 * `usageLimits.resetCredits`: the total, or the sum of its options when the
 * total is missing. Undefined for none, so the renderer draws nothing.
 */
export function parseResetCredits(raw: unknown): ResetCredits | undefined {
	if (!isObject(raw)) return undefined;
	const options = (Array.isArray(raw.options) ? raw.options : []).filter(isObject);
	const total = count(raw.availableCount) || options.reduce((sum, o) => sum + count(o.availableCount), 0);
	if (total <= 0) return undefined;
	// The server's own "next" date, else the earliest date among options that still have tickets.
	const dates = options.filter((o) => count(o.availableCount) > 0).flatMap((o) => validTime(o.expiresAt) ?? []);
	const next = validTime(raw.nextExpiresAt) ?? dates.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
	return { count: total, ...(next ? { nextExpiresAt: next } : {}) };
}

function parseUnavailable(raw: unknown): UsageUnavailable | undefined {
	const reason = isObject(raw) ? raw.reason : undefined;
	return reason === "unsupported" || reason === "probeFailed" ? { reason } : undefined;
}

/** The parts of a `usageLimits` object a key needs. Null when there is no object (a disabled provider). */
function parseLimits(raw: unknown): Pick<UsageProvider, "checkedAt" | "windows" | "resetCredits" | "unavailable"> | null {
	if (!isObject(raw)) return null;
	const resetCredits = parseResetCredits(raw.resetCredits);
	const unavailable = parseUnavailable(raw.unavailable);
	return { checkedAt: str(raw.checkedAt), windows: parseWindows(raw.windows), ...(resetCredits ? { resetCredits } : {}), ...(unavailable ? { unavailable } : {}) };
}

/**
 * T3's providers. One with a `usageLimits` object is kept even with no
 * windows, so a key set to it can say why; one without (disabled) is not.
 * Two providers that end up with one name get their instance id appended.
 */
export function parseProviders(config: unknown): UsageProvider[] {
	const raw = isObject(config) ? config.providers : undefined;
	const out: UsageProvider[] = [];
	for (const p of Array.isArray(raw) ? raw : []) {
		if (!isObject(p)) continue;
		const limits = parseLimits(p.usageLimits);
		if (!limits) continue;
		const driver = str(p.driver);
		const instanceId = str(p.instanceId) ?? str(p.id) ?? driver ?? "provider";
		out.push({ instanceId, displayName: str(p.displayName) ?? driverName(driver ?? instanceId), ...limits });
	}
	const names = new Map<string, number>();
	for (const p of out) names.set(p.displayName, (names.get(p.displayName) ?? 0) + 1);
	return out.map((p) => ((names.get(p.displayName) ?? 0) > 1 ? { ...p, displayName: `${p.displayName} · ${p.instanceId}` } : p));
}

/**
 * Hub accounts from a `usageLimitSourcesUpdated` payload. Each becomes a
 * provider-like entry keyed by `hubKey`, named for its plan ("Codex Plus") or,
 * with no plan, its hub: never its email.
 */
export function parseHubs(sources: unknown): { accounts: UsageProvider[]; hubs: HubStatus[] } {
	const accounts: UsageProvider[] = [];
	const hubs: HubStatus[] = [];
	for (const source of Array.isArray(sources) ? sources : []) {
		if (!isObject(source)) continue;
		const sourceId = str(source.id);
		if (!sourceId) continue;
		const hubLabel = str(source.label) ?? sourceId;
		hubs.push({ id: sourceId, label: hubLabel, ...(str(source.error) ? { error: true } : {}) });
		for (const a of Array.isArray(source.accounts) ? source.accounts : []) {
			if (!isObject(a)) continue;
			const accountId = str(a.id);
			const limits = parseLimits(a.usageLimits);
			if (!accountId || !limits) continue;
			const driver = driverName(str(a.driver) ?? "");
			const plan = str(a.plan);
			const hub: HubAccount = { sourceId, hubLabel, driver, name: accountId.replace(/\.json$/i, ""), ...(str(a.email) ? { email: str(a.email) } : {}), ...(plan ? { plan } : {}) };
			accounts.push({ instanceId: hubKey(sourceId, accountId, str(a.workspaceId)), displayName: plan ? `${driver} ${plan}` : hubLabel, ...limits, hub });
		}
	}
	return { accounts, hubs };
}
