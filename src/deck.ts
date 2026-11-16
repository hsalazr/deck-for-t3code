/**
 * Owns every visible Deck for T3 Code key: packs threads onto Thread keys from
 * top-left to bottom-right with no gaps, runs the Thread Actions page, and
 * drives the animation clock. Images are only sent when a key's frame
 * actually changes, and on a clock tick only the keys whose frame is due
 * are rendered at all.
 */
import { execFile } from "node:child_process";

import streamDeck, { DeviceType, type KeyAction } from "@elgato/streamdeck";

import { byUrgency, deepLinkFor, layoutThreads, parseQuickMessages, safeWebUrl, type QuickMessage, type ThreadCard } from "./model.ts";
import {
	HOLD_ACTIONS,
	isBackgroundOnly,
	nextOverviewFrame,
	nextScheduledFrame,
	nextThreadFrame,
	overviewState,
	renderActionKey,
	renderBackKey,
	renderDictateKey,
	renderMachineKey,
	renderOverview,
	renderScheduledKey,
	renderThreadKey,
	renderUpdatesKey,
	renderUsageKey,
	toDataUrl,
	type AnimationMode,
	type KeyStyle,
	type ScheduledCue,
	type ThreadActionName,
} from "./render.ts";
import { tomorrowAt9, type ThreadCommands } from "./t3/commands.ts";
import { AppLocator, validBundleId } from "./t3/app.ts";
import { DictatePresses, DictateRefusal, type DictatePhase, type DictateTarget, type DictateThread, type DictationPort } from "./dictate.ts";
import type { T3Location } from "./t3/auth.ts";
import type { Monitor, Snapshot } from "./t3/monitor.ts";
import type { UsageMonitor } from "./t3/usage-monitor.ts";
import type { UpdatesMonitor } from "./t3/updates-monitor.ts";
import type { ScheduledMonitor } from "./t3/scheduled-monitor.ts";
import { canRunNow, LOADING, pickTask, scheduleText, type ScheduledTask } from "./scheduled.ts";
import { MachineMonitor, machineStatOf, normalizeDiskPath, type MachineStat } from "./machine.ts";
import { defaultMetric, emptyState, hubDescription, metricsOf, pace, pickMetric } from "./usage.ts";
import { pendingUpdates } from "./updates.ts";

export { DEFAULT_MESSAGES } from "./model.ts";

/**
 * Overview keys: what a tap does. "threads" (default) opens the T3 Threads
 * page. "urgent" opens the most urgent thread, and a hold opens the page.
 */
export type OverviewTap = "threads" | "urgent";

/**
 * Usage keys: which limit window and style. Machine keys: which stat and which disk.
 * Thread Actions keys (bundled page): which action. Overview keys: what a tap does.
 */
export type KeySettings = {
	metric?: string;
	style?: "bar" | "ring" | KeyStyle;
	stat?: MachineStat | "load";
	path?: string;
	action?: ThreadActionName;
	index?: number;
	tap?: OverviewTap;
	/** Scheduled keys: the task id; unset = whichever runs next. */
	task?: string;
	/** Dictate keys: the thread open in T3 Code (default), or the most urgent one first. */
	dictateThread?: DictateThread;
};

export type KeyKind = "thread" | "overview" | "usage" | "machine" | "updates" | "scheduled" | "back" | "action" | "dictate";

const machineStat = (s: KeySettings): MachineStat => machineStatOf(s.stat);
/** Machine and Updates keys: the big, glanceable look, or the detailed one (default). */
const keyStyle = (s: KeySettings): KeyStyle => (s.style === "glance" ? "glance" : "detailed");

const ACTIVITY_MONITOR = ["-b", "com.apple.ActivityMonitor"];

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
	/** Scheduled keys: the task shown at key-down. "Whichever runs next" can change task while the key is held. */
	downTaskId?: string;
	/** This press can fire a hold action (overview, or an enabled hold-to-confirm action). */
	holdable?: boolean;
	/** Fires the hold action while the key is still down. */
	holdTimer?: NodeJS.Timeout;
	/** The hold action already ran; the key-up does nothing. */
	held?: boolean;
	/** Show "Hold to confirm / send" until then. */
	hintUntil?: number;
	/** Dictate keys: their presses, in order. */
	presses?: DictatePresses;
	/** Dictate keys: say "Allow Stream Deck in Accessibility" until then. */
	allowUntil?: number;
}

