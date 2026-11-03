/**
 * Pure SVG rendering for 144×144 keys. Every function takes the clock as an
 * argument so animation frames are deterministic and easy to dedupe.
 *
 * Legibility rules: no text below 14 px (keys are ~96 px on a real deck),
 * every state that needs you carries a glyph as well as a colour, and bar
 * tracks keep 3:1 against the background.
 */
import type { CardState, ThreadCard } from "./model.ts";
import { formatDuration, type Pace, type UsageMetric } from "./usage.ts";
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
	failed: { accent: "#F0524F", label: "FAILED" },
	done: { accent: "#3DD68C", label: "DONE" },
	working: { accent: "#5B9CFF", label: "WORKING" },
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
export function nextThreadFrame(card: ThreadCard | undefined, animation: AnimationMode, now: number): number | undefined {
	if (!card) return undefined;
	let next: number | undefined;
	const at = (t: number): void => {
		if (next === undefined || t < next) next = t;
	};
	if (card.state === "paused") {
		if (card.pausedUntil && card.pausedUntil > now) at(now + ((card.pausedUntil - now) % 60_000) + 1);
		return next;
	}
	if (animation === "off") return undefined;
	if (FLASH[card.state]) at(nextFlashEdge(card.state, now));
	if (spins(card)) at(nextBoundary(now, SPIN_STEP_MS));
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
	if (card.state === "paused") return overlay(renderPaused(card, now, input.showLabel), cue);

	const state = card.state;
	const { accent, label } = PALETTE[state];
	// DONE is a steady solid tile; only NEEDS YOU and FAILED blink.
	const lit = state === "done" || (animation !== "off" && flashLit(state, now));
	const steady = animation === "off" && FLASH[state] !== undefined;

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
	return pct >= 85 ? "#F0524F" : pct >= 70 ? "#F5A524" : DIM;
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
	if (connection.kind !== "ok") return renderMessage(connectionText(connection), connection.kind === "error" && connection.reason !== "signed-out" ? "#F0524F" : SOFT, "T3 CODE");

	const state = overviewState(counts);
	const accent = state === "background" ? BACKGROUND_ORBIT : PALETTE[state].accent;
	// Done is a steady solid tile; failed and needs-you blink.
	const lit = state === "done" || (animation !== "off" && (state === "failed" || state === "input") && flashLit(state, now));
	const steady = animation === "off" && (state === "failed" || state === "input");
	const bg = lit ? accent : steady ? mix(accent, BG, 0.72) : BG;
	const fg = lit ? INK : WHITE;

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

const PACE_COLOR = { ahead: "#F5A524", over: "#F0524F", on: "#5B9CFF", under: "#3DD68C", unknown: DIM };
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

/** Thread actions are off: the key says where to turn them on. */
const disabledNote = (): string => caption("Enable in", "settings", SOFT);

export function renderActionKey(input: ActionKeyInput): string {
	const { action, card } = input;
	const enabled = input.enabled !== false;
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
