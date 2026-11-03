// Prints the usage metrics the Usage key can show. Usage: node --experimental-strip-types scripts/usage.ts
// Uses (and if needed mints) the plugin's read-only "rpc" token, like the plugin itself.
import { locate } from "../src/t3/auth.ts";
import { RpcAccess } from "../src/t3/rpc.ts";
import { UsageMonitor } from "../src/t3/usage-monitor.ts";
import { metricsOf, pace } from "../src/usage.ts";

const u = new UsageMonitor(new RpcAccess(() => locate()));
u.on("log", (l) => console.error("log:", l));
u.on("change", (s) => {
	console.log(s.ok ? "ok" : `failed: ${s.detail}`);
	for (const m of metricsOf(s.providers)) {
		const p = pace(m.window, Date.now());
		console.log(`${m.key.padEnd(30)} ${String(Math.round(p.used)).padStart(3)}% used, ${p.elapsed?.toFixed(0)}% elapsed → ${p.state} (${p.delta?.toFixed(1)})`);
	}
	u.stop();
	process.exit(0);
});
u.start();
u.setWanted(true);
