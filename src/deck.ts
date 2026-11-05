/**
 * Owns every visible Deck for T3 Code key: packs threads onto Thread keys from
 * top-left to bottom-right with no gaps, runs the Thread Actions page, and
 * drives the animation clock. Images are only sent when a key's frame
 * actually changes, and on a clock tick only the keys whose frame is due
 * are rendered at all.
 */
import { execFile } from "node:child_process";

import streamDeck, { DeviceType, type KeyAction } from "@elgato/streamdeck";

import { byUrgency, deepLinkFor, layoutThreads, parseQuickMessages, type QuickMessage, type ThreadCard } from "./model.ts";
import {
	HOLD_ACTIONS,
	isBackgroundOnly,
	nextOverviewFrame,
	nextThreadFrame,
	overviewState,
	renderActionKey,
	renderBackKey,
	renderOverview,
	renderThreadKey,
	renderUsageKey,
	toDataUrl,
	type AnimationMode,
	type ThreadActionName,
} from "./render.ts";
import { tomorrowAt9, type ThreadCommands } from "./t3/commands.ts";
import { AppLocator } from "./t3/app.ts";
import type { T3Location } from "./t3/auth.ts";
import type { Monitor, Snapshot } from "./t3/monitor.ts";
import type { UsageMonitor } from "./t3/usage-monitor.ts";
import { metricsOf, pace, pickMetric } from "./usage.ts";

export { DEFAULT_MESSAGES } from "./model.ts";

/** Usage keys: which limit window and style. Thread Actions keys (bundled page): which action. */
export type KeySettings = { metric?: string; style?: "bar" | "ring"; action?: ThreadActionName; index?: number };

export type KeyKind = "thread" | "overview" | "usage" | "back" | "action";

/**
 * Bundled profiles (manifest `Profiles`), one per device type: page 0 is
 * T3 Threads, page 1 Thread Actions. One profile per device, so moving
 * between the two pages never replaces Stream Deck's "previous profile", and
 * the Threads page's Back still returns to yours.
 */
export const DECK_PROFILE: Partial<Record<DeviceType, string>> = {
	[DeviceType.StreamDeck]: "profiles/Deck for T3 Code",
	[DeviceType.StreamDeckMini]: "profiles/Deck for T3 Code Mini",
	[DeviceType.StreamDeckXL]: "profiles/Deck for T3 Code XL",
	[DeviceType.StreamDeckNeo]: "profiles/Deck for T3 Code Neo",
};
const THREADS_PAGE = 0;
const ACTIONS_PAGE = 1;

const APP_LOOKUP_MS = 500;

/** What the deck needs from Stream Deck and the OS; swapped out in tests. */
export interface DeckHost {
	switchToProfile(deviceId: string, profile?: string, page?: number): Promise<void>;
	/** Runs `open` with these arguments; rejects if it fails. */
	open(args: string[]): Promise<void>;
	/** `open` arguments that bring up the T3 Code app at this location (see `AppLocator.openArgs`). */
	appArgs(loc: T3Location): Promise<string[]>;
	warn(message: string): void;
	info?(message: string): void;
}

const appLocator = new AppLocator();

const defaultHost: DeckHost = {
	switchToProfile: (deviceId, profile, page) => streamDeck.profiles.switchToProfile(deviceId, profile, page),
	open: (args) => new Promise((resolve, reject) => execFile("/usr/bin/open", args, (error) => (error ? reject(error) : resolve()))),
	appArgs: (loc) => appLocator.openArgs(loc),
	warn: (message) => streamDeck.logger.warn(message),
	info: (message) => streamDeck.logger.info(message),
};

