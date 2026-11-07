/**
 * Pure SVG rendering for 144×144 keys. Every function takes the clock as an
 * argument so animation frames are deterministic and easy to dedupe.
 *
 * Legibility rules: no text below 14 px (keys are ~96 px on a real deck),
 * every state that needs you carries a glyph as well as a colour, and bar
 * tracks keep 3:1 against the background.
 */
import type { CardState, ThreadCard } from "./model.ts";
import { coreLayout, cpuLevel, diskLevel, diskTitle, formatBytes, formatLoadShort, mainCluster, memoryLevel, usedPercent, type CpuStats, type DiskStats, type Level, type MachineSnapshot, type MachineStat, type MemoryStats } from "./machine.ts";
import { formatDuration, type Pace, type UsageMetric } from "./usage.ts";
import { displayVersion, pendingUpdates, type UpdatesSnapshot } from "./updates.ts";
import type { Connection } from "./t3/monitor.ts";

const SIZE = 144;
const FONT = "-apple-system, 'SF Pro Text', 'Helvetica Neue', Helvetica, Arial, sans-serif";
/** Smallest font size anywhere on a key. */
export const MIN_FONT_PX = 14;

const BG = "#0E1013";
const WHITE = "#F4F5F7";
const INK = "#111111";
const DIM = "#8B93A1";
/** Secondary text that must stay readable (7:1). */
const SOFT = "#9AA1AD";
/** Zero counts and other quiet text (about 4:1). */
const QUIET = "#6B7280";
/** Bar and ring tracks: 3.1:1 against BG. */
const TRACK = "#5A6270";
/** Secondary ink on lit (accent-coloured) tiles. */
const LIT_DIM = "rgba(0,0,0,0.8)";

interface Palette {
	accent: string;
	label: string;
}

const PALETTE: Record<CardState, Palette> = {
	input: { accent: "#F5A524", label: "NEEDS YOU" },
	failed: { accent: "#FF242F", label: "FAILED" },
	done: { accent: "#00E069", label: "DONE" },
	working: { accent: "#297EFF", label: "WORKING" },
	paused: { accent: "#8B93A1", label: "PAUSED" },
	idle: { accent: "#6B7280", label: "IDLE" },
};

/** Flash rhythm per state: [period ms, share of the period spent lit]. Only states that need you blink. */
const FLASH: Partial<Record<CardState, [number, number]>> = {
	input: [900, 0.5],
	failed: [1400, 0.5],
};

/** Activity spinner: a small arc turning in the top-right corner, like T3's sidebar. */
export const SPIN_FRAMES = 8;
export const SPIN_STEP_MS = 300;
const SPIN_PERIOD_MS = SPIN_FRAMES * SPIN_STEP_MS;
const SPIN = { cx: 124, cy: 21, r: 9 };
/** Left edge of the spinner as drawn (radius plus half the 3 px stroke). */
export const SPINNER_LEFT = SPIN.cx - SPIN.r - 1.5;
/** Text on the spinner's rows stops this far short of it, because real glyphs run wider than the estimate. */
const SPINNER_GAP = 9;
const BACKGROUND_ORBIT = "#F4F5F7";
const ACTIVE_OWN = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export type AnimationMode = "smooth" | "off";

export interface ThreadKeyInput {
	card: ThreadCard | undefined;
	projectName: string;
	connection: Connection;
	animation: AnimationMode;
	now: number;
	/** Status word (WORKING, DONE…) above the title. Off by default: colour, glyph and motion already say it. */
	showLabel?: boolean;
	/**
	 * First Thread key on its deck. While T3 is unreachable only this one says
	 * why; the others go blank so the deck isn't a wall of the same error.
	 */
	primary?: boolean;
	/** Held past the long-press threshold: "Release to open" (actions page) or "to clear" (no page on this deck). */
	releaseCue?: "open" | "clear";
	/** "glance": a big state glyph and a two-line title in large type, no project or status word. */
	style?: KeyStyle;
}

export function isAnimated(state: CardState | undefined, animation: AnimationMode): boolean {
	if (!state || animation === "off") return false;
	return state === "working" || FLASH[state] !== undefined;
}

/** True while a flashing key is in its bright phase. */
function flashLit(state: CardState, now: number): boolean {
	const flash = FLASH[state];
	if (!flash) return false;
	const [period, duty] = flash;
	return now % period < period * duty;
}

/** Next time a flashing state switches between lit and dark. */
function nextFlashEdge(state: CardState, now: number): number {
	const [period, duty] = FLASH[state]!;
	const t = now % period;
	const litEnd = period * duty;
	return t < litEnd ? now - t + litEnd : now - t + period;
}

const nextBoundary = (now: number, step: number): number => (Math.floor(now / step) + 1) * step;

/** The tile shows a spinner: the agent, a subagent or background work is running. */
function spins(card: ThreadCard): boolean {
	if (card.state === "paused" || card.state === "idle") return false;
	return card.state === "working" || card.subagentsWorking > 0 || card.background > 0;
}

/**
 * When a thread tile next looks different with nothing but the clock moving
 * (spinner step, blink edge, a paused countdown's minute), or undefined if it
 * is static. The deck re-renders only those keys, at exactly those times.
 */
export function nextThreadFrame(card: ThreadCard | undefined, animation: AnimationMode, now: number, style: KeyStyle = "detailed"): number | undefined {
	if (!card) return undefined;
	let next: number | undefined;
	const at = (t: number): void => {
		if (next === undefined || t < next) next = t;
	};
	if (card.state === "paused") {
		// The glance look shows no countdown, so nothing to tick.
		if (style !== "glance" && card.pausedUntil && card.pausedUntil > now) at(now + ((card.pausedUntil - now) % 60_000) + 1);
		return next;
	}
	if (animation === "off") return undefined;
	if (FLASH[card.state]) at(nextFlashEdge(card.state, now));
	if (spins(card)) at(nextBoundary(now, style === "glance" ? ORBIT_STEP_MS : SPIN_STEP_MS));
	return next;
}

/** Short, actionable wording for why T3 can't be reached. */
export function connectionText(connection: Connection): string {
	if (connection.kind === "ok") return "";
	if (connection.kind === "connecting") return "Connecting…";
	switch (connection.reason) {
		case "not-installed":
			return "Install T3 Code";
		case "not-running":
			return "Open T3 Code";
		case "cli-missing":
			return "T3 CLI missing";
		case "sign-in-failed":
			return "Sign-in failed";
		case "signed-out":
			return "Signed out";
		case "server-error":
			return "T3 error";
	}
	return connection.kind === "offline" ? "T3 offline" : "T3 error";
}

export function renderThreadKey(input: ThreadKeyInput): string {
	const { card, connection, animation, now } = input;
	// Never show possibly stale thread state while T3 is unreachable.
	if (connection.kind !== "ok") return input.primary === false ? renderEmpty() : renderMessage(connectionText(connection), SOFT);
	if (!card) return renderEmpty();
	const cue = input.releaseCue ? releaseCue(input.releaseCue) : "";
	if (card.state === "paused") return overlay(input.style === "glance" ? renderPausedGlance(card) : renderPaused(card, now, input.showLabel), cue);

	const state = card.state;
	const { accent, label } = PALETTE[state];
	// DONE is a steady solid tile; only NEEDS YOU and FAILED blink.
	const lit = state === "done" || (animation !== "off" && flashLit(state, now));
	const steady = animation === "off" && FLASH[state] !== undefined;
	if (input.style === "glance") return overlay(renderThreadGlance(card, lit, steady, animation, now), cue);

	const bg = lit ? accent : steady ? mix(accent, BG, 0.72) : BG;
	const fg = lit ? INK : WHITE;
	const dim = lit ? LIT_DIM : DIM;
	const labelColor = lit ? INK : accent;

	const parts: string[] = [`<rect width="${SIZE}" height="${SIZE}" fill="${bg}"/>`];
	// Steady ring during the dark phase of a blink.
	if ((state === "input" || state === "failed") && !lit) {
		parts.push(`<rect x="3" y="3" width="138" height="138" rx="20" fill="none" stroke="${accent}" stroke-width="3" opacity="0.9"/>`);
	}

	// Spinner while something runs: blue for the agent, white when it only waits on background work.
	const backgroundOnly = isBackgroundOnly(card);
	const busy = spins(card);
	if (busy) parts.push(spinner(lit ? INK : backgroundOnly ? BACKGROUND_ORBIT : PALETTE.working.accent, animation === "off" ? 0 : now));
	const glyph = hasGlyph(state);

	// Title: the first line leaves room for the glyph and the spinner.
	const lineHeight = 23;
	let lines: string[];
	let top: number;
	let firstX = 12;
	if (input.showLabel) {
		const statusText = state === "input" && card.inputFromSubagent ? "AGENT ASKS" : label;
		let labelX = 29;
		if (glyph) {
			parts.push(stateGlyph(state, 20, 22, 9, lit, accent));
			labelX = 35;
		} else {
			parts.push(`<circle cx="18" cy="22" r="5" fill="${labelColor}"/>`);
		}
		const room = (busy ? 110 : 134) - labelX;
		parts.push(text(labelX, 27, fit(statusText, room, 14, 0.3), { size: 14, weight: 700, fill: labelColor, spacing: 0.3 }));
		lines = wrapWidths(card.title, [12, 12, 12]);
		top = 58 + (3 - lines.length) * (lineHeight / 2);
	} else {
		if (glyph) {
			parts.push(stateGlyph(state, 21, 28, 10, lit, accent));
			firstX = 37;
		}
		// The first line shares its row with the spinner (top right) and the glyph disc (left).
		const firstWidth = busy ? (SPINNER_LEFT - SPINNER_GAP - firstX) / (18 * 0.56) : 12 - (glyph ? 2.5 : 0);
		lines = wrapWidths(card.title, [firstWidth, 12, 12, 12]);
		top = 34;
	}
	lines.forEach((line, i) => {
		if (line) parts.push(text(i === 0 ? firstX : 12, top + i * lineHeight, line, { size: 18, weight: 650, fill: fg }));
	});

	// Footer: what it waits on, or project name + badge or context %.
	const agents = card.subagentsWorking + card.subagentsWaiting + card.background;
	if (backgroundOnly && card.waitingOn) {
		parts.push(waitingChip(card.waitingOn, lit));
	} else {
		const badgeWidth = agents > 0 ? 18 + String(agents).length * 9 + 8 : 0;
		const percent = agents === 0 && card.context !== undefined ? `${contextPercent(card.context)}%` : "";
		const right = agents > 0 ? SIZE - 10 - badgeWidth - 6 : percent ? 132 - pxWidth(percent, 14) - 6 : 128;
		parts.push(text(12, 130, fit(input.projectName, right - 12, 14), { size: 14, weight: 550, fill: dim }));
		if (agents > 0) parts.push(agentBadge(SIZE - 10 - badgeWidth, 114, badgeWidth, agents, lit ? INK : backgroundOnly ? BACKGROUND_ORBIT : accent, lit ? accent : BG));
		else if (percent) parts.push(text(132, 130, percent, { size: 14, weight: 750, fill: lit ? INK : contextColor(card.context!), anchor: "end" }));
	}
	if (card.context) parts.push(contextBar(card.context, lit));
	parts.push(cue);

	return svg(parts.join(""));
}

