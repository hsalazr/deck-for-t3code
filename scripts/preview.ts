// Writes an HTML contact sheet of every key state.
// Usage: node --experimental-strip-types scripts/preview.ts out.html [--labels] [--size 96]
//   --labels   status label on thread tiles
//   --size N   draw keys at N px (a Stream Deck key is about 72–96 px on screen)
import { writeFileSync } from "node:fs";
import type { GoalSummary, PullRequestStatus, ThreadCard } from "../src/model.ts";
import { renderActionKey, renderBackKey, renderOverview, renderScheduledKey, renderThreadKey, renderUsageKey, type ActionKeyInput, type ScheduledKeyInput } from "../src/render.ts";
import type { ScheduledTask } from "../src/scheduled.ts";
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
const pr = (status: PullRequestStatus, number = 42) => ({ number, url: `https://git.example.com/acme/api/pulls/${number}`, status });
const tickets = (w: UsageWindow, count: number, expiresInDays?: number, style: "bar" | "ring" = "bar", provider = "Claude", okFlag = true) =>
	renderUsageKey({
		metric: { key: "k", provider, label: w.label, window: w, credits: { count, ...(expiresInDays === undefined ? {} : { nextExpiresAt: new Date(now + expiresInDays * 86_400_000).toISOString() }) } },
		pace: pace(w, now), ok: okFlag, loading: false, style, now,
	});
const running = card("working", "Add retry to checkout flow", { activeRunId: "run-1" });
const act = (action: ActionKeyInput["action"], extra: Partial<ActionKeyInput> = {}) =>
	renderActionKey({ action, card: running, connection: ok, animation: "smooth", now: 0, projectName: "acme-api", ...extra });

const mins = (n: number): number => now + n * 60_000;
const task = (extra: Partial<ScheduledTask> = {}): ScheduledTask => ({
	id: "t1", title: "Nightly dependency check", enabled: true, schedule: { kind: "interval", everyMs: 7_200_000 }, threadId: null, nextRunAt: mins(135), lastRunAt: now - 3 * 3_600_000,
	lastRunStatus: "succeeded", blocked: false, ...extra });
const sched = (t: ScheduledTask | undefined, extra: Partial<ScheduledKeyInput> = {}, reason: "none" | "missing" = "none") =>
	renderScheduledKey({ connection: ok, stream: "live", pick: t ? { task: t } : { task: undefined, reason }, now, animation: "smooth", ...extra });
