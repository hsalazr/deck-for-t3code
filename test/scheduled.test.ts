import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { afterEach, mock, test } from "node:test";

import { checkSvg } from "./assets.test.ts";
import { MIN_FONT_PX, faceOf, nextScheduledFrame, renderScheduledKey, type ScheduledKeyInput } from "../src/render.ts";
import {
	agoText,
	canRunNow,
	countdownText,
	nextAgoChange,
	nextCountdownChange,
	parseTask,
	parseTaskList,
	pickTask,
	scheduleText,
	type ScheduledTask,
} from "../src/scheduled.ts";
import { TokenStore } from "../src/t3/auth.ts";
import type { RpcAccess } from "../src/t3/rpc.ts";
import { ScheduledMonitor, runScheduledTaskNow } from "../src/t3/scheduled-monitor.ts";
import { formatDuration } from "../src/usage.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;

/** What T3's schema says a task looks like (invented values). The prompt must never get past the parser. */
const raw = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	id: "task-1",
	title: "Nightly dependency check",
	prompt: "SECRET-PROMPT: look in /home/acme/.env",
	enabled: true,
	schedule: { type: "interval", everyMs: 2 * HOUR },
	projectId: "proj-1",
	threadId: null,
	threadMode: "new_thread",
	nextRunAt: iso(2 * HOUR),
	lastRunAt: iso(-HOUR),
	lastRunStatus: "succeeded",
	lastRunError: null,
	runCount: 4,
	...extra,
});

const task = (extra: Partial<ScheduledTask> = {}): ScheduledTask => ({
	id: "task-1", title: "Nightly dependency check", enabled: true, schedule: { kind: "interval", everyMs: 2 * HOUR }, threadId: null,
	nextRunAt: NOW + 135 * MIN, lastRunAt: NOW - 3 * HOUR, lastRunStatus: "succeeded", blocked: false, ...extra,
});

// ---------------------------------------------------------------- parsing

test("a full task parses, and its prompt and error text are never kept", () => {
	const t = parseTask(raw({ lastRunError: "boom: token abc123" }))!;
	assert.deepEqual(t, {
		id: "task-1", title: "Nightly dependency check", enabled: true, schedule: { kind: "interval", everyMs: 2 * HOUR }, threadId: null,
		nextRunAt: NOW + 2 * HOUR, lastRunAt: NOW - HOUR, lastRunStatus: "succeeded", blocked: false,
	});
	const text = JSON.stringify(t);
	assert.ok(!text.includes("SECRET-PROMPT") && !text.includes("abc123"));
});

test("every schedule variant", () => {
	assert.deepEqual(parseTask(raw({ schedule: { type: "interval", everyMs: 90 * MIN } }))!.schedule, { kind: "interval", everyMs: 90 * MIN });
	assert.deepEqual(parseTask(raw({ schedule: { type: "fixed_time", timeOfDay: "9:05" } }))!.schedule, { kind: "fixed_time", timeOfDay: "09:05" });
	assert.deepEqual(parseTask(raw({ schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1, 1, 9, "x", 3] } }))!.schedule, { kind: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3, 5] });
	assert.deepEqual(parseTask(raw({ schedule: { type: "once", runAt: iso(HOUR) } }))!.schedule, { kind: "once" });
	assert.deepEqual(parseTask(raw({ schedule: { type: "webhook", signature: null, filters: [] }, nextRunAt: null }))!.schedule, { kind: "webhook" });
	assert.deepEqual(parseTask(raw({ schedule: { type: "from_the_future" } }))!.schedule, { kind: "unknown" });
});

test("every run status; an unknown or missing one is 'unknown', not guessed", () => {
	for (const status of ["never", "running", "succeeded", "failed"]) assert.equal(parseTask(raw({ lastRunStatus: status }))!.lastRunStatus, status);
	assert.equal(parseTask(raw({ lastRunStatus: "paused-by-aliens" }))!.lastRunStatus, "unknown");
	assert.equal(parseTask(raw({ lastRunStatus: undefined }))!.lastRunStatus, "unknown");
});

