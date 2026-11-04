/**
 * Renders the looping demo animation (site, README, Marketplace gallery) from
 * the plugin's own key renderers.
 *
 *   nice -n 10 node --experimental-strip-types marketing/demo/render-demo.ts
 *
 * Every key image comes from src/render.ts, fed invented data (acme-* projects,
 * made-up titles). The Thread Actions page follows the bundled XL profile
 * (scripts/build-profile.mjs) and the press/hold timings follow src/deck.ts
 * (LONG_PRESS_MS, CONFIRM_HOLD_MS, 100 ms hold-progress steps).
 *
 * Frames are drawn by one headless Chrome page driven over the DevTools pipe:
 * each frame is a plain description (key images, positions, finger, captions)
 * applied to the page and screenshotted. Nothing depends on the wall clock, so
 * two runs give the same frames. Identical frames are copied, not re-rendered.
 * ffmpeg then encodes:
 *
 *   docs/assets/demo.mp4          1440×810 H.264 (site)
 *   docs/assets/demo.webm         1440×810 VP9 (site; skipped if libvpx-vp9 is missing)
 *   docs/assets/demo-poster.png   1440×810, the first frame
 *   docs/assets/demo.gif          800×450, 15 fps (README)
 *   marketing/gallery-video.mp4   1920×1080 H.264 (Elgato Marketplace)
 *
 * Environment:
 *   DEMO_SCRATCH  scratch dir (default: <os tmpdir>/t3deck-demo); frames go to <scratch>/frames
 *   CHROME        headless Chrome binary (default: the one T3 Code ships in ~/.t3/tools)
 *   ONLY=frames   render frames only; ONLY=encode encodes existing frames
 *   PREVIEW=ms,…  render just these moments to <scratch>/preview/t<ms>.png and stop
 */
import { execFileSync, execSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseQuickMessages, type CardState, type ThreadCard } from "../../src/model.ts";
import {
	isBackgroundOnly,
	renderActionKey,
	renderBackKey,
	renderOverview,
	renderThreadKey,
	renderUsageKey,
	type ActionKeyInput,
} from "../../src/render.ts";
import { pace, type UsageMetric } from "../../src/usage.ts";
import { waitingLabel } from "../../src/t3/shell-stream.ts";
import { PROFILES } from "../../scripts/build-profile.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRATCH = process.env.DEMO_SCRATCH ?? join(tmpdir(), "t3deck-demo");
const FRAMES = join(SCRATCH, "frames");

// ---------------------------------------------------------------- timing

const FPS = 30;
/** Loop length. A multiple of 1000/15 ms too, so the 15 fps GIF loops on a whole frame. */
const DURATION = 25_600;
const FRAME_COUNT = (DURATION * FPS) / 1000;

/** Same as src/deck.ts. */
const LONG_PRESS_MS = 500;
const CONFIRM_HOLD_MS = 800;
const PROGRESS_STEP_MS = 100;
/** How long Stream Deck's own "OK" check stays on a key. */
const OK_MS = 900;

/** A clock that sits on a multiple of every flash/spin period, so `BASE + t` behaves like `t`. */
const BASE = Math.round(Date.parse("2026-11-03T12:00:00Z") / 50_400) * 50_400;

// Storyboard (ms). Section 1: states change live.
const T_DONE = 1200; // a working tile finishes: solid green; Overview goes green
const T_INPUT = 2600; // one needs you: amber blink; Overview blinks amber
const T_FAILED = 4000; // one fails: red blink; Overview blinks red
const T_START = 5400; // an idle thread starts working
// Section 2: subagents.
const S2 = 7400;
const SPOT = [7800, 13_700] as const;
const T_SUB = [8600, 9300, 10_000] as const; // badge 1 → 2 → 3
const T_TURN_END = 11_200; // main agent ends its turn: white spinner, "3 agents"
const T_SUB_DONE = 12_800; // subagents finish: solid green
// Section 3: tap, hold, done.
const S3 = 14_000;
const T_FINGER_IN = 14_400;
const TAP_DONE = { down: 14_900, up: 15_050 }; // opens the done thread: it goes idle
const HOLD_THREAD = { down: 16_000, up: 17_000 }; // release cue at +500 ms
const T_TO_ACTIONS = HOLD_THREAD.up;
const HOLD_MSG = { down: 18_000, up: 19_000 };
const HOLD_COMPACT = { down: 19_900, up: 20_850 };
const T_COMPACTED = 21_400; // the header's context bar drops after /compact
const TAP_SNOOZE = { down: 22_000, up: 22_120 };
const T_SNOOZE_OK = TAP_SNOOZE.up + 30;
const T_TO_THREADS = 22_500;
const T_GONE = 22_950; // the next poll drops the snoozed thread…
const SLIDE = [23_050, 23_500] as const; // …and the rest slide up
const TAP_BACK = { down: 24_000, up: 24_120 };
const T_TO_PROFILE = TAP_BACK.up + 30;
const T_FINGER_OUT = 24_300;
const END_FADE = [24_850, 25_500] as const; // ease back into the opening state
const S1_AGAIN = 24_800;

// ---------------------------------------------------------------- layout (CSS px, 1920×1080 master)

const W = 1920;
const H = 1080;
const KEY = 144;
const GAP = 20;
const PAD = 40;
const COLS = 8;
const ROWS = 4;
const SLOTS = COLS * ROWS;
const DECK_W = COLS * KEY + (COLS - 1) * GAP + 2 * PAD; // 1372
const DECK_H = ROWS * KEY + (ROWS - 1) * GAP + 2 * PAD; // 716
const DECK_X = (W - DECK_W) / 2;
const DECK_Y = 258;

const slotPos = (slot: number): { x: number; y: number } => ({
	x: DECK_X + PAD + (slot % COLS) * (KEY + GAP),
	y: DECK_Y + PAD + Math.floor(slot / COLS) * (KEY + GAP),
});
const slotOf = (col: number, row: number): number => row * COLS + col;
const slotDist = (a: number, b: number): number => Math.hypot((a % COLS) - (b % COLS), Math.floor(a / COLS) - Math.floor(b / COLS));

