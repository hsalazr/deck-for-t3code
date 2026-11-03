/**
 * Context-window fill per thread.
 *
 * T3 keeps `contextUsage` ({usedTokens, maxTokens}) on a thread's active
 * provider thread, which is only in the thread's projection, not its shell.
 * A bounded `orchestration.subscribeThread` snapshot carries it without the
 * full timeline. Snapshots can be large (about 1 MB for a long thread), so:
 * only the threads on Thread keys, once when first seen, then when a run
 * finishes, or at most every 2 minutes while one runs; one request at a time.
 * Failures are retried with a backoff. Values stay in memory across
 * reconnects, and for LINGER_MS after a thread leaves the watched set, so
 * flipping between pages or profiles doesn't refetch every snapshot; then
 * they are dropped.
 */
import { EventEmitter } from "node:events";

import { closeQuietly, handleFrame, request, type RpcAccess } from "./rpc.ts";

export interface ContextUsage {
	used: number;
	max: number;
}

/** What the watcher needs to know about a thread on the deck. */
export interface WatchTarget {
	/** Changes when a run starts or ends (the card's ack key: latest run id and status). */
	runKey: string;
	/** The shell's `latestRunCompletedAt` when known (null while the shell stream is down). */
	completedAt: number | null;
	/** A turn is running right now. */
	working: boolean;
}

/** One fetch attempt's outcome per thread. `failures > 0` is the error sentinel. */
export interface FetchRecord {
	runKey: string;
	completedAt: number | null;
	working: boolean;
	/** Last successful fetch (0 if none yet). */
	at: number;
	failures: number;
	retryAt: number;
}

interface Projection {
	thread?: { activeProviderThreadId?: string | null };
	providerThreads?: { id: string; contextUsage?: { usedTokens?: number; maxTokens?: number } | null }[];
}

export const WORKING_INTERVAL_MS = 120_000;
const TICK_MS = 5_000;
/** Next thread right away (well, after this) when some were never fetched. */
const CATCH_UP_MS = 1_000;
const TIMEOUT_MS = 15_000;
const RETRY_MIN_MS = 10_000;
const RETRY_MAX_MS = 5 * 60_000;
/** A thread that left the watched set keeps its value and fetch record this long. */
export const LINGER_MS = 10 * 60_000;

export const retryDelay = (failures: number): number => Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.max(0, failures - 1));

/** Should this thread be fetched now? */
export function isDue(target: WatchTarget, record: FetchRecord | undefined, now: number): boolean {
	if (!record) return true;
	if (record.failures > 0) return now >= record.retryAt;
	if (target.working) return now - record.at >= WORKING_INTERVAL_MS;
	// Fetched while a run was going and it has finished since.
	if (record.working) return true;
	if (target.runKey !== record.runKey) return true;
	return target.completedAt !== null && record.completedAt !== null && target.completedAt !== record.completedAt;
}

/** Never-fetched threads first, then the one fetched longest ago. */
export function pickNext(wanted: ReadonlyMap<string, WatchTarget>, fetched: ReadonlyMap<string, FetchRecord>, now: number): string | undefined {
	let best: { id: string; at: number } | undefined;
	for (const [id, target] of wanted) {
		const record = fetched.get(id);
		if (!isDue(target, record, now)) continue;
		if (!record) return id; // never tried
		if (!best || record.at < best.at) best = { id, at: record.at };
	}
	return best?.id;
}

export class ContextWatcher extends EventEmitter<{ change: []; log: [string] }> {
	readonly #rpc: RpcAccess;
	readonly #fetchUsage: (threadId: string) => Promise<ContextUsage | null>;
	#usage = new Map<string, ContextUsage>();
	#fetched = new Map<string, FetchRecord>();
	/** Threads on the deck right now. */
	#wanted = new Map<string, WatchTarget>();
	#interval: NodeJS.Timeout | undefined;
	#soon: NodeJS.Timeout | undefined;
	#busy = false;
	/** Threads that left the watched set → when. Pruned after LINGER_MS. */
	#leftAt = new Map<string, number>();
	readonly #now: () => number;

	constructor(rpc: RpcAccess, opts: { fetch?: (threadId: string) => Promise<ContextUsage | null>; now?: () => number } = {}) {
		super();
		this.#rpc = rpc;
		this.#now = opts.now ?? Date.now;
		this.#fetchUsage = opts.fetch ?? ((threadId) => this.#fetch(threadId));
	}

	get(threadId: string): ContextUsage | undefined {
		return this.#usage.get(threadId);
	}