test("missing and malformed fields never throw and never invent state", () => {
	assert.equal(parseTask(null), null);
	assert.equal(parseTask("task"), null);
	assert.equal(parseTask([]), null);
	assert.equal(parseTask({ title: "no id" }), null);
	assert.equal(parseTask({ id: "" }), null);
	assert.equal(parseTask({ id: 7 }), null);
	const bare = parseTask({ id: "x" })!;
	assert.equal(bare.title, "Scheduled task");
	assert.equal(bare.enabled, true);
	assert.deepEqual(bare.schedule, { kind: "unknown" });
	assert.equal(bare.threadId, null);
	assert.equal(bare.nextRunAt, null);
	assert.equal(bare.lastRunAt, null);
	assert.equal(bare.blocked, false);
	const odd = parseTask({
		id: "y", title: 42, enabled: "yes", schedule: { type: "interval", everyMs: -5 }, threadId: 12, nextRunAt: "not a date", lastRunAt: {}, blockedByPolicy: 7,
	})!;
	assert.equal(odd.title, "Scheduled task");
	assert.equal(odd.enabled, true, "only an explicit false pauses");
	assert.deepEqual(odd.schedule, { kind: "interval" });
	assert.equal(odd.threadId, null);
	assert.equal(odd.nextRunAt, null);
	assert.equal(odd.lastRunAt, null);
	assert.equal(odd.blocked, false);
	assert.equal(parseTask(raw({ enabled: false }))!.enabled, false);
	assert.equal(parseTask(raw({ blockedByPolicy: "Your organisation blocks webhook tasks." }))!.blocked, true);
	assert.equal(parseTask(raw({ threadId: "thread-9" }))!.threadId, "thread-9");
	assert.deepEqual(parseTask(raw({ schedule: { type: "fixed_time", timeOfDay: "25:99", weekdays: "daily" } }))!.schedule, { kind: "fixed_time" });
});

test("a stream item is the whole list: empty is a real answer, junk is not", () => {
	assert.deepEqual(parseTaskList({ tasks: [] }), []);
	assert.equal(parseTaskList({}), null);
	assert.equal(parseTaskList({ tasks: "nope" }), null);
	assert.equal(parseTaskList(null), null);
	assert.equal(parseTaskList([]), null);
	const list = parseTaskList({ tasks: [raw(), null, { title: "no id" }, raw({ id: "task-2", title: "Weekly report" }), raw({ title: "same id again" })], extra: true })!;
	assert.deepEqual(list.map((t) => t.id), ["task-1", "task-2"]);
	assert.equal(list[0]!.title, "Nightly dependency check");
});

// ---------------------------------------------------------------- picking and wording

test("default task: whichever runs next, among enabled tasks that aren't blocked", () => {
	const a = task({ id: "a", title: "A", nextRunAt: NOW + 3 * HOUR });
	const b = task({ id: "b", title: "B", nextRunAt: NOW + HOUR });
	const paused = task({ id: "c", title: "C", enabled: false, nextRunAt: NOW + MIN });
	const blocked = task({ id: "d", title: "D", blocked: true, nextRunAt: NOW + 2 * MIN });
	const hook = task({ id: "e", title: "E", schedule: { kind: "webhook" }, nextRunAt: null });
	assert.equal(pickTask([a, b, paused, blocked, hook], undefined).task?.id, "b");
	// Ties break on id, so the key doesn't flip between two equal tasks.
	assert.equal(pickTask([task({ id: "z", nextRunAt: NOW + HOUR }), task({ id: "y", nextRunAt: NOW + HOUR })], undefined).task?.id, "y");
});

test("default task with nothing upcoming: a running one, then an enabled one, then the first by title", () => {
	const hook = task({ id: "h", title: "Hook", schedule: { kind: "webhook" }, nextRunAt: null });
	const off = task({ id: "o", title: "Aardvark", enabled: false, nextRunAt: null });
	const running = task({ id: "r", title: "Zed", nextRunAt: null, lastRunStatus: "running" });
	assert.equal(pickTask([off, hook, running], undefined).task?.id, "r");
	assert.equal(pickTask([off, hook], undefined).task?.id, "h");
	assert.equal(pickTask([off, task({ id: "p", title: "Beta", enabled: false, nextRunAt: null })], undefined).task?.id, "o");
});