// ---------------------------------------------------------------- easing

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const ramp = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));
const easeInOut = (p: number): number => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
const easeOut = (p: number): number => 1 - (1 - p) ** 3;
const lerp = (a: number, b: number, p: number): number => a + (b - a) * p;

// ---------------------------------------------------------------- invented threads

const ok = { kind: "ok" } as const;

interface ThreadState {
	state: CardState;
	own: string;
	ctx?: number;
	subagents: number;
	background: number;
	waitingOn?: string;
	run: boolean;
}
interface Spec {
	id: string;
	title: string;
	project: string;
	base: ThreadState;
	events: [number, Partial<ThreadState>][];
	pausedIn?: number;
}

const ownFor = (state: CardState): string => (state === "working" ? "running" : state === "input" ? "waiting" : state === "done" ? "completed" : state === "failed" ? "failed" : "idle");
function S(id: string, title: string, project: string, state: CardState, extra: Partial<ThreadState> & { pausedIn?: number; events?: [number, Partial<ThreadState>][] } = {}): Spec {
	const { pausedIn, events = [], ...rest } = extra;
	return { id, title, project, pausedIn, events, base: { state, own: ownFor(state), subagents: 0, background: 0, run: state === "working", ...rest } };
}
const agents = (n: number): string | undefined => waitingLabel(Array.from({ length: n }, (_, i) => ({ taskId: `task-${i}`, kind: "subagent" })));

/** Deck order on your own profile, after Overview and two Usage keys. */
const THREADS: Spec[] = [
	S("orders", "Paginate the orders endpoint", "acme-api", "working", { ctx: 19 }),
	S("checkout", "Add retry to checkout flow", "acme-web", "working", { ctx: 22, events: [[T_INPUT, { state: "input", own: "waiting" }]] }),
	S("wiki", "Migrate docs to new wiki", "acme-docs", "working", { ctx: 11 }),
	S("uploads", "Speed up image uploads", "acme-api", "working", { own: "completed", background: 1, waitingOn: "PR #57 CI", ctx: 63, run: false }),
	S("darkmode", "Add dark mode toggle", "acme-web", "working", { ctx: 29 }),

	S("node", "Upgrade to Node 24", "acme-api", "working", {
		ctx: 48,
		events: [
			[T_SUB[0], { background: 1 }],
			[T_SUB[1], { background: 2 }],
			[T_SUB[2], { background: 3 }],
			[T_TURN_END, { own: "completed", run: false, waitingOn: agents(3) }],
			[T_SUB_DONE, { state: "done", background: 0, waitingOn: undefined }],
			[TAP_DONE.up, { state: "idle" }], // opening it in T3 Code clears the highlight
		],
	}),
	S("ratelimit", "Rate-limit the public API", "acme-api", "idle", { events: [[T_START, { state: "working", own: "running", run: true, ctx: 2 }]] }),
	S("docker", "Trim Docker image size", "acme-infra", "idle"),
	S("secrets", "Rotate staging secrets", "acme-infra", "paused", { pausedIn: 2 * 3_600_000 + 10 * 60_000 + 40_000 }),
	S("csv", "Add CSV export to reports", "acme-web", "working", { ctx: 88, events: [[T_COMPACTED, { ctx: 14 }]] }),
	S("tz", "Fix timezone bug in reports", "acme-api", "idle"),
	S("onboarding", "Write the onboarding guide", "acme-docs", "working", { ctx: 27 }),
	S("flaky", "Fix flaky login test", "acme-web", "working", { ctx: 44, events: [[T_DONE, { state: "done", own: "completed", run: false }]] }),

	S("flags", "Clean up old feature flags", "acme-web", "idle"),
	S("playwright", "Add browser smoke tests", "acme-web", "working", { ctx: 55 }),
	S("webhook", "Review the webhook handler", "acme-api", "idle"),
	S("audit", "Add an audit log", "acme-api", "working", { ctx: 31 }),
	S("cache", "Cache CI artifacts", "acme-infra", "working", { subagents: 1, ctx: 36, events: [[T_FAILED, { state: "failed", own: "failed", subagents: 0, run: false }]] }),
	S("invoice", "Refactor invoice emails", "acme-api", "working", { ctx: 42 }),
	S("release", "Document the release process", "acme-docs", "idle"),
	S("i18n", "Add i18n to the signup page", "acme-web", "working", { subagents: 1 }),

	S("renovate", "Set up Renovate for the monorepo", "acme-infra", "idle"),
	S("cart", "Fix 500 on empty cart", "acme-web", "idle"),
	S("coldstart", "Reduce cold start time", "acme-infra", "idle"),
];
const SPOTLIT = "node";
const FOCUS = "csv"; // held, compacted, snoozed
const TAPPED = "node";

function cardAt(spec: Spec, t: number): ThreadCard {
	const s: ThreadState = { ...spec.base };
	for (const [at, patch] of spec.events) if (t >= at) Object.assign(s, patch);
	const card: ThreadCard = {
		threadId: spec.id, projectId: spec.project, title: spec.title, link: "", state: s.state, ownStatus: s.own,
		subagentsWorking: s.subagents, subagentsWaiting: 0, background: s.background, inputFromSubagent: false,
		waitingOn: s.waitingOn, activeRunId: s.run ? `run-${spec.id}` : undefined,
		pausedUntil: spec.pausedIn ? BASE + spec.pausedIn : undefined,
		context: s.ctx === undefined ? undefined : { used: s.ctx * 2000, max: 200_000 },
		ackKey: "", updatedAt: 0, createdAt: 0,
	};
	return card;
}

/** Threads still on the deck at `t` (the snoozed one leaves once the next poll drops it). */
const visibleAt = (t: number): ThreadCard[] => THREADS.filter((s) => s.id !== FOCUS || t < T_GONE).map((s) => cardAt(s, t));

