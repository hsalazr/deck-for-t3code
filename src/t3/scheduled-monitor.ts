/**
 * Live view of T3 Code's scheduled tasks, for Scheduled keys.
 *
 * Subscribes to `scheduledTasks.subscribe`, the stream behind T3's
 * Settings → Scheduled tasks list (read scope, so the plugin's read-only
 * "rpc" credential is enough). T3 sends the whole list at once, and again
 * whenever any task changes, so there is no polling. The socket is open only
 * while a Scheduled key is on a deck, and while it is down nothing it
 * reported is kept: a key never shows a stale countdown.
 *
 * "Run now" is a separate call (`scheduledTasks.runNow`); it needs the
 * orchestration:operate scope, so it goes through the actions credential.
 */
import { EventEmitter } from "node:events";

import { LOADING, parseTaskList, type ScheduledSnapshot } from "../scheduled.ts";
import { closeQuietly, handleFrame, request, type RpcAccess } from "./rpc.ts";
import { rpcOnce } from "./usage-monitor.ts";

const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
/** A socket that opened but sent no list by then is given up on. */
const FIRST_CHUNK_TIMEOUT_MS = 20_000;
/** T3 answers once the run has been handed to its thread, which can take a moment. */
const RUN_NOW_TIMEOUT_MS = 30_000;

export class ScheduledMonitor extends EventEmitter<{ change: [ScheduledSnapshot]; log: [string] }> {
	readonly #rpc: RpcAccess;
	#ws: WebSocket | undefined;
	#running = false;
	/** Only connect while a Scheduled key is on a deck. */
	#wanted = false;
	/** A connect attempt is waiting on `RpcAccess.open()`. */
	#opening = false;
	/** Bumped by every connect, restart and stop; stale sockets and attempts check it and bow out. */
	#generation = 0;
	#retryMs = RECONNECT_MIN_MS;
	#timer: NodeJS.Timeout | undefined;

	snapshot: ScheduledSnapshot = LOADING;

	constructor(rpc: RpcAccess) {
		super();
		this.#rpc = rpc;
	}

	setWanted(wanted: boolean): void {
		if (wanted === this.#wanted) return;
		this.#wanted = wanted;
		this.#sync();
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#sync();
	}

	stop(): void {
		this.#running = false;
		this.#sync();
	}

	/** Reconnect now (the T3 location changed, or the plugin signed in again). */
	restart(): void {
		if (!this.#running || !this.#wanted) return;
		this.#teardown();
		this.#retryMs = RECONNECT_MIN_MS;
		void this.#connect();
	}

	/** T3 is reachable again: if the stream is down and waiting to retry, retry now with a fresh backoff. */
	kick(): void {
		if (!this.#running || !this.#wanted || this.#ws || this.#opening) return;
		this.#retryMs = RECONNECT_MIN_MS;
		void this.#connect();
	}

	#sync(): void {
		if (this.#running && this.#wanted) {
			if (!this.#ws && !this.#opening && !this.#timer) void this.#connect();
			return;
		}
		this.#teardown();
		this.#set(LOADING);
	}

	/** Closes the socket and cancels a pending retry or attempt. */
	#teardown(): void {
		this.#generation++;
		this.#opening = false;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		const ws = this.#ws;
		this.#ws = undefined;
		closeQuietly(ws);
	}

	#set(next: ScheduledSnapshot): void {
		if (next.state === this.snapshot.state && next.tasks.length === 0 && this.snapshot.tasks.length === 0) return;
		this.snapshot = next;
		this.emit("change", next);
	}

	async #connect(): Promise<void> {
		if (!this.#running || !this.#wanted) return;
		const generation = ++this.#generation;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		let ws: WebSocket;
		this.#opening = true;
		try {
			ws = await this.#rpc.open();
		} catch (error) {
			if (generation !== this.#generation) return;
			this.emit("log", `scheduled tasks stream: ${(error as Error).message}`);
			this.#down();
			return;
		} finally {
			if (generation === this.#generation) this.#opening = false;
		}
		if (generation !== this.#generation || !this.#running || !this.#wanted) {
			closeQuietly(ws);
			return;
		}
		this.#ws = ws;
		const firstChunk = setTimeout(() => {
			if (this.#ws !== ws) return;
			this.emit("log", "scheduled tasks stream: no list after 20 s, reconnecting");
			closeQuietly(ws);
		}, FIRST_CHUNK_TIMEOUT_MS);
		ws.onopen = () => {
			try {
				ws.send(request("1", "scheduledTasks.subscribe", {}));
			} catch (error) {
				this.emit("log", `scheduled tasks stream: subscribe failed: ${(error as Error).message}`);
				closeQuietly(ws);
			}
		};
		ws.onmessage = (event) => {
			if (this.#ws !== ws) return;
			try {
				const frame = handleFrame(ws, event.data);
				if (!frame) return;
				if (frame._tag === "Chunk" && frame.requestId === "1") {
					// Each item is the whole list; the last good one is the truth.
					let tasks = null;
					for (const item of Array.isArray(frame.values) ? frame.values : []) tasks = parseTaskList(item) ?? tasks;
					if (!tasks) {
						this.emit("log", "scheduled tasks stream: skipped an item that wasn't a task list");
						return;
					}
					clearTimeout(firstChunk);
					this.#retryMs = RECONNECT_MIN_MS;
					this.snapshot = { state: "live", tasks };
					this.emit("change", this.snapshot);
				} else if (frame._tag === "Exit" && frame.requestId === "1") {
					this.emit("log", `scheduled tasks stream ended: ${JSON.stringify(frame.exit ?? null).slice(0, 200)}`);
					closeQuietly(ws);
				}
			} catch (error) {
				this.emit("log", `scheduled tasks stream: bad frame ignored: ${(error as Error).message}`);
			}
		};
		ws.onerror = () => undefined; // onclose follows
		ws.onclose = () => {
			clearTimeout(firstChunk);
			if (this.#ws !== ws) return; // replaced by restart() or stop()
			this.#ws = undefined;
			this.#down();
		};
	}

	/** The stream is gone: forget the tasks and retry with backoff. */
	#down(): void {
		this.#set({ state: "down", tasks: [] });
		if (!this.#running || !this.#wanted) return;
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#connect();
		}, this.#retryMs);
		this.#retryMs = Math.min(RECONNECT_MAX_MS, this.#retryMs * 2);
	}
}

/**
 * Runs a task now, the way T3's own "Run now" does. Needs an "operate"
 * RpcAccess (it refuses before any socket or token while actions are off).
 * T3 refuses webhook tasks; the caller checks first.
 */
export async function runScheduledTaskNow(access: RpcAccess, id: string): Promise<void> {
	await rpcOnce(await access.open(), "scheduledTasks.runNow", { id }, RUN_NOW_TIMEOUT_MS);
}