interface KeyEntry {
	id: string;
	kind: KeyKind;
	action: KeyAction<KeySettings>;
	settings: KeySettings;
	/** Image the key is known to show (setImage resolved). */
	lastImage?: string;
	/** Image on its way to the key. */
	sentImage?: string;
	imageSeq: number;
	/** When this key's frame next changes on its own; undefined when it is static. */
	nextFrameAt?: number;
	/** Set only by this key's own key-down; a key-up without it is ignored. */
	downAt?: number;
	/** Thread under the finger at key-down; tiles can slide while the key is held. */
	downThreadId?: string;
	/** This press can fire a hold action (overview, or an enabled hold-to-confirm action). */
	holdable?: boolean;
	/** Fires the hold action while the key is still down. */
	holdTimer?: NodeJS.Timeout;
	/** The hold action already ran; the key-up does nothing. */
	held?: boolean;
	/** Show "Hold to confirm / send" until then. */
	hintUntil?: number;
}

/** Hold a Thread tile this long, then release, to open its actions. */
export const LONG_PRESS_MS = 500;
/** Hold Stop / Settle / Compact / a message / the Overview this long to fire it. */
export const CONFIRM_HOLD_MS = 800;
/** The Overview shows "Hold to clear all" once held this long; letting go after that cancels. */
export const HOLD_CUE_MS = 250;
const HINT_MS = 3000;
/** Hold progress redraws this often. */
const PROGRESS_STEP_MS = 100;

export class Deck {
	readonly #monitor: Monitor;
	readonly #usage: UsageMonitor;
	readonly #commands: ThreadCommands;
	readonly #host: DeckHost;
	readonly #keys = new Map<string, KeyEntry>();
	/** Display order of threads; survives across polls so tiles only slide to close gaps. */
	#order: string[] = [];
	/** Thread key id → thread id it shows right now. */
	#shown = new Map<string, string>();
	/** Device id → threads that didn't fit on that device's Thread keys. */
	#overflow = new Map<string, string[]>();
	/** The first Thread key on each device: it explains a lost connection, the rest go blank. */
	#primary = new Set<string>();
	/** Device id → thread the Thread Actions page acts on. */
	#focus = new Map<string, string>();
	/** Commands in flight, per device + action, so a re-entered page can't send twice. */
	readonly #busy = new Set<string>();
	#messages: QuickMessage[] = parseQuickMessages(undefined);
	#animation: AnimationMode = "smooth";
	#showLabels = false;
	/** Thread actions (stop, snooze, settle, send) need an explicit opt-in in settings. */
	#actionsEnabled = false;
	#ticker: NodeJS.Timeout | undefined;
	#tickAt: number | undefined;

	constructor(monitor: Monitor, usage: UsageMonitor, commands: ThreadCommands, host: DeckHost = defaultHost) {
		this.#monitor = monitor;
		this.#usage = usage;
		this.#commands = commands;
		this.#host = host;
		monitor.on("change", () => this.#relayout());
		usage.on("change", () => this.#render());
	}

	set animation(mode: AnimationMode) {
		this.#animation = mode;
		this.#render();
	}

	set actionsEnabled(on: boolean) {
		this.#actionsEnabled = on;
		this.#render();
	}

	set showLabels(on: boolean) {
		this.#showLabels = on;
		this.#render();
	}

	/** Quick messages for the Thread Actions page, one per line in settings (`Label | text` allowed). */
	set messages(value: string | undefined) {
		this.#messages = parseQuickMessages(value);
		this.#render();
	}

	add(kind: KeyKind, action: KeyAction<KeySettings>, settings: KeySettings = {}): void {
		this.#keys.set(action.id, { id: action.id, kind, action, settings, imageSeq: 0 });
		this.#syncUsage();
		this.#relayout();
	}

	remove(id: string): void {
		const entry = this.#keys.get(id);
		clearTimeout(entry?.holdTimer);
		this.#keys.delete(id);
		this.#syncUsage();
		this.#relayout();
	}

	updateSettings(id: string, settings: KeySettings): void {
		const entry = this.#keys.get(id);
		if (!entry) return;
		entry.settings = settings;
		this.#render();
	}

	/** Limit windows T3 currently reports, for the Usage key picker. */
	usageMetrics(): { key: string; label: string; provider: string; used: number }[] {
		return metricsOf(this.#usage.snapshot.providers).map((m) => ({ key: m.key, label: m.label, provider: m.provider, used: Math.round(m.window.usedPercent) }));
	}

	#syncUsage(): void {
		this.#usage.setWanted([...this.#keys.values()].some((k) => k.kind === "usage"));
	}

	/** Thread shown on a key right now. */
	cardFor(id: string): ThreadCard | undefined {
		const threadId = this.#shown.get(id);
		return threadId ? this.#monitor.snapshot.cards.get(threadId) : undefined;
	}

	#focused(entry: KeyEntry): ThreadCard | undefined {
		const threadId = this.#focus.get(entry.action.device.id);
		return threadId ? this.#monitor.snapshot.cards.get(threadId) : undefined;
	}

	get #online(): boolean {
		return this.#monitor.snapshot.connection.kind === "ok";
	}