/** Same as countStates in src/deck.ts. */
function countStates(cards: readonly ThreadCard[]) {
	const counts = { input: 0, failed: 0, done: 0, working: 0, background: 0, idle: 0 };
	for (const card of cards) {
		counts[card.state === "paused" ? "idle" : card.state]++;
		if (isBackgroundOnly(card)) counts.background++;
	}
	return counts;
}
const attentionOf = (cards: readonly ThreadCard[]): boolean => cards.some((c) => c.state === "input" || c.state === "failed");

function metric(id: string, label: string, usedPercent: number, windowMins: number, elapsedPercent: number): UsageMetric {
	const resetsAt = new Date(BASE + (1 - elapsedPercent / 100) * windowMins * 60_000).toISOString();
	return { key: `acme:${id}`, provider: "Claude", label, window: { id, label, usedPercent, resetsAt, windowDurationMins: windowMins } };
}
const WEEKLY = metric("seven_day", "Weekly", 64, 10_080, 52);
const FIVE_HOUR = metric("five_hour", "5-hour", 31, 300, 48);
const USAGE_BAR = renderUsageKey({ metric: WEEKLY, pace: pace(WEEKLY.window, BASE), ok: true, loading: false, style: "bar" });
const USAGE_RING = renderUsageKey({ metric: FIVE_HOUR, pace: pace(FIVE_HOUR.window, BASE), ok: true, loading: false, style: "ring" });
const EMPTY = renderThreadKey({ card: undefined, projectName: "", connection: ok, animation: "smooth", now: BASE });

/** The same quick messages as the marketing stills. */
const QUICK_MESSAGES = parseQuickMessages(`continue
run the tests and report
summarize where you are
Open PR | open a pull request for this branch
address the review comments
merge if CI is green
write a handoff file
add tests for this
explain the last change
check for flaky tests
rebase on main
update the changelog
list open TODOs`);

const XL = PROFILES.find((p: { file: string }) => p.file === "Deck for T3 Code XL")!;
type Slot = string | { action: string; index: number };
const ACTION_SLOTS: { action: string; index?: number }[] = (XL.actions as Slot[][]).flat().map((s) => (typeof s === "string" ? { action: s } : s));
const actionSlot = (action: string, index?: number): number => ACTION_SLOTS.findIndex((s) => s.action === action && s.index === index);
const MSG_INDEX = QUICK_MESSAGES.findIndex((m) => m.label === "summarize where you are");
const SLOT_MSG = actionSlot("message", MSG_INDEX);
const SLOT_COMPACT = actionSlot("compact");
const SLOT_SNOOZE = actionSlot("snooze1h");

/** Profile slots: Overview, Usage bar, Usage ring, then threads. */
const PROFILE_FIRST = 3;
const profileSlotOf = (id: string): number => PROFILE_FIRST + THREADS.findIndex((s) => s.id === id);

// ---------------------------------------------------------------- the finger

interface Press {
	down: number;
	up: number;
	slot: number;
}
const PRESSES: Press[] = [
	{ ...TAP_DONE, slot: profileSlotOf(TAPPED) },
	{ ...HOLD_THREAD, slot: profileSlotOf(FOCUS) },
	{ ...HOLD_MSG, slot: SLOT_MSG },
	{ ...HOLD_COMPACT, slot: SLOT_COMPACT },
	{ ...TAP_SNOOZE, slot: SLOT_SNOOZE },
	{ ...TAP_BACK, slot: 0 },
];
/** Where the finger rests, and when it glides to the next key. */
const MOVES: { from: number; to: number; slot: number }[] = PRESSES.map((p, i) => {
	const arrive = p.down - 100;
	const prevUp = i === 0 ? T_FINGER_IN : PRESSES[i - 1]!.up;
	const leave = Math.max(prevUp + 250, arrive - 480);
	return { from: leave, to: arrive, slot: p.slot };
});

/** How far a key is pushed down (0–1): a quick travel down, a slightly slower spring back. */
function pressAmount(slot: number, t: number): number {
	let a = 0;
	for (const p of PRESSES) {
		if (p.slot !== slot || t < p.down || t > p.up + 140) continue;
		a = Math.max(a, t <= p.up ? easeOut(ramp(t, p.down, p.down + 70)) : 1 - easeOut(ramp(t, p.up, p.up + 140)));
	}
	return a;
}
const pressedFor = (slot: number, t: number, p: Press): number | undefined => (p.slot === slot && t >= p.down && t < p.up ? t - p.down : undefined);

interface Finger {
	x: number;
	y: number;
	opacity: number;
	scale: number;
	press: number;
	ripple?: { scale: number; opacity: number };
}
/** The finger rests a little below and right of the key centre, so the title stays readable. */
const FINGER_OFFSET = { x: 36, y: -4 };
function fingerAt(t: number): Finger | undefined {
	if (t < T_FINGER_IN || t > T_FINGER_OUT + 300) return undefined;
	let slot = MOVES[0]!.slot;
	let x = 0;
	let y = 0;
	let lift = 0;
	const at = (s: number) => {
		const p = slotPos(s);
		return { x: p.x + KEY / 2 + FINGER_OFFSET.x, y: p.y + KEY / 2 + FINGER_OFFSET.y };
	};
	({ x, y } = at(slot));
	for (const m of MOVES.slice(1)) {
		if (t >= m.to) {
			slot = m.slot;
			({ x, y } = at(slot));
		} else if (t > m.from) {
			const p = easeInOut(ramp(t, m.from, m.to));
			const a = at(slot);
			const b = at(m.slot);
			x = lerp(a.x, b.x, p);
			y = lerp(a.y, b.y, p);
			lift = Math.sin(Math.PI * p);
			break;
		} else break;
	}
	const appear = easeOut(ramp(t, T_FINGER_IN, T_FINGER_IN + 260));
	const vanish = easeOut(ramp(t, T_FINGER_OUT, T_FINGER_OUT + 300));
	let press = 0;
	let ripple: Finger["ripple"];
	for (const p of PRESSES) {
		press = Math.max(press, pressAmount(p.slot, t) * (p.slot === slot ? 1 : 0));
		if (t >= p.down && t < p.down + 520) {
			const e = easeOut(ramp(t, p.down, p.down + 520));
			ripple = { scale: 0.7 + 1.3 * e, opacity: 0.55 * (1 - e) };
		}
	}
	return { x, y, opacity: appear * (1 - vanish), scale: (1.25 - 0.25 * appear) * (1 + 0.08 * lift) * (1 - 0.1 * press), press, ripple };
}

