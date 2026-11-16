import assert from "node:assert/strict";
import { test } from "node:test";

import { safeWebUrl, type GoalSummary, type PullRequestStatus, type ThreadCard } from "../src/model.ts";
import { MIN_FONT_PX, PULL_REQUEST_WORD, goalText, nextThreadFrame, renderActionKey, renderThreadKey, textWidth } from "../src/render.ts";
import { ShellState, goalOf, pullRequestOf } from "../src/t3/shell-stream.ts";

const link = (number: number, extra: Record<string, unknown> = {}, snapshot: Record<string, unknown> | null = { state: "open", title: "Add retry to checkout flow", isDraft: false, updatedAt: "2026-11-03T10:00:00Z" }) => ({
	host: "git.example.com", repository: "acme/api", number, url: `https://git.example.com/acme/api/pulls/${number}`, source: "agent", linkedAt: "2026-11-01T10:00:00Z", snapshot, ...extra,
});
const open = (snapshot: Record<string, unknown>) => ({ state: "open", title: "t", isDraft: false, updatedAt: "2026-11-03T10:00:00Z", ...snapshot });
const status = (links: unknown[]) => pullRequestOf({ pullRequests: links as never })?.status;

test("pull request status comes only from facts T3 sent", () => {
	// Nothing known beyond "open": plain open. Never a guessed check result.
	assert.equal(status([link(1)]), "open");
	assert.equal(status([link(1, {}, open({ mergeability: "mergeable" }))]), "open");
	assert.equal(status([link(1, {}, open({ checksState: "failing" }))]), "failing");
	assert.equal(status([link(1, { watch: { failedChecks: ["unit"], passed: false } })]), "failing");
	assert.equal(status([link(1, {}, open({ mergeability: "conflicting" }))]), "conflict");
	assert.equal(status([link(1, { watch: { conflicting: true, failedChecks: [], passed: false } })]), "conflict");
	assert.equal(status([link(1, {}, open({ reviewDecision: "changes-requested" }))]), "changes");
	assert.equal(status([link(1, { watch: { awaitingApproval: ["https://git.example.com/run/9"], failedChecks: [], passed: false } })]), "approval");
	assert.equal(status([link(1, {}, open({ checksState: "pending" }))]), "running");
	assert.equal(status([link(1, {}, open({ reviewDecision: "review-required" }))]), "review");
	assert.equal(status([link(1, {}, open({ reviewDecision: "approved", checksState: "passing" }))]), "approved");
	assert.equal(status([link(1, {}, open({ reviewDecision: "approved" }))]), "approved");
	assert.equal(status([link(1, {}, open({ checksState: "passing" }))]), "passing");
	assert.equal(status([link(1, { watch: { passed: true, failedChecks: [] } })]), "passing");
	assert.equal(status([link(1, {}, open({ isDraft: true }))]), "draft");
	assert.equal(status([link(1, {}, open({ isDraft: true, reviewDecision: "review-required" }))]), "draft", "a draft isn't waiting for review");
	assert.equal(status([link(1, {}, open({ isDraft: true, checksState: "failing" }))]), "failing", "a draft with failing checks still needs you");
	// Passing checks don't hide a conflict or requested changes.
	assert.equal(status([link(1, {}, open({ checksState: "passing", mergeability: "conflicting" }))]), "conflict");
	assert.equal(status([link(1, {}, open({ checksState: "passing", reviewDecision: "changes-requested" }))]), "changes");
	// Values this code doesn't know are ignored, not interpreted.
	assert.equal(status([link(1, {}, open({ checksState: "flaky", reviewDecision: "maybe", mergeability: 7 }))]), "open");
	assert.equal(status([link(1, { watch: { failedChecks: "unit", conflicting: "yes", awaitingApproval: {} } })]), "open");
});

test("a link without a synced snapshot counts as open, as in T3's sidebar", () => {
	assert.equal(status([link(1, {}, null)]), "open");
	assert.equal(status([{ ...link(1), snapshot: undefined }]), "open");
});