/** States that need a glyph so they don't rely on colour alone. Working spins; paused says so in words. */
const hasGlyph = (state: CardState | "background"): state is "input" | "failed" | "done" => state === "input" || state === "failed" || state === "done";

/** "!" needs you, "✕" failed, "✓" done: a filled disc with the mark cut out of it. */
function stateGlyph(state: "input" | "failed" | "done", cx: number, cy: number, r: number, lit: boolean, accent: string): string {
	const disc = lit ? INK : accent;
	const ink = lit ? accent : BG;
	const s = r / 10;
	const p = (dx: number, dy: number): string => `${(cx + dx * s).toFixed(1)} ${(cy + dy * s).toFixed(1)}`;
	const stroke = `stroke="${ink}" stroke-width="${(3 * s).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
	let mark: string;
	if (state === "input") mark = `<path d="M${p(0, -5.5)}L${p(0, 1)}" ${stroke}/><circle cx="${cx}" cy="${(cy + 5.2 * s).toFixed(1)}" r="${(1.9 * s).toFixed(1)}" fill="${ink}"/>`;
	else if (state === "failed") mark = `<path d="M${p(-4, -4)}L${p(4, 4)}M${p(4, -4)}L${p(-4, 4)}" ${stroke}/>`;
	else mark = `<path d="M${p(-4.5, 0.5)}L${p(-1.3, 3.8)}L${p(4.8, -3.6)}" ${stroke}/>`;
	return `<g id="glyph-${state}"><circle cx="${cx}" cy="${cy}" r="${r}" fill="${disc}"/>${mark}</g>`;
}

/** Paused by a usage limit: dimmed, dashed border, when it resumes. */
function renderPaused(card: ThreadCard, now: number, showLabel?: boolean): string {
	const parts: string[] = [
		`<rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>`,
		`<rect x="3" y="3" width="138" height="138" rx="20" fill="none" stroke="${DIM}" stroke-width="2" stroke-dasharray="5 6"/>`,
	];
	if (showLabel) parts.push(text(12, 27, "PAUSED", { size: 14, weight: 700, fill: DIM, spacing: 0.6 }));
	const lines = wrapWidths(card.title, showLabel ? [12, 12] : [12, 12, 12]);
	lines.forEach((line, i) => parts.push(text(12, (showLabel ? 54 : 32) + i * 23, line, { size: 18, weight: 650, fill: DIM })));
	const resumes = card.pausedUntil ? `back in ${formatDuration(Math.max(0, card.pausedUntil - now))}` : "back soon";
	parts.push(`<rect x="10" y="86" width="124" height="50" rx="10" fill="#2A2416"/>`);
	parts.push(text(20, 106, "USAGE LIMIT", { size: 14, weight: 800, fill: PALETTE.input.accent, spacing: 0.4 }));
	parts.push(text(20, 127, fit(resumes, 106, 15), { size: 15, weight: 700, fill: WHITE }));
	return svg(parts.join(""));
}

function spinner(color: string, now: number): string {
	const step = Math.floor(((now % SPIN_PERIOD_MS) / SPIN_PERIOD_MS) * SPIN_FRAMES);
	const angle = (step * 360) / SPIN_FRAMES;
	const { cx, cy, r } = SPIN;
	return (
		`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="3" opacity="0.22"/>` +
		`<path d="M${cx} ${cy - r} A${r} ${r} 0 0 1 ${cx + r} ${cy}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" transform="rotate(${angle} ${cx} ${cy})"/>`
	);
}

function waitingChip(label: string, lit: boolean): string {
	const shown = fit(label, 124 - 36, 14);
	const width = Math.min(124, 36 + pxWidth(shown, 14));
	const ink = lit ? INK : WHITE;
	return (
		`<rect x="10" y="113" width="${width.toFixed(1)}" height="22" rx="11" fill="${lit ? "rgba(0,0,0,0.14)" : "#1E232B"}"/>` +
		`<circle cx="21" cy="124" r="4" fill="none" stroke="${ink}" stroke-width="2"/>` +
		`<path d="M21 121.5v2.7l1.8 1.1" stroke="${ink}" stroke-width="1.4" fill="none" stroke-linecap="round"/>` +
		text(30, 129, shown, { size: 14, weight: 650, fill: ink })
	);
}

export const contextPercent = (c: { used: number; max: number }): number => Math.min(100, Math.round((100 * c.used) / c.max));
const contextColor = (c: { used: number; max: number }): string => {
	const pct = contextPercent(c);
	return pct >= 85 ? "#FF242F" : pct >= 70 ? "#F5A524" : DIM;
};

/** Thin bar along the bottom edge: how full the context window is. */
function contextBar(c: { used: number; max: number }, lit: boolean): string {
	const width = (120 * contextPercent(c)) / 100;
	const pct = contextPercent(c);
	const fill = lit ? INK : pct >= 70 ? contextColor(c) : "#C9CED6";
	return (
		`<rect x="12" y="138" width="120" height="4" rx="2" fill="${lit ? "rgba(0,0,0,0.3)" : TRACK}"/>` +
		(width > 0 ? `<rect x="12" y="138" width="${width.toFixed(1)}" height="4" rx="2" fill="${fill}"/>` : "")
	);
}

export interface OverviewInput {
	connection: Connection;
	/** `background`: working threads that are only waiting on background work (also counted in `working`). */
	counts: { input: number; failed: number; done: number; working: number; background: number; idle: number };
	overflow: number;
	animation: AnimationMode;
	now: number;
	/** Being held: show "Hold to clear all" with this much progress (0–1). */
	hold?: number;
	/** "glance": one big count of the most urgent state. */
	style?: KeyStyle;
}

export type OverviewState = "failed" | "input" | "done" | "working" | "background" | "idle";

/**
 * Overview tile, by priority: any failure blinks red, then anything needing
 * you blinks amber, then any done thread makes it solid green, then a blue
 * orbit while agents work, a white orbit while only background work runs.
 */
export function overviewState(counts: OverviewInput["counts"]): OverviewState {
	if (counts.failed) return "failed";
	if (counts.input) return "input";
	if (counts.done) return "done";
	if (counts.working > counts.background) return "working";
	if (counts.background) return "background";
	return "idle";
}

export function isOverviewAnimated(state: OverviewState, animation: AnimationMode): boolean {
	return animation !== "off" && state !== "done" && state !== "idle";
}

/** When the Overview tile next changes on its own (blink edge or spinner step). */
export function nextOverviewFrame(state: OverviewState, animation: AnimationMode, now: number): number | undefined {
	if (!isOverviewAnimated(state, animation)) return undefined;
	if (state === "failed" || state === "input") return nextFlashEdge(state, now);
	return nextBoundary(now, SPIN_STEP_MS);
}

const MAX_COUNT = 999;