// ---------------------------------------------------------------- key tiles

interface Tile {
	id: string;
	slot: number;
	x: number;
	y: number;
	scale: number;
	opacity: number;
	/** Black overlay, 0–1 (spotlight, key travel). */
	dim: number;
	/** Accent ring around the key, 0–1. */
	ring: number;
	layers: { svg: string; opacity: number }[];
}
const tile = (id: string, slot: number, svg: string, extra: Partial<Tile> = {}): Tile => ({ id, slot, ...slotPos(slot), scale: 1, opacity: 1, dim: 0, ring: 0, layers: [{ svg, opacity: 1 }], ...extra });

/** Stream Deck's own "OK" feedback: a check over the key for a moment. Drawn here, not taken from Elgato. */
const OK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="#000" opacity="0.55"/><circle cx="72" cy="72" r="34" fill="#3DD68C"/><path d="M55 73l11 11 22-24" fill="none" stroke="#0E1013" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const okOpacity = (t: number, at: number): number => (t < at || t > at + OK_MS ? 0 : Math.min(ramp(t, at, at + 90), 1 - ramp(t, at + OK_MS - 220, at + OK_MS)));

function threadTile(card: ThreadCard, id: string, slot: number, t: number): Tile {
	const now = BASE + t;
	let releaseCue: "open" | undefined;
	for (const p of PRESSES) {
		const held = pressedFor(slot, t, p);
		if (held !== undefined && held >= LONG_PRESS_MS) releaseCue = "open";
	}
	const svg = renderThreadKey({ card, projectName: card.projectId, connection: ok, animation: "smooth", now, releaseCue });
	return tile(id, slot, svg);
}

/** Your own profile: Overview, Usage keys, thread keys, empty thread keys. */
function profileTiles(t: number): Tile[] {
	const now = BASE + t;
	const cards = visibleAt(t);
	const tiles: Tile[] = [];
	for (let s = PROFILE_FIRST; s < SLOTS; s++) tiles.push(tile(`pf-empty-${s}`, s, EMPTY));
	tiles.push(tile("pf-overview", 0, renderOverview({ connection: ok, counts: countStates(cards), overflow: 0, animation: "smooth", now })));
	tiles.push(tile("pf-usage-bar", 1, USAGE_BAR));
	tiles.push(tile("pf-usage-ring", 2, USAGE_RING));
	cards.forEach((card, i) => tiles.push(threadTile(card, `pf-${card.threadId}`, PROFILE_FIRST + i, t)));
	// Section 2: everything but the subagent tile (and the Overview that counts it) steps back.
	const spot = easeInOut(ramp(t, SPOT[0], SPOT[0] + 400)) * (1 - easeInOut(ramp(t, SPOT[1], SPOT[1] + 400)));
	if (spot > 0) {
		for (const tl of tiles) {
			if (tl.id === `pf-${SPOTLIT}`) tl.ring = spot;
			else if (tl.id !== "pf-overview") tl.dim = 0.62 * spot;
		}
	}
	return tiles;
}

/** The bundled Thread Actions page (XL), for the focused thread. */
function actionTiles(t: number): Tile[] {
	const now = BASE + t;
	const card = cardAt(THREADS.find((s) => s.id === FOCUS)!, t);
	const attention = attentionOf(visibleAt(t));
	const okAt: Record<number, number> = {
		[SLOT_MSG]: HOLD_MSG.down + CONFIRM_HOLD_MS,
		[SLOT_COMPACT]: HOLD_COMPACT.down + CONFIRM_HOLD_MS,
		[SLOT_SNOOZE]: T_SNOOZE_OK,
	};
	return ACTION_SLOTS.map((setting, slot) => {
		let svg: string;
		if (setting.action === "back") svg = renderBackKey(attention);
		else {
			// Hold progress as the plugin draws it: redrawn every 100 ms until the hold fires.
			let progress: number | undefined;
			for (const p of PRESSES) {
				const held = pressedFor(slot, t, p);
				if (held !== undefined && held < CONFIRM_HOLD_MS && (setting.action === "message" || setting.action === "compact")) {
					progress = (Math.floor(held / PROGRESS_STEP_MS) * PROGRESS_STEP_MS) / CONFIRM_HOLD_MS;
				}
			}
			const input: ActionKeyInput = {
				action: setting.action as ActionKeyInput["action"],
				card,
				message: setting.index === undefined ? undefined : QUICK_MESSAGES[setting.index]?.label,
				progress,
				projectName: card.projectId,
				connection: ok,
				animation: "smooth",
				now,
			};
			svg = renderActionKey(input);
		}
		const tl = tile(`ac-${slot}`, slot, svg);
		const okA = okAt[slot] === undefined ? 0 : okOpacity(t, okAt[slot]!);
		if (okA > 0) tl.layers.push({ svg: OK_SVG, opacity: okA });
		return tl;
	});
}

