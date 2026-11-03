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
 */
import { EventEmitter } from "node:events";

import type { UsageProvider, UsageWindow } from "../usage.ts";
import { closeQuietly, handleFrame, request, type RpcAccess } from "./rpc.ts";

export const REFRESH_MS = 5 * 60_000;
/** Longest wait while T3 keeps reporting the same `checkedAt`. */
export const REFRESH_MAX_MS = 20 * 60_000;
const RETRY_MS = 30_000;
const RPC_TIMEOUT_MS = 15_000;

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
	providers: UsageProvider[];
	fetchedAt: number;
}

interface RawProvider {
	instanceId?: string;
	id?: string;
	driver?: string;
	displayName?: string;
	enabled?: boolean;
	usageLimits?: { checkedAt?: string; windows?: UsageWindow[]; unavailable?: unknown };
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

	snapshot: UsageSnapshot = { ok: false, detail: "Loading…", providers: [], fetchedAt: 0 };

	constructor(rpc: RpcAccess) {
		super();
		this.#rpc = rpc;
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
			const providers = await this.#fetch();
			this.snapshot = { ok: true, providers, fetchedAt: Date.now() };
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

	async #fetch(): Promise<UsageProvider[]> {
		const ws = await this.#rpc.open();
		return parseProviders(await rpcOnce(ws, "server.getConfig", {}));
	}
}

/** One RPC request on a fresh socket; resolves with the Exit value. */
function rpcOnce(ws: WebSocket, tag: string, payload: unknown): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error(`${tag} timed out`)), RPC_TIMEOUT_MS);
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

export function parseProviders(config: unknown): UsageProvider[] {
	const raw = (config as { providers?: unknown } | null)?.providers;
	const providers = (Array.isArray(raw) ? raw : []).filter((p): p is RawProvider => !!p && typeof p === "object");
	const out: UsageProvider[] = [];
	for (const p of providers) {
		const windows = (Array.isArray(p.usageLimits?.windows) ? p.usageLimits.windows : []).filter(
			(w): w is UsageWindow => !!w && typeof w.id === "string" && typeof w.usedPercent === "number",
		);
		if (windows.length === 0) continue;
		const instanceId = p.instanceId ?? p.id ?? p.driver ?? "provider";
		out.push({
			instanceId,
			displayName: p.displayName ?? DISPLAY[p.driver ?? instanceId] ?? instanceId,
			checkedAt: p.usageLimits?.checkedAt,
			windows: windows.map((w) => ({ ...w, label: w.label || w.id })),
		});
	}
	return out;
}

const DISPLAY: Record<string, string> = { claudeAgent: "Claude", codex: "Codex", cursor: "Cursor", opencode: "OpenCode" };