const glance = { style: "glance" } as const;
const daily: ScheduledTask["schedule"] = { kind: "fixed_time", timeOfDay: "09:00", weekdays: [] };
const failedTask = task({ lastRunStatus: "failed", lastRunAt: now - 25 * 60_000, nextRunAt: mins(95) });

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
	["Pull request and goal marks", [
		...(["failing", "conflict", "changes", "approval", "running", "review", "approved", "passing", "open", "draft"] as PullRequestStatus[]).map((status): [string, string] => [`PR ${status}`, thread(card("idle", "Add retry to checkout flow", { pullRequest: pr(status) }), "acme-api")]),
		["PR merged: no mark", thread(card("idle", "Add retry to checkout flow", { pullRequest: pr("merged") }), "acme-api")],
		["PR failing · lit (done)", thread(card("done", "Migrate docs to new wiki", { pullRequest: pr("failing") }), "acme-web")],
		["PR running · dark blink", thread(card("input", "Upgrade to Node 24", { pullRequest: pr("running") }), "acme-docs", 600)],
		["PR + 2-digit agents", thread(card("working", "Cache build artifacts in CI", { subagentsWorking: 12, pullRequest: pr("failing", 1234) }), "acme-api", 300)],
		...(["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"] as GoalSummary["status"][]).map((status): [string, string] => [`goal ${status}`, thread(card("idle", "Add retry to checkout flow", { goal: { status } }), "acme-api")]),
		["goal 62% budget", thread(card("working", "Add retry to checkout flow", { goal: { status: "active", budgetPercent: 62 } }), "acme-api", 300)],
		["goal 91% budget", thread(card("working", "Add retry to checkout flow", { goal: { status: "active", budgetPercent: 91 } }), "acme-api", 300)],
		["PR + goal 62%", thread(card("idle", "Add retry to checkout flow", { pullRequest: pr("running"), goal: { status: "active", budgetPercent: 62 } }), "acme-api")],
		["PR + goal blocked", thread(card("idle", "Add retry to checkout flow", { pullRequest: pr("failing"), goal: { status: "blocked" } }), "acme-api")],
		["PR + goal + context %", thread(card("idle", "Add retry to checkout flow", { pullRequest: pr("approved"), goal: { status: "active", budgetPercent: 62 }, context: { used: 41, max: 100 } }), "acme-api")],
		["PR + goal + 1 agent", thread(card("working", "Add retry to checkout flow", { subagentsWorking: 1, pullRequest: pr("review"), goal: { status: "paused" } }), "acme-api", 300)],
		["PR + goal + 12 agents", thread(card("working", "Add retry to checkout flow", { subagentsWorking: 12, pullRequest: pr("review"), goal: { status: "paused" } }), "acme-api", 300)],
		["PR + goal + long project", thread(card("idle", "Add retry to checkout flow", { pullRequest: pr("conflict", 128), goal: { status: "budget_limited" } }), "acme-payments-service")],
		["PR + goal + no project", thread(card("idle", "Add retry to checkout flow", { pullRequest: pr("conflict", 128), goal: { status: "budget_limited" } }), "")],
		["waiting on this PR's CI", thread(card("working", "Release hardening", { ownStatus: "completed", background: 1, waitingOn: "PR #42 CI", pullRequest: pr("running") }), "acme-docs")],
		["waiting on CI + goal", thread(card("working", "Release hardening", { ownStatus: "completed", background: 1, waitingOn: "PR #42 CI", pullRequest: pr("running"), goal: { status: "active", budgetPercent: 30 } }), "acme-docs")],
		["waiting on a command + PR", thread(card("working", "Release hardening", { ownStatus: "completed", background: 1, waitingOn: "Web UI tests", pullRequest: pr("failing", 57), goal: { status: "complete" } }), "acme-docs")],
		["waiting, long label + both", thread(card("working", "Release hardening", { ownStatus: "completed", background: 1, waitingOn: "npm run test:integration", pullRequest: pr("failing", 57), goal: { status: "complete" } }), "acme-docs")],
		["glance · PR + goal: unchanged", thread(card("idle", "Add retry to checkout flow", { pullRequest: pr("failing"), goal: { status: "blocked" } }), "acme-api", 0, { style: "glance" })],
	]],
	["Thread Actions · pull request", [
		["open · PR failing", act("open", { card: card("working", "Add retry", { pullRequest: pr("failing") }) })],
		["open · PR running", act("open", { card: card("working", "Add retry", { pullRequest: pr("running") }) })],
		["open · PR approved", act("open", { card: card("working", "Add retry", { pullRequest: pr("approved") }) })],
		["open · PR plain", act("open", { card: card("working", "Add retry", { pullRequest: pr("open", 4821) }) })],
		["open · PR draft", act("open", { card: card("working", "Add retry", { pullRequest: pr("draft") }) })],
		["open · last PR merged", act("open", { card: card("idle", "Add retry", { pullRequest: pr("merged") }) })],
		["open · last PR closed", act("open", { card: card("idle", "Add retry", { pullRequest: pr("closed", 130) }) })],
		["open · holding", act("open", { card: card("working", "Add retry", { pullRequest: pr("failing") }), progress: 0.55 })],
		["open · bad link", act("open", { card: card("working", "Add retry", { pullRequest: { number: 42, url: "javascript:alert(1)", status: "failing" } }) })],
		["open · actions off", act("open", { enabled: false, card: card("working", "Add retry", { pullRequest: pr("failing") }) })],
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
		["bar · 2 tickets, expire in 2d", tickets(week(70, 3.5, { label: "Weekly · Fable" }), 2, 2)],
		["bar · 1 ticket, no expiry", tickets(week(12, 3.5), 1)],
		["bar · 12 tickets, 100% (no room)", tickets(week(100, 0.4, { label: "5-hour", windowDurationMins: 300 }), 12, 1)],
		["bar · hub plan title", tickets(week(33, 5, { label: "Weekly" }), 3, 9, "bar", "Codex Plus")],
		["bar · tickets, stale", tickets(week(55, 2), 2, 2, "bar", "Claude", false)],
		["ring · 2 tickets", tickets(week(62, 3.5), 2, 2, "ring")],
		["ring · 100%, 3-digit count", tickets(week(100, 1), 120, undefined, "ring")],
		["ring · 5-hour, tickets, stale", tickets(week(30, 0.1, { label: "5-hour", windowDurationMins: 300 }), 1, undefined, "ring", "Claude", false)],
		["no limits (unsupported)", renderUsageKey({ metric: undefined, pace: undefined, ok: true, loading: false, empty: { name: "OpenCode", text: "No plan limits" } })],
		["hub unavailable", renderUsageKey({ metric: undefined, pace: undefined, ok: true, loading: false, empty: { name: "Acme Hub", text: "Hub unavailable" } })],
	]],
];