test("only open pull requests are marked; with none open the latest one is kept for the Actions page", () => {
	const merged = (n: number, updatedAt: string) => link(n, {}, { state: "merged", title: "t", isDraft: false, updatedAt, mergedAt: updatedAt });
	const closed = (n: number, updatedAt: string) => link(n, {}, { state: "closed", title: "t", isDraft: false, updatedAt });
	// 89 merged links and one open: the open one.
	const many = Array.from({ length: 89 }, (_, i) => merged(i + 1, `2026-10-${String((i % 28) + 1).padStart(2, "0")}T10:00:00Z`));
	assert.deepEqual(pullRequestOf({ pullRequests: [...many, link(500)] as never }), { number: 500, url: "https://git.example.com/acme/api/pulls/500", status: "open" });
	// None open: the most recently updated, merged or closed, ties to the later link.
	assert.deepEqual(pullRequestOf({ pullRequests: [merged(1, "2026-10-01T00:00:00Z"), closed(2, "2026-10-05T00:00:00Z"), merged(3, "2026-10-02T00:00:00Z")] as never }), { number: 2, url: "https://git.example.com/acme/api/pulls/2", status: "closed" });
	assert.equal(pullRequestOf({ pullRequests: [merged(1, "2026-10-01T00:00:00Z"), merged(2, "2026-10-01T00:00:00Z")] as never })?.number, 2);
	// An updatedAt that isn't a date falls back to when it was linked.
	assert.equal(pullRequestOf({ pullRequests: [merged(1, "nope"), { ...merged(2, "nope"), linkedAt: "2026-11-09T00:00:00Z" }] as never })?.number, 2);
	assert.equal(pullRequestOf({ pullRequests: [] }), undefined);
	assert.equal(pullRequestOf({}), undefined);
});

test("several open pull requests: the one that most needs attention, then the most recently linked", () => {
	const order: [string, Record<string, unknown>][] = [
		["failing", { checksState: "failing" }],
		["approval", {}],
		["running", { checksState: "pending" }],
		["review", { reviewDecision: "review-required" }],
		["approved", { reviewDecision: "approved" }],
		["open", {}],
		["draft", { isDraft: true }],
	];
	// Each outranks everything after it, whatever order they are linked in.
	for (let i = 0; i < order.length - 1; i++) {
		const better = link(10 + i, order[i]![0] === "approval" ? { watch: { awaitingApproval: ["run"], failedChecks: [], passed: false } } : {}, open(order[i]![1]));
		const worse = link(90, {}, open(order[i + 1]![1]));
		assert.equal(pullRequestOf({ pullRequests: [worse, better] as never })?.number, 10 + i, `${order[i]![0]} beats ${order[i + 1]![0]}`);
		assert.equal(pullRequestOf({ pullRequests: [better, worse] as never })?.number, 10 + i);
	}
	// Failing checks, a conflict and requested changes tie: the latest linked wins.
	const f = link(1, { linkedAt: "2026-11-01T00:00:00Z" }, open({ checksState: "failing" }));
	const c = link(2, { linkedAt: "2026-11-03T00:00:00Z" }, open({ mergeability: "conflicting" }));
	const ch = link(3, { linkedAt: "2026-11-02T00:00:00Z" }, open({ reviewDecision: "changes-requested" }));
	assert.equal(pullRequestOf({ pullRequests: [f, c, ch] as never })?.number, 2);
	// Equal rank and no usable linkedAt: the later one in the list.
	assert.equal(pullRequestOf({ pullRequests: [link(1, { linkedAt: "x" }), link(2, { linkedAt: "x" })] as never })?.number, 2);
	// An open pull request beats a more recent merged one.
	assert.equal(pullRequestOf({ pullRequests: [link(1), link(2, {}, { state: "merged", title: "t", isDraft: false, updatedAt: "2027-01-01T00:00:00Z" })] as never })?.number, 1);
});

test("hidden, malformed and unknown links are skipped", () => {
	const dismissed = link(7, { source: "stack-dismissed" });
	assert.equal(pullRequestOf({ pullRequests: [dismissed] as never }), undefined, "a hidden stack member");
	assert.equal(status([dismissed, link(8, {}, open({ isDraft: true }))]), "draft");
	for (const bad of [null, 5, "x", [], {}, { ...link(1), number: 0 }, { ...link(1), number: 1.5 }, { ...link(1), number: "3" }, { ...link(1), url: "" }, { ...link(1), url: 5 }, link(1, {}, open({ state: "queued" })), { ...link(1), snapshot: "open" }]) {
		assert.equal(pullRequestOf({ pullRequests: [bad] as never }), undefined, JSON.stringify(bad));
	}
	assert.equal(pullRequestOf({ pullRequests: "nope" as never }), undefined);
	assert.equal(pullRequestOf({ pullRequests: {} as never }), undefined);
	// A bad entry doesn't hide a good one.
	assert.equal(pullRequestOf({ pullRequests: [null, { number: 1 }, link(3)] as never })?.number, 3);
});

