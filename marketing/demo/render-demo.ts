/**
 * Renders the looping demo animation (site, README, Marketplace gallery) from
 * the plugin's own key renderers.
 *
 *   nice -n 10 node --experimental-strip-types marketing/demo/render-demo.ts
 *
 * Five acts, one seamless loop:
 *   1. "Start with a few keys": your own XL profile, other apps' keys dimmed,
 *      plus Overview, Usage, Machine and Updates keys.
 *   2. "Tap for every thread": tap Overview, the T3 Threads page fills in;
 *      tap the thread that just finished and T3 Code opens on it, on the Mac.
 *   3. "Hold for actions": hold a thread, release, send a quick message,
 *      compact, snooze (it leaves, the rest slide up), Back home.
 *   4. "One key, every state": zoom into the Overview key's spot, drawn large
 *      from the same SVG in both looks side by side (Detailed and Glance), and
 *      step through the Overview and a thread's states; zoom back out.
 *   5. "Your Mac, at a glance": zoom into the Machine key and step through
 *      its stats and the Updates key, again in both looks; zoom back out to
 *      act 1.
 *
 * Every plugin key image comes from src/render.ts, fed invented data (acme-*
 * projects, made-up titles). The Thread Actions page follows the bundled XL
 * profile (scripts/build-profile.mjs) with the plugin's default quick messages,
 * and the press/hold timings follow src/deck.ts (LONG_PRESS_MS,
 * CONFIRM_HOLD_MS, 100 ms hold-progress steps). Other apps' keys are generic
 * outline glyphs drawn here.
 *
 * Frames are drawn by one headless Chrome page driven over the DevTools pipe:
 * each frame is a plain description (key images, positions, zoom, finger,
 * captions) applied to the page and screenshotted. Nothing depends on the wall
 * clock, so two runs give the same frames. Identical frames are copied, not
 * re-rendered. ffmpeg then encodes:
 *
 *   docs/assets/demo.mp4          1440×810 H.264 (site)
 *   docs/assets/demo.webm         1440×810 VP9 (site; skipped if libvpx-vp9 is missing)
 *   docs/assets/demo-poster.png   1440×810, the first frame
 *   docs/assets/demo.gif          800×450, 12 fps (README)
 *   marketing/gallery-video.mp4   1920×1080 H.264 (Elgato Marketplace)
 *
 * FORMAT=square renders the same loop for phones instead: a 1080×1080 frame
 * with bigger captions and a camera that frames the keys being acted on
 * (about two keys across at 360 px), and act 4's key filling the frame:
 *
 *   docs/assets/demo-square.mp4   1080×1080 H.264
 *   docs/assets/demo-square.webm  1080×1080 VP9
 *
 * Environment:
 *   DEMO_SCRATCH  scratch dir (default: <os tmpdir>/t3deck-demo); frames go to <scratch>/frames
 *   FORMAT        "wide" (default) or "square"; square frames go to <scratch>/frames-square
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
import { DEFAULT_MESSAGES, parseQuickMessages, type CardState, type ThreadCard } from "../../src/model.ts";
import {
	isBackgroundOnly,
	renderActionKey,
	renderBackKey,
	renderMachineKey,
	renderOverview,
	renderThreadKey,
	renderUpdatesKey,
	renderUsageKey,
	type ActionKeyInput,
} from "../../src/render.ts";
import type { MachineSnapshot } from "../../src/machine.ts";
import { pace, type UsageMetric } from "../../src/usage.ts";
import { waitingLabel } from "../../src/t3/shell-stream.ts";
import { PROFILES } from "../../scripts/build-profile.mjs";
import { soften } from "../screen-colors.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRATCH = process.env.DEMO_SCRATCH ?? join(tmpdir(), "t3deck-demo");
const FORMAT = process.env.FORMAT ?? "wide";
if (FORMAT !== "wide" && FORMAT !== "square") throw new Error(`FORMAT must be "wide" or "square", not "${FORMAT}"`);
const SQUARE = FORMAT === "square";
const FRAMES = join(SCRATCH, SQUARE ? "frames-square" : "frames");

// ---------------------------------------------------------------- timing

const FPS = 30;

/** Same as src/deck.ts. */
const LONG_PRESS_MS = 500;
const CONFIRM_HOLD_MS = 800;
const PROGRESS_STEP_MS = 100;
/** How long Stream Deck's own "OK" check stays on a key. */
const OK_MS = 900;

/** A clock that sits on a multiple of every flash/spin period, so `BASE + t` behaves like `t`. */
const BASE = Math.round(Date.parse("2026-11-03T12:00:00Z") / 50_400) * 50_400;

// Act 1 (ms): your own profile with two plugin keys.
const T_STARTS = 1600; // an idle thread starts working: Overview counts it
const T_RING = 2600; // the weekly ring ticks up a point
const T_ASKS = 3600; // a thread needs you: Overview blinks amber
// Act 2: tap Overview, the Threads page.
const ACT2 = 5600;
const FINGER_A = { in: 5900, out: 7050 };
const TAP_OVERVIEW = { down: 6500, up: 6620 };
const T_TO_THREADS = TAP_OVERVIEW.up + 30;
const T_FINISHES = 8800; // a working tile turns solid green
// …tap it: T3 Code opens on that thread, on the Mac, and the key's highlight clears.
const FINGER_C = { in: 9300, out: 10_700 };
const TAP_FLAKY = { down: 9800, up: 9920 };
const T_OPENED = TAP_FLAKY.up + 30;
const MAC_IN = [T_OPENED + 80, T_OPENED + 650] as const;
const MAC_OUT = [13_700, 14_200] as const;
/** Everything after the T3 Code window moved this much later when it was added. */
const OPEN = 3600;
// Act 3: hold for actions.
const ACT3 = 11_000 + OPEN;
const FINGER_B = { in: 11_200 + OPEN, out: 19_100 + OPEN };
const HOLD_THREAD = { down: 11_700 + OPEN, up: 12_700 + OPEN }; // release cue at +500 ms
const T_TO_ACTIONS = HOLD_THREAD.up;
const HOLD_MSG = { down: 13_500 + OPEN, up: 14_450 + OPEN };
const HOLD_COMPACT = { down: 15_100 + OPEN, up: 16_050 + OPEN };
const T_COMPACTED = 16_400 + OPEN; // the header's context bar drops after /compact
const TAP_SNOOZE = { down: 16_750 + OPEN, up: 16_870 + OPEN };
const T_SNOOZE_OK = TAP_SNOOZE.up + 30;
const T_TO_THREADS_AGAIN = 17_250 + OPEN;
const T_GONE = 17_700 + OPEN; // the next poll drops the snoozed thread…
const SLIDE = [17_800 + OPEN, 18_250 + OPEN] as const; // …and the rest slide up
const TAP_BACK = { down: 18_800 + OPEN, up: 18_920 + OPEN };
const T_TO_PROFILE = TAP_BACK.up + 30;
// Act 4: one key, every state.
const ACT4 = 19_600 + OPEN;
const ZOOM_IN = [19_800 + OPEN, 20_850 + OPEN] as const;
/**
 * How long each state holds the big key. The blinking ones get whole blink
 * cycles from src/render.ts (needs you 900 ms, failed 1400 ms), starting lit
 * and ending dark, so no blink is cut short.
 */