export function renderOverview(input: OverviewInput): string {
	const { connection, counts, now, animation } = input;
	if (input.hold !== undefined) return renderHoldCue(["Hold to", "clear all"], input.hold, "T3 CODE");
	// Offline and signed out aren't errors: grey, not red.
	if (connection.kind !== "ok") return renderMessage(connectionText(connection), connection.kind === "error" && connection.reason !== "signed-out" ? "#FF242F" : SOFT, "T3 CODE");

	const state = overviewState(counts);
	const accent = state === "background" ? BACKGROUND_ORBIT : PALETTE[state].accent;
	// Done is a steady solid tile; failed and needs-you blink.
	const lit = state === "done" || (animation !== "off" && (state === "failed" || state === "input") && flashLit(state, now));
	const steady = animation === "off" && (state === "failed" || state === "input");
	const bg = lit ? accent : steady ? mix(accent, BG, 0.72) : BG;
	const fg = lit ? INK : WHITE;
	if (input.style === "glance") return renderOverviewGlance(state, counts, lit, bg, accent);

	const parts: string[] = [`<rect width="${SIZE}" height="${SIZE}" fill="${bg}"/>`];
	if (state === "working" || state === "background") parts.push(spinner(accent, animation === "off" ? 0 : now));
	else if ((state === "failed" || state === "input") && !lit) {
		parts.push(`<rect x="3" y="3" width="138" height="138" rx="20" fill="none" stroke="${accent}" stroke-width="3" opacity="0.9"/>`);
	}
	const glyph = hasGlyph(state);
	if (glyph) parts.push(stateGlyph(state, 21, 23, 10, lit, accent));
	parts.push(text(glyph ? 37 : 12, 28, "T3 CODE", { size: 14, weight: 800, fill: lit ? INK : DIM, spacing: 1.2 }));

	const rows: [string, number, string][] = [
		["need you", counts.input + counts.failed, counts.failed ? PALETTE.failed.accent : PALETTE.input.accent],
		["working", counts.working, counts.working > counts.background ? PALETTE.working.accent : BACKGROUND_ORBIT],
		["done", counts.done, PALETTE.done.accent],
	];
	// Numbers right-align in a column as wide as the longest count, so 2–3 digits never run into the labels.
	const shown = rows.map(([, n]) => String(Math.min(MAX_COUNT, n)));
	const column = 12 + Math.max(2, ...shown.map((s) => s.length)) * 14.5;
	rows.forEach(([name, n, color], i) => {
		const y = 62 + i * 28;
		const c = lit ? INK : n > 0 ? color : QUIET;
		parts.push(text(column, y, shown[i]!, { size: 24, weight: 750, fill: c, anchor: "end" }));
		parts.push(text(column + 7, y - 2, fit(name, 132 - column - 7, 15), { size: 15, weight: 600, fill: lit ? INK : n > 0 ? fg : QUIET }));
	});
	if (input.overflow > 0) {
		parts.push(text(130, 132, `+${input.overflow}`, { size: 14, weight: 700, fill: lit ? INK : DIM, anchor: "end" }));
	}
	return svg(parts.join(""));
}

/** The blink's dark phase keeps a coloured ring round the key, as in the detailed look. */
const blinkRing = (accent: string): string => `<rect x="3" y="3" width="138" height="138" rx="20" fill="none" stroke="${accent}" stroke-width="3" opacity="0.9"/>`;

/**
 * The glance title: 26 px, left-aligned, centred top to bottom. Too long for
 * four lines: the last is cut with "…". A single word too long for a line is
 * cut the same way rather than split across lines.
 */
const GLANCE_TITLE = { size: 26, lineHeight: 31, room: 116, lines: 4 };

function glanceTitle(title: string, fill: string): string {
	const { size, lineHeight, room, lines: max } = GLANCE_TITLE;
	const units = room / (size * EM);
	const words = sanitize(title)
		.split(/\s+/)
		.filter(Boolean)
		.map((w) => (textWidth(w) > units ? truncate(w, units) : w))
		.join(" ");
	const lines = wrapWidths(words, Array.from({ length: max }, () => units)).filter(Boolean);
	const top = 72 + size * 0.36 - ((lines.length - 1) * lineHeight) / 2;
	return lines.map((line, i) => text(14, Math.round(top + i * lineHeight), line, { size, weight: 750, fill })).join("");
}

/** The border orbit: a bright stroke running round the tile's edge, one lap in 2.4 s. */
const ORBIT_PERIOD_MS = 2400;
const ORBIT_FRAMES = 16;
export const ORBIT_STEP_MS = ORBIT_PERIOD_MS / ORBIT_FRAMES;
const ORBIT_PATH = { x: 4, y: 4, w: 136, h: 136, r: 20 };
const ORBIT_LENGTH = 2 * (ORBIT_PATH.w + ORBIT_PATH.h - 4 * ORBIT_PATH.r) + 2 * Math.PI * ORBIT_PATH.r;

function orbit(color: string, now: number): string {
	const frame = Math.floor(((now % ORBIT_PERIOD_MS) / ORBIT_PERIOD_MS) * ORBIT_FRAMES);
	const offset = -(frame / ORBIT_FRAMES) * ORBIT_LENGTH;
	const { x, y, w, h, r } = ORBIT_PATH;
	const rect = `x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="none"`;
	const comet = 70;
	return (
		`<g id="orbit"><rect ${rect} stroke="${color}" stroke-width="2" opacity="0.22"/>` +
		`<rect ${rect} stroke="${color}" stroke-width="4" stroke-linecap="round" opacity="0.35" ` +
		`stroke-dasharray="${comet + 30} ${(ORBIT_LENGTH - comet - 30).toFixed(1)}" stroke-dashoffset="${(offset + 30).toFixed(1)}"/>` +
		`<rect ${rect} stroke="${color}" stroke-width="4" stroke-linecap="round" ` +
		`stroke-dasharray="${comet} ${(ORBIT_LENGTH - comet).toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"/></g>`
	);
}

/**
 * Thread key, glance style: only the title, in big type. Colour and motion
 * carry the state: amber blinks (needs you), red blinks (failed), solid
 * green (done), a blue stroke orbiting the border (working), a white one
 * (only background work left). No icons, numbers, project or context bar.
 */
function renderThreadGlance(card: ThreadCard, lit: boolean, steady: boolean, animation: AnimationMode, now: number): string {
	const state = card.state;
	const { accent } = PALETTE[state];
	const bg = lit ? accent : steady ? mix(accent, BG, 0.72) : BG;
	const parts: string[] = [`<rect width="${SIZE}" height="${SIZE}" fill="${bg}"/>`];
	if (spins(card)) {
		const color = lit ? INK : state !== "working" ? accent : isBackgroundOnly(card) ? BACKGROUND_ORBIT : PALETTE.working.accent;
		parts.push(orbit(color, animation === "off" ? 0 : now));
	} else if ((state === "input" || state === "failed") && !lit) parts.push(blinkRing(accent));
	parts.push(glanceTitle(card.title, lit ? INK : state === "idle" ? SOFT : WHITE));
	return svg(parts.join(""));
}

/** Paused by a usage limit, glance style: the dashed border and the title, dimmed. */
function renderPausedGlance(card: ThreadCard): string {
	return svg(
		`<rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>` +
			`<rect x="3" y="3" width="138" height="138" rx="20" fill="none" stroke="${DIM}" stroke-width="2" stroke-dasharray="5 6"/>` +
			glanceTitle(card.title, DIM),
	);
}

/** Overview glance: the label and colour of each state it can lead with (waiting = only background work left). */
const OVERVIEW_HEADS = {
	failed: { label: "FAILED", color: PALETTE.failed.accent },
	input: { label: "NEED YOU", color: PALETTE.input.accent },
	done: { label: "DONE", color: PALETTE.done.accent },
	working: { label: "WORKING", color: PALETTE.working.accent },
	background: { label: "WAITING", color: BACKGROUND_ORBIT },
} as const;

/**
 * Overview, glance style: how many threads are in the most urgent state, as
 * one big number, then "/" and how many threads there are in all, smaller and
 * fainter, on the same baseline ("1/2": one of two is done). "T3 THREADS" on
 * top, like the Machine and Updates keys; what the number counts at the bottom. What the big number counts sits on top in small type.
 * Colour and blinking carry the state (red blinks: failed; amber blinks:
 * needs you; solid green: done; blue: working; white: waiting). No spinner.
 */
