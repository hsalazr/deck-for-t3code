/**
 * Pure usage-limit math. A limit window (e.g. Claude's weekly window) is
 * "on pace" when the share used matches the share of the window that has
 * elapsed. Ahead of pace = spending faster than time passes.
 */

/** One window from a T3 provider's `usageLimits.windows`. */
export interface UsageWindow {
	id: string;
	kind?: string;
	label: string;
	usedPercent: number;
	resetsAt?: string;
	windowDurationMins?: number;
}

export interface UsageProvider {
	/** Provider instance id, e.g. "claudeAgent". */
	instanceId: string;
	displayName: string;
	checkedAt?: string;
	windows: UsageWindow[];
}

export interface UsageMetric {
	/** `<providerInstanceId>:<windowId>`, stable across polls. */
	key: string;
	provider: string;
	label: string;
	window: UsageWindow;
	checkedAt?: string;
}

export type PaceState = "ahead" | "on" | "under" | "unknown";

export interface Pace {
	used: number;
	/** Share of the window elapsed, 0-100. Null when the window length or reset is unknown. */
	elapsed: number | null;
	/** used − elapsed, in percentage points. Positive = ahead of pace. */
	delta: number | null;
	state: PaceState;
	/** Milliseconds until reset, if known. */
	resetsInMs: number | null;
}

/** Within this many points of even pace counts as "on pace". */
export const ON_PACE_TOLERANCE = 3;

export function pace(window: UsageWindow, now: number): Pace {
	const used = clamp(window.usedPercent, 0, 100);
	const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
	const resetsInMs = Number.isFinite(resetsAt) ? Math.max(0, resetsAt - now) : null;
	const lengthMs = window.windowDurationMins ? window.windowDurationMins * 60_000 : null;
	if (resetsInMs === null || !lengthMs) return { used, elapsed: null, delta: null, state: "unknown", resetsInMs };
	const elapsed = clamp(100 * (1 - resetsInMs / lengthMs), 0, 100);
	const delta = used - elapsed;
	const state: PaceState = delta > ON_PACE_TOLERANCE ? "ahead" : delta < -ON_PACE_TOLERANCE ? "under" : "on";
	return { used, elapsed, delta, state, resetsInMs };
}

/** Flattens providers into pickable metrics, weekly first. */
export function metricsOf(providers: readonly UsageProvider[]): UsageMetric[] {
	const metrics: UsageMetric[] = [];
	for (const p of providers) {
		for (const w of p.windows) {
			metrics.push({ key: `${p.instanceId}:${w.id}`, provider: p.displayName, label: w.label, window: w, checkedAt: p.checkedAt });
		}
	}
	return metrics;
}

/** Saved metric, or the first weekly window, or anything. */
export function pickMetric(metrics: readonly UsageMetric[], key: string | undefined): UsageMetric | undefined {
	return (
		(key ? metrics.find((m) => m.key === key) : undefined) ??
		(key ? undefined : metrics.find((m) => m.window.id === "seven_day") ?? metrics[0])
	);
}

/** "6d 18h", "5h 12m", "42m". */
export function formatDuration(ms: number): string {
	const mins = Math.floor(ms / 60_000);
	const d = Math.floor(mins / 1440);
	const h = Math.floor((mins % 1440) / 60);
	const m = mins % 60;
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

/** Short tile label: "Weekly · Fable" → "WEEKLY · FABLE". */
export function shortLabel(metric: UsageMetric): string {
	return metric.label.toUpperCase();
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : 0));
