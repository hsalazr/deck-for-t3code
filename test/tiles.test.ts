import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadCard } from "../src/model.ts";
import { SPINNER_LEFT, nextThreadFrame, sanitize, renderActionKey, renderBackKey, renderOverview, renderThreadKey, renderUsageKey, textWidth, truncate, wrap, wrapWidths } from "../src/render.ts";
import { pace } from "../src/usage.ts";
import { tomorrowAt9 } from "../src/t3/commands.ts";
import { contextOf } from "../src/t3/context-watcher.ts";
import { waitingLabel } from "../src/t3/shell-stream.ts";

const card = (extra: Partial<ThreadCard>): ThreadCard => ({
	threadId: "x", projectId: "p", title: "Add retry to checkout flow", link: "", state: "working", ownStatus: "running",
	subagentsWorking: 0, subagentsWaiting: 0, background: 0, inputFromSubagent: false, ackKey: "", updatedAt: 0, createdAt: 0, ...extra,
});
const ok = { kind: "ok" } as const;
const render = (c: ThreadCard, now = 0) => renderThreadKey({ card: c, projectName: "acme-api", connection: ok, animation: "smooth", now });

test("waiting-on labels", () => {
	assert.equal(waitingLabel([]), undefined);
	assert.equal(waitingLabel([{ taskId: "pull-request-watch:git.example.com/acme/api#42", kind: "monitor" }]), "PR #42 CI");
	assert.equal(waitingLabel([{ taskId: "a", kind: "subagent" }, { taskId: "b", kind: "subagent" }]), "2 agents");
	assert.equal(waitingLabel([{ taskId: "c", kind: "command", description: "Web UI tests" }]), "Web UI tests");
	assert.equal(waitingLabel([{ taskId: "c", kind: "command" }, { taskId: "a", kind: "subagent" }]), "2 tasks");
});

test("background-only tile shows what it waits on instead of the project", () => {
	const svg = render(card({ ownStatus: "completed", background: 1, waitingOn: "PR #42 CI" }));
	assert.ok(svg.includes(">PR #42 CI<"));
	assert.ok(!svg.includes(">acme-api<"));
	assert.ok(render(card({})).includes(">acme-api<"));
});

test("context bar: grey, amber from 70%, red from 85%", () => {
	assert.ok(render(card({ context: { used: 30, max: 100 } })).includes('height="4" rx="2" fill="#C9CED6"/>'));
	assert.ok(render(card({ context: { used: 76, max: 100 } })).includes('width="91.2" height="4" rx="2" fill="#F5A524"'));
	assert.ok(render(card({ context: { used: 91, max: 100 } })).includes('fill="#FF242F"'));
	assert.ok(render(card({ context: { used: 76, max: 100 } })).includes(">76%<"), "% shown when there's no badge");
	assert.deepEqual(contextOf({ thread: { activeProviderThreadId: "b" }, providerThreads: [{ id: "a", contextUsage: { usedTokens: 1, maxTokens: 10 } }, { id: "b", contextUsage: { usedTokens: 126616, maxTokens: 1000000 } }] }), { used: 126616, max: 1000000 });
	assert.equal(contextOf({ providerThreads: [] }), null);
});

test("paused by a usage limit: dashed border and time to resume", () => {
	const now = Date.parse("2026-11-03T12:00:00Z");
	const svg = render(card({ state: "paused", ownStatus: "failed", pausedUntil: now + 2 * 3600_000 + 10 * 60_000 }), now);
	assert.ok(svg.includes("USAGE LIMIT"));
	assert.ok(svg.includes("back in 2h 10m"));
	assert.ok(svg.includes('stroke-dasharray="5 6"'));
	assert.ok(!svg.includes("rotate("), "paused doesn't spin");
});

