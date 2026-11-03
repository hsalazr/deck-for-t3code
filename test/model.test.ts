import assert from "node:assert/strict";
import { test } from "node:test";

import { layoutThreads, buildCards, deepLinkFor, seenAfterRun, type ThreadCard, type ThreadSummary } from "../src/model.ts";
import { renderThreadKey, textWidth, wrap } from "../src/render.ts";

let clock = Date.parse("2026-11-03T12:00:00Z");
function thread(id: string, status: string, extra: Partial<ThreadSummary> = {}): ThreadSummary {
	clock += 1000;
	return {
		threadId: id,
		projectId: "p",
		title: `Thread ${id}`,
		link: `http://127.0.0.1:3773/env-1/${id}`,
		status,
		latestRunId: `run:${id}:1`,
		parentThreadId: null,
		relationshipToParent: null,
		settled: false,
		snoozed: false,
		createdAt: new Date(clock).toISOString(),
		updatedAt: new Date(clock).toISOString(),
		...extra,
	};
}
const opts = { acked: new Map<string, string>(), flashOnDone: true, flashOnFailed: true };

test("subagents fold into their root thread, recursively", () => {
	const cards = buildCards(
		[
			thread("root", "running"),
			thread("a", "running", { parentThreadId: "root", relationshipToParent: "subagent" }),
			thread("b", "running", { parentThreadId: "a", relationshipToParent: "subagent" }),
			thread("c", "idle", { parentThreadId: "root", relationshipToParent: "subagent" }),
		],
		opts,
	);
	assert.deepEqual([...cards.keys()], ["root"]);
	assert.equal(cards.get("root")!.subagentsWorking, 2);
	assert.equal(cards.get("root")!.state, "working");
});

test("a waiting subagent makes its idle root need attention", () => {
	const cards = buildCards(
		[thread("root", "completed"), thread("a", "waiting", { parentThreadId: "root" })],
		{ ...opts, acked: new Map([["root", "run:root:1|completed"]]) },
	);
	const root = cards.get("root")!;
	assert.equal(root.state, "input");
	assert.equal(root.inputFromSubagent, true);
	assert.equal(root.subagentsWaiting, 1);
});

test("an idle root with a working subagent shows working", () => {
	const cards = buildCards([thread("root", "idle"), thread("a", "starting", { parentThreadId: "root" })], opts);
	assert.equal(cards.get("root")!.state, "working");
});

test("done and failed flash only until acknowledged", () => {
	const t = thread("x", "completed");
	assert.equal(buildCards([t], opts).get("x")!.state, "done");
	assert.equal(buildCards([t], { ...opts, acked: new Map([["x", "run:x:1|completed"]]) }).get("x")!.state, "idle");
	assert.equal(buildCards([t], { ...opts, flashOnDone: false }).get("x")!.state, "idle");
	// A new run finishing re-arms it.
	const next = { ...t, latestRunId: "run:x:2" };
	assert.equal(buildCards([next], { ...opts, acked: new Map([["x", "run:x:1|completed"]]) }).get("x")!.state, "done");
	assert.equal(buildCards([thread("f", "failed")], opts).get("f")!.state, "failed");
});

const card = (id: string, state: ThreadCard["state"], updatedAt: number): ThreadCard => ({
	threadId: id,
	projectId: "p",
	title: id,
	link: "",
	state,
	ownStatus: state,
	subagentsWorking: 0,
	subagentsWaiting: 0,
	background: 0,
	inputFromSubagent: false,
	ackKey: "",
	updatedAt,
	createdAt: updatedAt,
});

test("threads pack from the first key with no gaps", () => {
	const first = layoutThreads([], 4, [card("a", "idle", 1), card("b", "working", 2)]);
	assert.deepEqual(first.shown, ["b", "a"]);
	// c appears and b changes state: existing tiles keep their order, c joins at the end.
	const second = layoutThreads(first.order, 4, [card("a", "idle", 1), card("b", "input", 3), card("c", "working", 4)]);
	assert.deepEqual(second.shown, ["b", "a", "c"]);
	// a leaves: c slides up into its place.
	const third = layoutThreads(second.order, 4, [card("b", "input", 3), card("c", "working", 4)]);
	assert.deepEqual(third.shown, ["b", "c"]);
});

