// Writes an HTML contact sheet of every key state.
// Usage: node --experimental-strip-types scripts/preview.ts out.html [--labels] [--size 96]
//   --labels   status label on thread tiles
//   --size N   draw keys at N px (a Stream Deck key is about 72–96 px on screen)
import { writeFileSync } from "node:fs";
import type { ThreadCard } from "../src/model.ts";
import { renderActionKey, renderBackKey, renderOverview, renderThreadKey, renderUsageKey, type ActionKeyInput } from "../src/render.ts";
import { pace, type UsageWindow } from "../src/usage.ts";
import type { Connection } from "../src/t3/monitor.ts";

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a));
if (!out) throw new Error("usage: preview.ts out.html [--labels] [--size 96]");
const showLabel = args.includes("--labels") || args.includes("labels");
const sizeAt = args.indexOf("--size");
const px = sizeAt >= 0 ? Number(args[sizeAt + 1]) : 144;

const ok = { kind: "ok" } as const;
const card = (state: ThreadCard["state"], title: string, extra: Partial<ThreadCard> = {}): ThreadCard => ({
	threadId: title, projectId: "p", title, link: "", state, ownStatus: state === "working" ? "running" : "completed", subagentsWorking: 0, subagentsWaiting: 0, background: 0,
	inputFromSubagent: false, ackKey: "", updatedAt: 0, createdAt: 0, ...extra });
const thread = (c: ThreadCard | undefined, projectName: string, now = 0, extra: Partial<Parameters<typeof renderThreadKey>[0]> = {}) =>
	renderThreadKey({ card: c, projectName, connection: ok, animation: "smooth", now, showLabel, ...extra });
const counts = (o: Partial<Record<"input" | "failed" | "done" | "working" | "background" | "idle", number>>) => ({ input: 0, failed: 0, done: 0, working: 0, background: 0, idle: 0, ...o });
const overview = (c: ReturnType<typeof counts>, overflow = 0, now = 0, extra: Partial<Parameters<typeof renderOverview>[0]> = {}) =>
	renderOverview({ connection: ok, counts: c, overflow, animation: "smooth", now, ...extra });
const offline = (reason?: string): Connection => ({ kind: "offline", detail: "", reason: reason as never });
const now = Date.parse("2026-11-03T12:00:00Z");
const week = (usedPercent: number, daysLeft: number, extra: Partial<UsageWindow> = {}): UsageWindow => ({
	id: "seven_day", label: "Weekly", usedPercent, windowDurationMins: 10080, resetsAt: new Date(now + daysLeft * 86_400_000).toISOString(), ...extra });
const usage = (w: UsageWindow, okFlag = true, style: "bar" | "ring" = "bar", provider = "Claude") =>
	renderUsageKey({ metric: { key: "k", provider, label: w.label, window: w }, pace: pace(w, now), ok: okFlag, loading: false, style });
const running = card("working", "Add retry to checkout flow", { activeRunId: "run-1" });
const act = (action: ActionKeyInput["action"], extra: Partial<ActionKeyInput> = {}) =>
	renderActionKey({ action, card: running, connection: ok, animation: "smooth", now: 0, projectName: "acme-api", ...extra });