test("a chosen task is that task or 'missing', never another; no tasks is 'none'", () => {
	const a = task({ id: "a" });
	assert.equal(pickTask([a, task({ id: "b" })], "b").task?.id, "b");
	assert.deepEqual(pickTask([a], "gone"), { task: undefined, reason: "missing" });
	assert.deepEqual(pickTask([], undefined), { task: undefined, reason: "none" });
	assert.deepEqual(pickTask([], "a"), { task: undefined, reason: "none" });
});

test("run now: not for webhook tasks (T3 refuses them) or one already running", () => {
	assert.equal(canRunNow(task()), true);
	assert.equal(canRunNow(task({ enabled: false })), true, "T3's own Run now works on a paused task too");
	assert.equal(canRunNow(task({ schedule: { kind: "webhook" } })), false);
	assert.equal(canRunNow(task({ lastRunStatus: "running" })), false);
});

test("schedule wording", () => {
	assert.equal(scheduleText({ kind: "interval", everyMs: 2 * HOUR }), "every 2h");
	assert.equal(scheduleText({ kind: "interval", everyMs: 30 * MIN }), "every 30m");
	assert.equal(scheduleText({ kind: "interval", everyMs: 90 * MIN }), "every 1h 30m");
	assert.equal(scheduleText({ kind: "interval", everyMs: 48 * HOUR }), "every 2d");
	assert.equal(scheduleText({ kind: "interval", everyMs: 30_000 }), "every 30s");
	assert.equal(scheduleText({ kind: "interval" }), "repeats");
	assert.equal(scheduleText({ kind: "fixed_time", timeOfDay: "09:00" }), "daily 09:00");
	assert.equal(scheduleText({ kind: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }), "daily 09:00");
	assert.equal(scheduleText({ kind: "fixed_time", timeOfDay: "08:30", weekdays: [1, 2, 3, 4, 5] }), "weekdays 08:30");
	assert.equal(scheduleText({ kind: "fixed_time", timeOfDay: "08:30", weekdays: [0, 6] }), "weekends 08:30");
	assert.equal(scheduleText({ kind: "fixed_time", timeOfDay: "08:30", weekdays: [1, 3] }), "Mon Wed 08:30");
	assert.equal(scheduleText({ kind: "fixed_time" }), "daily");
	assert.equal(scheduleText({ kind: "once" }), "once");
	assert.equal(scheduleText({ kind: "webhook" }), "webhook");
	assert.equal(scheduleText({ kind: "unknown" }), "scheduled");
});

test("countdown text and when it next changes (on the minute, not on a timer per key)", () => {
	assert.equal(countdownText(135 * MIN, formatDuration), "2h 15m");
	assert.equal(countdownText(59_999, formatDuration), "<1m");
	assert.equal(countdownText(60_000, formatDuration), "1m");
	assert.equal(countdownText(0, formatDuration), "Due now");
	assert.equal(countdownText(-5000, formatDuration), "Due now");
	// 2h 15m 30s left: the text becomes "2h 14m" once the remaining time drops below 2h 15m.
	const next = nextCountdownChange(NOW + 135 * MIN + 30_000, NOW)!;
	assert.equal(countdownText(NOW + 135 * MIN + 30_000 - (next - 1), formatDuration), "2h 15m");
	assert.equal(countdownText(NOW + 135 * MIN + 30_000 - next, formatDuration), "2h 14m");
	// Exactly on a minute edge: the next change is a millisecond away, then a minute.
	assert.equal(nextCountdownChange(NOW + 5 * MIN, NOW), NOW + 1);
	// Inside the last minute: the due moment. Overdue: static.
	assert.equal(nextCountdownChange(NOW + 40_000, NOW), NOW + 40_000);
	assert.equal(nextCountdownChange(NOW - 1, NOW), undefined);
});