/** The bundled T3 Threads page: Back, then every thread; the snoozed one leaves and the rest slide up. */
function threadsPageTiles(t: number): Tile[] {
	const all = THREADS.map((s) => cardAt(s, t));
	const cards = visibleAt(t);
	const tiles: Tile[] = [tile("th-back", 0, renderBackKey(attentionOf(cards)))];
	for (let s = 1; s < SLOTS; s++) tiles.push(tile(`th-empty-${s}`, s, EMPTY));
	const gone = all.findIndex((c) => c.threadId === FOCUS);
	const slide = easeInOut(ramp(t, SLIDE[0], SLIDE[1]));
	all.forEach((card, i) => {
		const from = 1 + i;
		if (i === gone) {
			// Shrinks away as the poll drops it.
			const p = easeInOut(ramp(t, T_GONE - 200, T_GONE + 50));
			if (p < 1) tiles.push({ ...threadTile(card, `th-${card.threadId}`, from, t), opacity: 1 - p, scale: 1 - 0.18 * p });
			return;
		}
		if (i < gone || slide === 0) {
			tiles.push(threadTile(card, `th-${card.threadId}`, from, t));
			return;
		}
		const to = from - 1;
		const a = slotPos(from);
		const b = slotPos(to);
		if (from % COLS === 0) {
			// Wraps to the end of the row above: fade across rather than fly diagonally.
			const out = ramp(slide, 0, 0.55);
			const inn = ramp(slide, 0.45, 1);
			if (out < 1) tiles.push({ ...threadTile(card, `th-${card.threadId}-out`, from, t), opacity: 1 - out, x: a.x - 28 * out });
			if (inn > 0) tiles.push({ ...threadTile(card, `th-${card.threadId}`, to, t), opacity: inn, x: b.x + 28 * (1 - inn) });
			return;
		}
		tiles.push({ ...threadTile(card, `th-${card.threadId}`, to, t), x: lerp(a.x, b.x, slide), y: lerp(a.y, b.y, slide) });
	});
	return tiles;
}

/** A page switch: new keys fade in over the old ones, rippling out from the key that was pressed. */
function switchPages(older: Tile[], newer: Tile[], t: number, start: number, origin: number): Tile[] {
	const progress = (slot: number): number => easeOut(ramp(t, start + slotDist(slot, origin) * 26, start + slotDist(slot, origin) * 26 + 200));
	const done = new Set<number>();
	for (let s = 0; s < SLOTS; s++) if (progress(s) >= 1) done.add(s);
	const shown: Tile[] = older.filter((tl) => !done.has(tl.slot));
	for (const tl of newer) {
		const p = progress(tl.slot);
		if (p <= 0) continue;
		shown.push({ ...tl, opacity: tl.opacity * p, scale: tl.scale * (0.94 + 0.06 * p) });
	}
	return shown;
}

/** Everything on the deck at `t` (t < 0 is the opening state, with its own clock). */
function deckTiles(t: number): Tile[] {
	let tiles: Tile[];
	if (t < T_TO_ACTIONS) tiles = profileTiles(t);
	else if (t < T_TO_ACTIONS + 600) tiles = switchPages(profileTiles(t), actionTiles(t), t, T_TO_ACTIONS, profileSlotOf(FOCUS));
	else if (t < T_TO_THREADS) tiles = actionTiles(t);
	else if (t < T_TO_THREADS + 600) tiles = switchPages(actionTiles(t), threadsPageTiles(t), t, T_TO_THREADS, SLOT_SNOOZE);
	else if (t < T_TO_PROFILE) tiles = threadsPageTiles(t);
	else if (t < T_TO_PROFILE + 600) tiles = switchPages(threadsPageTiles(t), profileTiles(t), t, T_TO_PROFILE, 0);
	else tiles = profileTiles(t);

	// Key travel under the finger.
	for (const tl of tiles) {
		const p = pressAmount(tl.slot, t);
		if (p > 0) {
			tl.scale *= 1 - 0.045 * p;
			tl.dim = Math.max(tl.dim, 0.2 * p);
		}
	}
	return tiles;
}

// ---------------------------------------------------------------- captions

interface Caption {
	id: string;
	kind: "title" | "sub";
	text: string;
	from: number;
	to: number;
}
const CAPTIONS: Caption[] = [
	{ id: "t1", kind: "title", text: "One glance", from: -Infinity, to: S2 },
	{ id: "s1", kind: "sub", text: "Every thread on a key. Colour, a glyph and motion show its state.", from: -Infinity, to: S2 },
	{ id: "t2", kind: "title", text: "Subagents folded in", from: S2, to: S3 },
	{ id: "s2", kind: "sub", text: "A badge counts them. A white spinner: only background work is left.", from: S2, to: S3 },
	{ id: "t3", kind: "title", text: "Tap, hold, done", from: S3, to: S1_AGAIN },
	{ id: "s3a", kind: "sub", text: "Tap a key to open the thread in T3 Code.", from: S3, to: HOLD_THREAD.down - 450 },
	{ id: "s3b", kind: "sub", text: "Hold, then let go, for its Thread Actions page.", from: HOLD_THREAD.down - 450, to: HOLD_MSG.down - 400 },
	{ id: "s3c", kind: "sub", text: "Hold a quick message to send it.", from: HOLD_MSG.down - 400, to: HOLD_COMPACT.down - 450 },
	{ id: "s3d", kind: "sub", text: "Hold Compact to compact its context.", from: HOLD_COMPACT.down - 450, to: TAP_SNOOZE.down - 500 },
	{ id: "s3e", kind: "sub", text: "Tap Snooze, and the thread leaves the deck.", from: TAP_SNOOZE.down - 500, to: TAP_BACK.down - 450 },
	{ id: "s3f", kind: "sub", text: "Back takes you to your own profile.", from: TAP_BACK.down - 450, to: S1_AGAIN },
	{ id: "t1b", kind: "title", text: "One glance", from: S1_AGAIN, to: Infinity },
	{ id: "s1b", kind: "sub", text: "Every thread on a key. Colour, a glyph and motion show its state.", from: S1_AGAIN, to: Infinity },
];
const FADE_OUT = 260;
const FADE_IN = 380;
/** Opacity and lift for every caption: the old one fades out, then the new one rises in. */
function captionsAt(t: number): { id: string; opacity: number; dy: number }[] {
	return CAPTIONS.map((c) => {
		const fadeIn = c.from === -Infinity ? 1 : easeOut(ramp(t, c.from + FADE_OUT - 60, c.from + FADE_OUT - 60 + FADE_IN));
		const fadeOut = c.to === Infinity ? 0 : easeInOut(ramp(t, c.to, c.to + FADE_OUT));
		return { id: c.id, opacity: Math.min(fadeIn, 1 - fadeOut), dy: (1 - fadeIn) * 10 - fadeOut * 6 };
	});
}