/**
 * Hold a Thread tile this long, then release, to open its actions. An Overview
 * key whose tap opens the most urgent thread opens the T3 Threads page the same way.
 */
export const LONG_PRESS_MS = 500;
/** Hold Stop / Settle / Compact / a message / the Overview (to clear all) this long to fire it. */
export const CONFIRM_HOLD_MS = 800;
/** The Overview shows "Hold to clear all" once held this long; letting go after that cancels. */
export const HOLD_CUE_MS = 250;
const HINT_MS = 3000;
/** How long a Dictate key asks for the Accessibility permission after posting was refused. */
export const ALLOW_HINT_MS = 5000;
/** Hold progress redraws this often. */
const PROGRESS_STEP_MS = 100;

export class Deck {
	readonly #monitor: Monitor;
	readonly #usage: UsageMonitor;
	readonly #commands: ThreadCommands;
	readonly #machine: MachineMonitor;
	readonly #updates: UpdatesMonitor | undefined;
	readonly #scheduled: ScheduledMonitor | undefined;
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
	/** Thread and Overview keys: detailed (default) or glance. */
	#threadStyle: KeyStyle = "detailed";
	/** Thread actions (stop, snooze, settle, send) need an explicit opt-in in settings. */
	#actionsEnabled = false;
	#ticker: NodeJS.Timeout | undefined;
	#tickAt: number | undefined;
	/** Dictate keys press T3 Code's dictation shortcut; off by default, like thread actions. */
	#dictation: DictationPort | undefined;
	#dictationEnabled = false;