	keyDown(id: string): void {
		const entry = this.#keys.get(id);
		if (!entry) return;
		clearTimeout(entry.holdTimer);
		entry.holdTimer = undefined;
		entry.downAt = Date.now();
		entry.downThreadId = this.#shown.get(id);
		entry.held = false;
		entry.holdable = this.#canHold(entry);
		if (entry.holdable) {
			entry.hintUntil = undefined;
			entry.holdTimer = setTimeout(() => {
				entry.holdTimer = undefined;
				if (entry.downAt === undefined || !entry.holdable) return;
				entry.held = true;
				this.#render((e) => e === entry);
				void this.#onHold(entry).catch((error: unknown) => this.#fail(entry, error));
			}, CONFIRM_HOLD_MS);
		}
		// Thread tiles need no timer: their "release" cue is just a frame due at LONG_PRESS_MS.
		this.#render((e) => e === entry);
	}

	async keyUp(id: string): Promise<void> {
		const entry = this.#keys.get(id);
		// A key-up this key never saw go down (a page switched under the finger,
		// or the plugin restarted mid-press) must do nothing.
		if (!entry || entry.downAt === undefined) return;
		clearTimeout(entry.holdTimer);
		entry.holdTimer = undefined;
		const heldMs = Date.now() - entry.downAt;
		const { downThreadId, held, holdable } = entry;
		entry.downAt = undefined;
		entry.downThreadId = undefined;
		entry.held = false;
		entry.holdable = false;
		this.#render((e) => e === entry);
		if (held) return; // the hold action already ran
		try {
			if (entry.kind === "thread" && heldMs >= LONG_PRESS_MS) await this.#onLongPress(entry, downThreadId);
			else if (entry.kind === "overview" && holdable && heldMs >= HOLD_CUE_MS) return; // let go after "Hold to clear all" showed: cancelled
			else await this.#onTap(entry, downThreadId, holdable === true);
		} catch (error) {
			await this.#fail(entry, error);
		}
	}

	/** Whether holding this key (now) leads to a hold action. */
	#canHold(entry: KeyEntry): boolean {
		if (entry.kind === "overview") return this.#online;
		if (entry.kind !== "action") return false;
		const action = entry.settings.action;
		if (!action || !HOLD_ACTIONS.has(action) || !this.#actionsEnabled) return false;
		const card = this.#focused(entry);
		if (!card || !canOperate(card)) return false;
		if (action === "stop") return card.activeRunId !== undefined;
		if (action === "message") return this.#messageFor(entry) !== undefined;
		return true;
	}