function renderOverviewGlance(state: OverviewState, counts: OverviewInput["counts"], lit: boolean, bg: string, accent: string): string {
	const parts: string[] = [`<rect width="${SIZE}" height="${SIZE}" fill="${bg}"/>`];
	if ((state === "failed" || state === "input") && !lit) parts.push(blinkRing(accent));
	const counted = {
		failed: counts.failed,
		input: counts.input,
		done: counts.done,
		working: Math.max(0, counts.working - counts.background),
		background: counts.background,
		idle: counts.idle,
	};
	const total = counts.input + counts.failed + counts.done + counts.working + counts.idle;
	const head = state === "idle" ? undefined : OVERVIEW_HEADS[state];
	const n = counted[state];
	const ink = lit ? INK : head ? head.color : QUIET;
	// Titled like the Machine and Updates keys; what the big number counts sits at the bottom.
	parts.push(text(72, 22, "T3 THREADS", { size: 14, weight: 800, fill: lit ? INK : DIM, anchor: "middle", spacing: 0.3 }));
	parts.push(text(72, 132, head ? head.label : "IDLE", { size: 14, weight: 800, fill: lit ? INK : head ? head.color : DIM, anchor: "middle", spacing: 1 }));

	const big = String(Math.min(MAX_COUNT, n));
	const bigSize = big.length >= 3 ? 50 : 66;
	const rest = total > n ? `/${Math.min(MAX_COUNT, total)}` : "";
	const restSize = 30;
	if (!rest) {
		parts.push(text(72, 96, big, { size: bigSize, weight: 800, fill: ink, anchor: "middle" }));
		return svg(parts.join(""));
	}
	// The count ends and "/N" starts at one point, whatever font draws them, so the
	// gap between them never depends on a width estimate; only the centring does.
	// Digits share one width in these fonts, so a final "1" leaves empty space on its right: tuck "/N" into it.
	const tuck = big.endsWith("1") ? Math.round(bigSize * 0.13) : 0;
	const bigWidth = pxWidth(big, bigSize) * 1.04 - tuck;
	const restWidth = pxWidth(rest, restSize) * 1.04;
	// A small gap between the count and "/N".
	const gap = 4;
	const join = Math.round(72 - (bigWidth + gap + restWidth) / 2 + bigWidth);
	parts.push(text(join + tuck, 96, big, { size: bigSize, weight: 800, fill: ink, anchor: "end" }));
	parts.push(text(join + gap, 96, rest, { size: restSize, weight: 700, fill: lit ? LIT_DIM : QUIET }));
	return svg(parts.join(""));
}

/** Working only because of background work (subagents, commands, monitors, PR CI). */
export function isBackgroundOnly(card: ThreadCard): boolean {
	return card.state === "working" && !ACTIVE_OWN.has(card.ownStatus) && card.subagentsWorking === 0 && card.background > 0;
}

function renderEmpty(): string {
	return svg(
		`<rect width="${SIZE}" height="${SIZE}" fill="#0B0C0E"/>` +
			`<rect x="10" y="10" width="124" height="124" rx="18" fill="none" stroke="#1F232A" stroke-width="2" stroke-dasharray="6 6"/>`,
	);
}

function renderMessage(message: string, color: string, heading?: string): string {
	return svg(
		`<rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>` +
			(heading ? text(12, 28, heading, { size: 14, weight: 800, fill: DIM, spacing: 1.2 }) : "") +
			wrap(message, 12, 2)
				.map((line, i) => text(72, 78 + i * 22, line, { size: 17, weight: 650, fill: color, anchor: "middle" }))
				.join(""),
	);
}

/** A key being held towards a hold action: what it will do, and how far along. */
function renderHoldCue(lines: string[], progress: number, heading?: string): string {
	const p = Math.max(0, Math.min(1, progress));
	return svg(
		`<rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>` +
			(heading ? text(12, 28, heading, { size: 14, weight: 800, fill: DIM, spacing: 1.2 }) : "") +
			lines.map((line, i) => text(72, 68 + i * 22, line, { size: 18, weight: 750, fill: WHITE, anchor: "middle" })).join("") +
			`<rect x="12" y="108" width="120" height="10" rx="5" fill="${TRACK}"/>` +
			(p > 0 ? `<rect x="12" y="108" width="${(120 * p).toFixed(1)}" height="10" rx="5" fill="${WHITE}"/>` : ""),
	);
}

/** Drawn over a Thread tile held past the long-press threshold. */
function releaseCue(kind: "open" | "clear"): string {
	return (
		`<g id="release-cue"><rect x="0" y="92" width="144" height="52" fill="${WHITE}"/>` +
		text(72, 114, "Release", { size: 17, weight: 800, fill: INK, anchor: "middle" }) +
		text(72, 135, kind === "open" ? "for actions" : "to clear", { size: 16, weight: 700, fill: INK, anchor: "middle" }) +
		`</g>`
	);
}

/** Hold progress on a hold-to-confirm key: a rising wash and a solid bar along the bottom. */
function holdFill(progress: number | undefined): string {
	if (progress === undefined) return "";
	const p = Math.max(0, Math.min(1, progress));
	const h = SIZE * p;
	return (
		`<g id="hold-progress"><rect x="0" y="${(SIZE - h).toFixed(1)}" width="${SIZE}" height="${h.toFixed(1)}" fill="#FFFFFF" opacity="0.22"/>` +
		`<rect x="0" y="137" width="${(SIZE * p).toFixed(1)}" height="7" fill="#FFFFFF"/></g>`
	);
}

function agentBadge(x: number, y: number, width: number, count: number, fill: string, ink: string): string {
	// Tiny "branch" glyph: one node forking into two.
	const gx = x + 9;
	const gy = y + 9;
	return (
		`<rect x="${x}" y="${y}" width="${width}" height="20" rx="10" fill="${fill}"/>` +
		`<path d="M${gx - 3} ${gy - 5} V${gy + 5} M${gx - 3} ${gy} Q${gx + 4} ${gy} ${gx + 4} ${gy - 5}" stroke="${ink}" stroke-width="2" fill="none" stroke-linecap="round"/>` +
		`<circle cx="${gx + 4}" cy="${gy - 5}" r="2" fill="${ink}"/>` +
		text(x + 18, y + 15, String(count), { size: 14, weight: 800, fill: ink })
	);
}

interface TextOptions {
	size: number;
	weight: number;
	fill: string;
	anchor?: "start" | "middle" | "end";
	spacing?: number;
}

function text(x: number, y: number, content: string, o: TextOptions): string {
	const size = Math.max(MIN_FONT_PX, o.size);
	return (
		`<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${o.weight}" fill="${o.fill}"` +
		(o.anchor ? ` text-anchor="${o.anchor}"` : "") +
		(o.spacing ? ` letter-spacing="${o.spacing}"` : "") +
		`>${escapeXml(sanitize(content))}</text>`
	);
}

function svg(body: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${body}</svg>`;
}

/** Adds markup on top of a finished key. */
function overlay(markup: string, extra: string): string {
	return extra ? markup.replace(/<\/svg>$/, `${extra}</svg>`) : markup;
}

export function toDataUrl(markup: string): string {
	return `data:image/svg+xml;base64,${Buffer.from(markup, "utf8").toString("base64")}`;
}

// ---------- Text measurement ----------

/** C0 controls except tab/newline/CR, DEL and the C1 controls (U+007F–U+009F), and the U+FFFE/U+FFFF non-characters. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]/g;

/** Removes control characters that would corrupt the SVG or render as boxes. */
export const sanitize = (s: string): string => s.replace(CONTROL, "");

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** User-perceived characters: never splits a surrogate pair, an emoji sequence or a combining mark. */
const graphemes = (s: string): string[] => Array.from(segmenter.segment(s), (g) => g.segment);

const NARROW = new Set([..."ijlI.,'|!:;`·"]);
const SEMI = new Set([..."frt()[]{}/-\""]);
const WIDE = new Set([..."MWmw@%&—"]);
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

function isFullWidth(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
	);
}

/**
 * Rough advance width of one character, in "average lowercase letters"
 * (about 0.56 em). Close enough to keep text inside the key without a font.
 */
export function charWidth(g: string): number {
	if (g === " ") return 0.5;
	if (NARROW.has(g)) return 0.5;
	if (SEMI.has(g)) return 0.7;
	if (WIDE.has(g)) return 1.6;
	const cp = g.codePointAt(0) ?? 0;
	if (isFullWidth(cp)) return 2;
	if (cp >= 0x2300 && PICTOGRAPHIC.test(g)) return 2;
	if (g >= "A" && g <= "Z") return 1.25;
	return 1;
}

export const textWidth = (s: string): number => graphemes(s).reduce((w, g) => w + charWidth(g), 0);

const EM = 0.56;
const pxWidth = (s: string, size: number): number => textWidth(s) * size * EM;
/** Truncates to fit `px` pixels at `size`. `spacing` is extra letter-spacing per character. */
function fit(s: string, px: number, size: number, spacing = 0): string {
	return truncate(s, px / (size * EM + spacing * 0.8));
}

/** Splits off the longest head that fits `room`; always takes at least one character. */
function splitAt(word: string, room: number): [string, string] {
	const gs = graphemes(word);
	let w = 0;
	let i = 0;
	while (i < gs.length && w + charWidth(gs[i]!) <= room) w += charWidth(gs[i++]!);
	if (i === 0) i = 1;
	// Prefer breaking after a hyphen, slash or underscore that fits ("double-" + "check")
	// over cutting at an arbitrary letter ("double-chec" + "k").
	if (i < gs.length) {
		for (let j = i - 1; j >= 2; j--) {
			if (gs[j] === "-" || gs[j] === "/" || gs[j] === "_") {
				i = j + 1;
				break;
			}
		}
	}
	return [gs.slice(0, i).join(""), gs.slice(i).join("")];
}

/** Word-wraps with a width per line (the last width repeats); one line per entry, the last ellipsized. */
export function wrapWidths(input: string, widths: number[]): string[] {
	const narrow = Math.min(...widths);
	const lines = wrap(input, Math.max(...widths), widths.length + 2, (i) => widths[Math.min(i, widths.length - 1)] ?? narrow);
	if (lines.length <= widths.length) return lines;
	const kept = lines.slice(0, widths.length);
	const last = widths.length - 1;
	kept[last] = truncate(`${kept[last]} ${lines[widths.length]}`, widths[last]!);
	return kept;
}