test("titles leave room for the spinner on the first line", () => {
	assert.deepEqual(wrapWidths("Upgrade to Node 24", [10, 12, 12, 12]), ["Upgrade to", "Node 24"]);
	assert.ok(wrapWidths("one two three four five six seven eight nine ten", [10, 12, 12]).at(-1)!.endsWith("…"));
});

test("a busy tile's first title line stays clear of the spinner (and of the glyph disc)", () => {
	// Estimated width as render.ts measures it: textWidth() units × 18 px × 0.56 em.
	const firstLine = (svg: string) => {
		const m = /<text x="([\d.]+)" y="34"[^>]*>([^<]*)<\/text>/.exec(svg)!;
		return { x: Number(m[1]), text: m[2]!, end: Number(m[1]) + textWidth(m[2]!) * 18 * 0.56 };
	};
	const busy = firstLine(render(card({ title: "Cache build artifacts in CI", subagentsWorking: 2 })));
	assert.ok(busy.end <= SPINNER_LEFT - 8, `first line "${busy.text}" ends at ${busy.end.toFixed(1)}, spinner starts at ${SPINNER_LEFT}`);
	assert.ok(busy.text.length > 0);
	// A glyph disc on the left (needs-you with a subagent still running) pushes the line right, so it gets less room.
	const withGlyph = firstLine(render(card({ title: "Cache build artifacts in CI", state: "input", ownStatus: "waiting", subagentsWorking: 1 })));
	assert.equal(withGlyph.x, 37);
	assert.ok(withGlyph.end <= SPINNER_LEFT - 8, `with glyph: ends at ${withGlyph.end.toFixed(1)}`);
});

test("thread actions: stop explains itself after a tap; messages show the text and a send button", () => {
	const base = { card: card({ activeRunId: "run-1" }), connection: ok, animation: "smooth" as const, now: 0 };
	const stop = renderActionKey({ ...base, action: "stop" });
	assert.ok(stop.includes('fill="#CC2F35"') && !stop.includes("Hold to"));
	assert.ok(renderActionKey({ ...base, action: "stop", hint: true }).includes("Hold to"));
	const msg = renderActionKey({ ...base, action: "message", message: "run the tests and report" });
	assert.ok(msg.includes(">run the tests<") && msg.includes(">and report<") && msg.includes('font-size="20"') && msg.includes('<circle cx="118" cy="118" r="15"'));
	assert.ok(!renderActionKey({ ...base, action: "message" }).includes("<text"), "empty slot is blank");
	assert.ok(renderActionKey({ ...base, action: "compact" }).includes("m14 10 7-7"), "T3's compact icon");
	assert.ok(renderActionKey({ ...base, action: "snooze1h" }).includes('<circle cx="12" cy="12" r="10"/>'), "clock icon");
	assert.ok(renderActionKey({ ...base, action: "header" }).includes('stroke-dasharray="3 5"'));
});

test("snooze until tomorrow is 9:00 local", () => {
	const d = tomorrowAt9(new Date(2026, 10, 3, 22, 15));
	assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [2026, 10, 4, 9, 0]);
});

const counts = (o: Partial<Record<"input" | "failed" | "done" | "working" | "background" | "idle", number>>) => ({ input: 0, failed: 0, done: 0, working: 0, background: 0, idle: 0, ...o });
const overview = (c: ReturnType<typeof counts>, extra: Partial<Parameters<typeof renderOverview>[0]> = {}) =>
	renderOverview({ connection: ok, counts: c, overflow: 0, animation: "smooth", now: 0, ...extra });