test("older servers: the single linkedPullRequest stands in when there is no list; branchPullRequest is not a link", () => {
	const linked = { projectId: "p", repository: "acme/api", number: 12, url: "https://git.example.com/acme/api/pulls/12" };
	assert.deepEqual(pullRequestOf({ linkedPullRequest: linked }), { number: 12, url: linked.url, status: "open" });
	assert.equal(pullRequestOf({ pullRequests: [], linkedPullRequest: linked }), undefined, "an empty list means unlinked");
	assert.equal(pullRequestOf({ linkedPullRequest: null }), undefined);
	assert.equal(pullRequestOf({ branchPullRequest: linked } as never), undefined);
});

test("goal summary", () => {
	assert.equal(goalOf(null), undefined);
	assert.equal(goalOf(undefined), undefined);
	assert.equal(goalOf("active"), undefined);
	assert.equal(goalOf([]), undefined);
	assert.equal(goalOf({ objective: "Ship it" }), undefined, "no status");
	assert.equal(goalOf({ status: "exploded" }), undefined, "a status from a newer server");
	for (const s of ["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"]) assert.deepEqual(goalOf({ status: s }), { status: s });
	assert.deepEqual(goalOf({ objective: "o", status: "active", tokensUsed: 620, tokenBudget: 1000 }), { status: "active", budgetPercent: 62 });
	assert.deepEqual(goalOf({ status: "active", tokensUsed: 5000, tokenBudget: 1000 }), { status: "active", budgetPercent: 100 }, "clamped");
	assert.deepEqual(goalOf({ status: "active", tokensUsed: 0, tokenBudget: 1000 }), { status: "active", budgetPercent: 0 });
	for (const odd of [{ tokenBudget: 1000 }, { tokensUsed: 5 }, { tokensUsed: 5, tokenBudget: null }, { tokensUsed: 5, tokenBudget: 0 }, { tokensUsed: -1, tokenBudget: 10 }, { tokensUsed: "5", tokenBudget: 10 }, { tokensUsed: Infinity, tokenBudget: 10 }, { tokensUsed: NaN, tokenBudget: 10 }]) {
		assert.deepEqual(goalOf({ status: "active", ...odd }), { status: "active" }, JSON.stringify(odd));
	}
});

test("ShellState carries the pull request and goal per thread, only when there are any", () => {
	const state = new ShellState();
	state.apply({
		kind: "snapshot",
		snapshot: {
			threads: [
				{ id: "a", pullRequests: [link(42, {}, open({ checksState: "failing" }))], goal: { objective: "Ship it", status: "blocked" } },
				{ id: "b", pullRequests: [], goal: null },
				{ id: "c", pullRequests: "junk", goal: 5 },
			],
		},
	});
	assert.deepEqual(state.extras("a")?.pullRequest, { number: 42, url: "https://git.example.com/acme/api/pulls/42", status: "failing" });
	assert.deepEqual(state.extras("a")?.goal, { status: "blocked" });
	for (const id of ["b", "c"]) {
		assert.ok(!("pullRequest" in state.extras(id)!) && !("goal" in state.extras(id)!), id);
	}
	// A goal that is cleared, or a pull request that merges, goes with the next update.
	state.apply({ kind: "thread.updated", thread: { id: "a", pullRequests: [link(42, {}, { state: "merged", title: "t", isDraft: false, updatedAt: "2026-11-04T00:00:00Z" })], goal: null } });
	assert.equal(state.extras("a")?.pullRequest?.status, "merged");
	assert.ok(!("goal" in state.extras("a")!));
});

test("safeWebUrl: http(s) only, no credentials, at most 2,048 characters", () => {
	assert.equal(safeWebUrl("https://git.example.com/acme/api/pulls/42"), "https://git.example.com/acme/api/pulls/42");
	assert.equal(safeWebUrl("http://127.0.0.1:3000/x"), "http://127.0.0.1:3000/x");
	assert.equal(safeWebUrl("https://git.example.com/a b"), "https://git.example.com/a%20b", "normalised");
	assert.equal(safeWebUrl(`https://git.example.com/${"a".repeat(2048 - 24)}`)?.length, 2048);
	for (const bad of [undefined, null, 5, {}, "", " ", "pulls/42", "//git.example.com/x", "javascript:alert(1)", "file:///etc/passwd", "t3code://threads/a/b", "ssh://git@git.example.com/x", "data:text/html,x", "-b com.evil.app", "--help", "https://user@git.example.com/x", "https://user:pw@git.example.com/x", "https://:pw@git.example.com/x", `https://git.example.com/${"a".repeat(2048)}`, "https://"]) {
		assert.equal(safeWebUrl(bad), undefined, String(bad).slice(0, 40));
	}
});

