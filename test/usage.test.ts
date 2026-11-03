import assert from "node:assert/strict";
import { test } from "node:test";

import { renderUsageKey } from "../src/render.ts";
import { parseProviders } from "../src/t3/usage-monitor.ts";
import { formatDuration, metricsOf, pace, pickMetric, type UsageWindow } from "../src/usage.ts";

const WEEK = 10080;
const now = Date.parse("2026-11-03T12:00:00Z");
const week = (usedPercent: number, daysLeft: number, extra: Partial<UsageWindow> = {}): UsageWindow => ({
	id: "seven_day",
	label: "Weekly",
	usedPercent,
	windowDurationMins: WEEK,
	resetsAt: new Date(now + daysLeft * 86_400_000).toISOString(),
	...extra,
});

test("pace compares usage with the share of the window elapsed", () => {
	// 3.5 days into 7 = 50% elapsed.
	assert.equal(pace(week(50, 3.5), now).state, "on");
	const ahead = pace(week(70, 3.5), now);
	assert.equal(ahead.state, "ahead");
	assert.equal(Math.round(ahead.delta!), 20);
	const under = pace(week(10, 3.5), now);
	assert.equal(under.state, "under");
	assert.equal(Math.round(under.elapsed!), 50);
	assert.equal(pace(week(2, 7), now).state, "on"); // window just started, within tolerance
	assert.equal(pace(week(4, 7), now).state, "ahead");
	assert.equal(pace({ id: "x", label: "x", usedPercent: 30 }, now).state, "unknown");
});

test("metrics flatten providers and default to the plain weekly window", () => {
	const providers = parseProviders({
		providers: [
			{ instanceId: "codex", driver: "codex", displayName: "Codex", usageLimits: { windows: [] } },
			{ instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude", usageLimits: { checkedAt: "t", windows: [week(4, 6, { id: "seven_day_fable", label: "Weekly · Fable" }), week(4, 6)] } },
			{ instanceId: "opencode", usageLimits: { windows: [], unavailable: { reason: "unsupported" } } },
		],
	});
	assert.equal(providers.length, 1);
	const metrics = metricsOf(providers);
	assert.deepEqual(metrics.map((m) => m.key), ["claudeAgent:seven_day_fable", "claudeAgent:seven_day"]);
	assert.equal(pickMetric(metrics, undefined)!.key, "claudeAgent:seven_day");
	assert.equal(pickMetric(metrics, "claudeAgent:seven_day_fable")!.label, "Weekly · Fable");
	assert.equal(pickMetric(metrics, "claudeAgent:gone"), undefined); // a saved pick that vanished isn't silently swapped
});

test("usage tile shows used %, the pace marker and time to reset", () => {
	const metric = { key: "k", provider: "Claude", label: "Weekly · Fable", window: week(70, 3.5) };
	const markup = renderUsageKey({ metric, pace: pace(metric.window, now), ok: true, loading: false });
	assert.ok(markup.includes(">70<"));
	assert.ok(markup.includes("20% ahead"));
	assert.ok(markup.includes("WEEKLY · FABLE"));
	assert.ok(markup.includes("resets in 3d 12h"));
	assert.equal(formatDuration(90 * 60_000), "1h 30m");
});

test("ring style: a segment per day (weekly) or hour (5-hour), % in the middle, no text", async () => {
	const { ringSegments } = await import("../src/render.ts");
	assert.equal(ringSegments(10080), 7);
	assert.equal(ringSegments(300), 5);
	assert.equal(ringSegments(undefined), 1);
	const metric = { key: "k", provider: "Claude", label: "Weekly", window: week(62, 3.5) };
	const ring = renderUsageKey({ metric, pace: pace(metric.window, now), ok: true, loading: false, style: "ring" });
	assert.equal((ring.match(/stroke="#5A6270"/g) ?? []).length, 7); // 7 day tracks
	assert.ok(ring.includes(">62<"));
	assert.ok(!ring.includes("resets in") && !ring.includes("ahead") && !ring.includes("under"));
	assert.ok(ring.includes('stroke="#F5A524"')); // ahead → amber fill
	const five = { key: "k", provider: "Claude", label: "5-hour", window: week(30, 0.1, { windowDurationMins: 300 }) };
	const fiveRing = renderUsageKey({ metric: five, pace: pace(five.window, now), ok: true, loading: false, style: "ring" });
	assert.equal((fiveRing.match(/stroke="#5A6270"/g) ?? []).length, 5);
});