	/** Exactly the threads to fetch for; others are remembered for LINGER_MS, then forgotten. */
	watch(targets: ReadonlyMap<string, WatchTarget>): void {
		this.#wanted = new Map(targets);
		const now = this.#now();
		for (const id of targets.keys()) this.#leftAt.delete(id);
		for (const id of new Set([...this.#fetched.keys(), ...this.#usage.keys()])) {
			if (!targets.has(id) && !this.#leftAt.has(id)) this.#leftAt.set(id, now);
		}
		this.#prune(now);
	}

	#prune(now: number): void {
		let dropped = false;
		for (const [id, left] of [...this.#leftAt]) {
			if (now - left < LINGER_MS) continue;
			this.#leftAt.delete(id);
			this.#fetched.delete(id);
			if (this.#usage.delete(id)) dropped = true;
		}
		if (dropped) this.emit("change");
	}

	/** T3 is back: retry failed threads now instead of waiting out their backoff. */
	retryNow(): void {
		for (const record of this.#fetched.values()) if (record.failures > 0) record.retryAt = 0;
		this.#schedule(0);
	}

	start(): void {
		this.#interval ??= setInterval(() => void this.tick(), TICK_MS);
		void this.tick();
	}

	stop(): void {
		clearInterval(this.#interval);
		clearTimeout(this.#soon);
		this.#interval = undefined;
		this.#soon = undefined;
	}

	/** Fetches at most one due thread. Public for tests. */
	async tick(): Promise<void> {
		if (this.#busy) return;
		const now = this.#now();
		this.#prune(now);
		const threadId = pickNext(this.#wanted, this.#fetched, now);
		if (!threadId) return;
		const target = this.#wanted.get(threadId)!;
		this.#busy = true;
		try {
			const usage = await this.#fetchUsage(threadId);
			if (!this.#wanted.has(threadId)) return; // left the deck meanwhile
			this.#fetched.set(threadId, { runKey: target.runKey, completedAt: target.completedAt, working: target.working, at: this.#now(), failures: 0, retryAt: 0 });
			const previous = this.#usage.get(threadId);
			if (usage) this.#usage.set(threadId, usage);
			else this.#usage.delete(threadId);
			if (previous?.used !== usage?.used || previous?.max !== usage?.max) this.emit("change");
		} catch (error) {
			if (!this.#wanted.has(threadId)) return;
			const previous = this.#fetched.get(threadId);
			const failures = (previous?.failures ?? 0) + 1;
			// Keep the last good values (and what they were fetched for); just retry later.
			this.#fetched.set(threadId, {
				runKey: previous?.runKey ?? target.runKey,
				completedAt: previous?.completedAt ?? target.completedAt,
				working: previous?.working ?? target.working,
				at: previous?.at ?? 0,
				failures,
				retryAt: this.#now() + retryDelay(failures),
			});
			this.emit("log", `context usage for ${threadId.slice(0, 8)} failed (retry ${failures}): ${(error as Error).message}`);
		} finally {
			this.#busy = false;
		}
		if ([...this.#wanted.keys()].some((id) => !this.#fetched.has(id))) this.#schedule(CATCH_UP_MS);
	}

	#schedule(delay: number): void {
		if (!this.#interval || this.#soon) return;
		this.#soon = setTimeout(() => {
			this.#soon = undefined;
			void this.tick();
		}, delay);
	}

	async #fetch(threadId: string): Promise<ContextUsage | null> {
		const ws = await this.#rpc.open();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => finish(new Error("timed out")), TIMEOUT_MS);
			let done = false;
			function finish(error: Error | null, value: ContextUsage | null = null): void {
				if (done) return;
				done = true;
				clearTimeout(timer);
				closeQuietly(ws);
				if (error) reject(error);
				else resolve(value);
			}
			ws.onopen = () => {
				try {
					ws.send(request("1", "orchestration.subscribeThread", { threadId, acceptBoundedSnapshot: true, acceptCompactTurnItems: true, acceptDeferredWork: true }));
				} catch (error) {
					finish(error as Error);
				}
			};
			ws.onmessage = (event) => {
				try {
					const frame = handleFrame(ws, event.data);
					if (!frame) return;
					if (frame._tag === "Exit") return finish(new Error("thread stream ended"));
					if (frame._tag !== "Chunk") return;
					for (const value of Array.isArray(frame.values) ? frame.values : []) {
						if (!value || typeof value !== "object") continue;
						const v = value as { snapshot?: { projection?: Projection }; projection?: Projection };
						const projection = v.snapshot?.projection ?? v.projection;
						if (projection && typeof projection === "object") return finish(null, contextOf(projection));
					}
				} catch (error) {
					finish(error as Error);
				}
			};
			ws.onerror = () => finish(new Error("WebSocket error"));
			ws.onclose = (event) => finish(new Error(`socket closed (${event.code})`));
		});
	}
}

export function contextOf(projection: Projection): ContextUsage | null {
	const providers = Array.isArray(projection.providerThreads) ? projection.providerThreads : [];
	const active = projection.thread?.activeProviderThreadId;
	const thread = providers.find((p) => p?.id === active) ?? providers.at(-1);
	const used = thread?.contextUsage?.usedTokens;
	const max = thread?.contextUsage?.maxTokens;
	return typeof used === "number" && typeof max === "number" && Number.isFinite(used) && max > 0 ? { used, max } : null;
}
