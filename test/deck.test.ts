import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, mock, test } from "node:test";

import { DeviceType } from "@elgato/streamdeck";

import { CONFIRM_HOLD_MS, Deck, type DeckHost, type KeyKind, type KeySettings } from "../src/deck.ts";
import type { ThreadCard } from "../src/model.ts";
import type { ThreadCommands } from "../src/t3/commands.ts";
import type { Connection, Monitor, Snapshot } from "../src/t3/monitor.ts";
import type { UsageMonitor } from "../src/t3/usage-monitor.ts";
import type { MachineMonitor, MachineSnapshot } from "../src/machine.ts";
import type { UpdatesMonitor } from "../src/t3/updates-monitor.ts";
import type { UpdatesSnapshot } from "../src/updates.ts";
import { ALLOW_HINT_MS } from "../src/deck.ts";
import { DICTATE_TAP_MS, DictateRefusal, MIN_HOLD_MS, type Chord, type DictatePhase, type DictateTarget, type DictationPort } from "../src/dictate.ts";

const card = (id: string, extra: Partial<ThreadCard> = {}): ThreadCard => ({
	threadId: id, projectId: "p", title: `Thread ${id}`, link: `http://127.0.0.1:3773/env/${id}`, state: "idle", ownStatus: "completed",
	subagentsWorking: 0, subagentsWaiting: 0, background: 0, inputFromSubagent: false, ackKey: "", updatedAt: 0, createdAt: 0, ...extra,
});

class FakeMonitor extends EventEmitter {
	snapshot: Snapshot = { connection: { kind: "ok" }, cards: new Map(), visible: [], projectNames: new Map([["p", "proj"]]) };
	calls: string[] = [];
	deckThreads: string[] = [];
	location = { home: "/tmp/t3", cli: "/tmp/t3/bin/t3", custom: true };
	setCards(cards: ThreadCard[], connection: Connection = { kind: "ok" }): void {
		this.snapshot = { ...this.snapshot, connection, cards: new Map(cards.map((c) => [c.threadId, c])), visible: cards };
		this.emit("change", this.snapshot);
	}
	setDeckThreads(ids: Iterable<string>): void {
		this.deckThreads = [...ids];
	}
	ack(id: string): void {
		this.calls.push(`ack:${id}`);
	}
	ackAll(): void {
		this.calls.push("ackAll");
	}
	refresh(): void {}
}

class FakeUsage extends EventEmitter {
	snapshot = { providers: [], ok: true, fetchedAt: 1, detail: "" };
	setWanted(): void {}
	refresh(): void {}
}