sections.push(
	["Scheduled · detailed", [
		["counting down", sched(task())],
		["daily · long title", sched(task({ title: "Weekly dependency audit for every package in the monorepo", schedule: daily, nextRunAt: mins(60 * 26 + 5) }))],
		["under a minute", sched(task({ nextRunAt: now + 40_000 }))],
		["due now", sched(task({ nextRunAt: now - 5_000 }))],
		["running (spinner)", sched(task({ lastRunStatus: "running", lastRunAt: now - 90_000 }), { now: now + 300 })],
		["running · animation off", sched(task({ lastRunStatus: "running", lastRunAt: now - 90_000 }), { animation: "off" })],
		["last run failed", sched(failedTask)],
		["failed · long title", sched({ ...failedTask, title: "Rebuild the search index for acme-web" })],
		["never run", sched(task({ lastRunStatus: "never", lastRunAt: null }))],
		["paused (disabled)", sched(task({ enabled: false, nextRunAt: null }))],
		["blocked by policy", sched(task({ schedule: { kind: "webhook" }, nextRunAt: null, blocked: true, lastRunAt: null, lastRunStatus: "never" }))],
		["webhook", sched(task({ title: "Triage new acme-api issues", schedule: { kind: "webhook" }, nextRunAt: null, lastRunAt: now - 2 * 86_400_000 }))],
		["once, finished", sched(task({ schedule: { kind: "once" }, nextRunAt: null, lastRunAt: now - 20 * 60_000 }))],
		["weekdays", sched(task({ schedule: { kind: "fixed_time", timeOfDay: "08:30", weekdays: [1, 2, 3, 4, 5] }, nextRunAt: mins(15 * 60) }))],
		["hold to run now", sched(task(), { cue: { kind: "run", progress: 0.55 } })],
		["actions off · hold", sched(task(), { cue: { kind: "enable" } })],
	]],
	["Scheduled · glance", [
		["counting down", sched(task(), glance)],
		["running", sched(task({ lastRunStatus: "running" }), { ...glance, now: now + 600 })],
		["last run failed", sched(failedTask, glance)],
		["paused", sched(task({ enabled: false, nextRunAt: null }), glance)],
		["blocked", sched(task({ schedule: { kind: "webhook" }, nextRunAt: null, blocked: true }), glance)],
		["webhook", sched(task({ schedule: { kind: "webhook" }, nextRunAt: null }), glance)],
		["once, finished", sched(task({ schedule: { kind: "once" }, nextRunAt: null }), glance)],
		["days away", sched(task({ nextRunAt: mins(60 * 24 * 6 + 18 * 60) }), glance)],
		["due now", sched(task({ nextRunAt: now - 1000 }), glance)],
		["hold to run now", sched(task(), { ...glance, cue: { kind: "run", progress: 0.4 } })],
	]],
	["Scheduled · no task", [
		["no tasks at all", sched(undefined)],
		["chosen task gone", sched(undefined, {}, "missing")],
		["loading", renderScheduledKey({ connection: ok, stream: "loading", pick: { task: undefined, reason: "none" }, now, animation: "off" })],
		["stream down", renderScheduledKey({ connection: ok, stream: "down", pick: { task: undefined, reason: "none" }, now, animation: "off" })],
		["T3 not running", renderScheduledKey({ connection: offline("not-running"), stream: "down", pick: { task: undefined, reason: "none" }, now, animation: "off" })],
		["sign-in failed", renderScheduledKey({ connection: { kind: "error", detail: "", reason: "sign-in-failed" }, stream: "down", pick: { task: undefined, reason: "none" }, now, animation: "off" })],
	]],
);

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
