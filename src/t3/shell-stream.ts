/**
 * Live view of what each T3 thread is waiting on in the background.
 *
 * Subscribes to `orchestration.subscribeShell`, the stream behind T3's
 * sidebar. Each thread shell carries `pendingBackgroundTasks`, T3's own
 * list of work a thread is waiting on after its turn ended: subagents,
 * background commands, monitors and pull-request watches. The socket stays
 * open; T3 pushes `thread.updated` events as they happen.
 *
 * While the socket is down everything it reported is dropped, so stale
 * background work, running turns or limit pauses never show.
 */
import { EventEmitter } from "node:events";

import { closeQuietly, handleFrame, request, type RpcAccess } from "./rpc.ts";

export interface PendingTask {
	taskId: string;
	/** "subagent" | "command" | "monitor" | "background_task" */
	kind: string;
	description?: string;
	childThreadId?: string;
}

interface PullRequestLink {
	host: string;
	repository: string;
	number: number;
	watch?: { passed?: boolean; failedChecks?: string[] };
}

/** The fields the plugin reads from a T3 shell thread. Everything is checked; frames may be missing any of it. */
export interface ShellThread {
	id: string;
	lineage?: { parentThreadId?: string | null; rootThreadId?: string | null };
	pendingBackgroundTasks?: PendingTask[];
	pullRequests?: PullRequestLink[];
	lastVisitedAt?: string | null;
	latestRunId?: string | null;
	latestRunCompletedAt?: string | null;
	activeRunId?: string | null;
	usageLimitResetAt?: string | null;
	limitRecovery?: { resetAt?: string } | null;
	/** A question, approval, secret or link request waiting on you. */
	pendingRuntimeRequest?: { kind?: string; blocking?: boolean } | null;
	updatedAt?: string;
}

/** Per-thread facts from the shell that the MCP thread list doesn't carry. */
export interface ShellExtras {
	/** When you last opened the thread in T3. */
	lastVisitedAt: number | null;
	/** The run `latestRunCompletedAt` belongs to. */
	latestRunId: string | null;
	latestRunCompletedAt: number | null;
	activeRunId: string | null;
	/** A usage limit paused the thread until then. */
	limitResetAt: number | null;
	/** Something is waiting on you: a question, approval, secret or link request. */
	pendingInput: boolean;
	updatedAt: number;
}

/** What the monitor reads from the shell stream. */
export interface ShellView {
	readonly connected: boolean;
	extras(threadId: string): ShellExtras | undefined;
	pendingByRoot(): Map<string, PendingTask[]>;
	rootOf(threadId: string): string | undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** The shell's picture of every thread, fed one stream item at a time. No I/O; tolerant of malformed items. */
export class ShellState {
	/** threadId → pending background tasks (only threads with any). */
	#pending = new Map<string, PendingTask[]>();
	/** threadId → root thread id, from the shell lineage. */
	#roots = new Map<string, string>();
	#extras = new Map<string, ShellExtras>();

	get size(): number {
		return this.#extras.size;
	}

	clear(): void {
		this.#pending.clear();
		this.#roots.clear();
		this.#extras.clear();
	}

	extras(threadId: string): ShellExtras | undefined {
		return this.#extras.get(threadId);
	}

	rootOf(threadId: string): string | undefined {
		return this.#roots.get(threadId);
	}

	/** Pending background tasks per root thread, with subagents' own tasks folded in. */
	pendingByRoot(): Map<string, PendingTask[]> {
		const byRoot = new Map<string, PendingTask[]>();
		for (const [threadId, tasks] of this.#pending) {
			const root = this.#roots.get(threadId) ?? threadId;
			byRoot.set(root, [...(byRoot.get(root) ?? []), ...tasks]);
		}
		return byRoot;
	}

	/** One `subscribeShell` item: a snapshot page, `thread.updated` or `thread.removed`. Anything else is ignored. */
	apply(item: unknown): void {
		if (!isObject(item)) return;
		if (item.kind === "snapshot") {
			// Snapshots can arrive in pages; each page adds threads.
			const snapshot = item.snapshot;
			const threads = isObject(snapshot) && Array.isArray(snapshot.threads) ? snapshot.threads : [];
			for (const thread of threads) this.#put(thread);
		} else if (item.kind === "thread.updated") {
			if (!isObject(item.thread)) return;
			if (item.location === "archive") {
				const id = str(item.thread.id);
				if (id) this.#drop(id);
			} else this.#put(item.thread);
		} else if (item.kind === "thread.removed") {
			const id = str(item.threadId);
			if (id) this.#drop(id);
		}
	}