test("'ago' text and when it next changes", () => {
	assert.equal(agoText(10_000), "just now");
	assert.equal(agoText(5 * MIN + 1), "5m ago");
	assert.equal(agoText(3 * HOUR), "3h ago");
	assert.equal(agoText(49 * HOUR), "2d ago");
	assert.equal(agoText(-1), "just now", "a clock a little behind T3's never shows a negative");
	assert.equal(nextAgoChange(NOW - 90_000, NOW), NOW - 90_000 + 2 * MIN);
	assert.equal(nextAgoChange(NOW - 3 * HOUR - 5 * MIN, NOW), NOW - 3 * HOUR - 5 * MIN + 4 * HOUR);
	assert.equal(nextAgoChange(NOW - 30 * HOUR, NOW), NOW - 30 * HOUR + 2 * 86_400_000);
});

// ---------------------------------------------------------------- rendering

const ok = { kind: "ok" } as const;
const view = (t: ScheduledTask | undefined, extra: Partial<ScheduledKeyInput> = {}): string =>
	renderScheduledKey({ connection: ok, stream: "live", pick: t ? { task: t } : { task: undefined, reason: "none" }, now: NOW, animation: "smooth", ...extra });
const fontSizes = (svg: string): number[] => [...svg.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]));

const STATES: [string, ScheduledTask | undefined, Partial<ScheduledKeyInput>][] = [
	["counting down", task(), {}],
	["daily", task({ schedule: { kind: "fixed_time", timeOfDay: "09:00", weekdays: [] } }), {}],
	["due now", task({ nextRunAt: NOW - 1000 }), {}],
	["running", task({ lastRunStatus: "running" }), {}],
	["failed", task({ lastRunStatus: "failed", lastRunAt: NOW - 25 * MIN }), {}],
	["never run", task({ lastRunStatus: "never", lastRunAt: null }), {}],
	["unknown status", task({ lastRunStatus: "unknown" }), {}],
	["disabled", task({ enabled: false, nextRunAt: null }), {}],
	["blocked", task({ schedule: { kind: "webhook" }, blocked: true, nextRunAt: null }), {}],
	["webhook", task({ schedule: { kind: "webhook" }, nextRunAt: null }), {}],
	["once, finished", task({ schedule: { kind: "once" }, nextRunAt: null }), {}],
	["no next run", task({ nextRunAt: null }), {}],
	["very long title", task({ title: "Rebuild the search index for every acme-web tenant before the nightly backup window opens" }), {}],
	["hold to run", task(), { cue: { kind: "run", progress: 0.5 } }],
	["hold, actions off", task(), { cue: { kind: "enable" } }],
	["no tasks", undefined, {}],
	["task gone", undefined, { pick: { task: undefined, reason: "missing" } }],
	["loading", undefined, { stream: "loading" }],
	["stream down", undefined, { stream: "down" }],
	["T3 offline", undefined, { connection: { kind: "offline", detail: "", reason: "not-running" } }],
];

test("every state, in both looks, is well-formed SVG with no text under 14 px", () => {
	for (const style of ["detailed", "glance"] as const) {
		for (const [name, t, extra] of STATES) {
			const svg = view(t, { style, ...extra });
			assert.deepEqual(checkSvg(svg), [], `${style} ${name}`);
			const sizes = fontSizes(svg);
			assert.ok(sizes.length > 0, `${style} ${name} draws text`);
			assert.ok(Math.min(...sizes) >= MIN_FONT_PX, `${style} ${name}: smallest font ${Math.min(...sizes)}`);
		}
	}
});

test("detailed: title, big countdown, schedule and last result", () => {
	const svg = view(task());
	assert.ok(svg.includes(">2h 15m<"));
	assert.ok(svg.includes(">every 2h<"));
	assert.ok(svg.includes(">✓ Ran 3h ago<"));
	assert.ok(svg.includes("Nightly"));
	assert.ok(!svg.includes("rotate("), "an idle task doesn't spin");
	assert.ok(!svg.includes("last-failed"));
});

