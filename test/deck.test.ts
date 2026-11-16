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
import type { ScheduledMonitor } from "../src/t3/scheduled-monitor.ts";
import type { ScheduledSnapshot, ScheduledTask } from "../src/scheduled.ts";
import type { UpdatesSnapshot } from "../src/updates.ts";

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
	runScheduledTask(id: string) { return this.#record(`run:${id}`); }
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

const PR_URL = "https://git.example.com/acme/api/pulls/42";
const withPr = (extra: Partial<ThreadCard["pullRequest"] & object> = {}): Partial<ThreadCard> => ({ pullRequest: { number: 42, url: PR_URL, status: "failing", ...extra } });

test("Open key with a pull request: a tap still opens the thread, a hold opens the pull request in the browser", async () => {
	await focusedPage(withPr());
	const open = add("action", fakeAction("open", 2), { action: "open" });
	assert.ok(open.last().includes("PR #42") && open.last().includes("Checks failing"));
	host.opened = [];
	await press(open, 100);
	assert.deepEqual(host.opened, [["-b", "com.t3tools.t3code", "t3code://threads/env/t1"]], "tap: the thread");
	host.opened = [];
	monitor.calls = [];
	await press(open, CONFIRM_HOLD_MS + 50);
	assert.deepEqual(host.opened, [[PR_URL]], "hold: the pull request, as one argument");
	assert.deepEqual(monitor.calls, [], "reads and changes nothing in T3 Code, not even the highlight");
	assert.deepEqual(commands.sent, []);
	assert.deepEqual(open.events, []);
});

test("Open key: the hold works with thread actions off", async () => {
	await focusedPage(withPr());
	deck.actionsEnabled = false;
	const open = add("action", fakeAction("open", 2), { action: "open" });
	host.opened = [];
	await press(open, CONFIRM_HOLD_MS + 50);
	assert.deepEqual(host.opened, [[PR_URL]]);
});

test("Open key: holding shows the usual progress, and with the last (merged) pull request when none is open", async () => {
	await focusedPage(withPr({ status: "merged" }));
	const open = add("action", fakeAction("open", 2), { action: "open" });
	assert.ok(open.last().includes("Last: merged"));
	deck.keyDown(open.id);
	mock.timers.tick(400);
	await flush();
	assert.ok(open.last().includes('id="hold-progress"') && open.last().includes("Hold to open"));
	mock.timers.tick(CONFIRM_HOLD_MS);
	await deck.keyUp(open.id);
	await flush();
	assert.deepEqual(host.opened.at(-1), [PR_URL]);
});

test("Open key: a link that isn't a plain web link is never opened, and the key doesn't offer it", async () => {
	for (const url of ["javascript:alert(1)", "file:///etc/passwd", "-b com.evil.app", "https://user:pw@git.example.com/x", `https://git.example.com/${"a".repeat(2100)}`, "not a url", ""]) {
		host.opened = [];
		const key = await (async () => {
			await focusedPage(withPr({ url }));
			return add("action", fakeAction(`open-${host.opened.length}-${url.length}`, 2), { action: "open" });
		})();
		assert.ok(!key.last().includes("PR #42"), `not offered: ${url.slice(0, 30)}`);
		host.opened = [];
		await press(key, CONFIRM_HOLD_MS + 50);
		assert.deepEqual(host.opened, [["-b", "com.t3tools.t3code", "t3code://threads/env/t1"]], `held: a long press is only a tap: ${url.slice(0, 30)}`);
	}
});

test("Open key without a pull request: unchanged, and a hold opens nothing", async () => {
	await focusedPage();
	const open = add("action", fakeAction("open", 2), { action: "open" });
	assert.ok(open.last().includes("in T3 Code") && !open.last().includes("PR #"));
	host.opened = [];
	await press(open, CONFIRM_HOLD_MS + 50);
	assert.deepEqual(host.opened, [["-b", "com.t3tools.t3code", "t3code://threads/env/t1"]], "a long press is only a tap");
});

test("Open key: a pull request that fails to open raises the alert", async () => {
	await focusedPage(withPr());
	const open = add("action", fakeAction("open", 2), { action: "open" });
	host.openFails = true;
	await press(open, CONFIRM_HOLD_MS + 50);
	await flush();
	assert.deepEqual(open.events, ["alert"]);
});

class FakeScheduled extends EventEmitter {
	snapshot: ScheduledSnapshot = { state: "loading", tasks: [] };
	wanted: boolean[] = [];
	setWanted(on: boolean): void {
		this.wanted.push(on);
	}
	set(snapshot: ScheduledSnapshot): void {
		this.snapshot = snapshot;
		this.emit("change", snapshot);
	}
}

/** Mock time starts at 1 000 000 ms. */
const sched = (extra: Partial<ScheduledTask> = {}): ScheduledTask => ({
	id: "task-1", title: "Nightly dependency check", enabled: true, schedule: { kind: "interval", everyMs: 7_200_000 }, threadId: null,
	nextRunAt: 1_000_000 + 135 * 60_000 + 30_000, lastRunAt: 1_000_000 - 3_600_000, lastRunStatus: "succeeded", blocked: false, ...extra,
});

function scheduledDeck(scheduled: FakeScheduled, settings: KeySettings = {}) {
	const d = new Deck(monitor as unknown as Monitor, new FakeUsage() as unknown as UsageMonitor, commands as unknown as ThreadCommands, host, undefined, undefined, scheduled as unknown as ScheduledMonitor);
	const key = fakeAction("s1", 1);
	d.add("scheduled", key as never, settings);
	return { d, key };
}

test("scheduled key: the stream is open only while one is on a deck", async () => {
	const scheduled = new FakeScheduled();
	const { d } = scheduledDeck(scheduled);
	try {
		assert.equal(scheduled.wanted.at(-1), true);
		d.add("scheduled", fakeAction("s2", 2) as never, {});
		d.remove("s1");
		assert.equal(scheduled.wanted.at(-1), true, "another is still shown");
		d.remove("s2");
		assert.equal(scheduled.wanted.at(-1), false);
		d.add("usage", fakeAction("u", 3) as never, {});
		assert.equal(scheduled.wanted.at(-1), false, "other keys don't open it");
	} finally {
		d.dispose();
	}
});

test("scheduled key: loading, no tasks, a task, the task going away, T3 unreachable, the stream dropping", async () => {
	const scheduled = new FakeScheduled();
	const { d, key } = scheduledDeck(scheduled, { task: "task-1" });
	try {
		await flush();
		assert.match(key.last(), />Loading…</);
		scheduled.set({ state: "live", tasks: [] });
		await flush();
		assert.match(key.last(), />No scheduled</);
		scheduled.set({ state: "live", tasks: [sched()] });
		await flush();
		assert.match(key.last(), />2h 15m</);
		assert.match(key.last(), />Nightly</);
		scheduled.set({ state: "live", tasks: [sched({ id: "other" })] });
		await flush();
		assert.match(key.last(), />Task not found</);
		scheduled.set({ state: "live", tasks: [sched()] });
		monitor.setCards([], { kind: "offline", detail: "", reason: "not-running" });
		await flush();
		assert.match(key.last(), />Open T3 Code</);
		assert.ok(!key.last().includes("Nightly"), "no task state while T3 is unreachable");
		monitor.setCards([], { kind: "ok" });
		scheduled.set({ state: "down", tasks: [] });
		await flush();
		assert.match(key.last(), />unavailable</);
		assert.ok(!key.last().includes("Nightly"));
	} finally {
		d.dispose();
	}
});

test("scheduled key: with no task chosen it follows whichever runs next", async () => {
	const scheduled = new FakeScheduled();
	const { d, key } = scheduledDeck(scheduled);
	try {
		scheduled.set({ state: "live", tasks: [sched({ id: "later", title: "Weekly report", nextRunAt: 1_000_000 + 5 * 3_600_000 }), sched({ id: "sooner", title: "Cache sweep", nextRunAt: 1_000_000 + 20 * 60_000 })] });
		await flush();
		assert.match(key.last(), />Cache sweep</);
		assert.match(key.last(), />20m</);
		d.updateSettings("s1", { task: "later" });
		await flush();
		assert.match(key.last(), />Weekly report</);
		assert.deepEqual(d.scheduledTasks().map((t) => [t.id, t.title, t.schedule]), [["later", "Weekly report", "every 2h"], ["sooner", "Cache sweep", "every 2h"]]);
		assert.ok(!JSON.stringify(d.scheduledTasks()).includes("prompt"));
	} finally {
		d.dispose();
	}
});

test("scheduled key: the countdown redraws on the minute from the deck's own frame clock, with no timer per key", async () => {
	const scheduled = new FakeScheduled();
	const { d, key } = scheduledDeck(scheduled);
	try {
		scheduled.set({ state: "live", tasks: [sched()] });
		await flush();
		assert.match(key.last(), />2h 15m</);
		const drawn = key.images.length;
		await advance(29_000);
		assert.equal(key.images.length, drawn, "nothing redrawn mid-minute");
		await advance(2_000);
		assert.match(key.last(), />2h 14m</);
		assert.equal(key.images.length, drawn + 1);
		await advance(60_000);
		assert.match(key.last(), />2h 13m</);
		scheduled.set({ state: "live", tasks: [sched({ nextRunAt: null, enabled: false })] });
		await flush();
		const idle = key.images.length;
		await advance(10 * 60_000);
		assert.equal(key.images.length, idle, "a static key stops the clock");
	} finally {
		d.dispose();
	}
});

test("scheduled key: a tap opens the task's thread when the plugin knows it, else brings T3 Code forward", async () => {
	const scheduled = new FakeScheduled();
	const { d, key } = scheduledDeck(scheduled);
	try {
		// No tasks at all: T3 Code.
		scheduled.set({ state: "live", tasks: [] });
		d.keyDown("s1");
		await d.keyUp("s1");
		await flush();
		assert.deepEqual(host.opened.splice(0), [["-b", "com.t3tools.t3code"]]);

		// A task with a thread the monitor knows: that thread.
		monitor.setCards([card("t1", { state: "done" })]);
		scheduled.set({ state: "live", tasks: [sched({ threadId: "t1" })] });
		d.keyDown("s1");
		mock.timers.tick(100);
		await d.keyUp("s1");
		await flush();
		assert.deepEqual(host.opened.splice(0), [["-b", "com.t3tools.t3code", "t3code://threads/env/t1"]]);
		assert.deepEqual(monitor.calls, ["ack:t1"]);

		// A thread the plugin doesn't know, or none yet (new thread each run): T3 Code.
		scheduled.set({ state: "live", tasks: [sched({ threadId: "unknown-thread" })] });
		d.keyDown("s1");
		await d.keyUp("s1");
		await flush();
		scheduled.set({ state: "live", tasks: [sched({ threadId: null })] });
		d.keyDown("s1");
		await d.keyUp("s1");
		await flush();
		assert.deepEqual(host.opened.splice(0), [["-b", "com.t3tools.t3code"], ["-b", "com.t3tools.t3code"]]);

		// T3 offline: T3 Code, never a stale thread.
		scheduled.set({ state: "live", tasks: [sched({ threadId: "t1" })] });
		monitor.setCards([card("t1")], { kind: "offline", detail: "", reason: "not-running" });
		d.keyDown("s1");
		await d.keyUp("s1");
		await flush();
		assert.deepEqual(host.opened.splice(0), [["-b", "com.t3tools.t3code"]]);
		assert.deepEqual(commands.sent, []);
		assert.deepEqual(key.events, []);
	} finally {
		d.dispose();
	}
});

test("scheduled key: holding 0.8 s runs the task now, only with thread actions on", async () => {
	const scheduled = new FakeScheduled();
	const { d, key } = scheduledDeck(scheduled);
	try {
		scheduled.set({ state: "live", tasks: [sched({ threadId: "t1" })] });
		monitor.setCards([card("t1")]);

		// Actions off (the default): holding shows where to turn them on, runs nothing, opens nothing.
		d.keyDown("s1");
		mock.timers.tick(300);
		await flush();
		assert.match(key.last(), />Enable in settings</);
		mock.timers.tick(CONFIRM_HOLD_MS);
		await d.keyUp("s1");
		await flush();
		assert.deepEqual(commands.sent, []);
		assert.deepEqual(host.opened, []);
		assert.deepEqual(key.events, ["alert"]);

		// Actions on: the hold shows its progress, then fires once.
		d.actionsEnabled = true;
		key.events.length = 0;
		d.keyDown("s1");
		mock.timers.tick(100);
		await flush();
		assert.ok(!key.last().includes("Hold to run now"), "a quick tap shows no cue yet");
		await advance(400);
		assert.match(key.last(), />Hold to run now</);
		assert.match(key.last(), /hold-progress/);
		assert.deepEqual(commands.sent, [], "not yet");
		await advance(400);
		assert.deepEqual(commands.sent, ["run:task-1"]);
		await d.keyUp("s1");
		await flush();
		assert.deepEqual(commands.sent, ["run:task-1"], "the key-up after a hold does nothing more");
		assert.deepEqual(host.opened, [], "and doesn't open the thread");
		assert.deepEqual(key.events, ["ok"]);
	} finally {
		d.dispose();
	}
});

test("scheduled key: letting go before 0.8 s after the cue cancels; a short tap still opens", async () => {
	const scheduled = new FakeScheduled();
	const { d, key } = scheduledDeck(scheduled);
	try {
		d.actionsEnabled = true;
		scheduled.set({ state: "live", tasks: [sched()] });
		d.keyDown("s1");
		mock.timers.tick(500);
		await d.keyUp("s1");
		await flush();
		assert.deepEqual(commands.sent, []);
		assert.deepEqual(host.opened, []);
		assert.deepEqual(key.events, []);
		assert.ok(!key.last().includes("Hold to run now"), "the cue goes away");
		d.keyDown("s1");
		mock.timers.tick(100);
		await d.keyUp("s1");
		await flush();
		assert.deepEqual(host.opened, [["-b", "com.t3tools.t3code"]]);
	} finally {
		d.dispose();
	}
});

test("scheduled key: nothing to run for a webhook task, one already running, or while T3 or the stream is down", async () => {
	const scheduled = new FakeScheduled();
	const { d, key } = scheduledDeck(scheduled);
	try {
		d.actionsEnabled = true;
		const holdIt = async () => {
			d.keyDown("s1");
			await advance(CONFIRM_HOLD_MS + 100);
			await d.keyUp("s1");
			await flush();
		};
		scheduled.set({ state: "live", tasks: [sched({ schedule: { kind: "webhook" }, nextRunAt: null })] });
		await holdIt();
		scheduled.set({ state: "live", tasks: [sched({ lastRunStatus: "running" })] });
		await holdIt();
		scheduled.set({ state: "down", tasks: [] });
		await holdIt();
		scheduled.set({ state: "live", tasks: [sched()] });
		monitor.setCards([], { kind: "offline", detail: "", reason: "not-running" });
		await holdIt();
		assert.deepEqual(commands.sent, []);
		assert.deepEqual(key.events, []);
	} finally {
		d.dispose();
	}
});

test("scheduled key: a second hold on the same task while the first is in flight sends once; a failure alerts", async () => {
	const scheduled = new FakeScheduled();
	const { d, key } = scheduledDeck(scheduled);
	try {
		d.actionsEnabled = true;
		scheduled.set({ state: "live", tasks: [sched()] });
		let release!: () => void;
		commands.gate = new Promise<void>((resolve) => (release = resolve));
		for (let i = 0; i < 2; i++) {
			d.keyDown("s1");
			await advance(CONFIRM_HOLD_MS + 50);
			await d.keyUp("s1");
		}
		assert.deepEqual(commands.sent, ["run:task-1"]);
		release();
		await flush();
		commands.gate = undefined;
		commands.runScheduledTask = () => Promise.reject(new Error("Could not run schedule task."));
		d.keyDown("s1");
		await advance(CONFIRM_HOLD_MS + 50);
		await d.keyUp("s1");
		await flush();
		assert.ok(key.events.includes("alert"));
		assert.match(host.warnings.at(-1) ?? "", /scheduled failed: Could not run schedule task/);
	} finally {
		d.dispose();
	}
});

test("scheduled key: a hold never runs a task other than the one the press started on", async () => {
	const scheduled = new FakeScheduled();
	const { d, key } = scheduledDeck(scheduled);
	try {
		d.actionsEnabled = true;
		const sweep = sched({ id: "sweep", title: "Cache sweep", nextRunAt: 1_000_000 + 60_000 });
		const report = sched({ id: "report", title: "Weekly report", nextRunAt: 1_000_000 + 3_600_000 });
		scheduled.set({ state: "live", tasks: [sweep, report] });
		await flush();
		assert.match(key.last(), />Cache sweep</, "whichever runs next");
		d.keyDown("s1");
		await advance(400);
		assert.match(key.last(), />Hold to run now</);
		// T3 starts the sweep's own run mid-hold, so the key moves on to the report.
		scheduled.set({ state: "live", tasks: [{ ...sweep, lastRunStatus: "running", nextRunAt: 1_000_000 + 2 * 3_600_000 }, report] });
		await flush();
		assert.match(key.last(), />Weekly report</);
		assert.ok(!key.last().includes("Hold to run now"), "no cue for a task the press didn't start on");
		assert.ok(!key.last().includes("hold-progress"));
		await advance(500);
		assert.deepEqual(commands.sent, [], "the report is not run");
		assert.deepEqual(key.events, ["alert"]);
		await d.keyUp("s1");
		await flush();
		assert.deepEqual(commands.sent, []);
		assert.deepEqual(host.opened, [], "and letting go is not a tap");
	} finally {
		d.dispose();
	}
});

test("scheduled key: a task that becomes runnable mid-press gets no cue and no run", async () => {
	const scheduled = new FakeScheduled();
	const { d, key } = scheduledDeck(scheduled);
	try {
		d.actionsEnabled = true;
		scheduled.set({ state: "live", tasks: [sched({ lastRunStatus: "running" })] });
		await flush();
		d.keyDown("s1");
		await advance(300);
		// Its run ends while the key is down: nothing was armed at key-down, so nothing may fill or fire.
		scheduled.set({ state: "live", tasks: [sched()] });
		await flush();
		assert.ok(!key.last().includes("Hold to run now"));
		assert.ok(!key.last().includes("hold-progress"));
		await advance(700);
		assert.deepEqual(commands.sent, []);
		assert.deepEqual(key.events, []);
	} finally {
		d.dispose();
	}
});
