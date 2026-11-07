/**
 * Polls this Mac's T3 Code server for updates (see ../updates.ts for where
 * each fact comes from). Only while an Updates key is on a deck: every 30
 * minutes, a minute after a failure, and at once on a key press. Uses the
 * same read-only token as usage limits.
 */
import { EventEmitter } from "node:events";

import { channelOf, providerUpdates, serverVersionOf, t3Update, type UpdatesSnapshot } from "../updates.ts";
import type { RpcAccess } from "./rpc.ts";
import { rpcOnce } from "./usage-monitor.ts";

export const UPDATES_REFRESH_MS = 30 * 60_000;
const RETRY_MS = 60_000;

/** The two RPCs, behind an interface so tests can fake them. */
export interface UpdatesSource {
	getConfig(): Promise<unknown>;
	getNpmRelease(spec: string): Promise<unknown>;
}

export const rpcUpdatesSource = (rpc: RpcAccess): UpdatesSource => ({
	getConfig: async () => rpcOnce(await rpc.open(), "server.getConfig", {}),
	getNpmRelease: async (spec) => rpcOnce(await rpc.open(), "server.getNpmRelease", { spec }),
});

export class UpdatesMonitor extends EventEmitter<{ change: [UpdatesSnapshot]; log: [string] }> {
	readonly #source: UpdatesSource;
	#timer: NodeJS.Timeout | undefined;
	#running = false;
	#busy = false;
	#wanted = false;

	snapshot: UpdatesSnapshot = { ok: false, detail: "Loading…", providers: [], fetchedAt: 0 };

	constructor(source: UpdatesSource) {
		super();
		this.#source = source;
	}

	setWanted(wanted: boolean): void {
		if (wanted === this.#wanted) return;
		this.#wanted = wanted;
		if (wanted) this.refresh();
		else clearTimeout(this.#timer);
	}

	start(): void {
		this.#running = true;
		if (this.#wanted) this.refresh();
	}

	stop(): void {
		this.#running = false;
		clearTimeout(this.#timer);
	}

	refresh(): void {
		if (!this.#running || !this.#wanted) return;
		clearTimeout(this.#timer);
		void this.#tick();
	}

	async #tick(): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		let delay = UPDATES_REFRESH_MS;
		try {
			const config = await this.#source.getConfig();
			const current = serverVersionOf(config);
			let latest: string | null = null;
			try {
				const release = (await this.#source.getNpmRelease(channelOf(current))) as { version?: unknown } | null;
				latest = typeof release?.version === "string" ? release.version : null;
			} catch (error) {
				// The provider checks still count; only T3 Code's own line goes unknown.
				this.emit("log", `T3 Code release lookup failed: ${(error as Error).message}`);
			}
			this.snapshot = { ok: true, fetchedAt: Date.now(), t3: t3Update(current, latest), providers: providerUpdates(config) };
		} catch (error) {
			delay = RETRY_MS;
			this.snapshot = { ...this.snapshot, ok: false, detail: (error as Error).message };
			this.emit("log", `updates refresh failed: ${(error as Error).message}`);
		} finally {
			this.#busy = false;
			this.emit("change", this.snapshot);
			if (this.#running && this.#wanted) this.#timer = setTimeout(() => void this.#tick(), delay);
		}
	}
}