test("running shows the spinner (and holds still with animation off)", () => {
	const t = task({ lastRunStatus: "running", lastRunAt: NOW - 2 * MIN });
	const a = view(t, { now: NOW });
	const b = view(t, { now: NOW + 600 });
	assert.ok(a.includes(">Running<") && a.includes(">Started 2m ago<") && a.includes("rotate("));
	assert.notEqual(a, b, "the spinner turns");
	assert.equal(view(t, { animation: "off", now: NOW }), view(t, { animation: "off", now: NOW + 600 }));
	assert.ok(view(t, { style: "glance" }).includes("rotate("));
});

test("a failed run stays red, with a cross, in both looks, and keeps the countdown", () => {
	const t = task({ lastRunStatus: "failed", lastRunAt: NOW - 25 * MIN, nextRunAt: NOW + 95 * MIN });
	const detailed = view(t);
	assert.ok(detailed.includes('id="last-failed"') && detailed.includes('id="glyph-failed"') && detailed.includes("#FF242F"));
	assert.ok(detailed.includes(">Failed 25m ago<") && detailed.includes(">1h 35m<"));
	const glance = view(t, { style: "glance" });
	assert.ok(glance.includes('id="glyph-failed"') && glance.includes(">FAILED · NEXT<") && glance.includes(">1h 35m<"));
	// Disabled and failed: still red and still a cross.
	assert.ok(view(task({ lastRunStatus: "failed", enabled: false, nextRunAt: null }), { style: "glance" }).includes('id="glyph-failed"'));
	// The next run succeeding is what clears it.
	assert.ok(!view({ ...t, lastRunStatus: "succeeded" }).includes("last-failed"));
});

test("the other faces", () => {
	assert.equal(faceOf(task({ enabled: false })), "disabled");
	assert.equal(faceOf(task({ blocked: true, schedule: { kind: "webhook" } })), "blocked");
	assert.equal(faceOf(task({ schedule: { kind: "webhook" }, nextRunAt: null })), "webhook");
	assert.equal(faceOf(task({ nextRunAt: null })), "finished");
	assert.equal(faceOf(task({ lastRunStatus: "running", enabled: false })), "running");
	assert.ok(view(task({ enabled: false, nextRunAt: null })).includes(">Disabled<"));
	assert.ok(view(task({ schedule: { kind: "webhook" }, blocked: true, nextRunAt: null })).includes(">Blocked<"));
	assert.ok(view(task({ schedule: { kind: "webhook" }, nextRunAt: null })).includes(">runs when called<"));
	assert.ok(view(task({ schedule: { kind: "once" }, nextRunAt: null })).includes(">Finished<"));
	assert.ok(view(task({ lastRunStatus: "never", lastRunAt: null })).includes(">Never run<"));
	assert.ok(view(task({ nextRunAt: NOW - 1 })).includes(">Due now<"));
	assert.ok(view(task({ nextRunAt: NOW + 30_000 })).includes("&lt;1m"));
	assert.ok(view(task({ enabled: false, nextRunAt: null }), { style: "glance" }).includes(">PAUSED<"));
});

test("no tasks says so and what to do; a missing chosen task says to pick another", () => {
	const none = view(undefined);
	assert.ok(none.includes(">No scheduled<") && none.includes(">tasks<") && none.includes(">Add one in T3<"));
	const gone = view(undefined, { pick: { task: undefined, reason: "missing" } });
	assert.ok(gone.includes(">Task not found<") && gone.includes("settings"));
});

test("T3 unreachable uses the other keys' wording; loading and a down stream say so", () => {
	assert.ok(view(task(), { connection: { kind: "offline", detail: "", reason: "not-running" } }).includes(">Open T3 Code<"));
	assert.match(view(task(), { connection: { kind: "offline", detail: "", reason: "not-installed" } }), />Install T3</);
	assert.ok(view(task(), { connection: { kind: "error", detail: "", reason: "sign-in-failed" } }).includes(">Sign-in failed<"));
	assert.ok(view(task(), { connection: { kind: "connecting" } }).includes(">Connecting…<"));
	assert.ok(view(undefined, { stream: "loading" }).includes(">Loading…<"));
	assert.ok(view(task(), { stream: "down" }).includes(">unavailable<"), "a down stream draws no task state");
	assert.ok(!view(task(), { stream: "down" }).includes("Nightly"));
});