class FakeCommands {
	sent: string[] = [];
	/** When set, commands wait for this before resolving. */
	gate: Promise<void> | undefined;
	async #record(what: string): Promise<void> {
		this.sent.push(what);
		await this.gate;
	}
	stop(threadId: string, runId: string) { return this.#record(`stop:${threadId}:${runId}`); }
	snooze(threadId: string) { return this.#record(`snooze:${threadId}`); }
	settle(threadId: string) { return this.#record(`settle:${threadId}`); }
	send(threadId: string, text: string) { return this.#record(`send:${threadId}:${text}`); }
}

class FakeHost implements DeckHost {
	switches: string[] = [];
	opened: string[][] = [];
	openFails = false;
	/** `open` fails for these bundle ids, like `open -b` with an app that isn't installed. */
	missingApps = new Set<string>();
	warnings: string[] = [];
	async switchToProfile(deviceId: string, profile?: string, page?: number): Promise<void> {
		this.switches.push(`${deviceId}:${profile ?? "previous"}:${page ?? ""}`);
	}
	/** What the app locator would answer (see test/app.test.ts for the real one). */
	app: string[] = ["-b", "com.t3tools.t3code"];
	/** When set, the app lookup waits for this (or fails with it) before answering. */
	appGate: Promise<void> | undefined;
	infos: string[] = [];
	async appArgs(): Promise<string[]> {
		await this.appGate;
		return this.app;
	}
	async open(args: string[]): Promise<void> {
		this.opened.push(args);
		if (this.openFails || (args[0] === "-b" && this.missingApps.has(args[1]!))) throw new Error("no such app");
	}
	warn(message: string): void {
		this.warnings.push(message);
	}
	info(message: string): void {
		this.infos.push(message);
	}
}

interface FakeAction {
	id: string;
	images: string[];
	events: string[];
	failNextImage: boolean;
	last(): string;
}

function fakeAction(id: string, column: number, row = 0, type = DeviceType.StreamDeckXL, deviceId = "dev1") {
	const a = {
		id,
		device: { id: deviceId, type },
		coordinates: { column, row },
		images: [] as string[],
		events: [] as string[],
		failNextImage: false,
		isInMultiAction: () => false,
		async setImage(url: string) {
			if (a.failNextImage) {
				a.failNextImage = false;
				throw new Error("device busy");
			}
			a.images.push(Buffer.from(url.split(",")[1]!, "base64").toString("utf8"));
		},
		async showOk() {
			a.events.push("ok");
		},
		async showAlert() {
			a.events.push("alert");
		},
		last() {
			return a.images.at(-1) ?? "";
		},
	};
	return a;
}

let monitor: FakeMonitor;
let commands: FakeCommands;
let host: FakeHost;
let deck: Deck;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Node 22's mock tick jumps the clock in one go, so timers scheduled meanwhile need small steps. */
async function advance(ms: number, step = 25): Promise<void> {
	for (let t = 0; t < ms; t += step) {
		mock.timers.tick(Math.min(step, ms - t));
		await flush();
	}
}

beforeEach(() => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
	monitor = new FakeMonitor();
	commands = new FakeCommands();
	host = new FakeHost();
	deck = new Deck(monitor as unknown as Monitor, new FakeUsage() as unknown as UsageMonitor, commands as unknown as ThreadCommands, host);
});

afterEach(() => {
	deck.dispose();
	mock.timers.reset();
});

function add(kind: KeyKind, a: ReturnType<typeof fakeAction>, settings: KeySettings = {}) {
	deck.add(kind, a as never, settings);
	return a;
}

async function press(a: FakeAction, ms: number): Promise<void> {
	deck.keyDown(a.id);
	mock.timers.tick(ms);
	await deck.keyUp(a.id);
	await flush();
}

/** A thread tile, its card focused on the Thread Actions page via a long press. */
async function focusedPage(extra: Partial<ThreadCard> = {}) {
	const tile = add("thread", fakeAction("tile", 1));
	monitor.setCards([card("t1", extra)]);
	await press(tile, 600);
	assert.deepEqual(host.switches, ["dev1:profiles/Deck for T3 Code XL:1"]);
	host.switches = [];
	return tile;
}

test("a key-up that never saw its own key-down does nothing", async () => {
	const tile = add("thread", fakeAction("tile", 1));
	const overview = add("overview", fakeAction("ov", 2));
	monitor.setCards([card("t1", { state: "done" })]);
	await deck.keyUp(tile.id);
	await deck.keyUp(overview.id);
	await flush();
	assert.deepEqual(host.opened, []);
	assert.deepEqual(host.switches, []);
	assert.deepEqual(monitor.calls, []);
});

test("thread tile: the link goes to the app that runs the T3 server, logged", async () => {
	const tile = add("thread", fakeAction("tile", 1));
	host.app = ["-b", "com.t3tools.t3code.custom"];
	monitor.setCards([card("t1", { state: "done", link: "http://127.0.0.1:3773/threads/env/t1" })]);
	await press(tile, 100);
	await flush();
	assert.deepEqual(host.opened, [["-b", "com.t3tools.t3code.custom", "t3code://threads/env/t1"]]);
	assert.deepEqual(host.infos, ["open -b com.t3tools.t3code.custom t3code://threads/env/t1"]);
});

test("thread tile: with no app found (t3code://new), a failed lookup or a slow one, the link opens on its own", async () => {
	const tile = add("thread", fakeAction("tile", 1));
	monitor.setCards([card("t1", { state: "done" })]);

	host.app = ["t3code://new"];
	await press(tile, 100);
	await flush();
	assert.deepEqual(host.opened.at(-1), ["t3code://threads/env/t1"], "not t3code://new and the thread");

	host.app = ["-b", "com.t3tools.t3code"];
	host.appGate = Promise.reject(new Error("ps failed"));
	host.appGate.catch(() => {});
	await press(tile, 100);
	await flush();
	assert.deepEqual(host.opened.at(-1), ["t3code://threads/env/t1"]);

	let release!: () => void;
	host.appGate = new Promise((resolve) => (release = resolve));
	const before = host.opened.length;
	await press(tile, 100);
	await advance(400);
	assert.equal(host.opened.length, before, "still waiting for the app lookup");
	await advance(150);
	assert.deepEqual(host.opened.at(-1), ["t3code://threads/env/t1"], "gave up on the lookup after 500 ms");
	release();
	await flush();
	assert.equal(host.opened.length, before + 1, "the late answer doesn't open it again");
});

test("thread tile: when the app can't be opened, the link opens on its own; if that fails too, an alert", async () => {
	const tile = add("thread", fakeAction("tile", 1));
	host.app = ["-b", "com.example.not-installed"];
	host.missingApps.add("com.example.not-installed");
	monitor.setCards([card("t1", { state: "done" })]);
	await press(tile, 100);
	await flush();
	assert.deepEqual(host.opened, [["-b", "com.example.not-installed", "t3code://threads/env/t1"], ["t3code://threads/env/t1"]]);
	assert.equal(host.warnings.length, 1);
	assert.match(host.warnings[0]!, /opening the link alone/);
	assert.deepEqual(tile.events, [], "the link opened: no alert");

	host.openFails = true;
	host.opened = [];
	await press(tile, 100);
	await flush();
	assert.equal(host.opened.length, 2, "tried once more, not in a loop");
	assert.deepEqual(tile.events, ["alert"]);
});

test("thread tile without -b: a failed open isn't retried with the same link", async () => {
	const tile = add("thread", fakeAction("tile", 1));
	host.app = ["t3code://new"];
	host.openFails = true;
	monitor.setCards([card("t1", { state: "done" })]);
	await press(tile, 100);
	await flush();
	assert.deepEqual(host.opened, [["t3code://threads/env/t1"]]);
	assert.deepEqual(tile.events, ["alert"]);
});

test("settle held on the actions page, then the key-up lands on the Threads page: nothing opens", async () => {
	await focusedPage();
	deck.actionsEnabled = true;
	const settle = add("action", fakeAction("settle", 6, 3), { action: "settle" });
	deck.keyDown(settle.id);
	mock.timers.tick(CONFIRM_HOLD_MS);
	await flush();
	assert.deepEqual(commands.sent, ["settle:t1"]);
	assert.deepEqual(host.switches, ["dev1:profiles/Deck for T3 Code XL:0"]);
	// Page 0 shows a Thread key at the same position; the finger comes up there.
	deck.remove(settle.id);
	const underFinger = add("thread", fakeAction("tile-under", 6, 3));
	await deck.keyUp(underFinger.id);
	await flush();
	assert.deepEqual(host.opened, [], "the release didn't open a thread");
});

test("thread tile without a link: a tap brings up the detected T3 app", async () => {
	const tile = add("thread", fakeAction("tile", 1));
	host.app = ["-b", "com.t3tools.t3code.custom"];
	monitor.setCards([card("t1", { state: "done", link: "" })]);
	await press(tile, 100);
	await flush();
	assert.deepEqual(host.opened, [["-b", "com.t3tools.t3code.custom"]]);
	assert.deepEqual(monitor.calls, ["ack:t1"]);
});

test("thread tile: tap opens, long press shows a release cue and opens actions on release", async () => {
	const tile = add("thread", fakeAction("tile", 1));
	monitor.setCards([card("t1", { state: "done" })]);
	await press(tile, 100);
	assert.deepEqual(host.opened, [["-b", "com.t3tools.t3code", "t3code://threads/env/t1"]]);
	assert.deepEqual(monitor.calls, ["ack:t1"]);

	deck.keyDown(tile.id);
	mock.timers.tick(300);
	assert.ok(!tile.last().includes("Release"));
	mock.timers.tick(250);
	await flush();
	assert.ok(tile.last().includes(">Release<"), "cue once the threshold passes");
	assert.deepEqual(host.switches, [], "nothing happens while held");
	await deck.keyUp(tile.id);
	await flush();
	assert.deepEqual(host.switches, ["dev1:profiles/Deck for T3 Code XL:1"]);
	assert.ok(!tile.last().includes("Release"), "cue cleared after release");
});

test("quick messages: Label | text, a tap only hints, a hold sends once", async () => {
	await focusedPage();
	deck.actionsEnabled = true;
	deck.messages = "continue\nShip | merge it if CI is green";
	const key = add("action", fakeAction("m1", 4), { action: "message", index: 1 });
	assert.ok(key.last().includes(">Ship<") && !key.last().includes("merge it"));

	await press(key, 200);
	assert.deepEqual(commands.sent, [], "a tap sends nothing");
	assert.ok(key.last().includes("Hold to send"));
	mock.timers.tick(3100);
	await flush();
	assert.ok(!key.last().includes("Hold to send"), "hint goes away after 3 s");

	deck.keyDown(key.id);
	mock.timers.tick(400);
	await flush();
	assert.ok(key.last().includes('id="hold-progress"'), "progress while held");
	mock.timers.tick(400);
	await flush();
	assert.deepEqual(commands.sent, ["send:t1:merge it if CI is green"]);
	await deck.keyUp(key.id);
	mock.timers.tick(2000);
	await flush();
	assert.equal(commands.sent.length, 1, "the release doesn't send again");
});

test("compact needs a hold too", async () => {
	await focusedPage();
	deck.actionsEnabled = true;
	const key = add("action", fakeAction("c", 0, 3), { action: "compact" });
	await press(key, 100);
	assert.deepEqual(commands.sent, []);
	assert.ok(key.last().includes("hold to send"));
	await press(key, CONFIRM_HOLD_MS + 50);
	assert.deepEqual(commands.sent, ["send:t1:/compact"]);
});

test("a command in flight can't be sent again by leaving and re-entering the page", async () => {
	await focusedPage();
	deck.actionsEnabled = true;
	let release!: () => void;
	commands.gate = new Promise((resolve) => (release = resolve));
	const first = add("action", fakeAction("m0", 3), { action: "message", index: 0 });
	await press(first, CONFIRM_HOLD_MS + 10);
	// The page reappears: new key entries for the same slot.
	deck.remove(first.id);
	const again = add("action", fakeAction("m0-again", 3), { action: "message", index: 0 });
	await press(again, CONFIRM_HOLD_MS + 10);
	assert.deepEqual(commands.sent, ["send:t1:continue"]);
	release();
	await flush();
	await press(again, CONFIRM_HOLD_MS + 10);
	assert.equal(commands.sent.length, 2, "sends again once the first finished");
});

test("thread actions off: keys say so, holds and taps send nothing; header and Open still work", async () => {
	await focusedPage({ activeRunId: "run-1" });
	const stop = add("action", fakeAction("stop", 7, 3), { action: "stop" });
	const snooze = add("action", fakeAction("snooze", 1, 3), { action: "snooze1h" });
	const open = add("action", fakeAction("open", 2), { action: "open" });
	assert.ok(stop.last().includes("Enable in") && snooze.last().includes("Enable in"));
	assert.ok(!open.last().includes("Enable in"));
	await press(stop, CONFIRM_HOLD_MS + 100);
	await press(snooze, 100);
	assert.deepEqual(commands.sent, []);
	assert.deepEqual(snooze.events, ["alert"]);
	await press(open, 100);
	assert.deepEqual(host.opened.at(-1), ["-b", "com.t3tools.t3code", "t3code://threads/env/t1"]);
});

test("a linked machine's thread: actions say so and send nothing, Open still deep-links there", async () => {
	await focusedPage({ activeRunId: "run-1", environmentId: "env-remote", link: "http://127.0.0.1:3773/env-remote/t1" });
	deck.actionsEnabled = true;
	const stop = add("action", fakeAction("stop", 7, 3), { action: "stop" });
	const snooze = add("action", fakeAction("snooze", 1, 3), { action: "snooze1h" });
	const message = add("action", fakeAction("msg", 3, 1), { action: "message", index: 0 });
	const open = add("action", fakeAction("open", 2), { action: "open" });
	for (const k of [stop, snooze, message]) assert.ok(k.last().includes("On another") && k.last().includes("machine"), k.id);
	await press(stop, CONFIRM_HOLD_MS + 100);
	await press(message, CONFIRM_HOLD_MS + 100);
	await press(snooze, 100);
	assert.deepEqual(commands.sent, []);
	assert.deepEqual(snooze.events, ["alert"]);
	await press(open, 100);
	assert.deepEqual(host.opened.at(-1), ["-b", "com.t3tools.t3code", "t3code://threads/env-remote/t1"]);
});

test("stop: dimmed with nothing running, hold to interrupt when a run is active", async () => {
	await focusedPage();
	deck.actionsEnabled = true;
	const stop = add("action", fakeAction("stop", 7, 3), { action: "stop" });
	assert.ok(stop.last().includes("Nothing") && stop.last().includes("running"));
	await press(stop, CONFIRM_HOLD_MS + 100);
	assert.deepEqual(commands.sent, []);
	monitor.setCards([card("t1", { state: "working", activeRunId: "run-9" })]);
	assert.ok(stop.last().includes('fill="#CC2F35"'));
	await press(stop, CONFIRM_HOLD_MS + 100);
	assert.deepEqual(commands.sent, ["stop:t1:run-9"]);
});

test("overview: tap opens the Threads page and dismisses nothing; hold 0.8 s clears all; letting go early cancels", async () => {
	const ov = add("overview", fakeAction("ov", 0));
	monitor.setCards([card("t1", { state: "done" })]);
	await press(ov, 100);
	assert.deepEqual(host.switches, ["dev1:profiles/Deck for T3 Code XL:0"]);
	assert.deepEqual(monitor.calls, []);

	deck.keyDown(ov.id);
	mock.timers.tick(400);
	await flush();
	assert.ok(ov.last().includes("Hold to") && ov.last().includes("clear all"));
	await deck.keyUp(ov.id);
	assert.deepEqual(monitor.calls, [], "released early: cancelled");
	assert.equal(host.switches.length, 1, "and it didn't count as a tap");

	deck.keyDown(ov.id);
	mock.timers.tick(CONFIRM_HOLD_MS);
	await flush();
	assert.deepEqual(monitor.calls, ["ackAll"]);
	await deck.keyUp(ov.id);
	assert.equal(host.switches.length, 1);
});

test("overview set to open the most urgent thread: a tap opens it, a hold then release opens the Threads page", async () => {
	const ov = add("overview", fakeAction("ov", 0), { tap: "urgent" });
	monitor.setCards([
		card("working", { state: "working", updatedAt: 9 }),
		card("done", { state: "done", updatedAt: 8 }),
		card("asks-old", { state: "input", updatedAt: 1 }),
		card("asks-new", { state: "input", updatedAt: 2 }),
	]);
	await press(ov, 100);
	assert.deepEqual(host.opened, [["-b", "com.t3tools.t3code", "t3code://threads/env/asks-new"]], "needs you first, the latest update among them");
	assert.deepEqual(monitor.calls, ["ack:asks-new"], "opening it clears its highlight, and no other");
	assert.deepEqual(host.switches, []);

	// Between the "Hold to clear all" delay and the long-press threshold it is still a tap.
	await press(ov, 400);
	assert.equal(host.opened.length, 2);
	assert.ok(!ov.images.some((image) => image.includes("clear all")), "no clear-all cue in this mode");

	deck.keyDown(ov.id);
	mock.timers.tick(450);
	await flush();
	assert.ok(!ov.last().includes("Release"));
	mock.timers.tick(100);
	await flush();
	assert.ok(ov.last().includes(">Release<") && ov.last().includes(">for threads<"), "cue once the threshold passes");
	assert.deepEqual(host.switches, [], "nothing happens while held");
	mock.timers.tick(CONFIRM_HOLD_MS);
	await flush();
	await deck.keyUp(ov.id);
	await flush();
	assert.deepEqual(host.switches, ["dev1:profiles/Deck for T3 Code XL:0"]);
	assert.ok(!ov.last().includes("Release"), "cue cleared after release");
	assert.equal(host.opened.length, 2, "the hold opened no thread");
	assert.deepEqual(monitor.calls, ["ack:asks-new", "ack:asks-new"], "and cleared nothing");

	// Nothing active: T3 Code itself.
	monitor.setCards([card("idle")]);
	await press(ov, 100);
	assert.deepEqual(host.opened.at(-1), ["-b", "com.t3tools.t3code"]);

	// Switching the setting back restores the default tap and hold.
	deck.updateSettings(ov.id, { tap: "threads" });
	host.switches = [];
	await press(ov, 100);
	assert.deepEqual(host.switches, ["dev1:profiles/Deck for T3 Code XL:0"]);
	await press(ov, CONFIRM_HOLD_MS);
	assert.deepEqual(monitor.calls.at(-1), "ackAll");
});

test("overview set to open the most urgent thread: offline it opens T3; without a bundled page a hold still clears all", async () => {
	const ov = add("overview", fakeAction("ov", 0), { tap: "urgent" });
	monitor.setCards([card("t1", { state: "done" })], { kind: "offline", detail: "", reason: "not-running" });
	await press(ov, 600);
	assert.deepEqual(host.opened, [["-b", "com.t3tools.t3code"]]);
	assert.deepEqual(host.switches, []);
	assert.ok(!ov.images.some((image) => image.includes("Release")), "no cue while T3 is unreachable");

	const plus = add("overview", fakeAction("plus", 0, 0, DeviceType.StreamDeckPlus, "dev2"), { tap: "urgent" });
	monitor.setCards([card("t1", { state: "done" })]);
	await press(plus, 100);
	assert.deepEqual(host.opened.at(-1), ["-b", "com.t3tools.t3code", "t3code://threads/env/t1"]);
	deck.keyDown(plus.id);
	mock.timers.tick(400);
	await flush();
	assert.ok(plus.last().includes("clear all"));
	mock.timers.tick(400);
	await flush();
	assert.deepEqual(monitor.calls.at(-1), "ackAll");
	await deck.keyUp(plus.id);
	assert.deepEqual(host.switches, []);
});

test("offline: the first Thread key says why, the rest are blank; a tap opens T3", async () => {
	const a = add("thread", fakeAction("a", 1));
	const b = add("thread", fakeAction("b", 2));
	monitor.setCards([], { kind: "offline", detail: "", reason: "not-running" });
	assert.ok(a.last().includes("Open T3 Code"));
	assert.ok(!b.last().includes("<text"));
	await press(b, 100);
	await flush();
	assert.deepEqual(host.opened, [["-b", "com.t3tools.t3code"]]);
	// Whatever the locator picks is what gets opened: a custom build's id, or the t3code:// scheme.
	host.app = ["-b", "com.t3tools.t3code.custom"];
	await press(b, 100);
	await flush();
	assert.deepEqual(host.opened.at(-1), ["-b", "com.t3tools.t3code.custom"]);
	host.app = ["t3code://new"];
	await press(b, 100);
	await flush();
	assert.deepEqual(host.opened.at(-1), ["t3code://new"]);
	host.openFails = true;
	monitor.setCards([], { kind: "offline", detail: "", reason: "not-installed" });
	assert.ok(a.last().includes("Install T3"));
	await press(a, 100);
	await flush();
	assert.deepEqual(a.events, ["alert"], "couldn't open T3: alert");
});

test("Threads page Back key shows +N for threads that don't fit on this deck", () => {
	const back = add("back", fakeAction("back", 0));
	add("thread", fakeAction("a", 1));
	add("thread", fakeAction("b", 2));
	monitor.setCards(["1", "2", "3", "4", "5"].map((id) => card(id, { state: "working" })));
	assert.ok(back.last().includes("+3 more"));
	assert.deepEqual(monitor.deckThreads.length, 2);
	monitor.setCards([card("1")]);
	assert.ok(!back.last().includes("more"));
});

test("clock: spinners step every 300 ms, blinks keep their own phase, static keys aren't re-sent", async () => {
	// New threads take keys most urgent first: needs-you, then working, then idle.
	const blink = add("thread", fakeAction("blink", 1));
	const spin = add("thread", fakeAction("spin", 2));
	const still = add("thread", fakeAction("still", 3));
	monitor.setCards([card("w", { state: "working", ownStatus: "running" }), card("i", { state: "input", ownStatus: "waiting" }), card("d", { state: "idle" })]);
	await flush();
	const counts = () => [spin.images.length, blink.images.length, still.images.length];
	const start = counts();
	await advance(300 - (Date.now() % 300));
	assert.equal(counts()[0], start[0]! + 1, "spinner stepped");
	await advance(2400);
	const after = counts();
	assert.equal(after[0]! - start[0]!, 9, "8 steps per 2.4 s turn, plus the first");
	// input blinks on a 900 ms period with 450 ms halves: about 6 edges in 2.7 s.
	assert.ok(after[1]! - start[1]! >= 5 && after[1]! - start[1]! <= 7, `blink edges: ${after[1]! - start[1]!}`);
	assert.equal(after[2], start[2], "idle key never re-sent");
	assert.ok(spin.last().includes("rotate(") && blink.last().includes("glyph-input"));
});

test("a failed setImage is retried on the next render", async () => {
	const tile = add("thread", fakeAction("tile", 1));
	monitor.setCards([card("t1", { title: "First" })]);
	await flush();
	assert.ok(tile.last().includes(">First<"));
	tile.failNextImage = true;
	monitor.setCards([card("t1", { title: "Second" })]);
	await flush();
	assert.ok(!tile.last().includes(">Second<"), "that one failed");
	monitor.setCards([card("t1", { title: "Second" })]);
	await flush();
	assert.ok(tile.last().includes(">Second<"), "same markup sent again after the failure");
	assert.equal(host.warnings.length, 1);
});

test("bundled profiles: one per device type, Back top-left, destructive actions last", async () => {
	const { PROFILES, layoutOf } = await import(new URL("../scripts/build-profile.mjs", import.meta.url).href);
	const manifest = JSON.parse((await import("node:fs")).readFileSync(new URL("../io.github.hsalazr.deck-for-t3code.sdPlugin/manifest.json", import.meta.url), "utf8"));
	const byType = new Map<number, { file: string; columns: number; rows: number; model: string }>(PROFILES.map((p: { deviceType: number }) => [p.deviceType, p]));
	assert.deepEqual([...byType.keys()].sort(), [0, 1, 2, 9]);
	for (const entry of manifest.Profiles) assert.equal(`profiles/${byType.get(entry.DeviceType)?.file}`, entry.Name);
	const sizes = Object.fromEntries(PROFILES.map((p: { file: string; columns: number; rows: number; model: string }) => [p.file, `${p.columns}x${p.rows} ${p.model}`]));
	assert.deepEqual(sizes, { "Deck for T3 Code XL": "8x4 20GAT9901", "Deck for T3 Code": "5x3 20GBA9901", "Deck for T3 Code Mini": "3x2 20GAI9901", "Deck for T3 Code Neo": "4x2 20GBJ9901" });

	for (const p of PROFILES) {
		const [threads, actions] = layoutOf(p) as Record<string, { uuid: string; settings: KeySettings }>[];
		assert.equal(Object.keys(threads!).length, p.columns * p.rows);
		assert.equal(threads!["0,0"]!.uuid, "io.github.hsalazr.deck-for-t3code.back");
		assert.ok(Object.entries(threads!).every(([pos, a]) => pos === "0,0" || a.uuid === "io.github.hsalazr.deck-for-t3code.thread"));
		const at = (col: number, row: number) => actions![`${col},${row}`]!.settings.action;
		assert.equal(at(0, 0), "back");
		assert.equal(at(1, 0), "header");
		// Stop in the bottom-right corner, Settle right before it.
		assert.equal(at(p.columns - 1, p.rows - 1), "stop", p.file);
		assert.equal(at(p.columns - 2, p.rows - 1), "settle", p.file);
		const names = Object.values(actions!).map((a) => a.settings.action);
		for (const needed of ["snooze1h", "compact"]) assert.ok(names.includes(needed as never), `${p.file} has ${needed}`);
		const indices = Object.values(actions!).filter((a) => a.settings.action === "message").map((a) => a.settings.index);
		assert.deepEqual(indices, indices.map((_, i) => i), `${p.file}: messages numbered in reading order`);
	}
	const messages = (file: string) => Object.values(layoutOf(PROFILES.find((p: { file: string }) => p.file === file)) [1] as Record<string, { settings: KeySettings }>).filter((a) => a.settings.action === "message").length;
	assert.deepEqual([messages("Deck for T3 Code XL"), messages("Deck for T3 Code"), messages("Deck for T3 Code Neo"), messages("Deck for T3 Code Mini")], [21, 7, 2, 0]);
});

test("context watching covers the focused thread of the Thread Actions page, on screen or not", async () => {
	const tile = add("thread", fakeAction("tile", 1));
	monitor.setCards([card("t1"), card("t2")]);
	assert.deepEqual(monitor.deckThreads, ["t1"], "one Thread key shows one thread");
	deck.keyDown(tile.id);
	mock.timers.tick(600);
	await deck.keyUp(tile.id);
	await flush();
	// The device flips to the actions page: the Thread keys go away, the focus stays.
	deck.remove(tile.id);
	monitor.setCards([card("t1"), card("t2")]);
	assert.deepEqual(monitor.deckThreads, ["t1"], "the actions page's thread is still watched");
	// Settling it leaves the page; nothing is focused any more.
	deck.actionsEnabled = true;
	const settle = add("action", fakeAction("settle", 6, 3), { action: "settle" });
	deck.keyDown(settle.id);
	mock.timers.tick(CONFIRM_HOLD_MS);
	await flush();
	assert.deepEqual(monitor.deckThreads, []);
});

class FakeMachine extends EventEmitter {
	snapshot: MachineSnapshot | undefined;
	wanted: [boolean, string[]][] = [];
	setWanted(wanted: boolean, paths: ReadonlySet<string> = new Set()): void {
		this.wanted.push([wanted, [...paths].sort()]);
	}
}

test("machine keys: sampled only while shown, with the disks they show; taps open Activity Monitor or the disk", async () => {
	const machine = new FakeMachine();
	const d = new Deck(monitor as unknown as Monitor, new FakeUsage() as unknown as UsageMonitor, commands as unknown as ThreadCommands, host, machine as unknown as MachineMonitor);
	try {
		const summary = fakeAction("m1", 1);
		const load = fakeAction("m2", 2);
		const disk = fakeAction("m3", 3);
		d.add("machine", summary as never, {});
		d.add("machine", load as never, { stat: "load", path: "/Volumes/Ignored" }); // the old name for the CPU stat
		d.add("machine", disk as never, { stat: "disk", path: "/Volumes/Backup" });
		assert.deepEqual(machine.wanted.at(-1), [true, ["/", "/Volumes/Backup"]], "a CPU key reads no disk");
		await flush();
		assert.match(summary.last(), />Loading…</);

		machine.snapshot = { at: 0, load: [2, 2, 2], cpu: { chip: "M2", windowMs: 30_000, clusters: [{ kind: "P", cores: 4, busy: 10 }, { kind: "E", cores: 4, busy: 40 }] }, memory: { freePercent: 70, pressure: 1, totalBytes: 16e9 }, disks: new Map([["/", { totalBytes: 500e9, freeBytes: 100e9 }]]) };
		machine.emit("change", machine.snapshot);
		await flush();
		assert.match(summary.last(), />80%</);
		assert.match(load.last(), />M2 · 4P\+4E</);
		assert.match(disk.last(), />Loading…</, "its disk isn't in the sample yet");

		d.keyDown("m1");
		await d.keyUp("m1");
		d.keyDown("m3");
		await d.keyUp("m3");
		await flush();
		assert.deepEqual(host.opened, [["-b", "com.apple.ActivityMonitor"], ["/Volumes/Backup"]]);

		d.updateSettings("m3", { stat: "memory" });
		assert.deepEqual(machine.wanted.at(-1), [true, ["/"]]);
		for (const id of ["m1", "m2", "m3"]) d.remove(id);
		assert.deepEqual(machine.wanted.at(-1), [false, []]);
	} finally {
		d.dispose();
	}
});

class FakeUpdates extends EventEmitter {
	snapshot: UpdatesSnapshot = { ok: false, detail: "Loading…", providers: [], fetchedAt: 0 };
	wanted: boolean[] = [];
	refreshes = 0;
	setWanted(on: boolean): void {
		this.wanted.push(on);
	}
	refresh(): void {
		this.refreshes++;
	}
}

test("updates key: polled only while shown; a tap opens T3 Code when something is waiting, else checks again", async () => {
	const updates = new FakeUpdates();
	const d = new Deck(monitor as unknown as Monitor, new FakeUsage() as unknown as UsageMonitor, commands as unknown as ThreadCommands, host, undefined, updates as unknown as UpdatesMonitor);
	try {
		const key = fakeAction("u1", 1);
		d.add("updates", key as never, {});
		assert.equal(updates.wanted.at(-1), true);
		await flush();
		assert.match(key.last(), />Loading…</);

		updates.snapshot = { ok: true, fetchedAt: 1, t3: { name: "T3 Code", current: "0.1.7", latest: "0.1.7", available: false }, providers: [{ name: "Claude", current: "2.1.319", latest: "2.1.319", available: false }] };
		updates.emit("change", updates.snapshot);
		await flush();
		assert.match(key.last(), />✓ Up to date</);
		d.keyDown("u1");
		await d.keyUp("u1");
		assert.equal(updates.refreshes, 1);
		assert.deepEqual(host.opened, []);

		updates.snapshot = { ...updates.snapshot, t3: { name: "T3 Code", current: "0.1.7", latest: "0.1.8", available: true } };
		updates.emit("change", updates.snapshot);
		await flush();
		assert.match(key.last(), />T3 0.1.8</);
		d.keyDown("u1");
		await d.keyUp("u1");
		await flush();
		assert.deepEqual(host.opened, [["-b", "com.t3tools.t3code"]]);

		d.remove("u1");
		assert.equal(updates.wanted.at(-1), false);
	} finally {
		d.dispose();
	}
});

// ---------- Dictate key ----------

class FakeDictation implements DictationPort {
	sent: string[] = [];
	chordCalls = 0;
	chordError: Error | undefined;
	/** When set, each send waits for it. */
	gate: Promise<void> | undefined;
	/** Fails sends of these phases. */
	failWith = new Map<DictatePhase, Error>();
	async chord(): Promise<Chord> {
		this.chordCalls++;
		if (this.chordError) throw this.chordError;
		return { keyCode: 2, flags: 0x120000, label: "shift+cmd+d" };
	}
	async send(phase: DictatePhase, target: DictateTarget): Promise<void> {
		this.sent.push(`${phase}:${target.bundleId}:${target.chord.keyCode}`);
		await this.gate;
		const error = this.failWith.get(phase);
		if (error) throw error;
		this.sent.push(`${phase} done`);
	}
}

async function settle(rounds = 12): Promise<void> {
	for (let i = 0; i < rounds; i++) await flush();
}

function dictateKey(settings: KeySettings = {}, enabled = true) {
	const dictation = new FakeDictation();
	deck.attachDictation(dictation);
	deck.dictationEnabled = enabled;
	const key = add("dictate", fakeAction("mic", 3), settings);
	return { key, dictation };
}

test("dictate: off by default, the key says so, and a press runs nothing", async () => {
	const dictation = new FakeDictation();
	deck.attachDictation(dictation);
	const key = add("dictate", fakeAction("mic", 3));
	assert.match(key.last(), />Enable in</);
	await press(key, 100);
	await advance(1000);
	assert.deepEqual(host.opened, []);
	assert.deepEqual(dictation.sent, []);
	assert.equal(dictation.chordCalls, 0, "not even a lookup");
	assert.deepEqual(key.events, ["alert"]);
	// A held press does nothing either.
	deck.keyDown(key.id);
	await advance(600);
	await deck.keyUp(key.id);
	await settle();
	assert.deepEqual(dictation.sent, []);
	deck.dictationEnabled = true;
	assert.match(key.last(), />Dictate</);
	assert.equal(dictation.chordCalls, 0, "looked up on a press, not ahead of it");
});

test("dictate: a tap brings T3 Code forward and sends one quick press", async () => {
	const { key, dictation } = dictateKey();
	deck.keyDown(key.id);
	await settle();
	assert.deepEqual(host.opened, [["-b", "com.t3tools.t3code"]], "forward at key-down");
	assert.deepEqual(dictation.sent, [], "nothing sent until the press is decided");
	mock.timers.tick(DICTATE_TAP_MS - 50);
	await deck.keyUp(key.id);
	await settle();
	assert.deepEqual(dictation.sent, ["tap:com.t3tools.t3code:2", "tap done"]);
	assert.deepEqual(key.events, ["ok"]);
	assert.doesNotMatch(key.last(), /Holding/);
	// Every press looks the shortcut up again.
	await press(key, 50);
	await settle();
	assert.equal(dictation.chordCalls, 2);
});

test("dictate: held past the tap window, key-down then, key-up on release; the key says it is holding", async () => {
	const { key, dictation } = dictateKey();
	deck.keyDown(key.id);
	await advance(DICTATE_TAP_MS - 25);
	assert.deepEqual(dictation.sent, []);
	assert.doesNotMatch(key.last(), /Holding/);
	await advance(50);
	assert.deepEqual(dictation.sent, ["down:com.t3tools.t3code:2", "down done"]);
	assert.match(key.last(), />Holding</);
	assert.doesNotMatch(key.last(), /[Rr]ecording/, "never claims T3 Code is recording");
	await advance(2000);
	assert.deepEqual(dictation.sent, ["down:com.t3tools.t3code:2", "down done"], "nothing more while held");
	await deck.keyUp(key.id);
	await settle();
	assert.deepEqual(dictation.sent, ["down:com.t3tools.t3code:2", "down done", "up:com.t3tools.t3code:2", "up done"]);
	assert.doesNotMatch(key.last(), /Holding/);
	assert.deepEqual(key.events, ["ok"]);
});

test("dictate: a key-up never goes before its key-down, and a second press waits for the first", async () => {
	const { key, dictation } = dictateKey();
	let open!: () => void;
	dictation.gate = new Promise((resolve) => (open = resolve));
	// Held just past the window, let go while the key-down is still on its way.
	deck.keyDown(key.id);
	await advance(DICTATE_TAP_MS + 25);
	await deck.keyUp(key.id);
	// Then two quick taps.
	await press(key, 50);
	await press(key, 50);
	await settle();
	assert.deepEqual(dictation.sent, ["down:com.t3tools.t3code:2"], "the key-up and the taps wait for the key-down");
	open();
	await settle(30);
	assert.deepEqual(dictation.sent.filter((s) => !s.endsWith("done")), ["down:com.t3tools.t3code:2"], "the key-up waits out the minimum hold");
	await advance(MIN_HOLD_MS + 50);
	await settle(30);
	assert.deepEqual(
		dictation.sent.filter((s) => !s.endsWith("done")),
		["down:com.t3tools.t3code:2", "up:com.t3tools.t3code:2", "tap:com.t3tools.t3code:2", "tap:com.t3tools.t3code:2"],
	);
	// Each press brought T3 Code forward again first.
	assert.equal(host.opened.length, 3);
});

test("dictate: a key-down refused by the script skips the key-up; a failed tap alerts and logs", async () => {
	const { key, dictation } = dictateKey();
	dictation.failWith.set("down", new DictateRefusal("not-frontmost", "T3 Code wasn't the frontmost app"));
	deck.keyDown(key.id);
	await advance(DICTATE_TAP_MS + 50);
	assert.deepEqual(key.events, ["alert"]);
	assert.doesNotMatch(key.last(), /Holding/, "a failed press never shows Holding");
	await deck.keyUp(key.id);
	await advance(MIN_HOLD_MS + 50);
	await settle();
	assert.deepEqual(dictation.sent, ["down:com.t3tools.t3code:2"]);
	assert.equal(host.warnings.length, 1);
	assert.match(host.warnings[0]!, /dictate failed: T3 Code wasn't the frontmost app/);

	dictation.failWith.set("tap", new DictateRefusal("no-key", "no key on the current keyboard layout types \"d\""));
	await press(key, 50);
	await settle();
	assert.deepEqual(key.events, ["alert", "alert"]);
	assert.match(host.warnings[1]!, /keyboard layout/);
});

test("dictate: a key-down that may have been posted (timeout, crash) still gets its key-up on release", async () => {
	const { key, dictation } = dictateKey();
	dictation.failWith.set("down", new Error("osascript timed out after 5000 ms"));
	deck.keyDown(key.id);
	await advance(DICTATE_TAP_MS + 50);
	assert.deepEqual(key.events, ["alert"]);
	assert.doesNotMatch(key.last(), /Holding/);
	await advance(1000);
	await deck.keyUp(key.id);
	await settle();
	assert.deepEqual(dictation.sent, ["down:com.t3tools.t3code:2", "up:com.t3tools.t3code:2", "up done"]);
	assert.deepEqual(key.events, ["alert"], "no check mark for a press that failed");
});

test("dictate: let go right after the key-down went out, the key-up still waits out the minimum hold", async () => {
	const { key, dictation } = dictateKey();
	let open!: () => void;
	dictation.gate = new Promise((resolve) => (open = resolve));
	deck.keyDown(key.id);
	await advance(DICTATE_TAP_MS + 25);
	await deck.keyUp(key.id);
	await advance(500); // the key-down script is slow
	assert.deepEqual(dictation.sent, ["down:com.t3tools.t3code:2"]);
	dictation.gate = undefined;
	open();
	await settle();
	assert.deepEqual(dictation.sent, ["down:com.t3tools.t3code:2", "down done"], "released long ago, but the key-up waits");
	await advance(MIN_HOLD_MS - 50);
	assert.equal(dictation.sent.length, 2);
	await advance(100);
	assert.deepEqual(dictation.sent.slice(2), ["up:com.t3tools.t3code:2", "up done"]);
});

test("dictate: a press whose preparation failed never shows Holding, held or not", async () => {
	const { key, dictation } = dictateKey();
	dictation.chordError = new DictateRefusal("lookup-failed", "couldn't read T3 Code's dictation shortcut: socket closed");
	deck.keyDown(key.id);
	await advance(DICTATE_TAP_MS + 100);
	assert.doesNotMatch(key.last(), /Holding/);
	assert.deepEqual(key.events, ["alert"]);
	await advance(1000);
	assert.doesNotMatch(key.last(), /Holding/);
	await deck.keyUp(key.id);
	await settle();
	assert.deepEqual(dictation.sent, []);
	// The next press, which works, shows it again.
	dictation.chordError = undefined;
	deck.keyDown(key.id);
	await advance(DICTATE_TAP_MS + 100);
	assert.match(key.last(), />Holding</);
	await deck.keyUp(key.id);
	await advance(MIN_HOLD_MS + 50);
});

test("dictate: without Accessibility permission the key says where to allow it, for a few seconds", async () => {
	const { key, dictation } = dictateKey();
	dictation.failWith.set("tap", new DictateRefusal("not-permitted", "Stream Deck isn't allowed to post key events"));
	await press(key, 50);
	await settle();
	assert.match(key.last(), />Allow Stream</);
	assert.match(key.last(), />Accessibility</);
	assert.deepEqual(key.events, [], "the message is the feedback; no alert over it");
	assert.equal(host.warnings.length, 1);
	await advance(ALLOW_HINT_MS - 500, 250);
	assert.match(key.last(), />Accessibility</);
	await advance(1000, 250);
	assert.match(key.last(), />Dictate</);
	// The next press clears it at once.
	dictation.failWith.delete("tap");
	await press(key, 50);
	await settle();
	assert.doesNotMatch(key.last(), /Accessibility/);
});

test("dictate: with no bundle id (only t3code://), the key refuses, logs why and sends nothing", async () => {
	const { key, dictation } = dictateKey();
	host.app = ["t3code://new"];
	await press(key, 50);
	await settle();
	assert.deepEqual(host.opened, []);
	assert.deepEqual(dictation.sent, []);
	assert.deepEqual(key.events, ["alert"]);
	assert.match(host.warnings[0]!, /no T3 Code app to send the dictation shortcut to/);
	// A bundle id that isn't one is refused the same way.
	host.app = ["-b", "-x"];
	await press(key, 50);
	await settle();
	assert.deepEqual(dictation.sent, []);
	assert.deepEqual(key.events, ["alert", "alert"]);
});

test("dictate: no shortcut to send (none bound, or a key it can't press): T3 Code comes forward, nothing is sent", async () => {
	const { key, dictation } = dictateKey();
	dictation.chordError = new DictateRefusal("unmapped", "the dictation shortcut cmd+enter uses a key the Dictate key can't press");
	await press(key, 50);
	await settle();
	assert.deepEqual(host.opened, [["-b", "com.t3tools.t3code"]]);
	assert.deepEqual(dictation.sent, []);
	assert.deepEqual(key.events, ["alert"]);
	assert.match(host.warnings[0]!, /can't press/);
});

test("dictate: 'most urgent thread' opens that thread first, like the Overview key; none qualifying, T3 Code as is", async () => {
	const { key, dictation } = dictateKey({ dictateThread: "urgent" });
	monitor.setCards([card("t1", { state: "working", updatedAt: 5 }), card("t2", { state: "input", updatedAt: 1 })]);
	await press(key, 50);
	await settle();
	assert.deepEqual(host.opened, [["-b", "com.t3tools.t3code", "t3code://threads/env/t2"]]);
	assert.ok(monitor.calls.includes("ack:t2"));
	assert.deepEqual(dictation.sent, ["tap:com.t3tools.t3code:2", "tap done"]);

	monitor.setCards([card("t1", { state: "idle" })]);
	host.opened = [];
	await press(key, 50);
	await settle();
	assert.deepEqual(host.opened, [["-b", "com.t3tools.t3code"]]);

	// The default setting never opens a thread.
	deck.updateSettings(key.id, {});
	monitor.setCards([card("t2", { state: "input" })]);
	host.opened = [];
	await press(key, 50);
	await settle();
	assert.deepEqual(host.opened, [["-b", "com.t3tools.t3code"]]);
});

test("dictate: a key that goes away, or dictation turned off, mid-hold still lets go of the shortcut", async () => {
	const { key, dictation } = dictateKey();
	deck.keyDown(key.id);
	await advance(DICTATE_TAP_MS + 50);
	deck.dictationEnabled = false;
	await advance(MIN_HOLD_MS);
	assert.deepEqual(dictation.sent, ["down:com.t3tools.t3code:2", "down done", "up:com.t3tools.t3code:2", "up done"]);
	assert.match(key.last(), />Enable in</);
	await deck.keyUp(key.id);
	await settle();
	assert.equal(dictation.sent.length, 4, "the late key-up adds nothing");

	deck.dictationEnabled = true;
	deck.keyDown(key.id);
	await advance(DICTATE_TAP_MS + 50);
	deck.remove(key.id);
	await advance(MIN_HOLD_MS);
	assert.deepEqual(dictation.sent.slice(4), ["down:com.t3tools.t3code:2", "down done", "up:com.t3tools.t3code:2", "up done"]);
});

test("dictate: turned off while a tap waits for T3 Code, nothing is sent", async () => {
	const { key, dictation } = dictateKey();
	let release!: () => void;
	host.appGate = new Promise((resolve) => (release = resolve));
	await press(key, 50);
	deck.dictationEnabled = false;
	release();
	await settle();
	assert.deepEqual(dictation.sent, []);
	assert.deepEqual(key.events, []);
});