	#put(raw: unknown): void {
		if (!isObject(raw)) return;
		const id = str(raw.id);
		if (!id) return;
		const thread = raw as unknown as ShellThread;
		const lineage = isObject(raw.lineage) ? raw.lineage : undefined;
		const root = str(lineage?.rootThreadId);
		if (root && root !== id) this.#roots.set(id, root);
		else this.#roots.delete(id);
		const limitRecovery = isObject(raw.limitRecovery) ? raw.limitRecovery : undefined;
		this.#extras.set(id, {
			lastVisitedAt: ms(raw.lastVisitedAt),
			latestRunId: str(raw.latestRunId),
			latestRunCompletedAt: ms(raw.latestRunCompletedAt),
			activeRunId: str(raw.activeRunId),
			limitResetAt: ms(raw.usageLimitResetAt) ?? ms(limitRecovery?.resetAt),
			// While a question is open T3 keeps the run "running"; the request itself
			// lives here. Non-blocking ones (the agent keeps working) still wait on you.
			pendingInput: isObject(raw.pendingRuntimeRequest),
			updatedAt: ms(raw.updatedAt) ?? 0,
		});
		const tasks = runningTasks(thread);
		if (tasks.length > 0) this.#pending.set(id, tasks);
		else this.#pending.delete(id);
	}

	#drop(threadId: string): void {
		this.#pending.delete(threadId);
		this.#extras.delete(threadId);
		this.#roots.delete(threadId);
	}
}

const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
/** A socket that opened but sent no snapshot by then is given up on. */
const FIRST_CHUNK_TIMEOUT_MS = 20_000;

export class ShellStream extends EventEmitter<{ change: []; log: [string] }> implements ShellView {
	readonly #rpc: RpcAccess;
	readonly #state = new ShellState();
	#ws: WebSocket | undefined;
	#running = false;
	/** A connect attempt is waiting on `RpcAccess.open()`. */
	#opening = false;
	/** Bumped by every connect, restart and stop; stale sockets and attempts check it and bow out. */
	#generation = 0;
	#retryMs = RECONNECT_MIN_MS;
	#timer: NodeJS.Timeout | undefined;
	#connected = false;

	constructor(rpc: RpcAccess) {
		super();
		this.#rpc = rpc;
	}

	/** A snapshot arrived on the current socket and it is still open. */
	get connected(): boolean {
		return this.#connected;
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;
		void this.#connect();
	}

	stop(): void {
		this.#running = false;
		this.#generation++;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		const ws = this.#ws;
		this.#ws = undefined;
		closeQuietly(ws);
		this.#disconnected();
	}