test("hold cue: progress and 'Hold to run now', or where to enable actions", () => {
	const run = view(task(), { cue: { kind: "run", progress: 0.5 } });
	assert.ok(run.includes(">Hold to run now<") && run.includes('id="hold-progress"'));
	const off = view(task(), { cue: { kind: "enable" } });
	assert.ok(off.includes(">Enable in settings<") && !off.includes("hold-progress"));
	assert.ok(view(task(), { style: "glance", cue: { kind: "run", progress: 0.2 } }).includes(">Hold to run now<"));
});

test("hostile text is escaped and cleaned", () => {
	const svg = view(task({ title: 'Bad <b>"title"</b> & \u0007\u001b[31m more' }));
	assert.deepEqual(checkSvg(svg), []);
	assert.ok(!svg.includes("<b>") && !svg.includes("\u0007") && svg.includes("&lt;b&gt;"));
});

test("the key's own next frame: the countdown's minute, the 'ago' text, the spinner; nothing when static", () => {
	const t = task({ nextRunAt: NOW + 135 * MIN + 30_000, lastRunAt: NOW - 3 * HOUR });
	const next = nextScheduledFrame(t, "smooth", NOW)!;
	assert.equal(next, NOW + 30_001, "the minute edge comes before the hourly 'ago' change");
	assert.notEqual(view(t, { now: next - 1 }), view(t, { now: next }), "the text changes at the frame");
	assert.equal(view(t, { now: NOW + 1000 }), view(t, { now: NOW + 30_000 }), "and not before it");
	assert.equal(nextScheduledFrame(task({ lastRunStatus: "running", nextRunAt: null, lastRunAt: null }), "smooth", NOW), NOW + 300);
	assert.equal(nextScheduledFrame(task({ lastRunStatus: "running", nextRunAt: null, lastRunAt: null }), "off", NOW), undefined);
	assert.equal(nextScheduledFrame(task({ enabled: false, nextRunAt: null, lastRunStatus: "never", lastRunAt: null }), "smooth", NOW), undefined);
	assert.equal(nextScheduledFrame(task({ nextRunAt: NOW - 1, lastRunStatus: "never", lastRunAt: null }), "smooth", NOW), undefined, "due now holds until T3 reports the next run");
	assert.equal(nextScheduledFrame(undefined, "smooth", NOW), undefined);
	// Glance has no "ago" text, so only the countdown matters.
	assert.equal(nextScheduledFrame(task({ nextRunAt: NOW + 10 * MIN * 100 }), "smooth", NOW, "glance"), NOW + 1);
});

// ---------------------------------------------------------------- monitor