const STATE_MS = { overview: 3 * 900, working: 1600, subagents: 2100, background: 1800, input: 3 * 900, done: 1800, failed: 2 * 1400, paused: 1800, context: 2400 };
const STATE_AT = (() => {
	let at = ZOOM_IN[1];
	const out: Record<string, number> = {};
	for (const [k, ms] of Object.entries(STATE_MS)) {
		out[k] = at;
		at += ms;
	}
	out.end = at;
	return out as Record<keyof typeof STATE_MS | "end", number>;
})();
const ZOOM_OUT = [STATE_AT.end, STATE_AT.end + 1050] as const;
// Act 5: your Mac, at a glance.
const ACT5 = ZOOM_OUT[1] + 300;
const ZOOM5_IN = [ACT5 + 200, ACT5 + 1250] as const;
const MACHINE_MS = { summary: 1900, cpu: 2400, memory: 2000, disk: 1800, updates: 1900 };
const MACHINE_AT = (() => {
	let at = ZOOM5_IN[1];
	const out: Record<string, number> = {};
	for (const [k, ms] of Object.entries(MACHINE_MS)) {
		out[k] = at;
		at += ms;
	}
	out.end = at;
	return out as Record<keyof typeof MACHINE_MS | "end", number>;
})();
const ZOOM5_OUT = [MACHINE_AT.end, MACHINE_AT.end + 1050] as const;
const ACT1_AGAIN = MACHINE_AT.end + 150;
/** Loop length: a beat after the last zoom-out, rounded up to 200 ms so the 15 fps GIF loops on a whole frame too. */
const DURATION = Math.ceil((ZOOM5_OUT[1] + 600) / 200) * 200;
const FRAME_COUNT = (DURATION * FPS) / 1000;

// ---------------------------------------------------------------- layout (CSS px, 1920×1080 master)

/** The frame. The deck itself is laid out for the wide frame in both formats; square shows it through a camera. */
const W = SQUARE ? 1080 : 1920;
const H = 1080;
const KEY = 144;
const GAP = 20;
const PAD = 40;
const COLS = 8;
const ROWS = 4;
const SLOTS = COLS * ROWS;
const DECK_W = COLS * KEY + (COLS - 1) * GAP + 2 * PAD; // 1372
const DECK_H = ROWS * KEY + (ROWS - 1) * GAP + 2 * PAD; // 716
const DECK_X = (1920 - DECK_W) / 2;
const DECK_Y = 258;

const slotPos = (slot: number): { x: number; y: number } => ({
	x: DECK_X + PAD + (slot % COLS) * (KEY + GAP),
	y: DECK_Y + PAD + Math.floor(slot / COLS) * (KEY + GAP),
});
const slotCenter = (slot: number): { x: number; y: number } => {
	const p = slotPos(slot);
	return { x: p.x + KEY / 2, y: p.y + KEY / 2 };
};
const slotDist = (a: number, b: number): number => Math.hypot((a % COLS) - (b % COLS), Math.floor(a / COLS) - Math.floor(b / COLS));

/**
 * Acts 4 and 5: the key drawn large twice, Detailed and Glance side by side,
 * 2.6× (374 px) with the label to the right; square: 3.1× (446 px), label below.
 * BIG_CENTER is the Detailed key's centre; the Glance twin sits TWIN_DX to its right.
 */
const ZOOM = SQUARE ? 3.1 : 2.6;
const BIG = KEY * ZOOM;
const TWIN_DX = BIG + (SQUARE ? 34 : 40);
const BIG_CENTER = SQUARE ? { x: Math.round(540 - TWIN_DX / 2), y: 560 } : { x: 450, y: 650 };
const LABEL_X = BIG_CENTER.x + TWIN_DX + BIG / 2 + 72;

// ---------------------------------------------------------------- square: the camera

/** A camera shot: deck point (fx, fy) lands on the frame's anchor, scaled by s. */
interface Shot {
	fx: number;
	fy: number;
	s: number;
}
/** Where a shot puts its focus point: centred, below the captions. */
const ANCHOR = { x: 540, y: 690 };
const COL_X = (col: number): number => DECK_X + PAD + KEY / 2 + col * (KEY + GAP);
const ROW_Y = (row: number): number => DECK_Y + PAD + KEY / 2 + row * (KEY + GAP);
const SHOT = {
	/** Acts 1, 4 and 5: the Machine, Overview and Usage keys, with a ring of other apps' keys. */
	home: { fx: COL_X(3), fy: ROW_Y(1), s: 2.1 },
	/** Act 2: the first threads, with the amber and the green one. */
	threads: { fx: COL_X(1.55), fy: ROW_Y(0.8), s: 1.8 },
	/** Act 3: the held thread. */
	held: { fx: COL_X(3), fy: ROW_Y(0.9), s: 2.0 },
	/** Thread Actions, top row: the thread and the quick messages. */
	messages: { fx: COL_X(2.5), fy: ROW_Y(0.5), s: 1.65 },
	/** Thread Actions, bottom row: Compact and Snooze. */
	bottom: { fx: COL_X(1.2), fy: ROW_Y(2.4), s: 1.9 },
	/** Back on the Threads page: the row that slides up. */
	slide: { fx: COL_X(4.2), fy: ROW_Y(1), s: 1.8 },
	/** Back key. */
	back: { fx: COL_X(1), fy: ROW_Y(0.7), s: 1.9 },
} satisfies Record<string, Shot>;
/** Camera moves: from each start time the camera eases to the shot over `ms`. */
const MOVES: { at: number; ms: number; to: Shot }[] = [
	{ at: 6650, ms: 900, to: SHOT.threads },
	{ at: 10_900 + OPEN, ms: 700, to: SHOT.held },
	{ at: 12_750 + OPEN, ms: 600, to: SHOT.messages },
	{ at: 14_650 + OPEN, ms: 450, to: SHOT.bottom },
	{ at: 17_300 + OPEN, ms: 500, to: SHOT.slide },
	{ at: 18_300 + OPEN, ms: 420, to: SHOT.back },
	{ at: 19_000 + OPEN, ms: 600, to: SHOT.home },
];
function cameraAt(t: number): Shot {
	let shot: Shot = SHOT.home;
	for (const m of MOVES) {
		if (t < m.at) break;
		const k = easeInOut(ramp(t, m.at, m.at + m.ms));
		shot = { fx: lerp(shot.fx, m.to.fx, k), fy: lerp(shot.fy, m.to.fy, k), s: lerp(shot.s, m.to.s, k) };
	}
	return shot;
}
/** A deck point seen through a shot, in frame pixels. */
const onScreen = (shot: Shot, x: number, y: number): { x: number; y: number } => ({ x: ANCHOR.x + shot.s * (x - shot.fx), y: ANCHOR.y + shot.s * (y - shot.fy) });

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
}

const ownFor = (state: CardState): string => (state === "working" ? "running" : state === "input" ? "waiting" : state === "done" ? "completed" : state === "failed" ? "failed" : "idle");
function S(id: string, title: string, project: string, state: CardState, extra: Partial<ThreadState> & { events?: [number, Partial<ThreadState>][] } = {}): Spec {
	const { events = [], ...rest } = extra;
	return { id, title, project, events, base: { state, own: ownFor(state), subagents: 0, background: 0, run: state === "working", ...rest } };
}