const SPACE = charWidth(" ");

/**
 * Word-wraps to `maxLines` lines of about `width` average characters,
 * ellipsizing the rest. Widths are weighted per character (wide capitals,
 * CJK and emoji count double, i/l/punctuation half).
 */
export function wrap(input: string, width: number, maxLines: number, widthOf: (line: number) => number = () => width): string[] {
	const words = sanitize(input).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
	const lines: string[] = [];
	let current = "";
	let used = 0;
	const room = (): number => widthOf(lines.length);
	const breakLine = (): void => {
		lines.push(current);
		current = "";
		used = 0;
	};
	for (const word of words) {
		let rest = word;
		let w = textWidth(rest);
		// A short first line (glyph, spinner) that can't take the word: start on the next, wider line.
		if (!current && w > room() && lines.length === 0 && w <= widthOf(1) && room() < widthOf(1)) breakLine();
		while (w > room()) {
			// A word that fits on the next line moves there whole; only a word longer
			// than an empty line is split.
			if (current && w <= widthOf(lines.length + 1)) {
				breakLine();
				continue;
			}
			// Hard-split words longer than a line.
			const space = current ? room() - used - SPACE : room();
			if (current && space < 3) {
				breakLine();
				continue;
			}
			const [head, tail] = splitAt(rest, space);
			lines.push(current ? `${current} ${head}` : head);
			current = "";
			used = 0;
			rest = tail;
			w = textWidth(rest);
		}
		if (!rest) continue;
		if (!current) {
			current = rest;
			used = w;
		} else if (used + SPACE + w <= room()) {
			current += ` ${rest}`;
			used += SPACE + w;
		} else {
			breakLine();
			current = rest;
			used = w;
		}
	}
	if (current) lines.push(current);
	if (lines.length <= maxLines) return lines;
	const kept = lines.slice(0, maxLines);
	kept[maxLines - 1] = truncate(`${kept[maxLines - 1]} ${lines[maxLines]}`, widthOf(maxLines - 1));
	return kept;
}

/** Shortens to `max` average characters (weighted), ending in "…". Never splits a character. */
export function truncate(input: string, max: number): string {
	const s = sanitize(input);
	if (textWidth(s) <= max) return s;
	const gs = graphemes(s);
	let out = "";
	let w = 0;
	for (const g of gs) {
		const cw = charWidth(g);
		if (w + cw > max - 1) break;
		out += g;
		w += cw;
	}
	return `${(out || gs[0] || "").trimEnd()}…`;
}