test("states that need you carry a glyph, not just a colour", () => {
	for (const now of [0, 600]) {
		assert.ok(render(card({ state: "input", ownStatus: "waiting" }), now).includes('id="glyph-input"'));
		assert.ok(render(card({ state: "failed", ownStatus: "failed" }), now).includes('id="glyph-failed"'));
	}
	assert.ok(render(card({ state: "done", ownStatus: "completed" })).includes('id="glyph-done"'));
	assert.ok(!render(card({})).includes("glyph-"), "working has the spinner instead");
	assert.ok(!render(card({ state: "idle", ownStatus: "completed" })).includes("glyph-"));
	const labelled = renderThreadKey({ card: card({ state: "failed" }), projectName: "p", connection: ok, animation: "smooth", now: 0, showLabel: true });
	assert.ok(labelled.includes('id="glyph-failed"') && labelled.includes(">FAILED<"), "label option still works");
	assert.ok(overview(counts({ failed: 1 })).includes('id="glyph-failed"'));
	assert.ok(overview(counts({ input: 1 })).includes('id="glyph-input"'));
	assert.ok(overview(counts({ done: 1 })).includes('id="glyph-done"'));
	assert.ok(!overview(counts({ working: 2 })).includes("glyph-"));
});

test("no text below 14 px on any key", () => {
	const now = Date.parse("2026-11-03T12:00:00Z");
	const week = { id: "seven_day", label: "Weekly · Fable", usedPercent: 70, windowDurationMins: 10080, resetsAt: new Date(now + 3.5 * 86_400_000).toISOString() };
	const metric = { key: "k", provider: "Claude", label: week.label, window: week };
	const base = { card: card({ activeRunId: "r" }), connection: ok, animation: "smooth" as const, now: 0, projectName: "acme-api" };
	const keys = [
		render(card({ context: { used: 100, max: 100 } })),
		render(card({ subagentsWorking: 12, background: 3 })),
		render(card({ ownStatus: "completed", background: 1, waitingOn: "PR #42 CI" })),
		render(card({ state: "paused", pausedUntil: now + 3600_000 }), now),
		renderThreadKey({ ...base, card: card({ state: "input" }), showLabel: true }),
		renderThreadKey({ ...base, card: card({ state: "working" }), releaseCue: "open" }),
		renderThreadKey({ ...base, card: undefined, connection: { kind: "offline", detail: "", reason: "not-running" } }),
		overview(counts({ input: 123, working: 45, done: 6 }), { overflow: 999 }),
		overview(counts({ done: 2 }), { hold: 0.5 }),
		overview(counts({}), { connection: { kind: "offline", detail: "" } }),
		renderBackKey(true, 12),
		renderUsageKey({ metric, pace: pace(week, now), ok: true, loading: false }),
		renderUsageKey({ metric, pace: pace(week, now), ok: false, loading: false }),
		renderUsageKey({ metric, pace: pace(week, now), ok: true, loading: false, style: "ring" }),
		...(["header", "open", "stop", "snooze1h", "snoozeTomorrow", "settle", "compact"] as const).flatMap((action) => [
			renderActionKey({ ...base, action }),
			renderActionKey({ ...base, action, hint: true }),
			renderActionKey({ ...base, action, enabled: false }),
		]),
		renderActionKey({ ...base, action: "message", message: "summarize where you are", hint: true }),
		renderActionKey({ ...base, action: "stop", card: card({}) }),
	];
	for (const svg of keys) {
		const sizes = [...svg.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
		assert.ok(sizes.length > 0 || !svg.includes("<text"));
		assert.ok(sizes.every((s) => s >= 14), `font sizes ${sizes.join(",")} in ${svg.slice(0, 200)}`);
	}
});

test("wrapping weighs characters: CJK and emoji wide, i/l narrow, never splits a character", () => {
	const cjk = wrap("修复登录页面的错误并添加测试", 12, 3);
	assert.ok(cjk.length >= 2 && cjk.every((l) => textWidth(l) <= 12), `cjk: ${cjk.join("|")}`);
	assert.ok(cjk[0]!.length <= 6, "CJK counts double");
	const emoji = wrap("🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀", 12, 2);
	assert.equal(emoji[0], "🚀🚀🚀🚀🚀🚀");
	assert.ok(emoji.join("").split("").every((c, i, all) => !/[\uD800-\uDBFF]/.test(c) || /[\uDC00-\uDFFF]/.test(all[i + 1] ?? "")), "no lone surrogates");
	assert.equal(wrap("illicit lily jill fill", 12, 2).length, 2, "narrow letters pack more per line");
	assert.deepEqual(wrap("MMMMMMMMMMMM", 12, 3).map(textWidth).every((w) => w <= 12), true);
	const cut = truncate("👩‍👩‍👧‍👦 family 👩‍👩‍👧‍👦 trip", 6);
	assert.ok(cut.endsWith("…") && cut.startsWith("👩‍👩‍👧‍👦"), `ZWJ sequence kept whole: ${cut}`);
	assert.ok(!truncate("ab🚀cd", 3.5).includes("\uD83D…"));
});

test("DEL and C1 controls are stripped too", () => {
	const svg = render(card({ title: "Del\u007Fete C1\u0085 \u009Fend" }));
	assert.ok(svg.includes(">Delete<") || svg.includes("Delete"), "DEL removed");
	assert.ok(!/[\u007F-\u009F]/.test(svg));
	assert.equal(sanitize("a\u007Fb\u0080c\u009Fd\u00A0e"), "abcd\u00A0e", "NBSP (U+00A0) stays");
});

test("control characters are stripped from everything rendered", () => {
	const svg = render(card({ title: "Bad\u0000ti\u0007tle\u001b[31m￿" }));
	assert.ok(svg.includes(">Badtitle[31m<"));
	assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/.test(svg));
	const project = renderThreadKey({ card: card({}), projectName: "p\u0001roj", connection: ok, animation: "smooth", now: 0 });
	assert.ok(project.includes(">proj<"));
	assert.ok(!/[\u0000-\u001F]/.test(renderActionKey({ card: card({}), connection: ok, animation: "smooth", now: 0, action: "message", message: "go\u0008 on" })));
});