/** Threads in the order they fill the T3 Threads page (after its Back key). */
const THREADS: Spec[] = [
	S("orders", "Paginate the orders endpoint", "acme-api", "working", { ctx: 19 }),
	S("checkout", "Add retry to checkout flow", "acme-web", "working", { ctx: 22, events: [[T_ASKS, { state: "input", own: "waiting" }]] }),
	S("wiki", "Migrate docs to new wiki", "acme-docs", "working", { ctx: 11 }),
	S("uploads", "Speed up image uploads", "acme-api", "working", { own: "completed", background: 1, waitingOn: "PR #57 CI", ctx: 63, run: false }),
	S("darkmode", "Add dark mode toggle", "acme-web", "idle", { events: [[T_STARTS, { state: "working", own: "running", run: true, ctx: 2 }]] }),
	S("node", "Upgrade to Node 24", "acme-api", "working", { subagents: 2, ctx: 48 }),
	S("i18n", "Add i18n to the signup page", "acme-web", "working", { subagents: 1, ctx: 34 }),

	S("flaky", "Fix flaky login test", "acme-web", "working", {
		ctx: 44,
		events: [
			[T_FINISHES, { state: "done", own: "completed", run: false }],
			[T_OPENED, { state: "idle", own: "completed" }], // opening a thread clears its highlight
		],
	}),
	S("smoke", "Add browser smoke tests", "acme-web", "working", { ctx: 55 }),
	S("audit", "Add an audit log", "acme-api", "working", { ctx: 31 }),
	S("csv", "Add CSV export to reports", "acme-web", "working", { ctx: 88, events: [[T_COMPACTED, { ctx: 14 }]] }),
	S("invoice", "Refactor invoice emails", "acme-api", "working", { ctx: 42 }),
	S("docker", "Trim Docker image size", "acme-infra", "idle"),
	S("tz", "Fix timezone bug in reports", "acme-api", "idle"),
	S("onboarding", "Write the onboarding guide", "acme-docs", "idle", { ctx: 27 }),

	S("flags", "Clean up old feature flags", "acme-web", "idle"),
	S("webhook", "Review the webhook handler", "acme-api", "idle"),
	S("release", "Document the release process", "acme-docs", "idle"),
	S("renovate", "Set up Renovate for the monorepo", "acme-infra", "idle"),
	S("cart", "Fix 500 on empty cart", "acme-web", "idle"),
	S("coldstart", "Reduce cold start time", "acme-infra", "idle"),
];
const FOCUS = "csv"; // held, compacted, snoozed
/** The thread that finishes in act 2 and is tapped open: its key on the Threads page (Back takes slot 0). */
const SLOT_FLAKY = 1 + THREADS.findIndex((s) => s.id === "flaky");

function cardOf(id: string, title: string, project: string, s: ThreadState, extra: Partial<ThreadCard> = {}): ThreadCard {
	return {
		threadId: id, projectId: project, title, link: "", state: s.state, ownStatus: s.own,
		subagentsWorking: s.subagents, subagentsWaiting: 0, background: s.background, inputFromSubagent: false,
		waitingOn: s.waitingOn, activeRunId: s.run ? `run-${id}` : undefined,
		context: s.ctx === undefined ? undefined : { used: s.ctx * 2000, max: 200_000 },
		ackKey: "", updatedAt: 0, createdAt: 0,
		...extra,
	};
}
function cardAt(spec: Spec, t: number): ThreadCard {
	const s: ThreadState = { ...spec.base };
	for (const [at, patch] of spec.events) if (t >= at) Object.assign(s, patch);
	return cardOf(spec.id, spec.title, spec.project, s);
}

/** Threads still listed at `t` (the snoozed one leaves once the next poll drops it). */
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

function weekly(usedPercent: number): UsageMetric {
	const resetsAt = new Date(BASE + (1 - 57 / 100) * 10_080 * 60_000).toISOString();
	return { key: "acme:seven_day", provider: "Claude", label: "Weekly", window: { id: "seven_day", label: "Weekly", usedPercent, resetsAt, windowDurationMins: 10_080 } };
}
const usageRing = (t: number): string => {
	const m = weekly(t >= T_RING ? 39 : 38);
	return renderUsageKey({ metric: m, pace: pace(m.window, BASE), ok: true, loading: false, style: "ring" });
};
const EMPTY = renderThreadKey({ card: undefined, projectName: "", connection: ok, animation: "smooth", now: BASE });

/** The plugin's own defaults: what a fresh install shows. */
const QUICK_MESSAGES = parseQuickMessages(DEFAULT_MESSAGES.join("\n"));

const XL = PROFILES.find((p: { file: string }) => p.file === "Deck for T3 Code XL")!;
type Slot = string | { action: string; index: number };
const ACTION_SLOTS: { action: string; index?: number }[] = (XL.actions as Slot[][]).flat().map((s) => (typeof s === "string" ? { action: s } : s));
const actionSlot = (action: string, index?: number): number => ACTION_SLOTS.findIndex((s) => s.action === action && s.index === index);
const SLOT_MSG = actionSlot("message", QUICK_MESSAGES.findIndex((m) => m.label === "summarize where you are"));
const SLOT_COMPACT = actionSlot("compact");
const SLOT_SNOOZE = actionSlot("snooze1h");
const SLOT_FOCUS = 1 + THREADS.findIndex((s) => s.id === FOCUS); // on the Threads page

// ---------------------------------------------------------------- act 1: your own profile

/** Where the plugin keys sit on your profile. */
const SLOT_MACHINE = 10;
const SLOT_OVERVIEW = 11;
const SLOT_USAGE = 12;
const SLOT_UPDATES = 13;

/** Other apps' keys: generic outline glyphs on a 24-unit grid. No real app's artwork. */
const GLYPHS: Record<string, string> = {
	play: `<path d="M8 5v14l11-7z"/>`,
	pause: `<path d="M9 5v14M15 5v14"/>`,
	volume: `<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9a4 4 0 0 1 0 6"/>`,
	mic: `<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>`,
	sun: `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`,
	moon: `<path d="M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z"/>`,
	folder: `<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>`,
	globe: `<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>`,
	calendar: `<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>`,
	lock: `<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>`,
	camera: `<rect x="3" y="7" width="18" height="13" rx="2"/><circle cx="12" cy="13.5" r="3.5"/><path d="M8 7l2-3h4l2 3"/>`,
	terminal: `<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>`,
	note: `<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>`,
	chat: `<path d="M4 5h16v11H9l-5 4z"/>`,
	bulb: `<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>`,
	timer: `<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M10 2h4"/>`,
};
const appKey = (glyph: string): string =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="#121418"/>` +
	`<g transform="translate(46 46) scale(2.1667)" fill="none" stroke="#5C636F" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[glyph]}</g></svg>`;
const OFF_KEY = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="#0B0C0E"/></svg>`;
/** Your profile, row by row: other apps' keys, empty slots (""), and the plugin keys. */
const PROFILE_LAYOUT = [
	["play", "pause", "volume", "mic", "", "sun", "moon", "bulb"],
	["folder", "terminal", "MACHINE", "OVERVIEW", "USAGE", "UPDATES", "", "lock"],
	["camera", "note", "", "chat", "timer", "", "", ""],
	["", "", "", "", "", "", "", ""],
].flat();

function profileTiles(t: number): Tile[] {
	const now = BASE + t;
	return PROFILE_LAYOUT.map((key, slot) => {
		if (key === "OVERVIEW") return tile(`pf-${slot}`, slot, renderOverview({ connection: ok, counts: countStates(visibleAt(t)), overflow: 0, animation: "smooth", now }));
		if (key === "USAGE") return tile(`pf-${slot}`, slot, usageRing(t));
		if (key === "MACHINE") return tile(`pf-${slot}`, slot, renderMachineKey({ stat: "summary", sample: machineAt(t), path: "/", style: "glance" }));
		if (key === "UPDATES") return tile(`pf-${slot}`, slot, renderUpdatesKey(UPDATES_ONE, "glance"));
		return tile(`pf-${slot}`, slot, key ? appKey(key) : OFF_KEY);
	});
}

// ---------------------------------------------------------------- the finger