// ---------------------------------------------------------------- one frame

interface Frame {
	tiles: Tile[];
	finger?: Finger;
	captions: { id: string; opacity: number; dy: number }[];
}
function frameAt(t: number): Frame {
	let tiles = deckTiles(t);
	// The loop: the closing state cross-fades into the opening one, which runs on its own clock (t − DURATION).
	const back = easeInOut(ramp(t, END_FADE[0], END_FADE[1]));
	if (back > 0) {
		const opening = deckTiles(t - DURATION).map((tl) => ({ ...tl, id: `${tl.id}~open`, opacity: tl.opacity * back }));
		tiles = back >= 1 ? opening.map((tl) => ({ ...tl, id: tl.id.replace(/~open$/, "") })) : [...tiles, ...opening];
	}
	const round = (tl: Tile): Tile => ({ ...tl, x: +tl.x.toFixed(2), y: +tl.y.toFixed(2), scale: +tl.scale.toFixed(4), opacity: +tl.opacity.toFixed(3), dim: +tl.dim.toFixed(3), ring: +tl.ring.toFixed(3), layers: tl.layers.map((l) => ({ svg: l.svg, opacity: +l.opacity.toFixed(3) })) });
	const finger = fingerAt(t);
	return {
		tiles: tiles.filter((tl) => tl.opacity > 0.001).map(round),
		finger: finger && finger.opacity > 0.001 ? JSON.parse(JSON.stringify(finger, (_k, v) => (typeof v === "number" ? +v.toFixed(3) : v))) : undefined,
		captions: captionsAt(t).map((c) => ({ id: c.id, opacity: +c.opacity.toFixed(3), dy: +c.dy.toFixed(2) })),
	};
}

// ---------------------------------------------------------------- the page

const ACCENT = "oklch(0.72 0.15 252)";
const SANS = `"Inter", ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace`;