	/** Reconnect now (e.g. after the T3 location changed): drops the socket, cancels any pending retry. */
	restart(): void {
		if (!this.#running) return;
		const ws = this.#ws;
		this.#ws = undefined;
		closeQuietly(ws);
		this.#disconnected();
		this.#retryMs = RECONNECT_MIN_MS;
		void this.#connect();
	}

	/** T3 is reachable again: if the stream is down and waiting to retry, retry now with a fresh backoff. */
	kick(): void {
		if (!this.#running || this.#connected || this.#ws || this.#opening) return;
		this.#retryMs = RECONNECT_MIN_MS;
		void this.#connect();
	}

	extras(threadId: string): ShellExtras | undefined {
		return this.#connected ? this.#state.extras(threadId) : undefined;
	}

	rootOf(threadId: string): string | undefined {
		return this.#connected ? this.#state.rootOf(threadId) : undefined;
	}

	/** Pending background tasks per root thread, with subagents' own tasks folded in. Empty while disconnected. */
	pendingByRoot(): Map<string, PendingTask[]> {
		return this.#connected ? this.#state.pendingByRoot() : new Map();
	}

	async #connect(): Promise<void> {
		if (!this.#running) return;
		const generation = ++this.#generation;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		let ws: WebSocket;
		this.#opening = true;
		try {
			ws = await this.#rpc.open();
		} catch (error) {
			if (generation !== this.#generation) return;
			this.emit("log", `shell stream: ${(error as Error).message}`);
			this.#scheduleReconnect();
			return;
		} finally {
			if (generation === this.#generation) this.#opening = false;
		}
		if (generation !== this.#generation || !this.#running) {
			closeQuietly(ws);
			return;
		}
		this.#ws = ws;
		let fresh = true;
		const firstChunk = setTimeout(() => {
			if (this.#ws !== ws) return;
			this.emit("log", "shell stream: no snapshot after 20 s, reconnecting");
			closeQuietly(ws);
		}, FIRST_CHUNK_TIMEOUT_MS);
		ws.onopen = () => {
			try {
				ws.send(request("1", "orchestration.subscribeShell", { omitIdleSubagents: true }));
			} catch (error) {
				this.emit("log", `shell stream: subscribe failed: ${(error as Error).message}`);
				closeQuietly(ws);
			}
		};
		ws.onmessage = (event) => {
			if (this.#ws !== ws) return;
			try {
				const frame = handleFrame(ws, event.data);
				if (!frame) return;
				if (frame._tag === "Chunk" && frame.requestId === "1") {
					if (fresh) {
						// New connection: its snapshot replaces whatever we had.
						this.#state.clear();
						fresh = false;
						clearTimeout(firstChunk);
					}
					for (const item of Array.isArray(frame.values) ? frame.values : []) {
						try {
							this.#state.apply(item);
						} catch (error) {
							this.emit("log", `shell stream: skipped a bad item: ${(error as Error).message}`);
						}
					}
					this.#connected = true;
					this.#retryMs = RECONNECT_MIN_MS;
					this.emit("change");
				} else if (frame._tag === "Exit" && frame.requestId === "1") {
					this.emit("log", `shell stream ended: ${JSON.stringify(frame.exit ?? null).slice(0, 200)}`);
					closeQuietly(ws);
				}
			} catch (error) {
				this.emit("log", `shell stream: bad frame ignored: ${(error as Error).message}`);
			}
		};
		ws.onerror = () => undefined; // onclose follows
		ws.onclose = () => {
			clearTimeout(firstChunk);
			if (this.#ws !== ws) return; // replaced by restart() or stop()
			this.#ws = undefined;
			this.#disconnected();
			this.#scheduleReconnect();
		};
	}

	#disconnected(): void {
		const had = this.#connected || this.#state.size > 0;
		this.#connected = false;
		this.#state.clear();
		if (had) this.emit("change");
	}

	#scheduleReconnect(): void {
		if (!this.#running) return;
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => void this.#connect(), this.#retryMs);
		this.#retryMs = Math.min(RECONNECT_MAX_MS, this.#retryMs * 2);
	}
}

/**
 * Only background work that is actually running. Subagents, background
 * commands and monitors always are. A pull-request watch only counts while
 * its CI checks are still going: not once they passed (then it waits on
 * review or merge) or failed (then it waits on a new push).
 */
export function runningTasks(thread: ShellThread): PendingTask[] {
	const tasks = Array.isArray(thread.pendingBackgroundTasks) ? (thread.pendingBackgroundTasks as unknown[]) : [];
	const links = Array.isArray(thread.pullRequests) ? (thread.pullRequests as unknown[]).filter(isObject) : [];
	const out: PendingTask[] = [];
	for (const raw of tasks) {
		if (!isObject(raw)) continue;
		const taskId = str(raw.taskId);
		if (!taskId) continue;
		const task: PendingTask = { taskId, kind: str(raw.kind) ?? "background_task" };
		const description = str(raw.description);
		if (description) task.description = description;
		const child = str(raw.childThreadId);
		if (child) task.childThreadId = child;
		if (taskId.startsWith(PR_WATCH_PREFIX)) {
			const key = taskId.slice(PR_WATCH_PREFIX.length);
			const link = links.find((pr) => typeof pr.host === "string" && typeof pr.repository === "string" && `${pr.host.toLowerCase()}/${pr.repository.toLowerCase()}#${String(pr.number)}` === key);
			const watch = isObject(link?.watch) ? link.watch : undefined;
			if (!watch) continue;
			if (watch.passed === true || (Array.isArray(watch.failedChecks) && watch.failedChecks.length > 0)) continue;
		}
		out.push(task);
	}
	return out;
}

const PR_WATCH_PREFIX = "pull-request-watch:";

const ms = (iso: unknown): number | null => {
	if (typeof iso !== "string" || !iso) return null;
	const t = Date.parse(iso);
	return Number.isFinite(t) ? t : null;
};

/** Short "what it's waiting on" label: "PR #42 CI", "2 agents", a command's name, "3 tasks". */
export function waitingLabel(tasks: readonly PendingTask[]): string | undefined {
	if (tasks.length === 0) return undefined;
	if (tasks.every((t) => t.kind === "subagent")) return tasks.length === 1 ? "1 agent" : `${tasks.length} agents`;
	if (tasks.length > 1) return `${tasks.length} tasks`;
	const task = tasks[0];
	const pr = /^pull-request-watch:.*#(\d+)$/.exec(task.taskId);
	if (pr) return `PR #${pr[1]} CI`;
	const description = task.description?.trim().replace(/^Watching /i, "");
	return description || (task.kind === "monitor" ? "monitor" : "command");
}