interface Press {
	down: number;
	up: number;
	slot: number;
}
interface Session {
	in: number;
	out: number;
	presses: Press[];
}
const SESSIONS: Session[] = [
	{ ...FINGER_A, presses: [{ ...TAP_OVERVIEW, slot: SLOT_OVERVIEW }] },
	{ ...FINGER_C, presses: [{ ...TAP_FLAKY, slot: SLOT_FLAKY }] },
	{
		...FINGER_B,
		presses: [
			{ ...HOLD_THREAD, slot: SLOT_FOCUS },
			{ ...HOLD_MSG, slot: SLOT_MSG },
			{ ...HOLD_COMPACT, slot: SLOT_COMPACT },
			{ ...TAP_SNOOZE, slot: SLOT_SNOOZE },
			{ ...TAP_BACK, slot: 0 },
		],
	},
];
const PRESSES: Press[] = SESSIONS.flatMap((s) => s.presses);

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
/** The finger rests right of the key centre, so the key's own text stays readable. */
const FINGER_OFFSET = { x: 36, y: -4 };
function fingerAt(t: number): Finger | undefined {
	const session = SESSIONS.find((s) => t >= s.in && t <= s.out + 300);
	if (!session) return undefined;
	const at = (slot: number) => {
		const c = slotCenter(slot);
		return { x: c.x + FINGER_OFFSET.x, y: c.y + FINGER_OFFSET.y };
	};
	const presses = session.presses;
	let slot = presses[0]!.slot;
	let { x, y } = at(slot);
	let lift = 0;
	for (let i = 1; i < presses.length; i++) {
		const p = presses[i]!;
		const arrive = p.down - 100;
		const leave = Math.max(presses[i - 1]!.up + 250, arrive - 460);
		if (t >= arrive) {
			slot = p.slot;
			({ x, y } = at(slot));
		} else if (t > leave) {
			const k = easeInOut(ramp(t, leave, arrive));
			const a = at(slot);
			const b = at(p.slot);
			x = lerp(a.x, b.x, k);
			y = lerp(a.y, b.y, k);
			lift = Math.sin(Math.PI * k);
			break;
		} else break;
	}
	const appear = easeOut(ramp(t, session.in, session.in + 260));
	const vanish = easeOut(ramp(t, session.out, session.out + 300));
	let press = 0;
	let ripple: Finger["ripple"];
	for (const p of presses) {
		if (p.slot === slot) press = Math.max(press, pressAmount(p.slot, t));
		if (t >= p.down && t < p.down + 520) {
			const e = easeOut(ramp(t, p.down, p.down + 520));
			ripple = { scale: 0.7 + 1.3 * e, opacity: 0.55 * (1 - e) };
		}
	}
	const scale = (1.25 - 0.25 * appear) * (1 + 0.08 * lift) * (1 - 0.1 * press);
	if (SQUARE) {
		// Through the camera, and a little smaller than the keys it grows with.
		const cam = cameraAt(t);
		return { ...onScreen(cam, x, y), opacity: appear * (1 - vanish), scale: scale * cam.s * 0.8, press, ripple };
	}
	return { x, y, opacity: appear * (1 - vanish), scale, press, ripple };
}

// ---------------------------------------------------------------- key tiles

interface Tile {
	id: string;
	slot: number;
	x: number;
	y: number;
	scale: number;
	opacity: number;
	/** Black overlay, 0–1 (key travel). */
	dim: number;
	layers: { svg: string; opacity: number }[];
}
function tile(id: string, slot: number, svg: string, extra: Partial<Tile> = {}): Tile {
	return { id, slot, ...slotPos(slot), scale: 1, opacity: 1, dim: 0, layers: [{ svg, opacity: 1 }], ...extra };
}

/** Stream Deck's own "OK" feedback: a check over the key for a moment. Drawn here, not taken from Elgato. */
const OK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="#000" opacity="0.55"/><circle cx="72" cy="72" r="34" fill="#3DD68C"/><path d="M55 73l11 11 22-24" fill="none" stroke="#0E1013" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const okOpacity = (t: number, at: number): number => (t < at || t > at + OK_MS ? 0 : Math.min(ramp(t, at, at + 90), 1 - ramp(t, at + OK_MS - 220, at + OK_MS)));

function threadTile(card: ThreadCard, id: string, slot: number, t: number): Tile {
	let releaseCue: "open" | undefined;
	for (const p of PRESSES) {
		const held = pressedFor(slot, t, p);
		if (held !== undefined && held >= LONG_PRESS_MS) releaseCue = "open";
	}
	return tile(id, slot, renderThreadKey({ card, projectName: card.projectId, connection: ok, animation: "smooth", now: BASE + t, releaseCue }));
}