function pageHtml(): string {
	const wells = Array.from({ length: SLOTS }, (_, s) => {
		const p = slotPos(s);
		return `<div class="well" style="left:${p.x - 5}px;top:${p.y - 5}px"></div>`;
	}).join("");
	const captions = CAPTIONS.map((c) => `<div class="cap ${c.kind}" id="${c.id}">${c.text}</div>`).join("");
	return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:#000;color:#f5f5f5;font-family:${SANS};-webkit-font-smoothing:antialiased}
.glow{position:absolute;left:0;top:0;width:${W}px;height:${H}px;background:radial-gradient(52% 46% at 50% 58%,oklch(0.72 0.15 252 / 0.2),transparent 72%)}
.eyebrow{position:absolute;left:0;width:${W}px;top:66px;text-align:center;font:600 16px/1 ${MONO};letter-spacing:.12em;text-transform:uppercase;color:${ACCENT}}
.cap{position:absolute;left:0;width:${W}px;text-align:center;opacity:0}
.cap.title{top:96px;font-size:64px;font-weight:700;letter-spacing:-.025em;line-height:1.06}
.cap.sub{top:182px;font-size:28px;line-height:1.3;color:#a3a3a3}
.slab{position:absolute;left:${DECK_X}px;top:${DECK_Y}px;width:${DECK_W}px;height:${DECK_H}px;border-radius:46px;
  background:linear-gradient(180deg,#1c1d22 0%,#131418 38%,#0c0d10 100%);
  box-shadow:0 0 0 1px #ffffff17,inset 0 1px 0 #ffffff26,inset 0 -1px 0 #00000099,0 7px 0 -1px #08080a,0 7px 0 0 #ffffff0d,0 46px 110px #000,0 18px 40px #000c}
.sheen{position:absolute;left:${DECK_X}px;top:${DECK_Y}px;width:${DECK_W}px;height:${DECK_H}px;border-radius:46px;pointer-events:none;
  background:linear-gradient(112deg,transparent 18%,#ffffff09 34%,#ffffff03 46%,transparent 58%);z-index:3}
.floor{position:absolute;left:${DECK_X + 80}px;top:${DECK_Y + DECK_H + 18}px;width:${DECK_W - 160}px;height:46px;border-radius:50%;
  background:radial-gradient(50% 50% at 50% 50%,oklch(0.72 0.15 252 / 0.10),transparent 70%)}
.well{position:absolute;width:${KEY + 10}px;height:${KEY + 10}px;border-radius:22px;background:#040405;
  box-shadow:inset 0 2px 6px #000,inset 0 0 0 1px #000,0 1px 0 #ffffff12}
#tiles{position:absolute;left:0;top:0;z-index:2}
.tile{position:absolute;left:0;top:0;width:${KEY}px;height:${KEY}px;transform-origin:50% 50%}
.face{position:absolute;inset:0;border-radius:17px;overflow:hidden;background:#050506;box-shadow:0 1px 2px #000}
.face>.l{position:absolute;inset:0}
.face svg{display:block}
.face>.shade{position:absolute;inset:0;background:#000;opacity:0}
.face>.gloss{position:absolute;inset:0;border-radius:17px;background:linear-gradient(162deg,#ffffff16 0%,#ffffff05 30%,transparent 46%);box-shadow:inset 0 1px 0 #ffffff1c,inset 0 0 0 1px #ffffff08}
.tile>.ring{position:absolute;inset:-9px;border-radius:25px;border:2.5px solid ${ACCENT};box-shadow:0 0 26px oklch(0.72 0.15 252 / .55);opacity:0}
.finger{position:absolute;left:0;top:0;width:62px;height:62px;margin:-31px 0 0 -31px;z-index:5;opacity:0}
.finger>.core{position:absolute;inset:0;border-radius:50%;
  background:radial-gradient(circle at 42% 38%,#ffffff73,#ffffff33 60%,#ffffff24);border:2px solid #ffffffcc;
  box-shadow:0 10px 28px #000a,0 0 0 1px #0000004d}
.finger>.ripple{position:absolute;inset:0;border-radius:50%;border:3px solid #ffffff;opacity:0}
.note{position:absolute;left:0;width:${W}px;top:${DECK_Y + DECK_H + 44}px;text-align:center;font-size:17px;color:#a3a3a3;opacity:.7}
</style></head><body>
<div class="glow"></div>
<div class="eyebrow">Deck for T3 Code</div>
${captions}
<div class="floor"></div>
<div class="slab"></div>
${wells}
<div id="tiles"></div>
<div class="sheen"></div>
<div class="finger" id="finger"><div class="ripple"></div><div class="core"></div></div>
<div class="note">Example data</div>
<script>
const host = document.getElementById("tiles");
const tiles = new Map();
const finger = document.getElementById("finger");
const caps = new Map([...document.querySelectorAll(".cap")].map((el) => [el.id, el]));
function make() {
  const el = document.createElement("div");
  el.className = "tile";
  el.innerHTML = '<div class="ring"></div><div class="face"><div class="shade"></div><div class="gloss"></div></div>';
  el._face = el.children[1]; el._ring = el.children[0]; el._shade = el._face.children[0]; el._layers = [];
  return el;
}
window.apply = (s) => {
  const seen = new Set();
  s.tiles.forEach((t, z) => {
    let el = tiles.get(t.id);
    if (!el) { el = make(); host.appendChild(el); tiles.set(t.id, el); }
    seen.add(t.id);
    el.style.transform = "translate(" + t.x + "px," + t.y + "px) scale(" + t.scale + ")";
    el.style.opacity = t.opacity;
    el.style.zIndex = z + 1;
    el._shade.style.opacity = t.dim;
    el._ring.style.opacity = t.ring;
    t.layers.forEach((l, i) => {
      let layer = el._layers[i];
      if (!layer) { layer = document.createElement("div"); layer.className = "l"; el._face.insertBefore(layer, el._shade); el._layers[i] = layer; layer._svg = ""; }
      if (layer._svg !== l.svg) { layer.innerHTML = l.svg; layer._svg = l.svg; }
      layer.style.opacity = l.opacity;
      layer.style.display = "";
    });
    for (let i = t.layers.length; i < el._layers.length; i++) el._layers[i].style.display = "none";
  });
  for (const [id, el] of tiles) if (!seen.has(id)) { el.remove(); tiles.delete(id); }
  const f = s.finger;
  if (f) {
    finger.style.opacity = f.opacity;
    finger.style.transform = "translate(" + f.x + "px," + f.y + "px) scale(" + f.scale + ")";
    finger.children[1].style.filter = "brightness(" + (1 + 0.5 * f.press) + ")";
    finger.children[0].style.opacity = f.ripple ? f.ripple.opacity : 0;
    finger.children[0].style.transform = "scale(" + (f.ripple ? f.ripple.scale : 1) + ")";
  } else finger.style.opacity = 0;
  for (const c of s.captions) {
    const el = caps.get(c.id);
    el.style.opacity = c.opacity;
    // No transform at rest, so a caption rasterises the same whatever came before it.
    el.style.transform = c.dy ? "translateY(" + c.dy + "px)" : "";
  }
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))));
};
</script></body></html>`;
}

// ---------------------------------------------------------------- headless Chrome over the DevTools pipe

const CHROME =
	process.env.CHROME ??
	execSync(`find "$HOME/.t3/tools/chrome-headless-shell" -name chrome-headless-shell -type f -perm +111 | sort | tail -1`, { encoding: "utf8", shell: "/bin/bash" }).trim();

class Browser {
	#proc: ChildProcess;
	#buf = Buffer.alloc(0);
	#id = 0;
	#pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	session = "";

	constructor() {
		if (!CHROME) throw new Error("headless Chrome not found; set $CHROME");
		const profile = join(SCRATCH, "chrome-profile");
		rmSync(profile, { recursive: true, force: true });
		this.#proc = spawn(
			"nice",
			["-n", "10", CHROME, "--remote-debugging-pipe", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--mute-audio", "--font-render-hinting=none", "--disable-partial-raster", "--num-raster-threads=1", `--user-data-dir=${profile}`, "about:blank"],
			{ stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
		);
		(this.#proc.stdio[4] as Readable).on("data", (chunk: Buffer) => {
			this.#buf = Buffer.concat([this.#buf, chunk]);
			let end: number;
			while ((end = this.#buf.indexOf(0)) >= 0) {
				const msg = JSON.parse(this.#buf.subarray(0, end).toString("utf8"));
				this.#buf = this.#buf.subarray(end + 1);
				const waiter = msg.id === undefined ? undefined : this.#pending.get(msg.id);
				if (!waiter) continue;
				this.#pending.delete(msg.id);
				if (msg.error) waiter.reject(new Error(`${msg.error.message} ${msg.error.data ?? ""}`));
				else waiter.resolve(msg.result);
			}
		});
	}

	send(method: string, params: object = {}, session: string | undefined = this.session || undefined): Promise<any> {
		const id = ++this.#id;
		const promise = new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
		(this.#proc.stdio[3] as Writable).write(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }) + "\0");
		return promise;
	}

	async open(url: string): Promise<void> {
		const { targetId } = await this.send("Target.createTarget", { url: "about:blank" }, undefined);
		({ sessionId: this.session } = await this.send("Target.attachToTarget", { targetId, flatten: true }, undefined));
		await this.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
		await this.send("Page.navigate", { url });
		for (let i = 0; i < 200; i++) {
			const { result } = await this.send("Runtime.evaluate", { expression: "document.readyState === 'complete' && typeof window.apply === 'function'", returnByValue: true });
			if (result.value) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		await this.send("Runtime.evaluate", { expression: "document.fonts.ready.then(() => true)", awaitPromise: true });
	}

	async draw(frame: Frame, out: string): Promise<void> {
		const res = await this.send("Runtime.evaluate", { expression: `window.apply(${JSON.stringify(frame)})`, awaitPromise: true, returnByValue: true });
		if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
		const { data } = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true, optimizeForSpeed: true });
		writeFileSync(out, Buffer.from(data, "base64"));
	}

	close(): void {
		this.#proc.kill();
	}
}

async function renderFrames(times: number[], name: (i: number, t: number) => string): Promise<void> {
	const html = join(SCRATCH, "demo.html");
	writeFileSync(html, pageHtml());
	const browser = new Browser();
	try {
		await browser.open(pathToFileURL(html).href);
		// One throwaway frame so fonts and layers are warm before the first real one.
		await browser.draw(frameAt(times[0]!), join(SCRATCH, "warmup.png"));
		let last = "";
		let lastFile = "";
		let drawn = 0;
		const started = Date.now();
		for (let i = 0; i < times.length; i++) {
			const frame = frameAt(times[i]!);
			const key = JSON.stringify(frame);
			const out = name(i, times[i]!);
			if (key === last) copyFileSync(lastFile, out);
			else {
				await browser.draw(frame, out);
				drawn++;
			}
			last = key;
			lastFile = out;
			if (i % 60 === 59) process.stdout.write(`  ${i + 1}/${times.length} frames (${drawn} drawn, ${((Date.now() - started) / 1000).toFixed(0)} s)\n`);
		}
		console.log(`${times.length} frames, ${drawn} drawn, in ${((Date.now() - started) / 1000).toFixed(1)} s`);
	} finally {
		browser.close();
	}
}

// ---------------------------------------------------------------- encoding

const ASSETS = join(ROOT, "docs/assets");
const MARKETING = join(ROOT, "marketing");

function ffmpeg(args: string[]): void {
	execFileSync("nice", ["-n", "10", "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
}
const hasEncoder = (name: string): boolean => execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).split("\n").some((l) => l.trim().split(/\s+/)[1] === name);

function encode(): void {
	const input = ["-framerate", String(FPS), "-i", join(FRAMES, "f%04d.png")];
	const bt709 = (w: number, h: number): string => `scale=${w}:${h}:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p`;
	const tags = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];
	const clean = ["-an", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-threads", "4"];
	const h264 = (crf: number) => ["-c:v", "libx264", "-preset", "slow", "-tune", "animation", "-crf", String(crf), "-profile:v", "high", "-g", String(FPS * 4), "-movflags", "+faststart", ...tags, ...clean];

	console.log("encoding marketing/gallery-video.mp4 (1920×1080)");
	ffmpeg([...input, "-vf", bt709(1920, 1080), ...h264(20), join(MARKETING, "gallery-video.mp4")]);
	console.log("encoding docs/assets/demo.mp4 (1440×810)");
	ffmpeg([...input, "-vf", bt709(1440, 810), ...h264(22), join(ASSETS, "demo.mp4")]);
	if (hasEncoder("libvpx-vp9")) {
		console.log("encoding docs/assets/demo.webm (1440×810, VP9)");
		ffmpeg([...input, "-vf", bt709(1440, 810), "-c:v", "libvpx-vp9", "-crf", "34", "-b:v", "0", "-deadline", "good", "-cpu-used", "2", "-row-mt", "1", "-g", String(FPS * 4), ...tags, ...clean, join(ASSETS, "demo.webm")]);
	} else console.warn("libvpx-vp9 not available: skipped docs/assets/demo.webm");
	console.log("writing docs/assets/demo-poster.png");
	ffmpeg(["-i", join(FRAMES, "f0000.png"), "-vf", "scale=1440:810:flags=lanczos", "-frames:v", "1", "-map_metadata", "-1", "-fflags", "+bitexact", join(ASSETS, "demo-poster.png")]);
	console.log("encoding docs/assets/demo.gif (800×450, 15 fps)");
	ffmpeg([
		...input,
		"-vf",
		"fps=15,scale=800:450:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=full:reserve_transparent=0[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
		"-loop", "0", "-map_metadata", "-1", "-fflags", "+bitexact", "-threads", "4",
		join(ASSETS, "demo.gif"),
	]);
	for (const f of [join(MARKETING, "gallery-video.mp4"), join(ASSETS, "demo.mp4"), join(ASSETS, "demo.webm"), join(ASSETS, "demo-poster.png"), join(ASSETS, "demo.gif")]) {
		if (existsSync(f)) console.log(`  ${f.slice(ROOT.length + 1)}  ${(statSync(f).size / 1e6).toFixed(2)} MB`);
	}
}

// ---------------------------------------------------------------- run

mkdirSync(SCRATCH, { recursive: true });
const started = Date.now();
if (process.env.PREVIEW) {
	const dir = join(SCRATCH, "preview");
	mkdirSync(dir, { recursive: true });
	const times = process.env.PREVIEW.split(",").map(Number);
	await renderFrames(times, (_i, t) => join(dir, `t${String(t).padStart(5, "0")}.png`));
	console.log(`previews in ${dir}`);
} else {
	if (process.env.ONLY !== "encode") {
		rmSync(FRAMES, { recursive: true, force: true });
		mkdirSync(FRAMES, { recursive: true });
		const times = Array.from({ length: FRAME_COUNT }, (_, i) => Math.round((i * 1000) / FPS));
		await renderFrames(times, (i) => join(FRAMES, `f${String(i).padStart(4, "0")}.png`));
	}
	if (process.env.ONLY !== "frames") {
		if (readdirSync(FRAMES).length !== FRAME_COUNT) throw new Error(`expected ${FRAME_COUNT} frames in ${FRAMES}`);
		encode();
	}
	console.log(`done in ${((Date.now() - started) / 1000).toFixed(0)} s`);
}
