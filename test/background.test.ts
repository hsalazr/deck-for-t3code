import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadCard } from "../src/model.ts";
import { renderThreadKey } from "../src/render.ts";
import { runningTasks } from "../src/t3/shell-stream.ts";

const watch = (n: number) => ({ taskId: `pull-request-watch:git.example.com/acme/api#${n}`, kind: "monitor" });
const pr = (n: number, w?: { passed?: boolean; failedChecks?: string[] }) => ({ host: "git.example.com", repository: "acme/api", number: n, ...(w ? { watch: w } : {}) });

test("PR watches count only while their CI is running", () => {
	const tasks = runningTasks({
		id: "t",
		pendingBackgroundTasks: [watch(44), watch(45), watch(42), watch(300), { taskId: "toolu_1", kind: "command" }, { taskId: "agent_1", kind: "subagent" }],
		pullRequests: [
			pr(44, { passed: false, failedChecks: ["CI"] }), // failed: waiting on a new push
			pr(45, { passed: true, failedChecks: [] }), // passed: waiting on review/merge
			pr(42, { passed: false, failedChecks: [] }), // checks running
			pr(300), // no watch record
		],
	});
	assert.deepEqual(tasks.map((t) => t.taskId), ["pull-request-watch:git.example.com/acme/api#42", "toolu_1", "agent_1"]);
});

const card = (extra: Partial<ThreadCard>): ThreadCard => ({
	threadId: "x", projectId: "p", title: "Review the checkout PR", link: "", state: "working", ownStatus: "completed",
	subagentsWorking: 0, subagentsWaiting: 0, background: 0, inputFromSubagent: false, ackKey: "", updatedAt: 0, createdAt: 0, ...extra,
});
const render = (c: ThreadCard, now = 0) => renderThreadKey({ card: c, projectName: "acme-api", connection: { kind: "ok" }, animation: "smooth", now });

test("spinner: blue while the agent works, white while only background work runs, same speed", () => {
	const rotation = (svg: string) => /rotate\(([\d.]+) 124 21\)/.exec(svg)?.[1];
	const bg = render(card({ background: 2 }), 900);
	const busy = render(card({ ownStatus: "running" }), 900);
	assert.ok(bg.includes('stroke="#F4F5F7" stroke-width="3" stroke-linecap="round" transform="rotate('));
	assert.ok(busy.includes('stroke="#297EFF" stroke-width="3" stroke-linecap="round" transform="rotate('));
	assert.equal(rotation(bg), rotation(busy));
	assert.notEqual(rotation(render(card({ ownStatus: "running" }), 0)), rotation(busy));
	assert.ok(!render(card({ state: "idle", ownStatus: "completed" })).includes("rotate("), "idle doesn't spin");
});

test("done is a steady solid tile; only needs-you and failed blink", () => {
	const frames = (state: ThreadCard["state"]) => new Set([0, 300, 600, 900, 1200, 1500].map((now) => render(card({ state, ownStatus: "completed" }), now)));
	assert.equal(frames("done").size, 1);
	assert.ok([...frames("done")][0]!.includes('fill="#00E069"'));
	assert.ok(frames("input").size > 1);
	assert.ok(frames("failed").size > 1);
});

test("overview priority: failed > needs you > done > working > background > idle", async () => {
	const { overviewState, renderOverview } = await import("../src/render.ts");
	const c = (o: Partial<Record<"input" | "failed" | "done" | "working" | "background" | "idle", number>>) => ({ input: 0, failed: 0, done: 0, working: 0, background: 0, idle: 0, ...o });
	assert.equal(overviewState(c({ failed: 1, input: 2, done: 3, working: 4 })), "failed");
	assert.equal(overviewState(c({ input: 2, done: 3, working: 4 })), "input");
	assert.equal(overviewState(c({ done: 3, working: 4 })), "done");
	assert.equal(overviewState(c({ working: 4, background: 1 })), "working");
	assert.equal(overviewState(c({ working: 1, background: 1 })), "background");
	assert.equal(overviewState(c({ idle: 5 })), "idle");
	const frames = (counts: ReturnType<typeof c>) => new Set([0, 300, 600, 900, 1200].map((now) => renderOverview({ connection: { kind: "ok" }, counts, overflow: 0, animation: "smooth", now })));
	const done = frames(c({ done: 1, working: 2 }));
	assert.equal(done.size, 1, "done is steady");
	assert.ok([...done][0]!.includes('fill="#00E069"'), "solid green");
	assert.ok(frames(c({ failed: 1 })).size > 1, "failed blinks");
	assert.ok(frames(c({ input: 1 })).size > 1, "needs you blinks");
	assert.ok([...frames(c({ working: 1, background: 1 }))][0]!.includes('stroke="#F4F5F7"'), "white orbit");
});