/** The bundled Thread Actions page (XL), for the focused thread. */
function actionTiles(t: number): Tile[] {
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
				now: BASE + t,
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
	const tiles: Tile[] = [tile("th-back", 0, renderBackKey(attentionOf(visibleAt(t))))];
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
function switchPages(older: Tile[], newer: Tile[], t: number, start: number, origin: number, step = 26, each = 200): Tile[] {
	const progress = (slot: number): number => easeOut(ramp(t, start + slotDist(slot, origin) * step, start + slotDist(slot, origin) * step + each));
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
const SWITCH_MS = 700;

/** Everything on the deck at `t` (t < 0 is the opening state, with its own clock). */
function deckTiles(t: number): Tile[] {
	let tiles: Tile[];
	if (t < T_TO_THREADS) tiles = profileTiles(t);
	// The Threads page fills in gently, from the Overview key outwards.
	else if (t < T_TO_THREADS + 900) tiles = switchPages(profileTiles(t), threadsPageTiles(t), t, T_TO_THREADS, SLOT_OVERVIEW, 40, 280);
	else if (t < T_TO_ACTIONS) tiles = threadsPageTiles(t);
	else if (t < T_TO_ACTIONS + SWITCH_MS) tiles = switchPages(threadsPageTiles(t), actionTiles(t), t, T_TO_ACTIONS, SLOT_FOCUS);
	else if (t < T_TO_THREADS_AGAIN) tiles = actionTiles(t);
	else if (t < T_TO_THREADS_AGAIN + SWITCH_MS) tiles = switchPages(actionTiles(t), threadsPageTiles(t), t, T_TO_THREADS_AGAIN, SLOT_SNOOZE);
	else if (t < T_TO_PROFILE) tiles = threadsPageTiles(t);
	else if (t < T_TO_PROFILE + SWITCH_MS) tiles = switchPages(threadsPageTiles(t), profileTiles(t), t, T_TO_PROFILE, 0);
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

// ---------------------------------------------------------------- act 4: one key, every state

const PALETTE = { working: "#5B9CFF", background: "#F4F5F7", input: "#F5A524", done: "#3DD68C", failed: "#F0524F", paused: "#8B93A1", context: "#F4F5F7" };
const STAR = { id: "star", title: "Add retry to checkout flow", project: "acme-web" };
const star = (s: Partial<ThreadState>, extra: Partial<ThreadCard> = {}): ThreadCard =>
	cardOf(STAR.id, STAR.title, STAR.project, { state: "working", own: "running", ctx: 32, subagents: 0, background: 0, run: true, ...s }, extra);
const PR_WAIT = waitingLabel([{ taskId: "pull-request-watch:acme/acme-web#42", kind: "background_task" }]);

interface StarState {
	id: string;
	from: number;
	to: number;
	color: string;
	title: string;
	sub: string;
	/** The key at `local` ms into this state: the detailed look. */
	svg: (local: number) => string;
	/** The same key in the glance look. */
	glance: (local: number) => string;
}
const keyAt = (card: ThreadCard, local: number, style: "detailed" | "glance" = "detailed"): string =>
	renderThreadKey({ card, projectName: card.projectId, connection: ok, animation: "smooth", now: BASE + local, style });
/** One thread state in both looks. */
const both = (c: () => ThreadCard | ((l: number) => ThreadCard)) => {
	const at = (l: number): ThreadCard => {
		const v = c();
		return typeof v === "function" ? v(l) : v;
	};
	return { svg: (l: number) => keyAt(at(l), l), glance: (l: number) => keyAt(at(l), l, "glance") };
};
const OVERVIEW_COUNTS = { input: 2, failed: 0, done: 1, working: 6, background: 2, idle: 3 };
const overviewAt = (local: number, style: "detailed" | "glance"): string =>
	renderOverview({ connection: ok, counts: OVERVIEW_COUNTS, overflow: 0, animation: "smooth", now: BASE + local, style });
const STATES: StarState[] = [
	{
		id: "overview", from: ZOOM_IN[0], to: STATE_AT.working, color: PALETTE.input, title: "Overview", sub: "Who needs you, who works, who's done.",
		svg: (l) => overviewAt(l, "detailed"), glance: (l) => overviewAt(l, "glance"),
	},
	{ id: "working", from: STATE_AT.working, to: STATE_AT.subagents, color: PALETTE.working, title: "Working", sub: "A spinner, or a stroke round the border.", ...both(() => star({})) },
	{ id: "subagents", from: STATE_AT.subagents, to: STATE_AT.background, color: PALETTE.working, title: "Subagents", sub: "Folded into the same key.", ...both(() => (l: number) => star({ subagents: l < 600 ? 1 : l < 1200 ? 2 : 3 })) },
	{ id: "background", from: STATE_AT.background, to: STATE_AT.input, color: PALETTE.background, title: "Waiting on CI", sub: "White: only background work is left.", ...both(() => star({ own: "completed", run: false, background: 1, waitingOn: PR_WAIT })) },
	{ id: "input", from: STATE_AT.input, to: STATE_AT.done, color: PALETTE.input, title: "Needs you", sub: "Amber blink: your turn.", ...both(() => star({ state: "input", own: "waiting" })) },
	{ id: "done", from: STATE_AT.done, to: STATE_AT.failed, color: PALETTE.done, title: "Done", sub: "Solid green until you look.", ...both(() => star({ state: "done", own: "completed", run: false })) },
	{ id: "failed", from: STATE_AT.failed, to: STATE_AT.paused, color: PALETTE.failed, title: "Failed", sub: "Red blink.", ...both(() => star({ state: "failed", own: "failed", run: false })) },
	{
		id: "paused", from: STATE_AT.paused, to: STATE_AT.context, color: PALETTE.paused, title: "Usage limit", sub: "Dimmed and dashed.",
		...both(() => (l: number) => star({ state: "paused", own: "idle", run: false }, { pausedUntil: BASE + l + 2 * 3_600_000 + 10 * 60_000 + 30_000 })),
	},
	{
		id: "context", from: STATE_AT.context, to: ZOOM_OUT[1], color: PALETTE.context, title: "Context window", sub: "Detailed: the bottom bar fills, grey to red.",
		...both(() => (l: number) => star({ state: "idle", own: "idle", run: false, ctx: Math.round(lerp(30, 92, easeInOut(ramp(l, 200, 1900)))) })),
	},
];
// ---------------------------------------------------------------- act 5: your Mac, at a glance

/** Invented readings for this Mac. On the profile the CPU climbs a little when a thread starts working. */
const GB = 1e9;
function mac(cpuP: number, cpuE: number, memUsed: number, pressure: number, diskFree: number): MachineSnapshot {
	return {
		at: 0,
		load: [6.2, 5.1, 4.4],
		cpu: { chip: "M4 Pro", windowMs: 30_000, clusters: [{ kind: "P", cores: 10, busy: cpuP }, { kind: "E", cores: 4, busy: cpuE }] },
		memory: { freePercent: 100 - memUsed, pressure, totalBytes: 48 * 2 ** 30, swapUsedBytes: 0 },
		disks: new Map([["/", { totalBytes: 994 * GB, freeBytes: diskFree * GB }]]),
	};
}
const machineAt = (t: number): MachineSnapshot => mac(Math.round(lerp(18, 31, easeInOut(ramp(t, T_STARTS, T_STARTS + 1500)))), 46, 41, 1, 412);
const UPDATES_ONE = { ok: true, fetchedAt: 1, t3: { name: "T3 Code", current: "0.1.7", latest: "0.1.8", available: true }, providers: [] };
const UPDATES_TWO = { ...UPDATES_ONE, providers: [{ name: "Claude", current: "2.1.319", latest: "2.1.320", available: true }] };
const machineKey = (stat: "summary" | "cpu" | "memory" | "disk", sample: MachineSnapshot, style: "glance" | "detailed" = "glance"): string =>
	renderMachineKey({ stat, sample, path: "/", style });
/** One Machine stat in both looks. */
const looks = (stat: "summary" | "cpu" | "memory" | "disk", sample: (l: number) => MachineSnapshot) => ({
	svg: (l: number) => machineKey(stat, sample(l), "detailed"),
	glance: (l: number) => machineKey(stat, sample(l), "glance"),
});
const MACHINE_STATES: StarState[] = [
	{ id: "m-summary", from: ZOOM5_IN[0], to: MACHINE_AT.cpu, color: PALETTE.done, title: "Your Mac", sub: "CPU, memory and disk on one key.", ...looks("summary", () => machineAt(Infinity)) },
	{
		id: "m-cpu", from: MACHINE_AT.cpu, to: MACHINE_AT.memory, color: PALETTE.input, title: "CPU", sub: "Performance cores, over 30 s. Amber at 70%, red at 90%.",
		...looks("cpu", (l) => mac(Math.round(lerp(34, 94, easeInOut(ramp(l, 250, 1900)))), 100, 41, 1, 412)),
	},
	{ id: "m-memory", from: MACHINE_AT.memory, to: MACHINE_AT.disk, color: PALETTE.done, title: "Memory pressure", sub: "82% in use, and still green: there's room.", ...looks("memory", () => mac(31, 46, 82, 1, 412)) },
	{ id: "m-disk", from: MACHINE_AT.disk, to: MACHINE_AT.updates, color: PALETTE.failed, title: "Disk", sub: "Space left on the disk you pick.", ...looks("disk", () => mac(31, 46, 41, 1, 21)) },
	{
		id: "m-updates", from: MACHINE_AT.updates, to: ZOOM5_OUT[1], color: PALETTE.input, title: "Updates", sub: "T3 Code or a provider CLI has a new version.",
		svg: () => renderUpdatesKey(UPDATES_TWO, "detailed"), glance: () => renderUpdatesKey(UPDATES_TWO, "glance"),
	},
];

/**
 * A state change dips through the key's dark background: the old image fades
 * out, then the new one fades in. Cross-fading two keys with different text
 * would double-expose it.
 */
const DIP_OUT = 130;
const DIP_IN = 170;
const KEY_BG = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="#0E1013"/></svg>`;
/** A state's own clock: it starts when its image starts to show, so a blink always opens lit. */
const stateClock = (states: StarState[], i: number, t: number): number => Math.max(0, t - states[i]!.from - (i === 0 ? 0 : DIP_OUT));

interface Big {
	x: number;
	y: number;
	scale: number;
	opacity: number;
	layers: { svg: string; opacity: number }[];
	/** The Glance twin, TWIN_DX to the right once zoomed; it fades in at the end of the zoom. */
	twin: { x: number; opacity: number; layers: { svg: string; opacity: number }[] };
}
/** A zoom into one key: act 4 the Overview key's spot (thread states), act 5 the Machine key. */
interface Zoom {
	slot: number;
	in: readonly [number, number];
	out: readonly [number, number];
	states: StarState[];
	/** Zooms out into the loop's opening state. */
	loops: boolean;
}
const ZOOMS: Zoom[] = [
	{ slot: SLOT_OVERVIEW, in: ZOOM_IN, out: ZOOM_OUT, states: STATES, loops: false },
	{ slot: SLOT_MACHINE, in: ZOOM5_IN, out: ZOOM5_OUT, states: MACHINE_STATES, loops: true },
];
/** The zoom under way at `t` (or the first, idle), and how far: 0 = the deck as is, 1 = all the way into its key. */
function zoomAt(t: number): { p: number; z: Zoom } {
	const z = ZOOMS.find((k) => t >= k.in[0] && t < k.out[1]);
	if (!z) return { p: 0, z: ZOOMS[0]! };
	if (t < z.in[1]) return { p: easeInOut(ramp(t, z.in[0], z.in[1])), z };
	if (t < z.out[0]) return { p: 1, z };
	return { p: 1 - easeInOut(ramp(t, z.out[0], z.out[1])), z };
}
/** Where the zoomed key's centre is, and how big (1 = a deck key, ZOOM = the big key). */
function zoomFrame(p: number, z: Zoom): { cx: number; cy: number; s: number } {
	const c = slotCenter(z.slot);
	if (SQUARE) {
		// Act 4 starts and ends on the home shot.
		const from = onScreen(SHOT.home, c.x, c.y);
		return { cx: lerp(from.x, BIG_CENTER.x, p), cy: lerp(from.y, BIG_CENTER.y, p), s: lerp(SHOT.home.s, ZOOM, p) };
	}
	return { cx: lerp(c.x, BIG_CENTER.x, p), cy: lerp(c.y, BIG_CENTER.y, p), s: lerp(1, ZOOM, p) };
}
function bigAt(t: number, p: number, z: Zoom): Big | undefined {
	const opacity = easeInOut(ramp(p, 0.35, 0.8));
	if (opacity <= 0) return undefined;
	const STATES = z.states;
	const i = Math.max(0, STATES.findIndex((s) => t >= s.from && t < s.to));
	const cur = STATES[i]!;
	const away = i === 0 ? 1 : easeInOut(ramp(t, cur.from, cur.from + DIP_OUT));
	const shown = i === 0 ? 1 : easeInOut(ramp(t, cur.from + DIP_OUT, cur.from + DIP_OUT + DIP_IN));
	const layersOf = (look: "svg" | "glance"): Big["layers"] => {
		const layers: Big["layers"] = [];
		if (shown < 1) {
			layers.push({ svg: KEY_BG, opacity: 1 });
			if (away < 1) layers.push({ svg: STATES[i - 1]![look](stateClock(STATES, i - 1, t)), opacity: 1 - away });
		}
		if (shown > 0) layers.push({ svg: cur[look](stateClock(STATES, i, t)), opacity: shown });
		return layers;
	};
	const { cx, cy, s } = zoomFrame(p, z);
	const scale = s / ZOOM;
	const x = cx - BIG / 2;
	return {
		x,
		y: cy - BIG / 2,
		scale,
		opacity,
		layers: layersOf("svg"),
		twin: { x: x + TWIN_DX * scale, opacity: opacity * easeInOut(ramp(p, 0.7, 1)), layers: layersOf("glance") },
	};
}
/** State labels beside the big key: the old one fades out, then the new one fades in with its key. */
function labelsAt(t: number, p: number, active: Zoom): { id: string; opacity: number; dy: number }[] {
	return ZOOMS.flatMap((z) => {
		const shown = z === active ? easeInOut(ramp(p, 0.75, 1)) : 0;
		return z.states.map((s, i) => {
			const inn = i === 0 ? 1 : easeOut(ramp(t, s.from + DIP_OUT, s.from + DIP_OUT + 320));
			const out = i === z.states.length - 1 ? 0 : easeInOut(ramp(t, s.to, s.to + DIP_OUT));
			return { id: `lab-${s.id}`, opacity: Math.min(inn, 1 - out) * shown, dy: (1 - inn) * 12 };
		});
	});
}

// ---------------------------------------------------------------- captions

interface Caption {
	id: string;
	kind: "title" | "sub";
	text: string;
	from: number;
	to: number;
}
const ACT1_TITLE = "Start with a few keys";
const ACT1_SUB = "Your profile, plus Overview, Usage, Machine and Updates.";
const CAPTIONS: Caption[] = [
	{ id: "t1", kind: "title", text: ACT1_TITLE, from: -Infinity, to: ACT2 },
	{ id: "s1", kind: "sub", text: ACT1_SUB, from: -Infinity, to: ACT2 },
	{ id: "t2", kind: "title", text: "Tap for every thread", from: ACT2, to: ACT3 },
	{ id: "s2", kind: "sub", text: "Tap Overview: every T3 Code thread gets a key.", from: ACT2, to: TAP_FLAKY.down - 450 },
	{ id: "s2b", kind: "sub", text: "Tap a thread: T3 Code opens on it, on your Mac.", from: TAP_FLAKY.down - 450, to: ACT3 },
	{ id: "t3", kind: "title", text: "Hold for actions", from: ACT3, to: ACT4 },
	{ id: "s3a", kind: "sub", text: "Hold a thread, then let go.", from: ACT3, to: HOLD_MSG.down - 450 },
	{ id: "s3b", kind: "sub", text: "Hold a quick message to send it.", from: HOLD_MSG.down - 450, to: HOLD_COMPACT.down - 450 },
	{ id: "s3c", kind: "sub", text: "Hold Compact to compact the context.", from: HOLD_COMPACT.down - 450, to: TAP_SNOOZE.down - 450 },
	{ id: "s3d", kind: "sub", text: "Tap Snooze: the thread leaves the deck.", from: TAP_SNOOZE.down - 450, to: TAP_BACK.down - 450 },
	{ id: "s3e", kind: "sub", text: "Back returns to your profile.", from: TAP_BACK.down - 450, to: ACT4 },
	{ id: "t4", kind: "title", text: "One key, every state", from: ACT4, to: ACT5 },
	{ id: "s4", kind: "sub", text: "Detailed, or Glance to read it from across your desk.", from: ACT4, to: ACT5 },
	{ id: "t5", kind: "title", text: "Your Mac, at a glance", from: ACT5, to: ACT1_AGAIN },
	{ id: "s5", kind: "sub", text: "CPU, memory, disk and updates, in either look.", from: ACT5, to: ACT1_AGAIN },
	{ id: "t1b", kind: "title", text: ACT1_TITLE, from: ACT1_AGAIN, to: Infinity },
	{ id: "s1b", kind: "sub", text: ACT1_SUB, from: ACT1_AGAIN, to: Infinity },
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
	/** Deck zoom: translate + scale of the whole device, and its opacity. */
	deck: { tx: number; ty: number; s: number; opacity: number };
	big?: Big;
	finger?: Finger;
	/** The T3 Code window on the Mac, opened by the tap in act 2. */
	mac: { opacity: number; scale: number; dy: number };
	captions: { id: string; opacity: number; dy: number }[];
	labels: { id: string; opacity: number; dy: number }[];
}
const r2 = (v: number): number => +v.toFixed(2);
const r3 = (v: number): number => +v.toFixed(3);
/** The T3 Code window pops up after the tap, holds, then goes, before act 3. */
function macAt(t: number): Frame["mac"] {
	const inn = easeOut(ramp(t, MAC_IN[0], MAC_IN[1]));
	const out = easeInOut(ramp(t, MAC_OUT[0], MAC_OUT[1]));
	const opacity = Math.min(inn, 1 - out);
	return { opacity, scale: 0.94 + 0.06 * inn - 0.03 * out, dy: (1 - inn) * 24 + out * 12 };
}

function frameAt(t: number): Frame {
	const { p, z } = zoomAt(t);
	// While the last zoom backs out, the deck underneath is already the opening state, on its own clock (t − DURATION).
	const deckOpacity = 1 - easeInOut(ramp(p, 0.5, 1));
	const tiles = deckOpacity > 0 ? deckTiles(z.loops && t >= z.out[0] ? t - DURATION : t) : [];
	const { cx, cy, s } = zoomFrame(p, z);
	const c = slotCenter(z.slot);
	const big = bigAt(t, p, z);
	// Square, outside the zoom: the camera frames the deck.
	const cam = SQUARE && p === 0 ? cameraAt(t) : undefined;
	const deck = cam
		? { tx: r2(ANCHOR.x - cam.s * cam.fx), ty: r2(ANCHOR.y - cam.s * cam.fy), s: +cam.s.toFixed(4), opacity: r3(deckOpacity) }
		: { tx: r2(cx - s * c.x), ty: r2(cy - s * c.y), s: +s.toFixed(4), opacity: r3(deckOpacity) };
	const finger = fingerAt(t);
	// Keys in the softer screen colours: they read like light from a real key (see marketing/screen-colors.ts).
	const roundTile = (tl: Tile): Tile => ({ ...tl, x: r2(tl.x), y: r2(tl.y), scale: +tl.scale.toFixed(4), opacity: r3(tl.opacity), dim: r3(tl.dim), layers: tl.layers.map((l) => ({ svg: soften(l.svg), opacity: r3(l.opacity) })) });
	const softBig = (b: Big): Big => ({ ...b, layers: b.layers.map((l) => ({ ...l, svg: soften(l.svg) })), twin: { ...b.twin, layers: b.twin.layers.map((l) => ({ ...l, svg: soften(l.svg) })) } });
	const round = <T>(o: T): T => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "number" ? r3(v) : v)));
	const fades = (list: { id: string; opacity: number; dy: number }[]) => list.map((x) => ({ id: x.id, opacity: r3(x.opacity), dy: r2(x.dy) }));
	return {
		tiles: tiles.filter((tl) => tl.opacity > 0.001).map(roundTile),
		deck,
		big: big ? round(softBig(big)) : undefined,
		finger: finger && finger.opacity > 0.001 ? round(finger) : undefined,
		mac: round(macAt(t)),
		captions: fades(captionsAt(t)),
		labels: fades(labelsAt(t, p, z)),
	};
}


/**
 * The T3 Code window: a plain app window drawn here (no T3 artwork), with a
 * thread list and the tapped thread open. Invented content.
 */
const MAC_SIDEBAR: [string, string, boolean?][] = [
	["Paginate the orders endpoint", PALETTE.working],
	["Add retry to checkout flow", PALETTE.input],
	["Migrate docs to new wiki", PALETTE.working],
	["Fix flaky login test", PALETTE.done, true],
	["Add browser smoke tests", PALETTE.working],
	["Add an audit log", PALETTE.working],
	["Trim Docker image size", "#5C636F"],
];
const MAC_W = SQUARE ? 760 : 980;
const MAC_H = SQUARE ? 500 : 600;
const MAC_POS = SQUARE ? { x: 300, y: 420 } : { x: 860, y: 300 };
function macHtml(): string {
	const side = MAC_SIDEBAR.map(([title, color, on]) => `<div class="it${on ? " on" : ""}"><i style="background:${color}"></i>${title}</div>`).join("");
	return `<div id="mac"><div class="bar"><i></i><i></i><i></i><span>T3 Code</span></div><div class="body"><div class="side"><div class="sh">Threads</div>${side}</div>` +
		`<div class="main"><div class="th">Fix flaky login test<span>acme-web</span></div>` +
		`<div class="msg me">The login test fails about one run in ten. Find out why and fix it.</div>` +
		`<div class="msg">It waited a fixed 200 ms for the session cookie, which is sometimes too short. I now wait for the cookie itself. 50 runs in a row pass.</div>` +
		`<div class="chip">✓ Done</div></div></div></div>`;
}
const macCss = (): string => `
#mac{position:absolute;left:${MAC_POS.x}px;top:${MAC_POS.y}px;width:${MAC_W}px;height:${MAC_H}px;z-index:7;opacity:0;transform-origin:30% 50%;
  border-radius:14px;overflow:hidden;background:#15171b;box-shadow:0 0 0 1px #ffffff1f,0 40px 120px #000,0 10px 30px #000c;font-family:${SANS}}
#mac .bar{height:44px;display:flex;align-items:center;gap:8px;padding:0 16px;background:#1d2026;border-bottom:1px solid #ffffff12}
#mac .bar i{width:13px;height:13px;border-radius:50%;background:#3a3f47}
#mac .bar span{margin-left:12px;font-size:15px;font-weight:600;color:#a3a3a3}
#mac .body{display:flex;height:${MAC_H - 44}px}
#mac .side{width:${SQUARE ? 250 : 300}px;padding:14px 10px;background:#111317;border-right:1px solid #ffffff10}
#mac .sh{font:600 12px/1 ${MONO};letter-spacing:.1em;text-transform:uppercase;color:#6b7280;padding:4px 10px 12px}
#mac .it{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;font-size:${SQUARE ? 15 : 16}px;color:#c9ced6;white-space:nowrap;overflow:hidden}
#mac .it i{flex:none;width:9px;height:9px;border-radius:50%}
#mac .it.on{background:#2a3242;color:#fff}
#mac .main{flex:1;padding:26px 30px;display:flex;flex-direction:column;gap:18px;min-width:0}
#mac .th{font-size:${SQUARE ? 24 : 28}px;font-weight:700;letter-spacing:-.01em;color:#f5f5f5}
#mac .th span{margin-left:12px;font-size:16px;font-weight:500;color:#8b93a1}
#mac .msg{max-width:88%;padding:14px 18px;border-radius:14px;background:#1f232a;color:#d8dce3;font-size:${SQUARE ? 16 : 18}px;line-height:1.45}
#mac .msg.me{align-self:flex-end;background:#2d4a86;color:#fff}
#mac .chip{align-self:flex-start;padding:7px 14px;border-radius:999px;background:#3dd68c26;color:#3dd68c;font-weight:700;font-size:16px}
`;

// ---------------------------------------------------------------- the page

const ACCENT = "oklch(0.72 0.15 252)";
const SANS = `"Inter", ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace`;

/** Square: bigger captions over a black scrim, act 4's label under the key. Readable at 360 px wide. */
const SQUARE_CSS = `
.eyebrow{top:44px;font-size:20px;z-index:7}
.cap{z-index:7;padding:0 40px}
.cap.title{top:78px;font-size:84px}
.cap.sub{top:184px;font-size:40px;line-height:1.25}
.scrim{position:absolute;left:0;top:0;width:${W}px;height:400px;z-index:5;background:linear-gradient(180deg,#000 0%,#000 66%,#0000 100%)}
#big,#big2,.lab,.finger{z-index:6}
.lab{left:0;width:${W}px;top:${BIG_CENTER.y + BIG / 2 + 26}px;text-align:center}
.lab .lt{font-size:60px}
.lab .ls{margin-top:8px;font-size:34px}
.note{top:1050px;font-size:16px;z-index:7}
`;

function pageHtml(): string {
	const wells = Array.from({ length: SLOTS }, (_, s) => {
		const p = slotPos(s);
		return `<div class="well" style="left:${p.x - 5}px;top:${p.y - 5}px"></div>`;
	}).join("");
	const captions = CAPTIONS.map((c) => `<div class="cap ${c.kind}" id="${c.id}">${c.text}</div>`).join("");
	const labels = [...STATES, ...MACHINE_STATES].map((s) => `<div class="lab" id="lab-${s.id}"><div class="lt" style="color:${s.color}">${s.title}</div><div class="ls">${s.sub}</div></div>`).join("");
	const r = 17 * ZOOM;
	return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:#000;color:#f5f5f5;font-family:${SANS};-webkit-font-smoothing:antialiased}
.glow{position:absolute;left:0;top:0;width:${W}px;height:${H}px;background:radial-gradient(52% 46% at 50% 58%,oklch(0.72 0.15 252 / 0.2),transparent 72%)}
.eyebrow{position:absolute;left:0;width:${W}px;top:66px;text-align:center;font:600 16px/1 ${MONO};letter-spacing:.12em;text-transform:uppercase;color:${ACCENT}}
/* Fading text keeps its own layer, so its pixels never depend on the frames before. */
.cap,.lab{will-change:opacity}
.cap{position:absolute;left:0;width:${W}px;text-align:center;opacity:0}
.cap.title{top:96px;font-size:64px;font-weight:700;letter-spacing:-.025em;line-height:1.06}
.cap.sub{top:180px;font-size:30px;line-height:1.3;color:#a3a3a3}
#deck{position:absolute;left:0;top:0;width:${W}px;height:${H}px;transform-origin:0 0}
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
#big,#big2{position:absolute;left:0;top:0;width:${BIG}px;height:${BIG}px;transform-origin:50% 50%;z-index:4;opacity:0;border-radius:${r}px;
  box-shadow:0 0 0 ${ZOOM * 5}px #040405,0 0 0 ${ZOOM * 5 + 1}px #ffffff14,0 40px 110px #000}
#big>.face,#big2>.face{border-radius:${r}px}
#big>.face>.gloss,#big2>.face>.gloss{border-radius:${r}px;box-shadow:inset 0 2px 0 #ffffff1c,inset 0 0 0 2px #ffffff08}
#big svg,#big2 svg{width:${BIG}px;height:${BIG}px}
.look{position:absolute;left:0;right:0;top:-${SQUARE ? 52 : 46}px;text-align:center;font:600 ${SQUARE ? 24 : 18}px/1 ${MONO};letter-spacing:.12em;text-transform:uppercase;color:#a3a3a3}
.lab{position:absolute;left:${LABEL_X}px;top:${BIG_CENTER.y - 70}px;width:${W - LABEL_X - 120}px;opacity:0;z-index:4}
.lab .lt{font-size:64px;font-weight:700;letter-spacing:-.02em;line-height:1.05}
.lab .ls{margin-top:16px;font-size:32px;line-height:1.3;color:#a3a3a3}
.finger{position:absolute;left:0;top:0;width:62px;height:62px;margin:-31px 0 0 -31px;z-index:5;opacity:0}
.finger>.core{position:absolute;inset:0;border-radius:50%;
  background:radial-gradient(circle at 42% 38%,#ffffff73,#ffffff33 60%,#ffffff24);border:2px solid #ffffffcc;
  box-shadow:0 10px 28px #000a,0 0 0 1px #0000004d}
.finger>.ripple{position:absolute;inset:0;border-radius:50%;border:3px solid #ffffff;opacity:0}
.note{position:absolute;left:0;width:${W}px;top:${DECK_Y + DECK_H + 44}px;text-align:center;font-size:17px;color:#a3a3a3;opacity:.7}
${macCss()}
${SQUARE ? SQUARE_CSS : ""}</style></head><body>
<div class="glow"></div>
<div class="eyebrow">Deck for T3 Code</div>
${captions}
<div id="deck">
<div class="floor"></div>
<div class="slab"></div>
${wells}
<div id="tiles"></div>
<div class="sheen"></div>
</div>${SQUARE ? `<div class="scrim"></div>` : ""}
<div id="big"><div class="face"><div class="gloss"></div></div><div class="look">Detailed</div></div>
<div id="big2"><div class="face"><div class="gloss"></div></div><div class="look">Glance</div></div>
${labels}
<div class="finger" id="finger"><div class="ripple"></div><div class="core"></div></div>
${macHtml()}
<div class="note">Example data</div>
<script>
const host = document.getElementById("tiles");
const deck = document.getElementById("deck");
const big = document.getElementById("big");
big._face = big.children[0]; big._layers = [];
const big2 = document.getElementById("big2");
big2._face = big2.children[0]; big2._layers = [];
const tiles = new Map();
const finger = document.getElementById("finger");
const mac = document.getElementById("mac");
const fades = new Map([...document.querySelectorAll(".cap,.lab")].map((el) => [el.id, el]));
function make() {
  const el = document.createElement("div");
  el.className = "tile";
  el.innerHTML = '<div class="face"><div class="shade"></div><div class="gloss"></div></div>';
  el._face = el.children[0]; el._shade = el._face.children[0]; el._layers = [];
  return el;
}
function setLayers(el, layers, before) {
  layers.forEach((l, i) => {
    let layer = el._layers[i];
    if (!layer) { layer = document.createElement("div"); layer.className = "l"; el._face.insertBefore(layer, before); el._layers[i] = layer; layer._svg = ""; }
    if (layer._svg !== l.svg) { layer.innerHTML = l.svg; layer._svg = l.svg; }
    layer.style.opacity = l.opacity;
    layer.style.display = "";
  });
  for (let i = layers.length; i < el._layers.length; i++) el._layers[i].style.display = "none";
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
    setLayers(el, t.layers, el._shade);
  });
  for (const [id, el] of tiles) if (!seen.has(id)) { el.remove(); tiles.delete(id); }
  // No transform at rest, so the deck rasterises the same whatever came before it.
  deck.style.transform = s.deck.s === 1 ? "" : "translate(" + s.deck.tx + "px," + s.deck.ty + "px) scale(" + s.deck.s + ")";
  deck.style.opacity = s.deck.opacity;
  deck.style.display = s.deck.opacity > 0 ? "" : "none";
  if (s.big) {
    big.style.display = "";
    big.style.opacity = s.big.opacity;
    big.style.transform = "translate(" + s.big.x + "px," + s.big.y + "px)" + (s.big.scale === 1 ? "" : " scale(" + s.big.scale + ")");
    setLayers(big, s.big.layers, big._face.lastChild);
    big2.style.display = "";
    big2.style.opacity = s.big.twin.opacity;
    big2.style.transform = "translate(" + s.big.twin.x + "px," + s.big.y + "px)" + (s.big.scale === 1 ? "" : " scale(" + s.big.scale + ")");
    setLayers(big2, s.big.twin.layers, big2._face.lastChild);
  } else { big.style.display = "none"; big2.style.display = "none"; }
  mac.style.opacity = s.mac.opacity;
  mac.style.display = s.mac.opacity > 0 ? "" : "none";
  mac.style.transform = s.mac.opacity > 0 ? "translateY(" + s.mac.dy + "px) scale(" + s.mac.scale + ")" : "";
  const f = s.finger;
  if (f) {
    finger.style.opacity = f.opacity;
    finger.style.transform = "translate(" + f.x + "px," + f.y + "px) scale(" + f.scale + ")";
    finger.children[1].style.filter = "brightness(" + (1 + 0.5 * f.press) + ")";
    finger.children[0].style.opacity = f.ripple ? f.ripple.opacity : 0;
    finger.children[0].style.transform = "scale(" + (f.ripple ? f.ripple.scale : 1) + ")";
  } else finger.style.opacity = 0;
  for (const c of [...s.captions, ...s.labels]) {
    const el = fades.get(c.id);
    el.style.opacity = c.opacity;
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
	const html = join(SCRATCH, SQUARE ? "demo-square.html" : "demo.html");
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

function encodeSquare(): void {
	const input = ["-framerate", String(FPS), "-i", join(FRAMES, "f%04d.png")];
	const vf = "format=yuv420p,scale=out_color_matrix=bt709:out_range=tv";
	const tags = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];
	const clean = ["-an", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-threads", "4"];
	console.log("encoding docs/assets/demo-square.mp4 (1080×1080)");
	ffmpeg([...input, "-vf", vf, "-c:v", "libx264", "-preset", "slow", "-tune", "animation", "-crf", "24", "-profile:v", "high", "-g", String(FPS * 4), "-movflags", "+faststart", ...tags, ...clean, join(ASSETS, "demo-square.mp4")]);
	if (hasEncoder("libvpx-vp9")) {
		console.log("encoding docs/assets/demo-square.webm (1080×1080, VP9)");
		ffmpeg([...input, "-vf", vf, "-c:v", "libvpx-vp9", "-crf", "37", "-b:v", "0", "-deadline", "good", "-cpu-used", "2", "-row-mt", "1", "-g", String(FPS * 4), ...tags, ...clean, join(ASSETS, "demo-square.webm")]);
	} else console.warn("libvpx-vp9 not available: skipped docs/assets/demo-square.webm");
	for (const f of [join(ASSETS, "demo-square.mp4"), join(ASSETS, "demo-square.webm")]) {
		if (existsSync(f)) console.log(`  ${f.slice(ROOT.length + 1)}  ${(statSync(f).size / 1e6).toFixed(2)} MB`);
	}
}

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
	console.log("encoding docs/assets/demo.gif (800×450, 12 fps)");
	// No dithering and 12 fps keep the README GIF near 5.7 MB (8.1 MB with Bayer
	// dithering at 15 fps): the keys are flat colour, so dithering only added noise
	// that LZW can't compress. The cost is faint banding in the background vignette.
	ffmpeg([
		...input,
		"-vf",
		"fps=12,scale=800:450:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=full:reserve_transparent=0[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
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
	const dir = join(SCRATCH, SQUARE ? "preview-square" : "preview");
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
		if (SQUARE) encodeSquare();
		else encode();
	}
	console.log(`done in ${((Date.now() - started) / 1000).toFixed(0)} s`);
}