test("overview counts of 2–3 digits never run into their labels", () => {
	for (const n of [7, 42, 123, 4567]) {
		const svg = overview(counts({ input: n, working: 1, done: 0 }));
		const number = /<text x="([\d.]+)" y="62"[^>]*text-anchor="end">(\d+)<\/text>/.exec(svg);
		const label = /<text x="([\d.]+)" y="60"[^>]*>need you<\/text>/.exec(svg);
		assert.ok(number && label, `n=${n}`);
		const digits = number[2]!.length;
		const numberLeft = Number(number[1]) - digits * 14.5;
		assert.ok(numberLeft >= 11, `number starts inside the key (n=${n})`);
		assert.ok(Number(label[1]) - Number(number[1]) >= 6, `gap before the label (n=${n})`);
		assert.ok(digits <= 3, "capped at 999");
	}
});

test("thread actions off: operating keys dim with 'Enable in settings', header and Open don't", () => {
	const base = { card: card({ activeRunId: "r" }), connection: ok, animation: "smooth" as const, now: 0, enabled: false };
	for (const action of ["stop", "settle", "snooze1h", "snoozeTomorrow", "compact"] as const) {
		const svg = renderActionKey({ ...base, action });
		assert.ok(svg.includes(">Enable in<") && svg.includes(">settings<"), action);
		assert.ok(!svg.includes("#CC2F35"), `${action} isn't red`);
	}
	assert.ok(renderActionKey({ ...base, action: "message", message: "continue" }).includes(">Enable in<"));
	assert.ok(!renderActionKey({ ...base, action: "open" }).includes("Enable in"));
	assert.ok(!renderActionKey({ ...base, action: "header" }).includes("Enable in"));
});