	constructor(monitor: Monitor, usage: UsageMonitor, commands: ThreadCommands, host: DeckHost = defaultHost, machine: MachineMonitor = new MachineMonitor(), updates?: UpdatesMonitor, scheduled?: ScheduledMonitor) {
		this.#monitor = monitor;
		this.#usage = usage;
		this.#commands = commands;
		this.#machine = machine;
		this.#updates = updates;
		this.#scheduled = scheduled;
		this.#host = host;
		monitor.on("change", () => this.#relayout());
		usage.on("change", () => this.#render());
		machine.on("change", () => this.#render((e) => e.kind === "machine"));
		updates?.on("change", () => this.#render((e) => e.kind === "updates"));
		scheduled?.on("change", () => this.#render((e) => e.kind === "scheduled"));
	}

	set animation(mode: AnimationMode) {
		this.#animation = mode;
		this.#render();
	}

	set actionsEnabled(on: boolean) {
		this.#actionsEnabled = on;
		this.#render();
	}

	/** "Enable the Dictate key": off, Dictate keys send nothing and run nothing. */
	set dictationEnabled(on: boolean) {
		this.#dictationEnabled = on;
		if (!on) for (const e of this.#keys.values()) e.presses?.up();
		this.#render((e) => e.kind === "dictate");
	}

	attachDictation(port: DictationPort): void {
		this.#dictation = port;
	}

	set showLabels(on: boolean) {
		this.#showLabels = on;
		this.#render();
	}

	set threadStyle(style: KeyStyle) {
		this.#threadStyle = style;
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
		this.#syncMachine();
		this.#relayout();
	}

	remove(id: string): void {
		const entry = this.#keys.get(id);
		clearTimeout(entry?.holdTimer);
		// A Dictate key that goes away mid-press still lets go of the shortcut.
		entry?.presses?.up();
		this.#keys.delete(id);
		this.#syncUsage();
		this.#syncMachine();
		this.#relayout();
	}

	updateSettings(id: string, settings: KeySettings): void {
		const entry = this.#keys.get(id);
		if (!entry) return;
		entry.settings = settings;
		if (entry.kind === "machine") this.#syncMachine();
		this.#render();
	}

	/**
	 * Limit windows T3 currently reports, for the Usage key picker. Hub accounts
	 * carry `account` (hub label, email or account name, plan): the only place an
	 * email is shown, never on a key. `defaultKey` is what a key with no pick shows.
	 */
	usageMetrics(): { key: string; label: string; provider: string; used: number; account?: string; tickets?: number }[] {
		return metricsOf(this.#usage.snapshot.providers).map((m) => ({
			key: m.key,
			label: m.label,
			provider: m.provider,
			used: Math.round(m.window.usedPercent),
			...(m.hub ? { account: hubDescription(m.hub) } : {}),
			...(m.credits ? { tickets: m.credits.count } : {}),
		}));
	}

	/** The key a Usage key with no pick shows, so the picker can name it. */
	usageDefaultKey(): string | undefined {
		return defaultMetric(metricsOf(this.#usage.snapshot.providers))?.key;
	}

	/** Tasks T3 reports, for the Scheduled key picker. Titles and schedules only: prompts are never read. */
	scheduledTasks(): { id: string; title: string; schedule: string; enabled: boolean }[] {
		return this.#scheduled?.snapshot.tasks.map((t) => ({ id: t.id, title: t.title, schedule: scheduleText(t.schedule), enabled: t.enabled })) ?? [];
	}

	#syncUsage(): void {
		this.#usage.setWanted([...this.#keys.values()].some((k) => k.kind === "usage"));
		this.#updates?.setWanted([...this.#keys.values()].some((k) => k.kind === "updates"));
		this.#scheduled?.setWanted([...this.#keys.values()].some((k) => k.kind === "scheduled"));
	}

	/** Sample this Mac only while a Machine key is on a deck, and only the disks those keys show. */
	#syncMachine(): void {
		const keys = [...this.#keys.values()].filter((k) => k.kind === "machine");
		const paths = new Set(keys.filter((k) => machineStat(k.settings) !== "cpu" && machineStat(k.settings) !== "memory").map((k) => normalizeDiskPath(k.settings.path)));
		this.#machine.setWanted(keys.length > 0, paths);
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
		entry.downTaskId = entry.kind === "scheduled" ? this.#scheduledTask(entry)?.id : undefined;
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
		if (entry.kind === "dictate") this.#dictateDown(entry);
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
		entry.downTaskId = undefined;
		entry.held = false;
		entry.holdable = false;
		this.#render((e) => e === entry);
		if (held) return; // the hold action already ran
		try {
			const threadsPage = heldMs >= LONG_PRESS_MS && this.#online ? this.#heldOverviewPage(entry) : undefined;
			if (entry.kind === "thread" && heldMs >= LONG_PRESS_MS) await this.#onLongPress(entry, downThreadId);
			else if (threadsPage) await this.#host.switchToProfile(entry.action.device.id, threadsPage, THREADS_PAGE);
			else if (entry.kind === "overview" && holdable && heldMs >= HOLD_CUE_MS) return; // let go after "Hold to clear all" showed: cancelled
			else if (entry.kind === "scheduled" && heldMs >= HOLD_CUE_MS && (holdable || this.#scheduledHold(entry) === "enable")) {
				// Let go after "Hold to run now" showed: cancelled. With actions off the key said "Enable in settings".
				if (!holdable) await entry.action.showAlert();
				return;
			}
			else await this.#onTap(entry, downThreadId, holdable === true);
		} catch (error) {
			await this.#fail(entry, error);
		}
	}

	/**
	 * The T3 Threads page that holding this Overview key, then letting go, opens:
	 * only when its tap opens the most urgent thread and this deck has a bundled
	 * page. Any other Overview key clears every highlight on a hold instead.
	 */
	#heldOverviewPage(entry: KeyEntry): string | undefined {
		return entry.kind === "overview" && entry.settings.tap === "urgent" ? DECK_PROFILE[entry.action.device.type] : undefined;
	}

	/** Whether holding this key (now) leads to a hold action. */
	#canHold(entry: KeyEntry): boolean {
		if (entry.kind === "overview") return this.#online && !this.#heldOverviewPage(entry);
		if (entry.kind === "scheduled") return this.#scheduledHold(entry) === "run";
		if (entry.kind !== "action") return false;
		const action = entry.settings.action;
		// Opening a pull request reads nothing and changes nothing in T3 Code, so it needs no actions token.
		if (action === "open") return this.#pullRequestUrl(entry) !== undefined;
		if (!action || !HOLD_ACTIONS.has(action) || !this.#actionsEnabled) return false;
		const card = this.#focused(entry);
		if (!card || !canOperate(card)) return false;
		if (action === "stop") return card.activeRunId !== undefined;
		if (action === "message") return this.#messageFor(entry) !== undefined;
		return true;
	}

	/** The focused thread's pull request link, if it is one `open` may be given (`safeWebUrl`). */
	#pullRequestUrl(entry: KeyEntry): string | undefined {
		return safeWebUrl(this.#focused(entry)?.pullRequest?.url);
	}

	/** The task a Scheduled key shows right now; none while T3 is unreachable or the stream is down. */
	#scheduledTask(entry: KeyEntry): ScheduledTask | undefined {
		const stream = this.#scheduled?.snapshot;
		if (!stream || stream.state !== "live" || !this.#online) return undefined;
		return pickTask(stream.tasks, entry.settings.task).task;
	}

	/** What holding a Scheduled key does: run the task now, or (actions off) say where to turn that on. Undefined: nothing to hold for. */
	#scheduledHold(entry: KeyEntry): "run" | "enable" | undefined {
		const task = this.#scheduledTask(entry);
		if (!task || !canRunNow(task)) return undefined;
		return this.#actionsEnabled ? "run" : "enable";
	}

	/**
	 * This press armed a run of the task the key still shows. A key on "Whichever runs next" moves to
	 * another task when the first one starts or is rescheduled, and a hold must never run that other task.
	 */
	#scheduledArmed(entry: KeyEntry): boolean {
		return entry.holdable === true && entry.downTaskId !== undefined && this.#scheduledTask(entry)?.id === entry.downTaskId;
	}

	/** Runs the task the press started on, if the key still shows it. A second hold on the same task while the first is in flight does nothing. */
	async #runScheduled(entry: KeyEntry): Promise<void> {
		const task = this.#scheduledTask(entry);
		if (!task || !this.#scheduledArmed(entry) || !this.#actionsEnabled || !canRunNow(task)) return entry.action.showAlert();
		const key = `scheduled|${task.id}`;
		if (this.#busy.has(key)) return;
		this.#busy.add(key);
		try {
			await this.#commands.runScheduledTask(task.id);
			await entry.action.showOk();
		} finally {
			this.#busy.delete(key);
		}
	}

	/** Fires at CONFIRM_HOLD_MS while the key is still down. */
	async #onHold(entry: KeyEntry): Promise<void> {
		if (entry.kind === "overview") {
			this.#monitor.ackAll();
			await entry.action.showOk();
			return;
		}
		if (entry.kind === "scheduled") return this.#runScheduled(entry);
		if (entry.settings.action === "open") {
			const url = this.#pullRequestUrl(entry);
			if (url) this.#launch(entry, Promise.resolve([url]));
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
			case "updates": {
				// Updates waiting: T3 Code is where they're installed. Otherwise check again now.
				const pending = this.#updates ? pendingUpdates(this.#updates.snapshot) : [];
				if (pending.length > 0) return this.#openT3(entry);
				this.#updates?.refresh();
				return entry.action.showOk();
			}
			case "scheduled": {
				// The task's thread when the plugin knows it, else T3 Code itself (also with no tasks, or while T3 is offline).
				const task = this.#online ? this.#scheduledTask(entry) : undefined;
				const card = task?.threadId ? this.#monitor.snapshot.cards.get(task.threadId) : undefined;
				return card ? this.#open(entry, card) : this.#openT3(entry);
			}
			case "machine":
				// A disk key shows that folder in Finder; the others open Activity Monitor.
				return this.#launch(entry, Promise.resolve(machineStat(entry.settings) === "disk" ? [normalizeDiskPath(entry.settings.path)] : ACTIVITY_MONITOR));
			case "overview": {
				if (!this.#online) return this.#openT3(entry);
				// Open the full page of thread tiles, like a folder; that dismisses nothing.
				// Keys set to it, and devices without a bundled page, jump to the most urgent
				// thread instead, which clears that one thread's highlight like a tap on its tile.
				const profile = DECK_PROFILE[entry.action.device.type];
				if (profile && entry.settings.tap !== "urgent") return this.#host.switchToProfile(entry.action.device.id, profile, THREADS_PAGE);
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
			case "dictate":
				// Off: the key already says "Enable in settings", and nothing runs.
				if (!this.#dictationEnabled || !this.#dictation) return entry.action.showAlert();
				entry.presses?.up();
				this.#render((e) => e === entry);
				return;
		}
	}

	/**
	 * Dictate key down: bring T3 Code forward (and open the most urgent thread,
	 * if set) now; the presses queue then sends a tap, or key-down and key-up
	 * around the hold, once T3 Code is ready.
	 */
	#dictateDown(entry: KeyEntry): void {
		const port = this.#dictation;
		if (!this.#dictationEnabled || !port) return;
		entry.allowUntil = undefined;
		entry.presses ??= new DictatePresses();
		entry.presses.down({
			prepare: () => this.#dictatePrepare(entry, port),
			send: (phase: DictatePhase, target: DictateTarget) => {
				// Turned off mid-press: a key-up still goes out, so nothing stays held; nothing new starts.
				if (!this.#dictationEnabled && phase !== "up") throw new DictateRefusal("disabled", "the Dictate key was turned off");
				return port.send(phase, target);
			},
			changed: () => this.#render((e) => e === entry),
			sent: () => void entry.action.showOk().catch(() => {}),
			failed: (error: unknown) => {
				if (error instanceof DictateRefusal && error.reason === "not-permitted") {
					this.#host.warn(`dictate failed: ${error.message}`);
					entry.allowUntil = Date.now() + ALLOW_HINT_MS;
					this.#render((e) => e === entry);
					return;
				}
				if (error instanceof DictateRefusal && error.reason === "disabled") return;
				this.#fail(entry, error).catch(() => {}); // the key may have gone meanwhile
			},
		});
	}

	/** Where the shortcut goes: T3 Code's bundle id is required, since the script checks the front app against it. */
	async #dictatePrepare(entry: KeyEntry, port: DictationPort): Promise<DictateTarget> {
		const args = await this.#host.appArgs(this.#monitor.location).catch((): string[] => []);
		const bundleId = args[0] === "-b" && typeof args[1] === "string" && validBundleId(args[1]) ? args[1] : undefined;
		if (!bundleId) throw new DictateRefusal("no-app", "no T3 Code app to send the dictation shortcut to: open T3 Code from its app, or set T3 app bundle id");
		const chord = port.chord();
		chord.catch(() => {}); // awaited below; the app comes forward either way
		const target = entry.settings.dictateThread === "urgent" && this.#online ? this.#mostUrgent() : undefined;
		const url = target ? deepLinkFor(target.link, target.threadId) : null;
		if (target) this.#monitor.ack(target.threadId);
		const open = ["-b", bundleId, ...(url ? [url] : [])];
		this.#host.info?.(`open ${open.join(" ")}`);
		await this.#host.open(open);
		return { bundleId, chord: await chord };
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
		if (!url) return this.#openT3(entry);
		// Hand the link to the app that runs the T3 server, if it is found quickly; else to whichever app owns t3code://.
		let timer: NodeJS.Timeout | undefined;
		const app = Promise.race([
			this.#host.appArgs(this.#monitor.location).catch(() => []),
			new Promise<string[]>((resolve) => (timer = setTimeout(() => resolve([]), APP_LOOKUP_MS))),
		]).finally(() => clearTimeout(timer));
		// If that app can't be opened (say, the T3 app bundle id setting names one that isn't installed), the link alone.
		this.#launch(entry, app.then((found) => (found[0] === "-b" ? [...found, url] : [url])), [url]);
	}

	/** Brings up T3 Code itself (also what a tap does while T3 is offline). */
	#openT3(entry: KeyEntry): void {
		this.#launch(entry, this.#host.appArgs(this.#monitor.location));
	}

	/** Runs `open` with `pending`'s arguments; if that fails and `fallback` differs, tries `fallback` once. */
	#launch(entry: KeyEntry, pending: Promise<string[]>, fallback?: string[]): void {
		let args: string[] = [];
		const run = (next: string[]): Promise<void> => {
			args = next;
			this.#host.info?.(`open ${args.join(" ")}`);
			return this.#host.open(args);
		};
		pending
			.then((resolved) =>
				run(resolved).catch((error: unknown) => {
					if (!fallback || fallback.join("\0") === resolved.join("\0")) throw error;
					this.#host.warn(`open ${resolved.join(" ")} failed, opening the link alone: ${(error as Error)?.message ?? String(error)}`);
					return run(fallback);
				}),
			)
			.catch((error: unknown) => {
				this.#host.warn(`open ${args.join(" ")} failed: ${(error as Error)?.message ?? String(error)}`);
				return entry.action.showAlert();
			});
	}

	/** The thread to jump to: needs you, then failed, done, working; the latest update first. None while every thread is idle. */
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
						empty: metric ? undefined : emptyState(usage.providers, usage.hubs ?? [], entry.settings.metric),
						now,
						ok: usage.ok,
						loading: usage.fetchedAt === 0 && usage.ok === false && usage.detail === "Loading…",
						style: entry.settings.style === "ring" ? "ring" : "bar",
					}),
				};
			}
			case "scheduled": {
				const stream = this.#scheduled?.snapshot ?? LOADING;
				const pick = stream.state === "live" ? pickTask(stream.tasks, entry.settings.task) : ({ task: undefined, reason: "none" } as const);
				// "Hold to run now" only for the press that armed the run, on the task it started on: a task that became
				// runnable, or took the key over, mid-press has no timer behind it, so it gets no cue and no progress bar.
				const state = this.#scheduledHold(entry);
				const hold = state === "run" && !this.#scheduledArmed(entry) ? undefined : state;
				const style = keyStyle(entry.settings);
				const holding = hold !== undefined && !entry.held && pressedFor !== undefined;
				const cued = holding && pressedFor >= HOLD_CUE_MS;
				const cue: ScheduledCue | undefined = cued ? (hold === "run" ? { kind: "run", progress: pressedFor / CONFIRM_HOLD_MS } : { kind: "enable" }) : undefined;
				const markup = renderScheduledKey({ connection: snapshot.connection, stream: stream.state, pick, now, animation, style, cue });
				const next = earliest(
					online && stream.state === "live" ? nextScheduledFrame(pick.task, animation, now, style) : undefined,
					holding ? (cued ? (hold === "run" ? progressFrame(entry.downAt!, now) : undefined) : entry.downAt! + HOLD_CUE_MS) : undefined,
				);
				return { markup, next };
			}
			case "updates":
				return { markup: renderUpdatesKey(this.#updates?.snapshot ?? { ok: false, detail: "Loading…", providers: [], fetchedAt: 0 }, keyStyle(entry.settings)) };
			case "machine":
				return {
					markup: renderMachineKey({ stat: machineStat(entry.settings), sample: this.#machine.snapshot, path: normalizeDiskPath(entry.settings.path), style: keyStyle(entry.settings) }),
				};
			case "overview": {
				const counts = countStates(snapshot);
				const holding = entry.holdable && !entry.held && pressedFor !== undefined;
				const cue = holding && pressedFor >= HOLD_CUE_MS;
				// A key whose hold opens the T3 Threads page says "Release for threads" once letting go would, like a Thread tile.
				const releasable = pressedFor !== undefined && online && this.#heldOverviewPage(entry) !== undefined;
				const armed = releasable && pressedFor >= LONG_PRESS_MS;
				const markup = renderOverview({
					connection: snapshot.connection,
					counts,
					overflow: this.#overflowFor(entry.action.device.id),
					animation,
					now,
					hold: cue ? pressedFor / CONFIRM_HOLD_MS : undefined,
					releaseCue: armed,
					style: this.#threadStyle,
				});
				const next = holding
					? cue
						? progressFrame(entry.downAt!, now)
						: entry.downAt! + HOLD_CUE_MS
					: earliest(nextOverviewFrame(overviewState(counts), animation, now), releasable && !armed ? entry.downAt! + LONG_PRESS_MS : undefined);
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
			case "dictate": {
				const allow = (entry.allowUntil ?? 0) > now;
				return {
					markup: renderDictateKey({ enabled: this.#dictationEnabled && this.#dictation !== undefined, holding: entry.presses?.holding, allow }),
					next: allow ? entry.allowUntil : undefined,
				};
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
					style: this.#threadStyle,
				});
				const next = earliest(
					online ? nextThreadFrame(card, animation, now, this.#threadStyle) : undefined,
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
		for (const e of this.#keys.values()) {
			clearTimeout(e.holdTimer);
			e.presses?.up();
		}
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