/** A WebSocket stand-in, like the one in backend.test.ts. */
class FakeSocket {
	sent: Record<string, unknown>[] = [];
	closed = false;
	onopen: (() => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;
	onclose: ((ev: { code: number }) => void) | null = null;
	onerror: (() => void) | null = null;
	send(data: string): void {
		this.sent.push(JSON.parse(data) as Record<string, unknown>);
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		setImmediate(() => this.onclose?.({ code: 1000 }));
	}
	deliver(frame: unknown): void {
		this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
	}
}

class FakeAccess {
	opened: FakeSocket[] = [];
	fail?: Error;
	reply?: (msg: Record<string, unknown>) => unknown;
	readonly tokens = new TokenStore({ dir: path.join(os.tmpdir(), "t3deck-unused") });
	async open(): Promise<FakeSocket> {
		if (this.fail) throw this.fail;
		const ws = new FakeSocket();
		this.opened.push(ws);
		setImmediate(() => ws.onopen?.());
		if (this.reply) {
			const reply = this.reply;
			const send = ws.send.bind(ws);
			ws.send = (data: string) => {
				send(data);
				const answer = reply(JSON.parse(data) as Record<string, unknown>);
				if (answer) setImmediate(() => ws.deliver(answer));
			};
		}
		return ws;
	}
}

const tick = (n = 4) => new Promise<void>((resolve) => { let i = 0; const next = () => (++i >= n ? resolve() : setImmediate(next)); setImmediate(next); });
const chunk = (...items: unknown[]) => ({ _tag: "Chunk", requestId: "1", values: items });

afterEach(() => mock.timers.reset());

test("monitor: connects only while wanted, subscribes with an empty payload, acks nothing it shouldn't", async () => {
	const access = new FakeAccess();
	const monitor = new ScheduledMonitor(access as unknown as RpcAccess);
	monitor.start();
	await tick();
	assert.equal(access.opened.length, 0, "no key, no socket");
	assert.equal(monitor.snapshot.state, "loading");
	monitor.setWanted(true);
	await tick();
	const ws = access.opened[0]!;
	assert.ok(ws);
	assert.deepEqual(ws.sent[0], { _tag: "Request", id: "1", tag: "scheduledTasks.subscribe", payload: {}, headers: [] });
	monitor.setWanted(false);
	await tick();
	assert.ok(ws.closed, "the last key leaves: the socket goes");
	monitor.stop();
});

test("monitor: the first item answers at once; an empty list is live; each later item replaces the list", async () => {
	const access = new FakeAccess();
	const monitor = new ScheduledMonitor(access as unknown as RpcAccess);
	const changes: string[] = [];
	monitor.on("change", (s) => changes.push(`${s.state}:${s.tasks.length}`));
	monitor.setWanted(true);
	monitor.start();
	await tick();
	const ws = access.opened[0]!;
	ws.deliver(chunk({ tasks: [] }));
	assert.deepEqual(monitor.snapshot, { state: "live", tasks: [] }, "no tasks is an answer, not a loading state");
	assert.ok(ws.sent.some((m) => m._tag === "Ack" && m.requestId === "1"), "chunks are acked");
	ws.deliver(chunk({ tasks: [raw(), raw({ id: "task-2", title: "Weekly report" })] }));
	assert.deepEqual(monitor.snapshot.tasks.map((t) => t.id), ["task-1", "task-2"]);
	ws.deliver(chunk({ tasks: [raw({ id: "task-2", lastRunStatus: "running" })] }));
	assert.deepEqual(monitor.snapshot.tasks.map((t) => `${t.id}:${t.lastRunStatus}`), ["task-2:running"], "an item is the whole list");
	assert.deepEqual(changes, ["live:0", "live:2", "live:1"]);
	monitor.stop();
});

test("monitor: junk is logged and skipped, never wipes a good list", async () => {
	const access = new FakeAccess();
	const monitor = new ScheduledMonitor(access as unknown as RpcAccess);
	const logs: string[] = [];
	monitor.on("log", (l) => logs.push(l));
	monitor.setWanted(true);
	monitor.start();
	await tick();
	const ws = access.opened[0]!;
	ws.deliver(chunk({ tasks: [raw()] }));
	ws.deliver("not json");
	ws.deliver({ _tag: "Chunk", requestId: "1", values: "nope" });
	ws.deliver(chunk({ unexpected: true }));
	ws.deliver(chunk(null, 5));
	ws.deliver({ _tag: "Chunk", requestId: "2", values: [{ tasks: [] }] });
	assert.equal(monitor.snapshot.state, "live");
	assert.deepEqual(monitor.snapshot.tasks.map((t) => t.id), ["task-1"]);
	assert.ok(logs.some((l) => /wasn't a task list/.test(l)));
	monitor.stop();
});

test("monitor: when the socket drops nothing it reported stays; it retries with backoff and starts from the new list", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	const access = new FakeAccess();
	const monitor = new ScheduledMonitor(access as unknown as RpcAccess);
	monitor.setWanted(true);
	monitor.start();
	await tick();
	const ws = access.opened[0]!;
	ws.deliver(chunk({ tasks: [raw()] }));
	assert.equal(monitor.snapshot.tasks.length, 1);

	ws.onclose?.({ code: 1006 });
	assert.deepEqual(monitor.snapshot, { state: "down", tasks: [] }, "a key never shows a stale countdown");
	mock.timers.tick(1999);
	await tick();
	assert.equal(access.opened.length, 1, "backing off");
	mock.timers.tick(1);
	await tick();
	assert.equal(access.opened.length, 2, "retried after 2 s");
	// Fails again: the wait doubles.
	access.opened[1]!.onclose?.({ code: 1006 });
	mock.timers.tick(3999);
	await tick();
	assert.equal(access.opened.length, 2);
	mock.timers.tick(1);
	await tick();
	assert.equal(access.opened.length, 3);
	access.opened[2]!.deliver(chunk({ tasks: [raw({ id: "task-9" })] }));
	assert.deepEqual(monitor.snapshot.tasks.map((t) => t.id), ["task-9"], "a fresh connection starts from its own list");
	monitor.stop();
	await tick();
	assert.equal(monitor.snapshot.state, "loading");
});

test("monitor: a failed connect is logged, shows 'down', and kick() retries now", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	const access = new FakeAccess();
	access.fail = new Error("T3 Code is not running");
	const monitor = new ScheduledMonitor(access as unknown as RpcAccess);
	const logs: string[] = [];
	monitor.on("log", (l) => logs.push(l));
	monitor.setWanted(true);
	monitor.start();
	await tick();
	assert.match(logs[0]!, /not running/);
	assert.equal(monitor.snapshot.state, "down");
	access.fail = undefined;
	monitor.kick();
	await tick();
	assert.equal(access.opened.length, 1);
	monitor.stop();
	await tick();
});

test("monitor: an Exit frame (an old T3 without the method, or a refusal) closes the socket and goes down", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	const access = new FakeAccess();
	const monitor = new ScheduledMonitor(access as unknown as RpcAccess);
	const logs: string[] = [];
	monitor.on("log", (l) => logs.push(l));
	monitor.setWanted(true);
	monitor.start();
	await tick();
	const ws = access.opened[0]!;
	ws.deliver({ _tag: "Exit", requestId: "1", exit: { _tag: "Failure", cause: "unknown method" } });
	await tick();
	assert.ok(ws.closed);
	assert.equal(monitor.snapshot.state, "down");
	assert.ok(logs.some((l) => /stream ended/.test(l)));
	monitor.stop();
	await tick();
});