// ---------- Rendering ----------

const ok = { kind: "ok" } as const;
const card = (extra: Partial<ThreadCard>): ThreadCard => ({
	threadId: "x", projectId: "p", title: "Add retry to checkout flow", link: "", state: "idle", ownStatus: "completed",
	subagentsWorking: 0, subagentsWaiting: 0, background: 0, inputFromSubagent: false, ackKey: "", updatedAt: 0, createdAt: 0, ...extra,
});
const render = (c: ThreadCard, project = "acme-api", now = 0, style?: "glance") => renderThreadKey({ card: c, projectName: project, connection: ok, animation: "smooth", now, ...(style ? { style } : {}) });
const pr = (s: PullRequestStatus, number = 42) => ({ number, url: `https://git.example.com/acme/api/pulls/${number}`, status: s });
const OPEN_STATUSES: PullRequestStatus[] = ["failing", "conflict", "changes", "approval", "running", "review", "approved", "passing", "open", "draft"];
const GOALS: GoalSummary["status"][] = ["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"];

test("thread key: each open pull request status has its own mark and the number", () => {
	const seen = new Set<string>();
	for (const s of OPEN_STATUSES) {
		const svg = render(card({ pullRequest: pr(s) }));
		assert.ok(svg.includes(`id="pr-${s}"`), s);
		assert.ok(svg.includes(">#42<"), `${s} shows the number`);
		assert.ok(svg.includes(">acme-api<"), `${s} keeps the project name`);
		seen.add(svg.match(/<g id="pr-[^]*?<\/g>/)![0]!.replace(/id="pr-\w+"/, ""));
	}
	// "!" is shared by conflict, changes and approval, the tick by approved and passing: 7 shapes for 10 statuses.
	assert.equal(seen.size, 7, "marks differ in shape, not only in colour");
});

test("thread key: merged and closed pull requests draw no mark", () => {
	for (const s of ["merged", "closed"] as const) {
		const svg = render(card({ pullRequest: pr(s) }));
		assert.ok(!svg.includes('id="pr-') && !svg.includes(">#42<"), s);
	}
	assert.equal(render(card({ pullRequest: pr("merged") })), render(card({})));
});

test("thread key: nothing is drawn without data, and existing footers are unchanged", () => {
	const plain = render(card({}));
	assert.ok(!plain.includes('id="pr-') && !plain.includes('id="goal-'));
	assert.ok(plain.includes(">acme-api<"));
	for (const extra of [{ context: { used: 41, max: 100 } }, { subagentsWorking: 2 }, { ownStatus: "completed", state: "working", background: 1, waitingOn: "PR #42 CI" }] as Partial<ThreadCard>[]) {
		const svg = render(card(extra));
		assert.ok(!svg.includes('id="pr-') && !svg.includes('id="goal-'), JSON.stringify(extra));
	}
	// A footer with a mark keeps what the footer already had.
	const busy = render(card({ state: "working", ownStatus: "running", subagentsWorking: 2, pullRequest: pr("failing") }));
	assert.ok(busy.includes(">2<") && busy.includes('id="pr-failing"'), "the agent badge stays beside the mark");
	const ctx = render(card({ context: { used: 41, max: 100 }, pullRequest: pr("failing") }));
	assert.ok(ctx.includes(">41%<") && ctx.includes('height="4" rx="2"'));
});

test("thread key: goal marks, with the budget share while active and a word when it stopped", () => {
	for (const s of GOALS) assert.ok(render(card({ goal: { status: s } })).includes(`id="goal-${s}"`), s);
	assert.ok(render(card({ goal: { status: "active", budgetPercent: 62 } })).includes(">62%<"));
	assert.ok(render(card({ goal: { status: "active", budgetPercent: 91 } })).includes("#FF242F"), "91% turns red");
	assert.ok(!render(card({ goal: { status: "active" } })).includes("%<"), "no budget, no share");
	assert.deepEqual(GOALS.map((s) => goalText({ status: s })), ["", "paused", "blocked", "limit", "budget", "done"]);
	for (const [s, word] of [["paused", "paused"], ["blocked", "blocked"], ["usage_limited", "limit"], ["budget_limited", "budget"], ["complete", "done"]] as const) {
		assert.ok(render(card({ goal: { status: s } }), "").includes(`>${word}<`), s);
	}
});

test("thread key: pull request and goal marks share the footer, the project name giving way last", () => {
	const both = render(card({ pullRequest: pr("failing"), goal: { status: "active", budgetPercent: 62 } }));
	assert.ok(both.includes('id="pr-failing"') && both.includes('id="goal-active"'));
	assert.ok(both.includes(">acme-api<"), "a short project name stays whole");
	// Without a project name there is room for the words.
	const roomy = render(card({ pullRequest: pr("failing"), goal: { status: "active", budgetPercent: 62 } }), "");
	assert.ok(roomy.includes(">#42<") && roomy.includes(">62%<"));
	// With 2-digit agents only the pull request mark survives next to a short project name.
	const crowded = render(card({ state: "working", ownStatus: "running", subagentsWorking: 12, pullRequest: pr("review"), goal: { status: "paused" } }));
	assert.ok(crowded.includes('id="pr-review"') && !crowded.includes('id="goal-'));
	// A long project name is cut with an ellipsis rather than overlapping a mark.
	const long = render(card({ pullRequest: pr("failing"), goal: { status: "blocked" } }), "acme-payments-service-platform");
	assert.ok(long.includes("…</text>") && long.includes('id="pr-failing"'));
});

test("thread key: the project name stops short of the marks, and the marks short of the badge or context %", () => {
	for (const extra of [{}, { context: { used: 41, max: 100 } }, { state: "working", ownStatus: "running", subagentsWorking: 1 }, { state: "working", ownStatus: "running", subagentsWorking: 12 }] as Partial<ThreadCard>[]) {
		for (const project of ["acme-api", "acme-payments-service-platform"]) {
			const svg = render(card({ pullRequest: pr("failing", 4821), goal: { status: "active", budgetPercent: 62 }, ...extra }), project);
			const lefts = [...svg.matchAll(/<g id="(?:pr|goal)-\w+">(?:<circle cx="([\d.]+)" cy="124" r="9"|<rect x="([\d.]+)")/g)].map((m) => (m[1] ? Number(m[1]) - 9 : Number(m[2])));
			assert.ok(lefts.length > 0, "at least one mark fits");
			const name = /<text x="12" y="130"[^>]*>([^<]*)<\/text>/.exec(svg)!;
			const nameEnd = 12 + textWidth(name[1]!) * 14 * 0.56;
			assert.ok(nameEnd <= Math.min(...lefts) - 4, `${project}: name ends ${nameEnd}, marks start ${Math.min(...lefts)}`);
			// Right side: whatever sits at the key's edge starts after the last mark.
			const badge = /<rect x="([\d.]+)" y="114" width="[\d.]+" height="20" rx="10"/.exec(svg);
			if (badge) {
				const ends = [...svg.matchAll(/<g id="(?:pr|goal)-\w+">(?:<circle cx="([\d.]+)" cy="124" r="9"|<rect x="([\d.]+)")/g)].map((m) => (m[1] ? Number(m[1]) + 9 : Number(m[2]) + 18));
				assert.ok(Math.max(...ends) <= Number(badge[1]) - 4, "marks stop short of the agent badge");
			}
		}
	}
});

test("thread key: a waiting chip about this pull request isn't repeated by a mark; another one is", () => {
	const chip = { state: "working" as const, ownStatus: "completed", background: 1, waitingOn: "PR #42 CI" };
	const same = render(card({ ...chip, pullRequest: pr("running", 42) }));
	assert.ok(same.includes(">PR #42 CI<") && !same.includes('id="pr-'));
	const other = render(card({ ...chip, waitingOn: "2 agents", pullRequest: pr("failing", 57) }));
	assert.ok(other.includes(">2 agents<") && other.includes('id="pr-failing"'));
	const different = render(card({ ...chip, waitingOn: "2 agents", pullRequest: pr("failing", 57), goal: { status: "complete" } }));
	assert.ok(different.includes('id="pr-failing"'));
	// The chip's own text is never cut for a mark.
	const long = render(card({ ...chip, waitingOn: "npm run test:integration", pullRequest: pr("failing", 57) }));
	assert.equal(long, render(card({ ...chip, waitingOn: "npm run test:integration" })));
});

test("thread key: marks are static: state colours, flashing, spinner and frame timing don't change", () => {
	const bare = card({ state: "input", ownStatus: "waiting" });
	const marked = card({ state: "input", ownStatus: "waiting", pullRequest: pr("failing"), goal: { status: "blocked" } });
	for (const animation of ["smooth", "off"] as const) {
		for (const now of [0, 300, 450, 600, 899, 900]) {
			assert.equal(nextThreadFrame(marked, animation, now), nextThreadFrame(bare, animation, now));
			assert.equal(nextThreadFrame(marked, animation, now, "glance"), nextThreadFrame(bare, animation, now, "glance"));
		}
	}
	const failedPr = card({ state: "idle", pullRequest: pr("failing"), goal: { status: "blocked" } });
	assert.equal(nextThreadFrame(failedPr, "smooth", 0), undefined, "a failing pull request or blocked goal doesn't animate the key");
	// Lit and dark phases of a blink both keep the mark.
	assert.ok(render(marked, "acme-api", 0).includes('id="pr-failing"') && render(marked, "acme-api", 600).includes('id="pr-failing"'));
});

test("thread key: the glance look and paused look carry no marks", () => {
	const marked = card({ pullRequest: pr("failing"), goal: { status: "blocked" } });
	assert.equal(render(marked, "acme-api", 0, "glance"), render(card({}), "acme-api", 0, "glance"));
	const paused = card({ state: "paused", pausedUntil: 5_000_000, pullRequest: pr("failing") });
	assert.ok(!render(paused).includes('id="pr-'));
});

test("thread key: no text under the minimum size, every mark inside the key", () => {
	const cards: Partial<ThreadCard>[] = [];
	for (const s of OPEN_STATUSES) for (const g of [undefined, ...GOALS]) cards.push({ pullRequest: pr(s, 123456), ...(g ? { goal: { status: g, budgetPercent: 100 } } : {}) });
	for (const extra of cards) {
		for (const state of ["idle", "done", "failed", "working"] as const) {
			const svg = render(card({ state, ownStatus: state === "working" ? "running" : "completed", ...extra }), "acme-api", 0);
			for (const m of svg.matchAll(/font-size="([\d.]+)"/g)) assert.ok(Number(m[1]) >= MIN_FONT_PX, `font ${m[1]}`);
			for (const m of svg.matchAll(/<(?:circle|rect)[^>]*?\b(?:cx|x)="(-?[\d.]+)"/g)) assert.ok(Number(m[1]) >= 0 && Number(m[1]) <= 144, m[0]);
		}
	}
});

test("thread key: text from T3 can't break the mark", () => {
	const svg = render(card({ pullRequest: { number: 7, url: "x", status: "failing" }, goal: { status: "active", budgetPercent: 5 } }), "<b>&\"'");
	assert.ok(!svg.includes("<b>") && svg.includes("&lt;b&gt;"));
});

test("Open key: shows the pull request and its status; none open says it is the last one", () => {
	const act = (c: ThreadCard, extra: Partial<Parameters<typeof renderActionKey>[0]> = {}) => renderActionKey({ action: "open", card: c, connection: ok, animation: "smooth", now: 0, projectName: "acme-api", ...extra });
	for (const s of OPEN_STATUSES) {
		const svg = act(card({ pullRequest: pr(s) }));
		assert.ok(svg.includes("PR #42") && svg.includes(`>${PULL_REQUEST_WORD[s]}<`), s);
		assert.ok(svg.includes("Open in T3 Code"));
	}
	for (const s of ["merged", "closed"] as const) {
		const svg = act(card({ pullRequest: pr(s) }));
		assert.ok(svg.includes(`Last: ${s}`), s);
	}
	assert.ok(act(card({ pullRequest: pr("failing") }), { progress: 0.5 }).includes("Hold to open"));
	assert.ok(act(card({ pullRequest: pr("failing") }), { progress: 0.5 }).includes('id="hold-progress"'));
	assert.ok(act(card({ pullRequest: pr("failing") }), { enabled: false }).includes("PR #42"), "works with actions off");
	// Without one, or with a link that wouldn't open, the key is what it was.
	const plain = act(card({}));
	assert.ok(plain.includes("in T3 Code") && !plain.includes("PR #"));
	assert.equal(act(card({ pullRequest: { number: 42, url: "javascript:alert(1)", status: "failing" } })), plain);
	assert.equal(act(undefined as never), act(undefined as never));
	for (const m of act(card({ pullRequest: pr("failing") })).matchAll(/font-size="([\d.]+)"/g)) assert.ok(Number(m[1]) >= MIN_FONT_PX);
});