test("offline wording names the fix", () => {
	const key = (reason?: string, kind: "offline" | "error" = "offline") =>
		renderThreadKey({ card: undefined, projectName: "", connection: { kind, detail: "", reason: reason as never }, animation: "off", now: 0 });
	assert.ok(key("not-installed").includes(">Install T3<"));
	assert.ok(key("not-running").includes(">Open T3 Code<"));
	assert.ok(key("cli-missing").includes(">T3 CLI<"));
	assert.ok(key("sign-in-failed", "error").includes(">Sign-in failed<"));
	assert.ok(key("server-error", "error").includes(">T3 error<"));
	assert.ok(key("signed-out").includes(">Signed out<"));
	assert.ok(!key("signed-out").includes("#FF242F"), "signed out isn't red");
	assert.ok(!key("signed-out", "error").includes("#FF242F"), "signed out isn't red, whatever the kind");
	const signedOut = overview(counts({}), { connection: { kind: "offline", detail: "", reason: "signed-out" } });
	assert.ok(signedOut.includes("Signed out") && !signedOut.includes("#FF242F"), "overview says Signed out, in grey");
	assert.ok(!renderThreadKey({ card: undefined, projectName: "", connection: { kind: "offline", detail: "" }, animation: "off", now: 0, primary: false }).includes("<text"));
	assert.ok(!overview(counts({}), { connection: { kind: "offline", detail: "", reason: "not-running" } }).includes("#FF242F"), "offline overview is grey, not red");
});

test("a word that fits on the next line moves there whole instead of being split", () => {
	// A busy tile's first line is narrow (spinner); "Playwright" must not become "Playw" + "right".
	const lines = wrapWidths("Add Playwright smoke tests", [7, 12, 12, 12]);
	assert.ok(lines.includes("Add") || lines[0] === "Add", `got ${JSON.stringify(lines)}`);
	assert.ok(lines.some((l) => l.split(" ").includes("Playwright")), `got ${JSON.stringify(lines)}`);
	// A word longer than any line is still split.
	assert.ok(wrapWidths("Supercalifragilisticexpialidocious", [12, 12, 12]).length > 1);
});

test("a word too long for a line breaks after its hyphen, not at a random letter", () => {
	const lines = wrapWidths("double-check edge cases", [11, 11, 11, 7]);
	assert.equal(lines[0], "double-", `got ${JSON.stringify(lines)}`);
	assert.ok(lines[1]!.startsWith("check"), `got ${JSON.stringify(lines)}`);
});