function escapeXml(s: string): string {
	return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

function mix(a: string, b: string, t: number): string {
	const pa = hex(a);
	const pb = hex(b);
	const c = pa.map((v, i) => Math.round(v * (1 - t) + pb[i]! * t));
	return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

const hex = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// ---------- Usage ----------

export interface UsageKeyInput {
	metric: UsageMetric | undefined;
	pace: Pace | undefined;
	/** False while T3 is unreachable or the request failed. */
	ok: boolean;
	loading: boolean;
	/** "bar" (default): bar, pace text, reset time. "ring": segmented ring, % in the middle. */
	style?: "bar" | "ring";
}

const PACE_COLOR = { ahead: "#F5A524", over: "#FF242F", on: "#297EFF", under: "#00E069", unknown: DIM };
const STALE = QUIET;
const STALE_FILL = DIM;

/**
 * Usage tile: label, big used %, a bar with a tick at even pace (the share of
 * the window elapsed), how far ahead or under pace you are, and time to reset.
 */
export function renderUsageKey(input: UsageKeyInput): string {
	const { metric, pace } = input;
	if (!metric || !pace) {
		const message = input.loading ? "Loading…" : input.ok ? "No usage data" : "T3 offline";
		return renderMessage(message, SOFT, "USAGE");
	}
	if (input.style === "ring") return renderUsageRing(metric, pace, !input.ok);
	const used = Math.round(pace.used);
	const severity = used >= 90 ? PACE_COLOR.over : used >= 75 ? PACE_COLOR.ahead : WHITE;
	const fill = used >= 90 ? PACE_COLOR.over : pace.state === "ahead" ? PACE_COLOR.ahead : pace.state === "under" ? PACE_COLOR.under : PACE_COLOR.on;
	const stale = !input.ok;

	const parts: string[] = [`<rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>`];
	const title = metric.provider === "Claude" ? metric.label : `${metric.provider} ${metric.label}`;
	// The width estimate runs ~7% wide for bold capitals, so this still ends inside the key.
	parts.push(text(12, 26, fit(title.toUpperCase(), 128, 14, 0.3), { size: 14, weight: 800, fill: DIM, spacing: 0.3 }));

	parts.push(text(12, 68, `${used}`, { size: 40, weight: 800, fill: stale ? STALE : severity }));
	parts.push(text(12 + String(used).length * 23 + 2, 68, "%", { size: 20, weight: 700, fill: stale ? STALE : severity }));

	// Bar with the even-pace tick.
	const x0 = 12;
	const width = 120;
	const y = 80;
	parts.push(`<rect x="${x0}" y="${y}" width="${width}" height="10" rx="5" fill="${TRACK}"/>`);
	const fillWidth = Math.max(used > 0 ? 4 : 0, (width * Math.min(100, pace.used)) / 100);
	if (fillWidth > 0) parts.push(`<rect x="${x0}" y="${y}" width="${fillWidth.toFixed(1)}" height="10" rx="5" fill="${stale ? STALE_FILL : fill}"/>`);
	if (pace.elapsed !== null) {
		const mx = x0 + (width * pace.elapsed) / 100;
		parts.push(`<rect x="${(mx - 1.5).toFixed(1)}" y="${y - 5}" width="3" height="20" rx="1.5" fill="${WHITE}"/>`);
	}

	// Pace line. Stale numbers can't say much about pace, so it says "stale" instead.
	let paceText: string;
	let paceColor: string;
	if (stale) {
		paceText = "stale";
		paceColor = SOFT;
	} else if (pace.delta === null) {
		paceText = "pace unknown";
		paceColor = PACE_COLOR.unknown;
	} else {
		const points = Math.round(Math.abs(pace.delta));
		if (pace.state === "ahead") {
			paceText = `▲ ${points}% ahead`;
			paceColor = pace.delta > 15 ? PACE_COLOR.over : PACE_COLOR.ahead;
		} else if (pace.state === "under") {
			paceText = `▼ ${points}% under`;
			paceColor = PACE_COLOR.under;
		} else {
			paceText = "● on pace";
			paceColor = PACE_COLOR.on;
		}
	}
	parts.push(text(12, 113, paceText, { size: 15, weight: 700, fill: paceColor }));
	if (pace.resetsInMs !== null) parts.push(text(12, 133, fit(`resets in ${formatDuration(pace.resetsInMs)}`, 120, 14), { size: 14, weight: 550, fill: DIM }));
	return svg(parts.join(""));
}

// ---------- Updates ----------

/**
 * Updates key: "Up to date" with the versions in use, or how many updates
 * are waiting and for what. Names T3 Code first, then provider CLIs.
 */
export function renderUpdatesKey(s: UpdatesSnapshot, style: KeyStyle = "detailed"): string {
	if (!s.t3 && s.providers.length === 0) {
		const message = s.fetchedAt === 0 && !s.ok && s.detail === "Loading…" ? "Loading…" : s.ok ? "No update info" : "T3 offline";
		return renderMessage(message, SOFT, "UPDATES");
	}
	const stale = !s.ok;
	const pending = pendingUpdates(s);
	if (style === "glance") return renderUpdatesGlance(pending.length, stale);
	const parts = [`<rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>`];
	parts.push(text(12, 26, stale ? "UPDATES · STALE" : "UPDATES", { size: 14, weight: 800, fill: DIM, spacing: 0.3 }));
	let lines: { text: string; fill: string }[];
	if (pending.length === 0) {
		parts.push(text(12, 64, "✓ Up to date", { size: 20, weight: 800, fill: stale ? STALE : PACE_COLOR.under }));
		lines = [...(s.t3 ? [s.t3] : []), ...s.providers].map((u) => ({ text: `${shortName(u.name)} ${displayVersion(u.current)}`, fill: DIM }));
	} else {
		const ink = stale ? STALE : PACE_COLOR.ahead;
		const n = String(pending.length);
		parts.push(text(12, 68, n, { size: 40, weight: 800, fill: ink }));
		parts.push(text(12 + n.length * 23 + 6, 68, pending.length === 1 ? "update" : "updates", { size: 16, weight: 700, fill: ink }));
		lines = pending.map((u) => ({ text: `${shortName(u.name)} ${displayVersion(u.latest)}`, fill: stale ? STALE : WHITE }));
	}
	const room = 3;
	const shown = lines.length > room ? [...lines.slice(0, room - 1), { text: `+${lines.length - room + 1} more`, fill: DIM }] : lines;
	shown.forEach((l, i) => parts.push(text(12, 98 + i * 19, fit(l.text, 120, 14), { size: 14, weight: 650, fill: l.fill })));
	return svg(parts.join(""));
}

/** "T3 Code" → "T3": room for a nightly version on one line. */
const shortName = (name: string): string => (name === "T3 Code" ? "T3" : name);

// ---------- Machine ----------

export interface MachineKeyInput {
	stat: MachineStat;
	/** Undefined until the first sample. */
	sample: MachineSnapshot | undefined;
	/** Normalised disk path this key shows (summary and disk). */
	path: string;
	/** "detailed" (default): numbers and detail lines. "glance": one big number and a ring, readable from across your desk. */
	style?: KeyStyle;
}

/** Green headroom, amber tight, red act now: the same colours as usage pace. */
const LEVEL_COLOR: Record<Level, string> = { ok: PACE_COLOR.under, busy: PACE_COLOR.ahead, high: PACE_COLOR.over };
const levelInk = (level: Level): string => (level === "ok" ? WHITE : LEVEL_COLOR[level]);
const CPU_TEXT: Record<Level, string> = { ok: "● headroom", busy: "▲ busy", high: "■ maxed out" };
/** Shorter, to fit after "P-cores". */
const P_TEXT: Record<Level, string> = { ok: "● P-cores free", busy: "▲ P-cores busy", high: "■ P-cores maxed" };

/**
 * This Mac at a glance. Summary: CPU, memory and disk as three rows with
 * bars. One stat: label, big number, bar, and two lines of detail.
 */
export function renderMachineKey(input: MachineKeyInput): string {
	const { sample, stat, path } = input;
	const heading = stat === "summary" ? "THIS MAC" : stat === "disk" ? diskTitle(path) : stat.toUpperCase();
	if (!sample) return renderMessage("Loading…", SOFT, heading);
	if (input.style === "glance") return renderMachineGlance(stat, sample, path, heading);
	switch (stat) {
		case "cpu":
			return sample.cpu ? renderCpuKey(sample.cpu, sample.load) : renderMessage("Measuring…", SOFT, heading);
		case "memory":
			return sample.memory ? renderMemoryKey(sample.memory) : renderMessage("Can't read memory", SOFT, heading);
		case "disk": {
			const disk = sample.disks.get(path);
			if (!disk) return renderMessage("Loading…", SOFT, heading);
			return "error" in disk ? renderMessage(disk.error, SOFT, heading) : renderDiskKey(disk, path);
		}
		default:
			return renderMachineSummary(sample, path);
	}
}

interface BarPart {
	/** Share of the track this part takes (core count for CPU clusters). */
	weight: number;
	/** 0-1. */
	fill: number;
	color: string;
}

/** A bar split into parts (P cores | E cores), each filled on its own; one part is a plain bar. */
function partsBar(y: number, parts: BarPart[], height = 10): string {
	const x0 = 12;
	const width = 120;
	const gap = parts.length > 1 ? 4 : 0;
	const total = parts.reduce((s, p) => s + p.weight, 0) || 1;
	const usable = width - gap * (parts.length - 1);
	const out: string[] = [];
	let x = x0;
	for (const p of parts) {
		const w = (usable * p.weight) / total;
		const r = Math.min(height / 2, w / 2);
		out.push(`<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${height}" rx="${r.toFixed(1)}" fill="${TRACK}"/>`);
		const f = Math.max(0, Math.min(1, p.fill));
		const fw = f > 0 ? Math.max(Math.min(w, height * 0.4), w * f) : 0;
		if (fw > 0) out.push(`<rect x="${x.toFixed(1)}" y="${y}" width="${fw.toFixed(1)}" height="${height}" rx="${Math.min(r, fw / 2).toFixed(1)}" fill="${p.color}"/>`);
		x += w + gap;
	}
	return out.join("");
}

/** CPU bar: one part per cluster, as wide as its share of the cores. */
const cpuBar = (cpu: CpuStats, y: number, height?: number): string =>
	partsBar(y, cpu.clusters.map((c) => ({ weight: c.cores, fill: c.busy / 100, color: LEVEL_COLOR[cpuLevel(c.busy)] })), height);

/** Title, a big value with an optional unit, a bar, and two detail lines: the Usage key's layout. */
function statTile(o: { title: string; value: string; unit?: string; level: Level; bar: string; line1: string; line1Color: string; line2?: string }): string {
	const ink = levelInk(o.level);
	const size = o.value.length >= 5 ? 34 : 40;
	const parts = [`<rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>`];
	parts.push(text(12, 26, fit(o.title, 128, 14, 0.3), { size: 14, weight: 800, fill: DIM, spacing: 0.3 }));
	parts.push(text(12, 68, o.value, { size, weight: 800, fill: ink }));
	if (o.unit) parts.push(text(12 + o.value.length * 23 + 2, 68, o.unit, { size: 20, weight: 700, fill: ink }));
	parts.push(o.bar);
	parts.push(text(12, 113, fit(o.line1, 120, 15), { size: 15, weight: 700, fill: o.line1Color }));
	if (o.line2) parts.push(text(12, 133, fit(o.line2, 120, 14), { size: 14, weight: 550, fill: DIM }));
	return svg(parts.join(""));
}

/**
 * CPU: the big number is how busy the P cores were (all cores on a Mac
 * without E cores) over the last 30 s; the E cores and the 5-minute load
 * average sit underneath.
 */
function renderCpuKey(cpu: CpuStats, load: readonly number[]): string {
	const main = mainCluster(cpu)!;
	const e = cpu.clusters.find((c) => c.kind === "E");
	const level = cpuLevel(main.busy);
	const busy = Math.round(main.busy);
	return statTile({
		// "M1 MAX · 8P+2E"; a Mac with one kind of core says its count underneath instead.
		title: e ? `${cpu.chip.toUpperCase()} · ${coreLayout(cpu)}` : cpu.chip.toUpperCase(),
		value: String(busy),
		unit: "%",
		level,
		bar: cpuBar(cpu, 80),
		line1: (e ? P_TEXT : CPU_TEXT)[level],
		line1Color: LEVEL_COLOR[level],
		line2: e ? `E ${Math.round(e.busy)}% · load ${formatLoadShort(load[1] ?? 0)}` : `${main.cores} cores · load ${formatLoadShort(load[1] ?? 0)}`,
	});
}

const PRESSURE_TEXT: Record<Level, string> = { ok: "● normal", busy: "▲ pressure", high: "■ critical" };

function renderMemoryKey(m: MemoryStats): string {
	const level = memoryLevel(m);
	const used = Math.round(100 - m.freePercent);
	const swap = m.swapUsedBytes && m.swapUsedBytes >= 1e8 ? `swap ${formatBytes(m.swapUsedBytes)}` : `of ${formatBytes(m.totalBytes)}`;
	return statTile({
		title: "MEMORY",
		value: String(used),
		unit: "%",
		level,
		bar: partsBar(80, [{ weight: 1, fill: used / 100, color: LEVEL_COLOR[level] }]),
		line1: PRESSURE_TEXT[level],
		line1Color: LEVEL_COLOR[level],
		line2: swap,
	});
}

function renderDiskKey(d: DiskStats, path: string): string {
	const level = diskLevel(d);
	const used = Math.round(usedPercent(d));
	return statTile({
		title: diskTitle(path),
		value: String(used),
		unit: "%",
		level,
		bar: partsBar(80, [{ weight: 1, fill: used / 100, color: LEVEL_COLOR[level] }]),
		line1: `${formatBytes(d.freeBytes)} free`,
		line1Color: level === "ok" ? SOFT : LEVEL_COLOR[level],
		line2: `of ${formatBytes(d.totalBytes)}`,
	});
}

/** Three rows: CPU, MEM, DISK, each a label, a value and a thin bar. A row it can't read shows "—". */
function renderMachineSummary(s: MachineSnapshot, path: string): string {
	const rows: { label: string; value: string; level?: Level; bar: (y: number) => string }[] = [];
	const empty = (y: number) => partsBar(y, [{ weight: 1, fill: 0, color: TRACK }], 8);
	const one = (fill: number, level: Level) => (y: number) => partsBar(y, [{ weight: 1, fill, color: LEVEL_COLOR[level] }], 8);
	const main = s.cpu ? mainCluster(s.cpu) : undefined;
	if (s.cpu && main) {
		const cpu = s.cpu;
		rows.push({ label: "CPU", value: `${Math.round(main.busy)}%`, level: cpuLevel(main.busy), bar: (y) => cpuBar(cpu, y, 8) });
	} else rows.push({ label: "CPU", value: "…", bar: empty });
	if (s.memory) {
		const used = Math.round(100 - s.memory.freePercent);
		const level = memoryLevel(s.memory);
		rows.push({ label: "MEM", value: `${used}%`, level, bar: one(used / 100, level) });
	} else rows.push({ label: "MEM", value: "—", bar: empty });
	const disk = s.disks.get(path);
	const diskLabel = diskTitle(path);
	if (disk && !("error" in disk)) {
		const used = Math.round(usedPercent(disk));
		const level = diskLevel(disk);
		rows.push({ label: diskLabel, value: `${used}%`, level, bar: one(used / 100, level) });
	} else rows.push({ label: diskLabel, value: "—", bar: empty });

	const parts = [`<rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>`];
	rows.forEach((r, i) => {
		const y = 30 + i * 44;
		const ink = r.level ? levelInk(r.level) : QUIET;
		parts.push(text(12, y, fit(r.label, 64, 14, 0.3), { size: 14, weight: 800, fill: DIM, spacing: 0.3 }));
		parts.push(text(132, y, r.value, { size: 18, weight: 800, fill: ink, anchor: "end" }));
		parts.push(r.bar(y + 9));
	});
	return svg(parts.join(""));
}

// ---------- Glance style ----------

/** Machine and Updates keys: "detailed" packs in numbers and lines of detail; "glance" shows one big reading. */
export type KeyStyle = "detailed" | "glance";

/** A ring split into parts (P | E cores), the Usage ring's size, clockwise from the top; each part as long as its weight and filled on its own. */
function partsRing(parts: BarPart[]): string {
	const gap = parts.length > 1 ? RING.gapDeg : 0;
	const total = parts.reduce((n, p) => n + p.weight, 0) || 1;
	const out: string[] = [];
	let start = gap / 2;
	for (const p of parts) {
		const span = (360 * p.weight) / total - gap;
		out.push(arc(start, start + span, TRACK));
		const f = Math.max(0, Math.min(1, p.fill));
		if (f > 0) out.push(arc(start, start + Math.max(span * f, 3), p.color));
		start += span + gap;
	}
	return out.join("");
}

/** Laid out like the Usage key's ring: the title on top, the number in the middle with a small "%". */
function glanceTile(value: string, title: string, ink: string, ring: string): string {
	const digits = value.length;
	const size = digits >= 3 ? 26 : 32;
	return svg(
		`<rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>` +
			text(72, 22, fit(title, 132, 14, 0.3), { size: 14, weight: 800, fill: DIM, anchor: "middle", spacing: 0.3 }) +
			ring +
			text(RING.cx - 4, RING.cy + size * 0.36, value, { size, weight: 800, fill: ink, anchor: "middle" }) +
			text(RING.cx - 4 + digits * size * 0.29 + 2, RING.cy + size * 0.36, "%", { size: 15, weight: 700, fill: DIM }),
	);
}

function renderMachineGlance(stat: MachineStat, s: MachineSnapshot, path: string, heading: string): string {
	switch (stat) {
		case "cpu": {
			if (!s.cpu) return renderMessage("Measuring…", SOFT, heading);
			const main = mainCluster(s.cpu)!;
			const level = cpuLevel(main.busy);
			const parts = s.cpu.clusters.map((c) => ({ weight: c.cores, fill: c.busy / 100, color: LEVEL_COLOR[cpuLevel(c.busy)] }));
			return glanceTile(String(Math.round(main.busy)), s.cpu.clusters.length > 1 ? "P-CORES" : "CPU", levelInk(level), partsRing(parts));
		}
		case "memory": {
			if (!s.memory) return renderMessage("Can't read memory", SOFT, heading);
			const level = memoryLevel(s.memory);
			const used = Math.round(100 - s.memory.freePercent);
			return glanceTile(String(used), "MEMORY", levelInk(level), partsRing([{ weight: 1, fill: used / 100, color: LEVEL_COLOR[level] }]));
		}
		case "disk": {
			const disk = s.disks.get(path);
			if (!disk) return renderMessage("Loading…", SOFT, heading);
			if ("error" in disk) return renderMessage(disk.error, SOFT, heading);
			const level = diskLevel(disk);
			const used = Math.round(usedPercent(disk));
			return glanceTile(String(used), diskTitle(path), levelInk(level), partsRing([{ weight: 1, fill: used / 100, color: LEVEL_COLOR[level] }]));
		}
		default:
			return renderSummaryGlance(s, path);
	}
}

/** Three tall columns, CPU (P cores), memory, disk: a big number over each, colour says it all. */
function renderSummaryGlance(s: MachineSnapshot, path: string): string {
	const main = s.cpu ? mainCluster(s.cpu) : undefined;
	const disk = s.disks.get(path);
	const cols: { label: string; value?: number; level?: Level }[] = [
		{ label: "CPU", value: main?.busy, level: main ? cpuLevel(main.busy) : undefined },
		{ label: "MEM", value: s.memory ? 100 - s.memory.freePercent : undefined, level: s.memory ? memoryLevel(s.memory) : undefined },
		disk && !("error" in disk) ? { label: "DISK", value: usedPercent(disk), level: diskLevel(disk) } : { label: "DISK" },
	];
	const parts = [`<rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>`];
	const width = 34;
	const top = 40;
	const bottom = 116;
	cols.forEach((c, i) => {
		const x = 10 + i * 45;
		const mid = x + width / 2;
		parts.push(`<rect x="${x}" y="${top}" width="${width}" height="${bottom - top}" rx="6" fill="${TRACK}"/>`);
		if (c.value !== undefined && c.level) {
			const h = Math.max(6, ((bottom - top) * Math.min(100, c.value)) / 100);
			parts.push(`<rect x="${x}" y="${(bottom - h).toFixed(1)}" width="${width}" height="${h.toFixed(1)}" rx="6" fill="${LEVEL_COLOR[c.level]}"/>`);
		}
		const value = c.value === undefined ? "—" : String(Math.round(c.value));
		parts.push(text(mid, 31, value, { size: value.length >= 3 ? 19 : 24, weight: 800, fill: c.level ? levelInk(c.level) : QUIET, anchor: "middle" }));
		parts.push(text(mid, 136, c.label, { size: 14, weight: 800, fill: DIM, anchor: "middle" }));
	});
	return svg(parts.join(""));
}

/** A green disc with a check, or an amber one with the count, as big as the Usage ring; what it means on top. */
function renderUpdatesGlance(count: number, stale: boolean): string {
	const color = stale ? STALE_FILL : count > 0 ? PACE_COLOR.ahead : PACE_COLOR.under;
	const r = RING.r + RING.width / 2;
	const { cx, cy } = RING;
	const caption = stale ? "STALE" : count === 0 ? "UP TO DATE" : count === 1 ? "UPDATE" : "UPDATES";
	const parts = [
		`<rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>`,
		text(72, 22, caption, { size: 14, weight: 800, fill: stale ? SOFT : color, anchor: "middle", spacing: 0.3 }),
		`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`,
	];
	if (count > 0) {
		const n = count > 9 ? "9+" : String(count);
		parts.push(text(cx, cy + 18, n, { size: 50, weight: 800, fill: INK, anchor: "middle" }));
	} else {
		parts.push(`<path d="M${cx - 24} ${cy + 1} ${cx - 7} ${cy + 18} ${cx + 24} ${cy - 16}" fill="none" stroke="${INK}" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>`);
	}
	return svg(parts.join(""));
}

/** Back key on the T3 Threads page: a chevron, tinted when something needs you, and "+N" for threads that didn't fit. */
export function renderBackKey(attention: boolean, overflow = 0): string {
	const color = attention ? PALETTE.input.accent : WHITE;
	const lift = overflow > 0 ? 14 : 0;
	return svg(
		`<rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>` +
			`<path d="M82 ${40 - lift} 50 ${72 - lift}l32 32" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>` +
			(overflow > 0 ? text(72, 128, `+${overflow} more`, { size: 16, weight: 750, fill: SOFT, anchor: "middle" }) : ""),
	);
}

/** Fill colour carries the pace: under green, on pace blue, ahead amber, far ahead or nearly used up red. */
function paceFill(p: Pace): string {
	if (p.used >= 90 || (p.delta ?? 0) > 15) return PACE_COLOR.over;
	if (p.state === "ahead") return PACE_COLOR.ahead;
	if (p.state === "under") return PACE_COLOR.under;
	return PACE_COLOR.on;
}

/** One segment per day of a weekly window, per hour of a 5-hour window. */
export function ringSegments(windowMins: number | undefined): number {
	if (!windowMins) return 1;
	if (windowMins % 1440 === 0 && windowMins / 1440 <= 14) return windowMins / 1440;
	if (windowMins % 60 === 0 && windowMins / 60 <= 12) return windowMins / 60;
	return 1;
}

const RING = { cx: 72, cy: 82, r: 45, width: 12, gapDeg: 5 };

/**
 * Ring style: the window as a circle of segments (days or hours), filled
 * clockwise from the top with usage. The white tick marks even pace (how much
 * of the window has passed); the fill colour says ahead or under.
 */
function renderUsageRing(metric: UsageMetric, p: Pace, stale: boolean): string {
	const segments = ringSegments(metric.window.windowDurationMins);
	const gap = segments > 1 ? RING.gapDeg : 0;
	const span = 360 / segments;
	const usedDeg = (360 * Math.min(100, p.used)) / 100;
	const fill = stale ? STALE_FILL : paceFill(p);

	const parts: string[] = [`<rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>`];
	const title = metric.provider === "Claude" ? metric.label : `${metric.provider} ${metric.label}`;
	parts.push(text(72, 22, fit(title.toUpperCase(), 132, 14, 0.3), { size: 14, weight: 800, fill: DIM, anchor: "middle", spacing: 0.3 }));

	for (let i = 0; i < segments; i++) {
		const start = i * span + gap / 2;
		const end = (i + 1) * span - gap / 2;
		parts.push(arc(start, end, TRACK));
		const filledEnd = Math.min(end, usedDeg);
		if (filledEnd > start) parts.push(arc(start, filledEnd, fill));
	}
	if (p.elapsed !== null) {
		const deg = (360 * p.elapsed) / 100;
		const inner = polar(deg, RING.r - RING.width / 2 - 3);
		const outer = polar(deg, RING.r + RING.width / 2 + 3);
		parts.push(`<line x1="${inner.x.toFixed(1)}" y1="${inner.y.toFixed(1)}" x2="${outer.x.toFixed(1)}" y2="${outer.y.toFixed(1)}" stroke="${WHITE}" stroke-width="3" stroke-linecap="round"/>`);
	}

	const used = Math.round(p.used);
	const digits = String(used).length;
	const size = digits >= 3 ? 26 : 32;
	parts.push(text(RING.cx - 4, RING.cy + size * 0.36, String(used), { size, weight: 800, fill: stale ? STALE : WHITE, anchor: "middle" }));
	parts.push(text(RING.cx - 4 + digits * size * 0.29 + 2, RING.cy + size * 0.36, "%", { size: 15, weight: 700, fill: stale ? STALE : DIM }));
	return svg(parts.join(""));
}

/** Degrees clockwise from 12 o'clock. */
function polar(deg: number, radius: number): { x: number; y: number } {
	const rad = ((deg - 90) * Math.PI) / 180;
	return { x: RING.cx + radius * Math.cos(rad), y: RING.cy + radius * Math.sin(rad) };
}

function arc(startDeg: number, endDeg: number, color: string): string {
	const a = polar(startDeg, RING.r);
	const b = polar(endDeg, RING.r);
	const large = endDeg - startDeg > 180 ? 1 : 0;
	if (endDeg - startDeg >= 359.9) {
		return `<circle cx="${RING.cx}" cy="${RING.cy}" r="${RING.r}" fill="none" stroke="${color}" stroke-width="${RING.width}"/>`;
	}
	return `<path d="M${a.x.toFixed(2)} ${a.y.toFixed(2)} A${RING.r} ${RING.r} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}" fill="none" stroke="${color}" stroke-width="${RING.width}"/>`;
}

// ---------- Thread Actions page ----------

export type ThreadActionName = "back" | "blank" | "header" | "open" | "stop" | "snooze1h" | "snoozeTomorrow" | "settle" | "compact" | "message";

/** Actions that change a thread; they need "Enable thread actions" in settings. */
export const OPERATE_ACTIONS: ReadonlySet<ThreadActionName> = new Set(["stop", "snooze1h", "snoozeTomorrow", "settle", "compact", "message"]);
/** Actions that fire only after being held, never on a tap. */
export const HOLD_ACTIONS: ReadonlySet<ThreadActionName> = new Set(["stop", "settle", "compact", "message"]);

export interface ActionKeyInput {
	action: ThreadActionName;
	/** The thread the page acts on. */
	card: ThreadCard | undefined;
	/** Label shown on "message" keys (the text sent can be longer). */
	message?: string;
	/** "Hold to confirm / send" after a single tap. */
	hint?: boolean;
	/** Being held: 0–1 towards firing. */
	progress?: number;
	/** Thread actions are enabled in settings. Default true. */
	enabled?: boolean;
	projectName?: string;
	connection: Connection;
	animation: AnimationMode;
	now: number;
}

/** A Lucide icon (24×24 grid, as T3 uses) scaled into the key. */
function lucide(paths: string, size: number, cx: number, cy: number, color: string): string {
	const scale = size / 24;
	return `<g transform="translate(${cx - size / 2} ${cy - size / 2}) scale(${scale})" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</g>`;
}
const ICON = {
	open: `<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M9 12h7M13 9l3 3-3 3"/>`,
	clock: `<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>`,
	check: `<path d="M20 6 9 17l-5-5"/>`,
	compact: `<path d="m14 10 7-7"/><path d="M20 10h-6V4"/><path d="m3 21 7-7"/><path d="M4 14h6v6"/>`, // T3's "Compact context" (minimize-2)
};

const STOP_RED = "#CC2F35";
const OFF_ICON = "#4B5260";

const caption = (title: string, sub?: string, color = WHITE): string =>
	text(72, 110, title, { size: 16, weight: 750, fill: color, anchor: "middle" }) + (sub ? text(72, 130, sub, { size: 14, weight: 600, fill: color === WHITE ? SOFT : color, anchor: "middle" }) : "");

/** Thread actions are off: the key says where to turn them on, or that the thread is on a linked machine. */
const disabledNoteFor = (remote: boolean): string => (remote ? caption("On another", "machine", SOFT) : caption("Enable in", "settings", SOFT));

export function renderActionKey(input: ActionKeyInput): string {
	const { action, card } = input;
	// Actions go through this machine's server; a linked machine's thread can only be opened.
	const remote = !!card?.environmentId;
	const enabled = input.enabled !== false && !remote;
	const disabledNote = (): string => disabledNoteFor(remote);
	if (action === "header") {
		if (!card) return renderMessage("No thread", SOFT);
		const inner = renderThreadKey({ card, projectName: input.projectName ?? "", connection: input.connection, animation: input.animation, now: input.now });
		return overlay(inner, `<rect x="2" y="2" width="140" height="140" rx="20" fill="none" stroke="${WHITE}" stroke-width="3" stroke-dasharray="3 5"/>`);
	}
	if (action === "blank" || action === "back") return svg(`<rect width="${SIZE}" height="${SIZE}" fill="#0B0C0E"/>`);
	const bg = `<rect width="${SIZE}" height="${SIZE}" fill="${BG}"/>`;
	if (action === "message") {
		if (!input.message) return svg(`<rect width="${SIZE}" height="${SIZE}" fill="#0B0C0E"/>`);
		const body = (widths: number[], color: string): string =>
			wrapWidths(input.message!, widths).map((line, i) => text(12, 36 + i * 25, line, { size: 20, weight: 650, fill: color })).join("");
		if (!enabled) return svg(bg + body([11, 11], QUIET) + disabledNote());
		if (input.hint) {
			return svg(
				bg +
					body([11, 11, 11], WHITE) +
					`<rect x="8" y="106" width="128" height="30" rx="15" fill="${WHITE}"/>` +
					text(72, 126, "Hold to send", { size: 15, weight: 800, fill: INK, anchor: "middle" }),
			);
		}
		// Big enough to read at a glance; the last line stops short of the send button.
		return svg(
			bg +
				body([11, 11, 11, 7], WHITE) +
				// T3's send button: an arrow up in a circle.
				`<circle cx="118" cy="118" r="15" fill="${WHITE}"/><path d="M118 126V110M111 116l7-7 7 7" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>` +
				holdFill(input.progress),
		);
	}
	if (action === "stop") {
		if (!enabled) return svg(bg + `<rect x="54" y="30" width="36" height="36" rx="6" fill="${OFF_ICON}"/>` + disabledNote());
		if (!card?.activeRunId) {
			return svg(
				bg +
					`<rect x="54" y="30" width="36" height="36" rx="6" fill="none" stroke="${OFF_ICON}" stroke-width="3"/>` +
					caption("Nothing", "running", SOFT),
			);
		}
		const square = input.hint ? `<rect x="50" y="28" width="44" height="44" rx="7" fill="${WHITE}"/>` : `<rect x="50" y="50" width="44" height="44" rx="7" fill="${WHITE}"/>`;
		return svg(
			`<rect width="${SIZE}" height="${SIZE}" fill="${STOP_RED}"/>` +
				square +
				(input.hint ? text(72, 104, "Hold to", { size: 16, weight: 750, fill: WHITE, anchor: "middle" }) + text(72, 124, "confirm", { size: 16, weight: 750, fill: WHITE, anchor: "middle" }) : "") +
				holdFill(input.progress),
		);
	}
	if (action === "open") return svg(bg + lucide(ICON.open, 56, 72, 54, WHITE) + caption("Open", "in T3 Code"));
	const icon = action === "compact" ? ICON.compact : action === "settle" ? ICON.check : ICON.clock;
	const iconSize = action === "settle" ? 56 : 48;
	if (!enabled) return svg(bg + lucide(icon, iconSize - 8, 72, 50, OFF_ICON) + disabledNote());
	if (action === "snooze1h") return svg(bg + lucide(ICON.clock, iconSize, 72, 54, WHITE) + caption("Snooze", "1 hour"));
	if (action === "snoozeTomorrow") return svg(bg + lucide(ICON.clock, iconSize, 72, 54, WHITE) + caption("Snooze", "tomorrow 9:00"));
	if (action === "compact") return svg(bg + lucide(ICON.compact, iconSize, 72, 54, WHITE) + caption("Compact", input.hint ? "hold to send" : "hold") + holdFill(input.progress));
	// settle
	return svg(bg + lucide(ICON.check, iconSize, 72, 54, WHITE) + caption("Settle", input.hint ? "hold to confirm" : "hold") + holdFill(input.progress));
}