	/** Fires at CONFIRM_HOLD_MS while the key is still down. */
	async #onHold(entry: KeyEntry): Promise<void> {
		if (entry.kind === "overview") {
			this.#monitor.ackAll();
			await entry.action.showOk();
			return;
		}
		const card = this.#focused(entry);
		if (!card || !this.#actionsEnabled || !canOperate(card)) return entry.action.showAlert();
		switch (entry.settings.action) {
			case "stop": {
				const runId = card.activeRunId;
				if (!runId) return; // finished meanwhile; the key already says "Nothing running"
				await this.#run(entry, () => this.#commands.stop(card.threadId, runId));
				return;
			}
			case "settle":
				if (await this.#run(entry, () => this.#commands.settle(card.threadId))) await this.#leaveActions(entry);
				return;
			case "compact":
				await this.#run(entry, () => this.#commands.send(card.threadId, "/compact"));
				return;
			case "message": {
				const message = this.#messageFor(entry);
				if (message) await this.#run(entry, () => this.#commands.send(card.threadId, message.text));
				return;
			}
		}
	}

	/** Released a Thread tile after LONG_PRESS_MS: its Thread Actions page. */
	async #onLongPress(entry: KeyEntry, threadId: string | undefined): Promise<void> {
		if (!this.#online) return this.#openT3(entry);
		const card = threadId ? this.#monitor.snapshot.cards.get(threadId) : undefined;
		if (!card) return;
		const profile = DECK_PROFILE[entry.action.device.type];
		if (!profile) {
			// No bundled page for this deck: a long press just dismisses the highlight.
			this.#monitor.ack(card.threadId);
			await entry.action.showOk();
			return;
		}
		this.#focus.set(entry.action.device.id, card.threadId);
		this.#syncDeckThreads();
		await this.#host.switchToProfile(entry.action.device.id, profile, ACTIONS_PAGE);
	}

	async #onTap(entry: KeyEntry, downThreadId: string | undefined, holdable: boolean): Promise<void> {
		switch (entry.kind) {
			case "back":
				// No profile name: Stream Deck goes back to the previously active profile.
				return this.#host.switchToProfile(entry.action.device.id);
			case "usage":
				this.#usage.refresh();
				return entry.action.showOk();
			case "overview": {
				// A tap never dismisses anything; that takes a hold.
				if (!this.#online) return this.#openT3(entry);
				// Open the full page of thread tiles, like a folder. Devices without a
				// bundled page fall back to jumping to the most urgent thread.
				const profile = DECK_PROFILE[entry.action.device.type];
				if (profile) return this.#host.switchToProfile(entry.action.device.id, profile, THREADS_PAGE);
				const target = this.#mostUrgent();
				return target ? this.#open(entry, target) : this.#openT3(entry);
			}
			case "thread": {
				if (!this.#online) return this.#openT3(entry);
				const card = downThreadId ? this.#monitor.snapshot.cards.get(downThreadId) : undefined;
				return card ? this.#open(entry, card) : this.#openT3(entry); // opening clears its highlight
			}
			case "action":
				return this.#onActionTap(entry, holdable);
		}
	}

	async #onActionTap(entry: KeyEntry, holdable: boolean): Promise<void> {
		const action = entry.settings.action;
		if (action === "back") return this.#leaveActions(entry);
		if (!action || action === "blank" || (action === "message" && !this.#messageFor(entry))) return; // empty slot
		const card = this.#focused(entry);
		if (!card) return entry.action.showAlert();
		if (action === "header" || action === "open") return this.#open(entry, card);
		// Everything else changes the thread; the key already says "Enable in settings" (or "On another machine").
		if (!this.#actionsEnabled || !canOperate(card)) return entry.action.showAlert();
		if (HOLD_ACTIONS.has(action)) {
			if (!holdable) return; // e.g. Stop with nothing running
			// A tap only explains itself; holding confirms.
			entry.hintUntil = Date.now() + HINT_MS;
			this.#render((e) => e === entry);
			return;
		}
		const until = action === "snooze1h" ? new Date(Date.now() + 3600_000) : action === "snoozeTomorrow" ? tomorrowAt9() : undefined;
		if (until && (await this.#run(entry, () => this.#commands.snooze(card.threadId, until)))) await this.#leaveActions(entry);
	}

	#messageFor(entry: KeyEntry): QuickMessage | undefined {
		return entry.settings.index === undefined ? undefined : this.#messages[entry.settings.index];
	}

	/** Runs a thread command unless the same one is still in flight on this device. Returns whether it ran. */
	async #run(entry: KeyEntry, command: () => Promise<void>): Promise<boolean> {
		const key = `${entry.action.device.id}|${entry.settings.action}|${entry.settings.index ?? ""}`;
		if (this.#busy.has(key)) return false;
		this.#busy.add(key);
		try {
			await command();
			await entry.action.showOk();
			this.#monitor.refresh();
			return true;
		} finally {
			this.#busy.delete(key);
		}
	}

	/** Back to the T3 Threads page (also after snooze or settle, when the thread leaves the deck). */
	async #leaveActions(entry: KeyEntry): Promise<void> {
		this.#focus.delete(entry.action.device.id);
		this.#syncDeckThreads();
		const profile = DECK_PROFILE[entry.action.device.type];
		if (profile) await this.#host.switchToProfile(entry.action.device.id, profile, THREADS_PAGE);
	}

	async #fail(entry: KeyEntry, error: unknown): Promise<void> {
		const err = error as Error | undefined;
		// Actions switched off in settings isn't a failure worth a warning.
		if (err?.name !== "ActionsDisabledError") this.#host.warn(`${entry.kind}${entry.settings.action ? `:${entry.settings.action}` : ""} failed: ${err?.message ?? String(error)}`);
		await entry.action.showAlert();
	}

	#open(entry: KeyEntry, card: ThreadCard): void {
		this.#monitor.ack(card.threadId);
		const url = deepLinkFor(card.link, card.threadId);
		if (!url) return this.#openT3(entry) 
		
		let timer: NodeJS.Timeout | undefined;
		const app = Promise.race([
			this.#host.appArgs(this.#monitor.location).catch(() => []),
			new Promise<string[]>((resolve) => (timer = setTimeout(() => resolve ([]), APP_LOOKUP_MS))),
		]).finally(() => clearTimeout(timer));
		const args = app.then((found)=> (found[0] === "-b" ? [...found, url]: [url]))
		this.#launch(entry, args);
		
	}

	/** Brings up T3 Code itself (also what a tap does while T3 is offline). */
	#openT3(entry: KeyEntry): void {
		this.#launch(entry, this.#host.appArgs(this.#monitor.location));
	}

	#launch(entry: KeyEntry, pending: Promise<string[]>): void {
		let args: string[] = [];
		pending
			.then((resolved) => {
				args = resolved;
				this.#host.info?.(`open ${args.join(" ")}`)
				return this.#host.open(args);
			})
			.catch((error: unknown) => {
				this.#host.warn(`open ${args.join(" ")} failed: ${(error as Error)?.message ?? String(error)}`);
				return entry.action.showAlert();
			});
	}