test("glance thread keys: only the title, big; colour and motion carry the state", () => {
	const at = (extra: Partial<ThreadCard>, now = 0) => renderThreadKey({ card: card(extra), projectName: "acme-api", connection: ok, animation: "smooth", now, style: "glance" });
	const sizes = (svg: string) => [...svg.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
	const input = at({ state: "input", title: "Upgrade to Node 24", context: { used: 80, max: 100 }, subagentsWorking: 0 });
	assert.ok(!input.includes("<g id=\"glyph") && !input.includes(">acme-api<") && !input.includes('y="138"'), "no icon, project or context bar");
	assert.ok(input.includes(">Upgrade<") || input.includes(">Upgrade to<"));
	assert.ok(at({ state: "input", title: "x" }, 600).includes('stroke-width="3" opacity="0.9"'), "dark phase keeps the ring");

	// Working: a blue stroke orbits the border; only background work left: a white one. No numbers.
	const working = at({ state: "working", ownStatus: "running", title: "Cache build artifacts", subagentsWorking: 12 });
	assert.ok(working.includes('<g id="orbit">') && working.includes('stroke="#297EFF"'));
	assert.ok(!/>\d+<\/text>|>\+</.test(working), "no counts");
	assert.notEqual(working, at({ state: "working", ownStatus: "running", title: "Cache build artifacts", subagentsWorking: 12 }, 150), "it moves every 150 ms");
	const waiting = at({ state: "working", ownStatus: "completed", background: 1, title: "Release hardening" });
	assert.ok(waiting.includes('<g id="orbit">') && waiting.includes('stroke="#F4F5F7"'));

	const long = at({ state: "failed", title: "Deploy staging stack for the quarterly release review" });
	assert.ok(long.includes("…"), "too long: the last line is cut");
	const word = at({ state: "done", title: "Implementation" });
	assert.ok(word.includes("Implem") && word.includes("…") && !word.includes(">ntation<"), "a word too long for a line is cut, not split");
	const paused = at({ state: "paused", title: "Write the plan", pausedUntil: 2 * 3600_000 + 10 * 60_000 });
	assert.ok(paused.includes("stroke-dasharray") && !paused.includes("2h 10m"), "paused: dashed and dim, no countdown");
	for (const svg of [input, working, waiting, long, word, paused]) assert.ok(sizes(svg).every((n) => n === 26), `titles at 26 px: ${sizes(svg)}`);
});

test("glance thread keys schedule the orbit's steps, and paused ones don't tick", () => {
	const working = card({ state: "working", ownStatus: "running" });
	assert.equal(nextThreadFrame(working, "smooth", 1000, "glance"), 1050);
	assert.equal(nextThreadFrame(working, "smooth", 1000), 1200, "the detailed spinner steps every 300 ms");
	const paused = card({ state: "paused", pausedUntil: 3_600_000 });
	assert.equal(nextThreadFrame(paused, "smooth", 0, "glance"), undefined);
	assert.notEqual(nextThreadFrame(paused, "smooth", 0), undefined);
});

test("glance overview: the most urgent count big, then / all threads, smaller and fainter, joined at one point", () => {
	const counts = (o: Partial<Record<"input" | "failed" | "done" | "working" | "background" | "idle", number>>) => ({ input: 0, failed: 0, done: 0, working: 0, background: 0, idle: 0, ...o });
	const ov = (c: ReturnType<typeof counts>, now = 0) => renderOverview({ connection: ok, counts: c, overflow: 3, animation: "smooth", now, style: "glance" });
	const needs = ov(counts({ input: 2, working: 6, background: 2, done: 1, idle: 3 }), 600); // the blink's dark phase
	assert.match(needs, /y="132"[^>]*>NEED YOU</, "what it counts, at the bottom");
	assert.match(needs, /x="72" y="22"[^>]*>T3 THREADS</, "titled like the Machine keys");
	const big = /<text x="(\d+)" y="96" [^>]*font-size="66"[^>]*text-anchor="end">2</.exec(needs);
	const rest = /<text x="(\d+)" y="96" [^>]*font-size="30"[^>]*fill="#6B7280">\/12</.exec(needs);
	assert.ok(big && rest, "2 of 12, same baseline, the rest fainter");
	assert.equal(Number(rest![1]), Number(big![1]) + 4, "a small, fixed gap between the count and /12");
	assert.match(ov(counts({ input: 2, idle: 3 }), 0), /fill="rgba\(0,0,0,0.8\)">\/5</, "on the lit tile the total is dark ink");
	assert.ok(!needs.includes("<circle"), "no dots");
	const half = ov(counts({ done: 1, idle: 1 }));
	assert.ok(half.includes(">/2<"), "two threads, one done: 1/2");
	const one = /<text x="(\d+)" y="96" [^>]*text-anchor="end">1</.exec(half);
	const two = /<text x="(\d+)" y="96" [^>]*font-size="30"[^>]*>\/2</.exec(half);
	assert.ok(Number(two![1]) < Number(one![1]), "/2 tucks into the space a final 1 leaves");
	assert.ok(ov(counts({ failed: 1, input: 2 })).includes(">FAILED<"), "failed first");
	const working = ov(counts({ working: 12, background: 3, idle: 4 }), 300);
	assert.ok(working.includes(">WORKING<") && working.includes(">9<") && working.includes(">/16<") && !working.includes("rotate("), "no spinner");
	assert.ok(ov(counts({ working: 2, background: 2, idle: 5 })).includes(">WAITING<"));
	const idle = ov(counts({ idle: 6 }));
	assert.ok(idle.includes(">IDLE<") && /text-anchor="middle">6</.test(idle) && !idle.includes(">/"), "all of them: just the count, centred");
});