test("monitor: no list within 20 s and the socket is given up on", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	const access = new FakeAccess();
	const monitor = new ScheduledMonitor(access as unknown as RpcAccess);
	monitor.setWanted(true);
	monitor.start();
	await tick();
	const ws = access.opened[0]!;
	mock.timers.tick(20_000);
	await tick();
	assert.ok(ws.closed);
	monitor.stop();
	await tick();
});

test("monitor: restart() reconnects at once and drops the old socket's late frames", async () => {
	const access = new FakeAccess();
	const monitor = new ScheduledMonitor(access as unknown as RpcAccess);
	monitor.setWanted(true);
	monitor.start();
	await tick();
	const first = access.opened[0]!;
	first.deliver(chunk({ tasks: [raw()] }));
	monitor.restart();
	await tick();
	assert.equal(access.opened.length, 2);
	assert.ok(first.closed);
	first.deliver(chunk({ tasks: [raw({ id: "stale" })] }));
	assert.ok(!monitor.snapshot.tasks.some((t) => t.id === "stale"));
	monitor.stop();
});

test("run now: one runNow request with just the id; a failure rejects", async () => {
	const access = new FakeAccess();
	access.reply = (msg) => (msg._tag === "Request" ? { _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: { task: raw() } } } : undefined);
	await runScheduledTaskNow(access as unknown as RpcAccess, "task-1");
	assert.deepEqual(access.opened[0]!.sent[0], { _tag: "Request", id: "1", tag: "scheduledTasks.runNow", payload: { id: "task-1" }, headers: [] });
	access.reply = (msg) => (msg._tag === "Request" ? { _tag: "Exit", requestId: "1", exit: { _tag: "Failure", cause: [{ error: { message: "Webhook tasks run when their URL receives a request." } }] } } : undefined);
	await assert.rejects(runScheduledTaskNow(access as unknown as RpcAccess, "task-1"), /runNow failed/);
});
