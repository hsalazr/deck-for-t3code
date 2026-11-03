import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, mock, test } from "node:test";

import { DeviceType } from "@elgato/streamdeck";

import { CONFIRM_HOLD_MS, Deck, type DeckHost, type KeyKind, type KeySettings } from "../src/deck.ts";
import type { ThreadCard } from "../src/model.ts";
import type { ThreadCommands } from "../src/t3/commands.ts";
import type { Connection, Monitor, Snapshot } from "../src/t3/monitor.ts";
import type { UsageMonitor } from "../src/t3/usage-monitor.ts";

const card = (id: string, extra: Partial<ThreadCard> = {}): ThreadCard => ({
	threadId: id, projectId: "p", title: `Thread ${id}`, link: `http://127.0.0.1:3773/env/${id}`, state: "idle", ownStatus: "completed",
	subagentsWorking: 0, subagentsWaiting: 0, background: 0, inputFromSubagent: false, ackKey: "", updatedAt: 0, createdAt: 0, ...extra,
});

class FakeMonitor extends EventEmitter {
	snapshot: Snapshot = { connection: { kind: "ok" }, cards: new Map(), visible: [], projectNames: new Map([["p", "proj"]]) };
	calls: string[] = [];
	deckThreads: string[] = [];
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
	warnings: string[] = [];
	async switchToProfile(deviceId: string, profile?: string, page?: number): Promise<void> {
		this.switches.push(`${deviceId}:${profile ?? "previous"}:${page ?? ""}`);
	}
	async open(args: string[]): Promise<void> {
		this.opened.push(args);
		if (this.openFails) throw new Error("no such app");
	}
	warn(message: string): void {
		this.warnings.push(message);
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

test("thread tile: tap opens, long press shows a release cue and opens actions on release", async () => {
	const tile = add("thread", fakeAction("tile", 1));
	monitor.setCards([card("t1", { state: "done" })]);
	await press(tile, 100);
	assert.deepEqual(host.opened, [["t3code://threads/env/t1"]]);
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
	assert.deepEqual(host.opened.at(-1), ["t3code://threads/env/t1"]);
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

test("offline: the first Thread key says why, the rest are blank; a tap opens T3", async () => {
	const a = add("thread", fakeAction("a", 1));
	const b = add("thread", fakeAction("b", 2));
	monitor.setCards([], { kind: "offline", detail: "", reason: "not-running" });
	assert.ok(a.last().includes("Open T3 Code"));
	assert.ok(!b.last().includes("<text"));
	await press(b, 100);
	assert.deepEqual(host.opened, [["-b", "com.t3tools.t3code"]]);
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