	#mostUrgent(): ThreadCard | undefined {
		const cards = this.#monitor.snapshot.visible.filter((c) => c.state !== "idle").sort(byUrgency);
		return cards[0];
	}

	/** Thread keys per device, each in reading order (row, then column). */
	#threadKeysByDevice(): Map<string, KeyEntry[]> {
		const byDevice = new Map<string, KeyEntry[]>();
		for (const k of this.#keys.values()) {
			if (k.kind !== "thread" || k.action.isInMultiAction()) continue;
			const list = byDevice.get(k.action.device.id) ?? [];
			list.push(k);
			byDevice.set(k.action.device.id, list);
		}
		for (const list of byDevice.values()) {
			list.sort((a, b) => {
				const ca = a.action.coordinates ?? { row: 99, column: 99 };
				const cb = b.action.coordinates ?? { row: 99, column: 99 };
				return ca.row - cb.row || ca.column - cb.column;
			});
		}
		return byDevice;
	}

	/**
	 * Each device fills its own Thread keys from the first thread, so the
	 * T3 Threads page on one deck shows the whole list even while the other
	 * deck has Thread keys too. Display order is shared, so a thread sits in
	 * the same relative place everywhere.
	 */
	#relayout(): void {
		const previouslyShown = new Set(this.#shown.values());
		const visible = this.#monitor.snapshot.visible;
		this.#shown.clear();
		this.#overflow.clear();
		this.#primary.clear();
		let order = this.#order;
		for (const [deviceId, keys] of this.#threadKeysByDevice()) {
			const layout = layoutThreads(order, keys.length, visible, previouslyShown);
			order = layout.order;
			this.#overflow.set(deviceId, layout.overflow);
			if (keys[0]) this.#primary.add(keys[0].id);
			keys.forEach((k, i) => {
				const threadId = layout.shown[i];
				if (threadId) this.#shown.set(k.id, threadId);
			});
		}
		this.#order = layoutThreads(order, 0, visible).order;
		this.#syncDeckThreads();
		this.#render();
	}

	/**
	 * Threads whose context usage matters: those on Thread keys, plus the one
	 * each device's Thread Actions page acts on (its header shows the context
	 * bar), whether or not that page is the one on screen.
	 */
	#syncDeckThreads(): void {
		this.#monitor.setDeckThreads(new Set([...this.#shown.values(), ...this.#focus.values()]));
	}

	/** Renders every key, or only those `only` picks (clock ticks, a pressed key). */
	#render(only?: (entry: KeyEntry, now: number) => boolean): void {
		const now = Date.now();
		const snapshot = this.#monitor.snapshot;
		// Stale state must not keep flashing or spinning while T3 is unreachable.
		const animation: AnimationMode = this.#online ? this.#animation : "off";
		const attention = snapshot.visible.some((c) => c.state === "input" || c.state === "failed");
		for (const entry of this.#keys.values()) {
			if (only && !only(entry, now)) continue;
			const { markup, next } = this.#frame(entry, snapshot, animation, attention, now);
			entry.nextFrameAt = next;
			this.#paint(entry, markup);
		}
		this.#schedule();
	}

	#frame(entry: KeyEntry, snapshot: Snapshot, animation: AnimationMode, attention: boolean, now: number): { markup: string; next?: number } {
		const online = snapshot.connection.kind === "ok";
		const pressedFor = entry.downAt === undefined ? undefined : now - entry.downAt;
		switch (entry.kind) {
			case "back":
				return { markup: renderBackKey(attention, this.#overflow.get(entry.action.device.id)?.length ?? 0) };
			case "usage": {
				const usage = this.#usage.snapshot;
				const metric = pickMetric(metricsOf(usage.providers), entry.settings.metric);
				return {
					markup: renderUsageKey({
						metric,
						pace: metric ? pace(metric.window, now) : undefined,
						ok: usage.ok,
						loading: usage.fetchedAt === 0 && usage.ok === false && usage.detail === "Loading…",
						style: entry.settings.style === "ring" ? "ring" : "bar",
					}),
				};
			}
			case "overview": {
				const counts = countStates(snapshot);
				const holding = entry.holdable && !entry.held && pressedFor !== undefined;
				const cue = holding && pressedFor >= HOLD_CUE_MS;
				const markup = renderOverview({
					connection: snapshot.connection,
					counts,
					overflow: this.#overflowFor(entry.action.device.id),
					animation,
					now,
					hold: cue ? pressedFor / CONFIRM_HOLD_MS : undefined,
				});
				const next = holding ? (cue ? progressFrame(entry.downAt!, now) : entry.downAt! + HOLD_CUE_MS) : nextOverviewFrame(overviewState(counts), animation, now);
				return { markup, next };
			}
			case "action": {
				const action = entry.settings.action ?? "open";
				if (action === "back") return { markup: renderBackKey(attention) };
				const card = this.#focused(entry);
				const hint = (entry.hintUntil ?? 0) > now;
				const holding = entry.holdable && !entry.held && pressedFor !== undefined;
				const markup = renderActionKey({
					action,
					card,
					message: this.#messageFor(entry)?.label,
					hint,
					progress: holding ? pressedFor / CONFIRM_HOLD_MS : undefined,
					enabled: this.#actionsEnabled,
					projectName: card ? snapshot.projectNames.get(card.projectId) ?? "" : "",
					connection: snapshot.connection,
					animation,
					now,
				});
				const next = earliest(
					action === "header" && online ? nextThreadFrame(card, animation, now) : undefined,
					hint ? entry.hintUntil : undefined,
					holding ? progressFrame(entry.downAt!, now) : undefined,
				);
				return { markup, next };
			}
			case "thread": {
				const card = this.cardFor(entry.id);
				const armed = pressedFor !== undefined && pressedFor >= LONG_PRESS_MS;
				const markup = renderThreadKey({
					card,
					projectName: card ? snapshot.projectNames.get(card.projectId) ?? "" : "",
					connection: snapshot.connection,
					animation,
					showLabel: this.#showLabels,
					primary: this.#primary.has(entry.id),
					releaseCue: armed && online && card ? (DECK_PROFILE[entry.action.device.type] ? "open" : "clear") : undefined,
					now,
				});
				const next = earliest(
					online ? nextThreadFrame(card, animation, now) : undefined,
					pressedFor !== undefined && !armed && online && card ? entry.downAt! + LONG_PRESS_MS : undefined,
				);
				return { markup, next };
			}
		}
	}

	/** Sends a key's image if it changed. The image only counts as shown once Stream Deck accepts it. */
	#paint(entry: KeyEntry, markup: string): void {
		if (markup === entry.lastImage || markup === entry.sentImage) return;
		const seq = ++entry.imageSeq;
		entry.sentImage = markup;
		entry.action.setImage(toDataUrl(markup)).then(
			() => {
				if (seq !== entry.imageSeq) return; // a newer image is on its way
				entry.lastImage = markup;
				entry.sentImage = undefined;
			},
			(error: unknown) => {
				if (seq === entry.imageSeq) entry.sentImage = undefined;
				entry.lastImage = undefined; // unknown what the key shows: send again next render
				this.#host.warn(`setImage failed: ${String(error)}`);
			},
		);
	}

	/** Wakes up when the next key's frame is due, and renders only the keys that are due. */
	#schedule(): void {
		let next = Infinity;
		for (const e of this.#keys.values()) if (e.nextFrameAt !== undefined && e.nextFrameAt < next) next = e.nextFrameAt;
		if (next === this.#tickAt) return;
		clearTimeout(this.#ticker);
		this.#ticker = undefined;
		this.#tickAt = undefined;
		if (next === Infinity) return;
		this.#tickAt = next;
		this.#ticker = setTimeout(() => {
			this.#ticker = undefined;
			this.#tickAt = undefined;
			this.#render((e, now) => e.nextFrameAt !== undefined && e.nextFrameAt <= now + 4);
		}, Math.max(10, next - Date.now()));
	}

	/** Threads the Overview key's own deck can't show. With no Thread keys there, that's all of them. */
	#overflowFor(deviceId: string): number {
		return this.#overflow.get(deviceId)?.length ?? this.#monitor.snapshot.visible.length;
	}

	/** Stops the clock; for tests and shutdown. */
	dispose(): void {
		clearTimeout(this.#ticker);
		this.#ticker = undefined;
		this.#tickAt = undefined;
		for (const e of this.#keys.values()) clearTimeout(e.holdTimer);
	}
}

/**
 * Thread actions go through this machine's server (its /ws dispatchCommand), which
 * can't act on a linked machine's threads; those keys stay unavailable.
 */
export const canOperate = (card: ThreadCard): boolean => !card.environmentId;

/** Next hold-progress redraw, up to the moment the hold fires. */
function progressFrame(downAt: number, now: number): number | undefined {
	const elapsed = now - downAt;
	if (elapsed >= CONFIRM_HOLD_MS) return undefined; // the hold timer takes it from here
	return downAt + Math.min(CONFIRM_HOLD_MS, (Math.floor(elapsed / PROGRESS_STEP_MS) + 1) * PROGRESS_STEP_MS);
}

function earliest(...times: (number | undefined)[]): number | undefined {
	let best: number | undefined;
	for (const t of times) if (t !== undefined && (best === undefined || t < best)) best = t;
	return best;
}

/** Counts the threads that belong on the deck (settled and snoozed ones excluded). */
function countStates(snapshot: Snapshot) {
	const counts = { input: 0, failed: 0, done: 0, working: 0, background: 0, idle: 0 };
	for (const card of snapshot.visible) {
		counts[card.state === "paused" ? "idle" : card.state]++;
		if (isBackgroundOnly(card)) counts.background++;
	}
	return counts;
}