test("with more threads than keys, the most urgent win but keep their order", () => {
	const visible = [card("a", "idle", 5), card("b", "idle", 1), card("c", "input", 9)];
	const { shown, overflow } = layoutThreads(["a", "b"], 2, visible);
	assert.deepEqual(shown, ["a", "c"]);
	assert.deepEqual(overflow, ["b"]);
	const full = layoutThreads(["a", "b"], 2, [card("a", "working", 5), card("b", "working", 1), card("c", "idle", 9)]);
	assert.deepEqual(full.shown, ["a", "b"]);
	assert.deepEqual(full.overflow, ["c"]);
	assert.deepEqual(layoutThreads(["a"], 0, [card("a", "input", 1)]).overflow, ["a"]);
});

test("deep links target the desktop app's thread route", () => {
	assert.equal(
		deepLinkFor("http://127.0.0.1:3773/aaaa1111/0000beef-0001", "0000beef-0001"),
		"t3code://threads/aaaa1111/0000beef-0001",
	);
	assert.equal(deepLinkFor("http://h/env/x", "thread:provider:a%3Ab"), "t3code://threads/env/thread%3Aprovider%3Aa%253Ab");
	assert.equal(deepLinkFor("not a url", "x"), null);
});

test("wrap keeps to the line budget and ellipsizes", () => {
	assert.deepEqual(wrap("Fix flaky login test", 12, 3), ["Fix flaky login", "test"]);
	const long = wrap("Upgrade to Node 24 with extra words and more words", 12, 3);
	assert.equal(long.length, 3);
	assert.ok(long[2]!.endsWith("…"));
	assert.ok(wrap("Supercalifragilisticexpialidocious", 12, 3).every((l) => textWidth(l) <= 12));
});

test("thread key escapes titles and flashes between frames", () => {
	const c = { ...card("x", "input", 1), title: `<script>&"` };
	const base = { card: c, projectName: "acme-api", connection: { kind: "ok" } as const, animation: "smooth" as const };
	const lit = renderThreadKey({ ...base, now: 0 });
	const dark = renderThreadKey({ ...base, now: 600 });
	assert.ok(lit.includes("&lt;script&gt;&amp;&quot;"));
	assert.notEqual(lit, dark);
	assert.ok(lit.includes('fill="#F5A524"'));
});

test("a subagent whose parent isn't loaded becomes its own card", () => {
	const cards = buildCards([thread("orphan", "running", { parentThreadId: "gone" }), thread("kid", "waiting", { parentThreadId: "orphan" })], opts);
	assert.deepEqual([...cards.keys()], ["orphan"]);
	assert.equal(cards.get("orphan")!.state, "input");
});

test("deep links accept the agent-facing t3-thread form", () => {
	assert.equal(deepLinkFor("<t3-thread://v2/envA/thr-1>", "thr-1"), "t3code://threads/envA/thr-1");
});

test("overflow keeps threads already on keys when urgency ties", () => {
	const visible = [card("a", "working", 1), card("b", "working", 2), card("c", "working", 3)];
	// a is on a key; b and c are newer but shouldn't push it off.
	const { shown } = layoutThreads(["a", "b", "c"], 2, visible, new Set(["a", "b"]));
	assert.deepEqual(shown, ["a", "b"]);
});

test("thread keys never show stale state while offline", () => {
	const c = card("x", "input", 1);
	const markup = renderThreadKey({ card: c, projectName: "", connection: { kind: "offline", detail: "" }, animation: "smooth", now: 0 });
	assert.ok(markup.includes("T3 offline"));
	assert.ok(!markup.includes("NEEDS YOU"));
});

