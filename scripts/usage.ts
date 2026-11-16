// Prints the usage metrics the Usage key can show: every provider's windows, banked reset tickets,
// hub accounts (CLIProxyAPI) and why a provider with no windows has none. Hub accounts print their
// email here, as the settings picker does; a key never shows it.
// Usage: node --experimental-strip-types scripts/usage.ts
// Uses (and if needed mints) the plugin's read-only "rpc" token, like the plugin itself.
import { locate } from "../src/t3/auth.ts";
import { RpcAccess } from "../src/t3/rpc.ts";
import { UsageMonitor } from "../src/t3/usage-monitor.ts";
import { defaultMetric, hubDescription, metricsOf, pace, type UsageProvider } from "../src/usage.ts";

const u = new UsageMonitor(new RpcAccess(() => locate()));
u.on("log", (l) => console.error("log:", l));

const tickets = (p: UsageProvider): string => {
	if (!p.resetCredits) return "";
	const next = p.resetCredits.nextExpiresAt ? `, next lapses ${p.resetCredits.nextExpiresAt}` : "";
	return `  🎟 ${p.resetCredits.count} reset ticket${p.resetCredits.count === 1 ? "" : "s"}${next}`;
};

u.on("change", (s) => {
	console.log(s.ok ? "ok" : `failed: ${s.detail}`);
	const metrics = metricsOf(s.providers);
	const fallback = defaultMetric(metrics);
	for (const p of s.providers) {
		console.log(`\n${p.displayName}${p.hub ? `  [${hubDescription(p.hub)}]` : ""}  (${p.instanceId})${tickets(p)}`);
		if (p.windows.length === 0) console.log(`  no windows: ${p.unavailable ? `T3 says ${p.unavailable.reason}` : "none reported"}`);
	}
	for (const h of s.hubs ?? []) if (h.error) console.log(`\nhub "${h.label}" reported an error`);
	console.log("");
	for (const m of metrics) {
		const p = pace(m.window, Date.now());
		const mark = m === fallback ? "*" : " ";
		console.log(`${mark} ${m.key.padEnd(44)} ${String(Math.round(p.used)).padStart(3)}% used, ${p.elapsed?.toFixed(0)}% elapsed → ${p.state} (${p.delta?.toFixed(1)})`);
	}
	console.log("\n* = what a Usage key with no pick shows");
	u.stop();
	process.exit(0);
});
u.start();
u.setWanted(true);
