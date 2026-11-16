/**
 * Pure usage-limit math. A limit window (e.g. Claude's weekly window) is
 * "on pace" when the share used matches the share of the window that has
 * elapsed. Ahead of pace = spending faster than time passes.
 */
import { createHash } from "node:crypto";

/** One window from a T3 provider's `usageLimits.windows`. */
export interface UsageWindow {
	id: string;
	kind?: string;
	label: string;
	usedPercent: number;
	resetsAt?: string;
	windowDurationMins?: number;
	/** Set (after T3 0.1.9) when the limit applies only to some models; such a window is never the default pick. */
	modelIds?: string[];
}

/** Banked reset tickets: how many are left and when the next one lapses. Only present when the count is above zero. */
export interface ResetCredits {
	count: number;
	nextExpiresAt?: string;
}

/** Why T3 reports no windows for a provider or account. */
export interface UsageUnavailable {
	reason: "unsupported" | "probeFailed";
}

/** An account served through a hub (CLIProxyAPI). Emails are for the settings picker only, never for a key. */
export interface HubAccount {
	sourceId: string;
	hubLabel: string;
	/** Driver name, e.g. "Codex". */
	driver: string;
	email?: string;
	plan?: string;
	/** The account id without ".json": what T3 itself calls an account that has no email. */
	name: string;
}

/** A hub as T3 reports it, kept for its error when it has no accounts. */
export interface HubStatus {
	id: string;
	label: string;
	error?: boolean;
}

export interface UsageProvider {
	/** Provider instance id, e.g. "claudeAgent". */
	instanceId: string;
	displayName: string;
	checkedAt?: string;
	windows: UsageWindow[];
	resetCredits?: ResetCredits;
	unavailable?: UsageUnavailable;
	/** Set for an account served through a hub; then `instanceId` is `hubKey(...)`. */
	hub?: HubAccount;
}

export interface UsageMetric {
	/** `<providerInstanceId>:<windowId>`, stable across polls. */
	key: string;
	provider: string;
	label: string;
	window: UsageWindow;
	checkedAt?: string;
	credits?: ResetCredits;
	hub?: HubAccount;
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

/**
 * Metric-key prefix of a hub account. Provider instance ids are slugs that
 * start with a letter, so a key starting with "~" can never collide with
 * the `<providerInstanceId>:<windowId>` keys saved before hub accounts existed.
 */
export function hubKey(sourceId: string, accountId: string, workspaceId?: string): string {
	// A hub names an account after its auth file, which often holds the email, and Stream Deck saves the key
	// in the key's settings on disk. So the account and workspace parts are hashed; the hub's own id stays readable.
	const short = (s: string): string => (s === "" ? "" : createHash("sha256").update(s).digest("hex").slice(0, 16));
	return `~hub:${encodeURIComponent(sourceId)}:${short(accountId)}:${short(workspaceId ?? "")}`;
}

/** Picker text for a hub account: which hub, which driver, then who (email, else the account's name) and its plan. */
export function hubDescription(h: HubAccount): string {
	return `${h.hubLabel} · ${h.driver} · ${h.email ?? h.name}${h.plan ? ` (${h.plan})` : ""}`;
}

/** Flattens providers into pickable metrics, weekly first. */
export function metricsOf(providers: readonly UsageProvider[]): UsageMetric[] {
	const metrics: UsageMetric[] = [];
	for (const p of providers) {
		for (const w of p.windows) {
			metrics.push({ key: `${p.instanceId}:${w.id}`, provider: p.displayName, label: w.label, window: w, checkedAt: p.checkedAt, credits: p.resetCredits, hub: p.hub });
		}
	}
	return metrics;
}

/**
 * The limit a key shows when the user picked none: Claude's plain weekly window
 * (as before), else another provider's weekly window by `kind`, else the first.
 * The provider's own limits come before a hub account's.
 */
export function defaultMetric(metrics: readonly UsageMetric[]): UsageMetric | undefined {
	for (const own of [true, false]) {
		const group = metrics.filter((m) => !m.hub === own);
		const claude = group.find((m) => m.window.id === "seven_day");
		if (claude) return claude;
		// A weekly limit for every model beats one for a single model ("Weekly · Fable"), which has more separators.
		const weekly = group.filter((m) => m.window.kind === "weekly" && !m.window.modelIds?.length);
		let best: UsageMetric | undefined;
		for (const m of weekly) if (!best || m.label.split("·").length < best.label.split("·").length) best = m;
		if (best) return best;
	}
	return metrics[0];
}

/** Saved metric, or the default. */
export function pickMetric(metrics: readonly UsageMetric[], key: string | undefined): UsageMetric | undefined {
	return key ? metrics.find((m) => m.key === key) : defaultMetric(metrics);
}

/** What to say on a key whose limit isn't there, when T3 told why. Undefined: say nothing more than "No usage data". */
export interface EmptyState {
	/** Provider or hub name, for the key's heading. */
	name: string;
	text: string;
}

export function emptyState(providers: readonly UsageProvider[], hubs: readonly HubStatus[], key: string | undefined): EmptyState | undefined {
	if (!key) return undefined;
	// Longest instance id wins; ids never contain ":" except hub ones, which end in a fixed three parts.
	const owner = providers.filter((p) => key.startsWith(`${p.instanceId}:`)).sort((a, b) => b.instanceId.length - a.instanceId.length)[0];
	if (owner) {
		if (owner.windows.length > 0) return { name: owner.displayName, text: "Limit not reported" };
		if (owner.unavailable?.reason === "unsupported") return { name: owner.displayName, text: "No plan limits" };
		if (owner.unavailable?.reason === "probeFailed") return { name: owner.displayName, text: "Couldn't read limits" };
		return { name: owner.displayName, text: "No limits reported" };
	}
	// A hub that failed has no accounts, so the key's account is gone with it.
	const hub = hubs.find((h) => h.error && key.startsWith(`~hub:${encodeURIComponent(h.id)}:`));
	return hub ? { name: hub.label, text: "Hub unavailable" } : undefined;
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
