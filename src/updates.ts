/**
 * Update availability for the Updates key: T3 Code itself and each provider
 * CLI it runs (Claude, Codex…). Pure parsing and version maths; the polling
 * lives in t3/updates-monitor.ts.
 *
 * Where the facts come from (all from this Mac's T3 Code server):
 * - T3 Code's version: `server.getConfig` → `environment.serverVersion`.
 * - The newest T3 Code release: `server.getNpmRelease {spec}`, where spec is
 *   "nightly" when this Mac runs a nightly build and "latest" otherwise.
 *   T3 Code's server looks this up on npm; the plugin never goes online.
 * - Provider CLIs: `server.getConfig` → `providers[].versionAdvisory`, which
 *   T3 Code fills in from its own update checks ("Check for provider updates"
 *   in T3 Code's settings).
 */

export interface UpdateItem {
	/** "T3 Code", "Claude", "Codex"… */
	name: string;
	current: string | null;
	latest: string | null;
	available: boolean;
}

export interface UpdatesSnapshot {
	ok: boolean;
	detail?: string;
	fetchedAt: number;
	/** Undefined until T3 Code has answered once. */
	t3?: UpdateItem;
	/** Enabled, installed providers only. */
	providers: UpdateItem[];
}

export type ReleaseChannel = "latest" | "nightly";

/** Nightly builds carry "-nightly." in their version ("0.1.8-nightly.20261106.4288"). */
export const channelOf = (version: string | null | undefined): ReleaseChannel => (version && /-nightly\./.test(version) ? "nightly" : "latest");

/**
 * Semver-style comparison: numeric core first, then a release sorts after
 * its pre-releases, then pre-release parts compare numerically when both are
 * numbers. Build metadata (`+…`) is ignored. Negative when a < b.
 */
export function compareVersions(a: string, b: string): number {
	const split = (v: string) => {
		const [core = "", pre] = v.trim().replace(/^v/, "").split("+")[0]!.split(/-(.*)/s);
		return { core: core.split(".").map((n) => Number(n) || 0), pre: pre ? pre.split(".") : [] };
	};
	const x = split(a);
	const y = split(b);
	for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
		const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
		if (d !== 0) return Math.sign(d);
	}
	if (x.pre.length === 0 || y.pre.length === 0) return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1;
	for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
		const p = x.pre[i];
		const q = y.pre[i];
		if (p === undefined) return -1;
		if (q === undefined) return 1;
		const pn = /^\d+$/.test(p);
		const qn = /^\d+$/.test(q);
		if (pn && qn) {
			const d = Number(p) - Number(q);
			if (d !== 0) return Math.sign(d);
		} else if (pn !== qn) return pn ? -1 : 1;
		else if (p !== q) return p < q ? -1 : 1;
	}
	return 0;
}

/** Short form for a key: "0.1.8-nightly.20261106.4288" → "0.1.8 nightly". */
export const displayVersion = (v: string | null | undefined): string => (v ? v.replace(/-nightly\..*$/, " nightly") : "?");

interface RawProvider {
	instanceId?: string;
	driver?: string;
	displayName?: string;
	enabled?: boolean;
	installed?: boolean;
	version?: string | null;
	versionAdvisory?: { status?: string; currentVersion?: string | null; latestVersion?: string | null };
}

/** T3 Code's own version, from `server.getConfig`. */
export function serverVersionOf(config: unknown): string | null {
	const v = (config as { environment?: { serverVersion?: unknown } } | null)?.environment?.serverVersion;
	return typeof v === "string" && v ? v : null;
}

/** Provider CLIs from `server.getConfig`: enabled and installed ones only. */
export function providerUpdates(config: unknown): UpdateItem[] {
	const raw = (config as { providers?: unknown } | null)?.providers;
	const out: UpdateItem[] = [];
	for (const p of Array.isArray(raw) ? (raw as RawProvider[]) : []) {
		if (!p || typeof p !== "object" || p.enabled === false || p.installed === false) continue;
		const advisory = p.versionAdvisory ?? {};
		const current = advisory.currentVersion ?? p.version ?? null;
		const latest = advisory.latestVersion ?? null;
		const available = advisory.status === "behind_latest" || (!!current && !!latest && compareVersions(latest, current) > 0);
		out.push({ name: p.displayName ?? p.instanceId ?? p.driver ?? "Provider", current, latest, available });
	}
	return out;
}

/** T3 Code itself, given its version and the newest release on its channel. */
export function t3Update(current: string | null, latest: string | null): UpdateItem {
	return { name: "T3 Code", current, latest, available: !!current && !!latest && compareVersions(latest, current) > 0 };
}

/** Everything with an update waiting, T3 Code first. */
export const pendingUpdates = (s: UpdatesSnapshot): UpdateItem[] => [...(s.t3 ? [s.t3] : []), ...s.providers].filter((u) => u.available);