const sections: [string, [string, string][]][] = [
	["Thread tiles", [
		["working", thread(card("working", "Add retry to checkout flow", { context: { used: 42, max: 100 } }), "acme-api", 300)],
		["working + 2 subagents", thread(card("working", "Cache build artifacts in CI", { subagentsWorking: 2 }), "acme-api", 1500)],
		["needs you (lit)", thread(card("input", "Upgrade to Node 24"), "acme-docs", 0)],
		["needs you (dark)", thread(card("input", "Upgrade to Node 24"), "acme-docs", 600)],
		["subagent asks + working", thread(card("input", "Fix flaky login test", { inputFromSubagent: true, subagentsWaiting: 1, subagentsWorking: 1 }), "acme-api", 600)],
		["done", thread(card("done", "Migrate docs to new wiki", { context: { used: 76, max: 100 } }), "acme-web")],
		["failed (lit)", thread(card("failed", "Deploy staging stack", { context: { used: 100, max: 100 } }), "acme-infra", 0)],
		["failed (dark)", thread(card("failed", "Deploy staging stack"), "acme-infra", 900)],
		["background only", thread(card("working", "Release hardening", { ownStatus: "completed", background: 1, waitingOn: "PR #42 CI" }), "acme-docs", 0)],
		["idle", thread(card("idle", "Refactor session handling"), "acme-auth")],
		["paused (limit)", thread(card("paused", "Write the migration plan for Q1", { pausedUntil: now + 2 * 3600_000 + 10 * 60_000 }), "acme-api", now)],
		["animation off · needs you", renderThreadKey({ card: card("input", "Approve the deploy"), projectName: "infra", connection: ok, animation: "off", now: 0, showLabel })],
		["release cue", thread(card("working", "Add retry to checkout flow"), "acme-api", 300, { releaseCue: "open" })],
		["empty", thread(undefined, "")],
	]],
	["Text stress", [
		["CJK title", thread(card("working", "修复登录页面的错误并添加测试"), "项目")],
		["emoji title", thread(card("input", "🚀 Ship it 🎉 tonight"), "launch", 0)],
		["wide caps", thread(card("done", "WWW MMM WWWW MMMMM WWW"), "MMMMMMMMMMMM")],
		["narrow", thread(card("idle", "illicit lily jill fill ill will till"), "iiiiiiiiiiiiiiiiiiii")],
		["long word", thread(card("failed", "Supercalifragilisticexpialidocious refactor"), "x", 900)],
		["control chars", thread(card("idle", "Bad\u0007title\u001b[31m here￿"), "p\u0000roj")],
		["many agents", thread(card("working", "Big fan-out", { subagentsWorking: 12, background: 3 }), "acme-infra", 300)],
	]],
	["Offline (first key / others)", [
		["not installed", renderThreadKey({ card: undefined, projectName: "", connection: offline("not-installed"), animation: "off", now: 0 })],
		["not running", renderThreadKey({ card: undefined, projectName: "", connection: offline("not-running"), animation: "off", now: 0 })],
		["cli missing", renderThreadKey({ card: undefined, projectName: "", connection: offline("cli-missing"), animation: "off", now: 0 })],
		["sign-in failed", renderThreadKey({ card: undefined, projectName: "", connection: { kind: "error", detail: "", reason: "sign-in-failed" }, animation: "off", now: 0 })],
		["server error", renderThreadKey({ card: undefined, projectName: "", connection: { kind: "error", detail: "", reason: "server-error" }, animation: "off", now: 0 })],
		["other keys", renderThreadKey({ card: undefined, projectName: "", connection: offline("not-running"), animation: "off", now: 0, primary: false })],
		["overview offline", overview(counts({}), 0, 0, { connection: offline("not-running") })],
		["overview error", overview(counts({}), 0, 0, { connection: { kind: "error", detail: "", reason: "sign-in-failed" } })],
	]],
	["Overview", [
		["working", overview(counts({ done: 0, working: 3, idle: 2 }), 0, 900)],
		["done", overview(counts({ done: 1, working: 3 }))],
		["needs you (lit)", overview(counts({ input: 1, working: 3 }), 4, 0)],
		["failed (dark)", overview(counts({ failed: 2, input: 1, working: 3 }), 0, 900)],
		["2 digits", overview(counts({ input: 12, working: 34, done: 56 }), 18, 600)],
		["3 digits", overview(counts({ input: 123, working: 456, done: 789 }), 999, 600)],
		["idle", overview(counts({ idle: 4 }))],
		["hold to clear all", overview(counts({ done: 3 }), 0, 0, { hold: 0.55 })],
		["release for threads", overview(counts({ input: 1, working: 3, done: 2 }), 4, 900, { releaseCue: true })],
		["release · glance", overview(counts({ input: 1, working: 3, done: 2 }), 4, 900, { releaseCue: true, style: "glance" })],
	]],
	["Back keys", [
		["back", renderBackKey(false)],
		["back, needs you", renderBackKey(true)],
		["back +7", renderBackKey(false, 7)],
		["back +12, needs you", renderBackKey(true, 12)],
	]],
	["Thread Actions", [
		["header", act("header")],
		["open", act("open")],
		["message", act("message", { message: "run the tests and report" })],
		["message (Label)", act("message", { message: "Ship" })],
		["message · hint", act("message", { message: "summarize where you are", hint: true })],
		["message · holding", act("message", { message: "continue", progress: 0.6 })],
		["compact", act("compact")],
		["compact · hint", act("compact", { hint: true })],
		["snooze 1h", act("snooze1h")],
		["snooze tomorrow", act("snoozeTomorrow")],
		["settle", act("settle")],
		["settle · holding", act("settle", { progress: 0.4 })],
		["stop", act("stop")],
		["stop · hint", act("stop", { hint: true })],
		["stop · holding", act("stop", { progress: 0.7 })],
		["stop · nothing running", act("stop", { card: card("idle", "Done thing") })],
	]],
	["Thread Actions · actions off", [
		["stop", act("stop", { enabled: false })],
		["settle", act("settle", { enabled: false })],
		["snooze", act("snooze1h", { enabled: false })],
		["compact", act("compact", { enabled: false })],
		["message", act("message", { message: "continue", enabled: false })],
		["open (still works)", act("open", { enabled: false })],
	]],
	["Usage", [
		["bar · ahead", usage(week(70, 3.5, { label: "Weekly · Fable" }))],
		["bar · under", usage(week(12, 3.5))],
		["bar · 100%", usage(week(100, 0.4, { label: "5-hour", windowDurationMins: 300 }))],
		["bar · stale", usage(week(55, 2), false)],
		["bar · other provider", usage(week(33, 5, { label: "Weekly" }), true, "bar", "Codex")],
		["ring · ahead", usage(week(62, 3.5), true, "ring")],
		["ring · 5-hour", usage(week(30, 0.1, { label: "5-hour", windowDurationMins: 300 }), true, "ring")],
		["ring · stale", usage(week(100, 1), false, "ring")],
		["loading", renderUsageKey({ metric: undefined, pace: undefined, ok: false, loading: true })],
	]],
];

const radius = Math.round(px * 0.1);
const body = sections
	.map(([title, keys]) => `<h2>${title}</h2><div class="grid">${keys.map(([l, s]) => `<figure><div class="k">${s}</div><figcaption>${l}</figcaption></figure>`).join("")}</div>`)
	.join("");
writeFileSync(out, `<html><head><meta charset="utf-8"><style>
body{margin:0;padding:16px;background:#1b1b1d;font:12px -apple-system;color:#aaa}
h2{font-size:13px;color:#ddd;margin:14px 0 8px}
.grid{display:grid;grid-template-columns:repeat(8,${px + 16}px);gap:10px}
figure{margin:0;text-align:center}
.k{width:${px}px;height:${px}px;border-radius:${radius}px;overflow:hidden;margin:0 auto 6px}
.k svg{width:${px}px;height:${px}px;display:block}
</style></head><body>${body}</body></html>`);
console.log(`wrote ${out} (${sections.reduce((n, [, k]) => n + k.length, 0)} keys at ${px}px)`);