test("background work (subagents, monitors, PR watches) keeps a finished root working", () => {
	const root = thread("root", "completed");
	const kid = thread("kid", "idle", { parentThreadId: "root", relationshipToParent: "subagent", latestRunId: null });
	const cards = buildCards([root, kid], { ...opts, background: new Map([["root", 2]]) });
	assert.equal(cards.get("root")!.state, "working");
	assert.equal(cards.get("root")!.background, 2);
	// Once they finish, the unseen completed run shows as done again.
	assert.equal(buildCards([root, kid], opts).get("root")!.state, "done");
	// Needing input still wins.
	const waiting = buildCards([thread("w", "waiting")], { ...opts, background: new Map([["w", 1]]) });
	assert.equal(waiting.get("w")!.state, "input");
});

test("grace period keeps a root working right after its subagents finish", () => {
	const root = thread("g", "completed");
	assert.equal(buildCards([root], { ...opts, subagentGrace: new Set(["g"]) }).get("g")!.state, "working");
	assert.equal(buildCards([root], opts).get("g")!.state, "done");
	assert.equal(buildCards([thread("gw", "waiting")], { ...opts, subagentGrace: new Set(["gw"]) }).get("gw")!.state, "input");
});

test("status label is optional and off by default", () => {
	const base = { card: { ...card("x", "working", 1), title: "One two three four five six seven eight nine ten" }, projectName: "p", connection: { kind: "ok" } as const, animation: "off" as const, now: 0 };
	const plain = renderThreadKey(base);
	const labelled = renderThreadKey({ ...base, showLabel: true });
	assert.ok(!plain.includes("WORKING"));
	assert.ok(labelled.includes("WORKING"));
	const titleLines = (s: string) => (s.match(/font-size="18"/g) ?? []).length;
	assert.equal(titleLines(plain), 4);
	assert.equal(titleLines(labelled), 3);
});

test("seen in T3: only a visit after the run ended counts, not having it open as it ended", () => {
	const done = Date.parse("2026-11-03T20:58:00Z");
	assert.equal(seenAfterRun(done, done), false, "T3 stamps an open thread visited at the completion time");
	assert.equal(seenAfterRun(done + 500, done), false);
	assert.equal(seenAfterRun(done + 60_000, done), true, "opened it later");
	assert.equal(seenAfterRun(done - 60_000, done), false, "visited before it finished");
	assert.equal(seenAfterRun(null, done), false);
	assert.equal(seenAfterRun(done, null), false);
});

test("quick messages: one per line, `Label | text`, neutral defaults", async () => {
	const { parseQuickMessages, DEFAULT_MESSAGES } = await import("../src/model.ts");
	assert.deepEqual(parseQuickMessages("continue\n\n  Ship | merge it if CI is green  \nPR|open a PR for this\n| only text\nonly label |\n|"), [
		{ label: "continue", text: "continue" },
		{ label: "Ship", text: "merge it if CI is green" },
		{ label: "PR", text: "open a PR for this" },
		{ label: "only text", text: "only text" },
		{ label: "only label", text: "only label" },
	]);
	assert.equal(parseQuickMessages("a | b | c")[0]!.text, "b | c", "only the first bar splits");
	assert.deepEqual(parseQuickMessages(undefined).map((m) => m.text), DEFAULT_MESSAGES);
	assert.deepEqual(parseQuickMessages(""), [], "cleared on purpose: no messages");
	assert.ok(!DEFAULT_MESSAGES.some((m) => /merge|PR|review/.test(m)), "defaults don't act on repos");
});

test("a main thread that finished while its subagents still run stays working, not done", () => {
	const root = thread("root", "completed");
	const kid = thread("kid", "running", { parentThreadId: "root", relationshipToParent: "subagent" });
	assert.equal(buildCards([root, kid], opts).get("root")!.state, "working");
	// Once they finish, the unseen run shows as done.
	assert.equal(buildCards([root, { ...kid, status: "completed" }], opts).get("root")!.state, "done");
	// Failed and needs-you still win over working.
	assert.equal(buildCards([thread("f", "failed"), thread("k2", "running", { parentThreadId: "f" })], opts).get("f")!.state, "failed");
});
