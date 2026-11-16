import assert from "node:assert/strict";
import { test } from "node:test";

import { MIN_FONT_PX, renderUsageKey } from "../src/render.ts";
import type { RpcAccess } from "../src/t3/rpc.ts";
import { driverName, parseHubs, parseProviders, parseResetCredits, readConfigStream, UsageMonitor, type UsageSnapshot } from "../src/t3/usage-monitor.ts";
import { defaultMetric, emptyState, formatDuration, hubDescription, hubKey, metricsOf, pace, pickMetric, type UsageMetric, type UsageWindow } from "../src/usage.ts";

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
	// A provider with a usageLimits object stays (a key set to it can say why it is empty); only windows make metrics.
	assert.deepEqual(providers.map((p) => p.instanceId), ["codex", "claudeAgent", "opencode"]);
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

// ---------------------------------------------------------------- tickets, hub accounts, every provider

const win = (id: string, over: Partial<UsageWindow> = {}): UsageWindow => ({ id, kind: "weekly", label: id, usedPercent: 10, ...over });
const metric = (key: string, w: UsageWindow, over: Partial<UsageMetric> = {}): UsageMetric => ({ key, provider: "P", label: w.label, window: w, ...over });
const fontSizes = (svg: string): number[] => [...svg.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
const inDays = (d: number): string => new Date(now + d * 86_400_000).toISOString();

test("reset tickets: the total, else the options' sum; nothing for zero, junk or a missing object", () => {
	assert.deepEqual(parseResetCredits({ availableCount: 2, nextExpiresAt: inDays(2) }), { count: 2, nextExpiresAt: inDays(2) });
	// No total: sum the options; the next expiry is the earliest among options that still have tickets.
	const options = [
		{ creditId: "a", label: "Weekly", description: "d", availableCount: 1, expiresAt: inDays(9) },
		{ creditId: "b", label: "Fable", description: "d", availableCount: 2, expiresAt: inDays(4) },
		{ creditId: "c", label: "Spent", description: "d", availableCount: 0, expiresAt: inDays(1) },
	];
	assert.deepEqual(parseResetCredits({ options }), { count: 3, nextExpiresAt: inDays(4) });
	assert.equal(parseResetCredits({ availableCount: 0 }), undefined);
	assert.equal(parseResetCredits({ availableCount: -3 }), undefined);
	assert.equal(parseResetCredits({ availableCount: "5" }), undefined);
	assert.equal(parseResetCredits({ availableCount: Number.NaN }), undefined);
	assert.equal(parseResetCredits(null), undefined);
	assert.equal(parseResetCredits("2"), undefined);
	assert.deepEqual(parseResetCredits({ availableCount: 1, nextExpiresAt: "someday" }), { count: 1 });
	assert.equal(parseResetCredits({ availableCount: 2.9 })?.count, 2);
});

test("every provider shows under a name: displayName, else the known driver name, else a tidied driver id", () => {
	const providers = parseProviders({
		providers: [
			{ instanceId: "grok", driver: "grok", usageLimits: { windows: [win("w")] } },
			{ instanceId: "muse", driver: "muse", displayName: 42, usageLimits: { windows: [win("w")] } },
			{ instanceId: "acp", driver: "acpRegistry", displayName: "  ", usageLimits: { windows: [win("w")] } },
			{ instanceId: "newAgent", driver: "someNewAgent", usageLimits: { windows: [win("w")] } },
			{ instanceId: "kiro", driver: "kiro", displayName: "Kiro (work)", usageLimits: { windows: [win("w")] } },
			{ driver: "pi", usageLimits: { windows: [win("w")] } },
		],
	});
	assert.deepEqual(providers.map((p) => p.displayName), ["Grok", "Muse Code", "ACP Registry", "Some New Agent", "Kiro (work)", "Pi"]);
	assert.equal(driverName("antigravity"), "Antigravity");
	assert.equal(driverName("fx"), "fx");
	assert.equal(driverName("my_new-driver"), "My New Driver");
});

test("providers: disabled (usageLimits null) and malformed entries are dropped; unavailable ones are kept; bad windows are skipped", () => {
	const providers = parseProviders({
		providers: [
			null,
			"codex",
			{ instanceId: "off", driver: "codex", displayName: "Codex", usageLimits: null },
			{ instanceId: "none", driver: "cursor", usageLimits: { checkedAt: "t", windows: [], unavailable: { reason: "unsupported", message: "n/a" } } },
			{ instanceId: "odd", driver: "codex", usageLimits: { windows: [null, { id: 3, usedPercent: 4 }, { id: "x", usedPercent: "5" }, { id: "y", usedPercent: Number.NaN }, win("ok", { label: "", windowDurationMins: "long" as never, modelIds: ["m1", 7 as never] })] } },
			{ instanceId: "bad", driver: "codex", usageLimits: { windows: "nope", unavailable: { reason: "weird" } } },
		],
	});
	assert.deepEqual(providers.map((p) => p.instanceId), ["none", "odd", "bad"]);
	assert.equal(providers[0]!.unavailable?.reason, "unsupported");
	assert.equal(providers[0]!.windows.length, 0);
	assert.deepEqual(providers[1]!.windows, [{ id: "ok", label: "ok", usedPercent: 10, kind: "weekly", modelIds: ["m1"] }]);
	assert.equal(providers[2]!.unavailable, undefined);
	assert.deepEqual(parseProviders(undefined), []);
	assert.deepEqual(parseProviders({ providers: "x" }), []);
});

test("two instances of one driver with one name are told apart by instance id", () => {
	const providers = parseProviders({
		providers: [
			{ instanceId: "codex", driver: "codex", displayName: "Codex", usageLimits: { windows: [win("w")] } },
			{ instanceId: "codex_work", driver: "codex", displayName: "Codex", usageLimits: { windows: [win("w")] } },
			{ instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude", usageLimits: { windows: [win("w")] } },
		],
	});
	assert.deepEqual(providers.map((p) => p.displayName), ["Codex · codex", "Codex · codex_work", "Claude"]);
});

const hubPayload = (): unknown[] => [
	{
		id: "acme-hub",
		kind: "cliproxy",
		label: "Acme Hub",
		checkedAt: "2026-11-03T11:00:00Z",
		accounts: [
			{ id: "codex-dev@example.com-plus.json", driver: "codex", email: "dev@example.com", plan: "Plus", usageLimits: { checkedAt: "t", windows: [win("primary", { label: "Weekly", usedPercent: 41 })], resetCredits: { availableCount: 2, nextExpiresAt: inDays(2) } } },
			{ id: "codex-ops.json", driver: "codex", plan: "Pro", usageLimits: { checkedAt: "t", windows: [win("primary", { label: "Weekly", usedPercent: 7 })] } },
			{ id: "claude-bare.json", driver: "claudeAgent", usageLimits: { checkedAt: "t", windows: [], unavailable: { reason: "probeFailed", message: "token expired for dev@example.com" } } },
			{ id: "shared.json", workspaceId: "ws-1", driver: "codex", email: "ws@example.com", usageLimits: { checkedAt: "t", windows: [win("primary")] } },
			{ id: "shared.json", workspaceId: "ws-2", driver: "codex", email: "ws@example.com", usageLimits: { checkedAt: "t", windows: [win("primary")] } },
		],
	},
	{ id: "old-hub", kind: "cliproxy", label: "Old Hub", checkedAt: "t", accounts: [], error: "No management key configured." },
];

test("hub accounts: named by plan or hub, never by email; two accounts on one hub stay apart; a failed hub is noted", () => {
	const { accounts, hubs } = parseHubs(hubPayload());
	assert.deepEqual(hubs, [{ id: "acme-hub", label: "Acme Hub" }, { id: "old-hub", label: "Old Hub", error: true }]);
	assert.deepEqual(accounts.map((a) => a.displayName), ["Codex Plus", "Codex Pro", "Acme Hub", "Acme Hub", "Acme Hub"]);
	for (const a of accounts) assert.ok(!a.displayName.includes("@"), "no email as a name");
	assert.equal(new Set(accounts.map((a) => a.instanceId)).size, accounts.length, "every account has its own key, workspaces included");
	assert.equal(accounts[0]!.resetCredits?.count, 2);
	assert.equal(accounts[1]!.hub?.email, undefined);
	assert.equal(accounts[1]!.hub?.name, "codex-ops");
	assert.equal(accounts[2]!.unavailable?.reason, "probeFailed");
	assert.equal(JSON.stringify(accounts[2]).includes("token expired"), false, "T3's free-text message isn't kept");
	assert.equal(hubDescription(accounts[0]!.hub!), "Acme Hub · Codex · dev@example.com (Plus)");
	assert.equal(hubDescription(accounts[1]!.hub!), "Acme Hub · Codex · codex-ops (Pro)");
});

test("hub payloads with missing or malformed fields don't throw", () => {
	assert.deepEqual(parseHubs(undefined), { accounts: [], hubs: [] });
	assert.deepEqual(parseHubs("x"), { accounts: [], hubs: [] });
	const { accounts, hubs } = parseHubs([null, { label: "no id" }, { id: "h", accounts: "nope" }, { id: "h2", label: 5, accounts: [null, { id: "a" }, { driver: "codex", usageLimits: { windows: [] } }, { id: "b", usageLimits: { windows: [win("w")] } }] }]);
	assert.deepEqual(hubs, [{ id: "h", label: "h" }, { id: "h2", label: "h2" }]);
	assert.equal(accounts.length, 1);
	assert.equal(accounts[0]!.displayName, "h2", "no plan: the hub's label");
});

test("metric keys: legacy keys keep their form; hub keys are stable, unambiguous and can't collide with them", () => {
	const first = metricsOf(parseHubs(hubPayload()).accounts).map((m) => m.key);
	const again = metricsOf(parseHubs(hubPayload()).accounts.reverse()).map((m) => m.key).sort();
	assert.deepEqual([...first].sort(), again, "the same keys on the next poll, whatever the order");
	assert.match(hubKey("acme-hub", "a.json", "ws-1"), /^~hub:acme-hub:[0-9a-f]{16}:[0-9a-f]{16}$/);
	assert.match(hubKey("acme-hub", "a.json"), /^~hub:acme-hub:[0-9a-f]{16}:$/);
	assert.equal(hubKey("acme-hub", "a.json"), hubKey("acme-hub", "a.json"));
	assert.notEqual(hubKey("acme-hub", "a.json"), hubKey("acme-hub", "b.json"));
	assert.notEqual(hubKey("a:b", "c"), hubKey("a", "b:c"), "a colon in an id can't shift the parts");
	for (const key of first) assert.ok(!key.includes("@") && !key.includes("example"), "the saved key holds no email");
	for (const key of first) assert.ok(key.startsWith("~"), "provider instance ids start with a letter");
	const claude = parseProviders({ providers: [{ instanceId: "claudeAgent", driver: "claudeAgent", usageLimits: { windows: [win("seven_day")] } }] });
	assert.equal(metricsOf(claude)[0]!.key, "claudeAgent:seven_day");
	// A key saved before hub accounts existed still finds its window next to them.
	const all = metricsOf([...claude, ...parseHubs(hubPayload()).accounts]);
	assert.equal(pickMetric(all, "claudeAgent:seven_day")!.label, "seven_day");
	assert.equal(pickMetric(all, first[0])!.hub?.email, "dev@example.com");
});

test("default pick: Claude's seven_day as before, else another provider's plain weekly window by kind", () => {
	const claude = [metric("claudeAgent:seven_day_fable", win("seven_day_fable", { label: "Weekly · Fable" })), metric("claudeAgent:seven_day", win("seven_day", { label: "Weekly" }))];
	assert.equal(defaultMetric(claude)!.key, "claudeAgent:seven_day", "two weekly windows: the plain one");
	assert.equal(defaultMetric([metric("codex:5h", win("5h", { kind: "session" })), ...claude])!.key, "claudeAgent:seven_day");
	// No Claude: the weekly window of whichever provider has one, not a 5-hour one that comes first.
	const codex = [metric("codex:primary", win("primary", { kind: "session", label: "5-hour" })), metric("codex:secondary", win("secondary", { label: "Weekly" }))];
	assert.equal(defaultMetric(codex)!.key, "codex:secondary");
	// A weekly limit for one model only isn't the default while a general one exists.
	const perModel = [metric("g:a", win("a", { label: "Weekly · Gemini", modelIds: ["gemini-x"] })), metric("g:b", win("b", { label: "Weekly" }))];
	assert.equal(defaultMetric(perModel)!.key, "g:b");
	assert.equal(defaultMetric([metric("g:a", win("a", { label: "Weekly · Gemini" })), metric("g:b", win("b", { label: "Weekly" }))])!.key, "g:b", "fewer separators wins");
	// The provider's own limits come before a hub account's.
	const hubbed = [metric("~hub:h:a:", win("seven_day"), { hub: { sourceId: "h", hubLabel: "H", driver: "Claude", name: "a" } }), ...codex];
	assert.equal(defaultMetric(hubbed)!.key, "codex:secondary");
	assert.equal(defaultMetric([metric("x:only", win("only", { kind: "monthly" }))])!.key, "x:only");
	assert.equal(defaultMetric([]), undefined);
});

test("empty states: why a key's limit isn't there", () => {
	const providers = parseProviders({
		providers: [
			{ instanceId: "opencode", driver: "opencode", usageLimits: { windows: [], unavailable: { reason: "unsupported" } } },
			{ instanceId: "cursor", driver: "cursor", usageLimits: { windows: [], unavailable: { reason: "probeFailed" } } },
			{ instanceId: "codex", driver: "codex", usageLimits: { windows: [] } },
			{ instanceId: "claudeAgent", driver: "claudeAgent", usageLimits: { windows: [win("seven_day")] } },
		],
	});
	const { accounts, hubs } = parseHubs(hubPayload());
	const all = [...providers, ...accounts];
	assert.deepEqual(emptyState(all, hubs, "opencode:weekly"), { name: "OpenCode", text: "No plan limits" });
	assert.deepEqual(emptyState(all, hubs, "cursor:weekly"), { name: "Cursor", text: "Couldn't read limits" });
	assert.deepEqual(emptyState(all, hubs, "codex:weekly"), { name: "Codex", text: "No limits reported" });
	assert.deepEqual(emptyState(all, hubs, "claudeAgent:gone"), { name: "Claude", text: "Limit not reported" });
	assert.equal(emptyState(all, hubs, "nobody:weekly"), undefined);
	assert.equal(emptyState(all, hubs, undefined), undefined);
	// A hub that failed: its accounts are gone, the key says so under the hub's name.
	assert.deepEqual(emptyState(all, hubs, hubKey("old-hub", "x.json") + ":primary"), { name: "Old Hub", text: "Hub unavailable" });
	assert.equal(emptyState(all, hubs, hubKey("acme-hub", "gone.json") + ":primary"), undefined, "a healthy hub without that account: generic");
	// An account whose probe failed is named by its hub (it has no plan), and says why.
	assert.deepEqual(emptyState(all, hubs, accounts[2]!.instanceId + ":primary"), { name: "Acme Hub", text: "Couldn't read limits" });
});

test("key with nothing to show says why instead of looking broken", () => {
	const svg = renderUsageKey({ metric: undefined, pace: undefined, ok: true, loading: false, empty: { name: "OpenCode", text: "No plan limits" } });
	assert.ok(svg.includes(">OPENCODE<") && svg.includes("No plan limits"));
	assert.ok(fontSizes(svg).every((n) => n >= MIN_FONT_PX));
	// Offline or loading still win: the reason would be stale.
	assert.ok(renderUsageKey({ metric: undefined, pace: undefined, ok: false, loading: false, empty: { name: "OpenCode", text: "No plan limits" } }).includes("T3 offline"));
	assert.ok(renderUsageKey({ metric: undefined, pace: undefined, ok: true, loading: false }).includes("No usage data"));
});

/** The ticket glyph is the only thing drawn with a dashed tear line. */
const hasTicket = (svg: string): boolean => svg.includes('stroke-dasharray="2 2"');

test("tickets on the bar style: a mark and the count, 'exp' only when it lapses within 3 days and there is room", () => {
	const bar = (count: number, expires?: number, over: { used?: number; ok?: boolean; now?: number } = {}): string => {
		const window = week(over.used ?? 40, 3);
		return renderUsageKey({
			metric: { key: "k", provider: "Claude", label: "Weekly", window, credits: { count, ...(expires === undefined ? {} : { nextExpiresAt: inDays(expires) }) } },
			pace: pace(window, now), ok: over.ok ?? true, loading: false, now: "now" in over ? over.now : now,
		});
	};
	const two = bar(2, 2);
	assert.ok(hasTicket(two) && two.includes(">2<") && two.includes(">exp 2d<"));
	assert.ok(fontSizes(two).every((n) => n >= MIN_FONT_PX), `font sizes ${fontSizes(two)}`);
	assert.ok(!bar(2, 5).includes("exp "), "beyond 3 days: just the ticket");
	assert.ok(!bar(2).includes("exp "), "no date, no expiry");
	assert.ok(!bar(2, 2, { now: undefined }).includes("exp "), "no clock, no expiry");
	assert.ok(!bar(2, -1).includes("exp "), "already lapsed");
	assert.ok(bar(2, 0.2).includes(">exp 4h<"), "hours when under a day");
	assert.ok(!bar(2, 2, { used: 100 }).includes("exp "), "three digits leave no room");
	assert.ok(!bar(2, 2, { ok: false }).includes("exp "), "stale numbers carry no expiry");
	assert.ok(bar(150).includes(">99+<"));
	// Nothing drawn for zero tickets, and nothing changes without credits.
	const none = renderUsageKey({ metric: { key: "k", provider: "Claude", label: "Weekly", window: week(40, 3), credits: { count: 0 } }, pace: pace(week(40, 3), now), ok: true, loading: false, now });
	const plain = renderUsageKey({ metric: { key: "k", provider: "Claude", label: "Weekly", window: week(40, 3) }, pace: pace(week(40, 3), now), ok: true, loading: false, now });
	assert.equal(none, plain);
	assert.ok(!hasTicket(plain));
});

test("tickets on the ring style: the count under the %, no expiry text, same legibility", () => {
	const ring = (count: number, used = 62): string => {
		const window = week(used, 3.5);
		return renderUsageKey({ metric: { key: "k", provider: "Claude", label: "Weekly", window, credits: { count, nextExpiresAt: inDays(1) } }, pace: pace(window, now), ok: true, loading: false, style: "ring", now });
	};
	const svg = ring(3);
	assert.ok(hasTicket(svg) && svg.includes(">3<") && svg.includes(">62<"));
	assert.ok(!svg.includes("exp "));
	assert.ok(fontSizes(svg).every((n) => n >= MIN_FONT_PX), `font sizes ${fontSizes(svg)}`);
	assert.ok(ring(120, 100).includes(">99+<"));
	const window = week(62, 3.5);
	const plain = renderUsageKey({ metric: { key: "k", provider: "Claude", label: "Weekly", window }, pace: pace(window, now), ok: true, loading: false, style: "ring", now });
	assert.equal(ring(0), plain, "a count of zero draws nothing");
	assert.ok(!hasTicket(plain));
});

// ---- the monitor, with a fake socket

type Script = (request: { tag: string; payload: unknown }, deliver: (frame: unknown) => void) => void;

class StreamSocket {
	sent: Record<string, unknown>[] = [];
	closed = false;
	onopen: (() => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;
	onclose: ((ev: { code: number }) => void) | null = null;
	onerror: (() => void) | null = null;
	readonly script: Script;
	/** `script` delivers frames once the request arrives. */
	constructor(script: Script) {
		this.script = script;
	}
	send(data: string): void {
		const msg = JSON.parse(data) as Record<string, unknown>;
		this.sent.push(msg);
		if (msg._tag === "Request") setImmediate(() => this.script({ tag: String(msg.tag), payload: msg.payload }, (f) => this.deliver(f)));
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		setImmediate(() => this.onclose?.({ code: 1000 }));
	}
	deliver(frame: unknown): void {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}
}

const chunk = (...values: unknown[]) => ({ _tag: "Chunk", requestId: "1", values });
const snapshotEvent = (providers: unknown[]) => ({ type: "snapshot", version: 1, config: { providers } });
const sourcesEvent = (sources: unknown[]) => ({ type: "usageLimitSourcesUpdated", version: 1, payload: { sources } });
const claudeProvider = { instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude", usageLimits: { checkedAt: "t1", windows: [win("seven_day", { label: "Weekly", usedPercent: 12 })], resetCredits: { availableCount: 1 } } };

class StreamAccess {
	sockets: StreamSocket[] = [];
	readonly scripts: Script[];
	constructor(scripts: Script[]) {
		this.scripts = scripts;
	}
	async open(): Promise<StreamSocket> {
		const ws = new StreamSocket(this.scripts[Math.min(this.sockets.length, this.scripts.length - 1)]!);
		this.sockets.push(ws);
		setImmediate(() => ws.onopen?.());
		return ws;
	}
}

const refreshed = (m: UsageMonitor): Promise<UsageSnapshot> => new Promise((resolve) => m.once("change", resolve));
const run = async (access: StreamAccess, steps: number): Promise<{ m: UsageMonitor; snaps: UsageSnapshot[] }> => {
	const m = new UsageMonitor(access as unknown as RpcAccess, { hubGraceMs: 30 });
	const snaps: UsageSnapshot[] = [];
	m.start();
	for (let i = 0; i < steps; i++) {
		const next = refreshed(m);
		if (i === 0) m.setWanted(true);
		else m.refresh();
		snaps.push(await next);
	}
	m.stop();
	return { m, snaps };
};

test("monitor: one short-lived subscription yields providers and hub accounts, acks chunks and closes", async () => {
	const access = new StreamAccess([(r, d) => {
		assert.equal(r.tag, "subscribeServerConfig");
		assert.deepEqual(r.payload, { usageLimitSources: true });
		d(chunk(snapshotEvent([claudeProvider])));
		d(chunk(sourcesEvent(hubPayload())));
	}]);
	const { snaps } = await run(access, 1);
	const snap = snaps[0]!;
	assert.equal(snap.ok, true);
	assert.deepEqual(snap.providers.map((p) => p.displayName), ["Claude", "Codex Plus", "Codex Pro", "Acme Hub", "Acme Hub", "Acme Hub"]);
	assert.equal(snap.providers[0]!.resetCredits?.count, 1);
	assert.equal(snap.hubs?.find((h) => h.id === "old-hub")?.error, true);
	assert.equal(access.sockets.length, 1, "no second socket");
	const ws = access.sockets[0]!;
	assert.equal(ws.sent.filter((f) => f._tag === "Ack").length, 2, "each chunk is acked");
	await new Promise((r) => setImmediate(r));
	assert.equal(ws.closed, true, "closed once it has what it needs");
});

test("monitor: an older server sends no sources event; providers show, hub accounts already known are kept", async () => {
	let n = 0;
	const access = new StreamAccess([(_r, d) => {
		d(chunk(snapshotEvent([claudeProvider])));
		if (++n === 1) d(chunk(sourcesEvent(hubPayload())));
	}]);
	const { snaps } = await run(access, 2);
	assert.equal(snaps[0]!.providers.length, 6);
	assert.equal(snaps[1]!.ok, true);
	assert.equal(snaps[1]!.providers.length, 6, "no news from the hub side keeps the last accounts");
	// An empty set, on the other hand, is news.
	const empty = new StreamAccess([(_r, d) => { d(chunk(snapshotEvent([claudeProvider]))); d(chunk(sourcesEvent([]))); }]);
	assert.deepEqual((await run(empty, 1)).snaps[0]!.providers.map((p) => p.instanceId), ["claudeAgent"]);
});

test("monitor: a failed stream falls back to server.getConfig once, with its own socket", async () => {
	const access = new StreamAccess([
		(_r, d) => d({ _tag: "Exit", requestId: "1", exit: { _tag: "Failure", cause: "nope" } }),
		(r, d) => {
			assert.equal(r.tag, "server.getConfig");
			d({ _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: { providers: [claudeProvider] } } });
		},
	]);
	const { snaps } = await run(access, 1);
	assert.equal(snaps[0]!.ok, true);
	assert.deepEqual(snaps[0]!.providers.map((p) => p.instanceId), ["claudeAgent"]);
	assert.equal(access.sockets.length, 2);
});

test("monitor: when both fail the key goes stale but keeps what it had", async () => {
	let first = true;
	const access = new StreamAccess([(_r, d) => {
		if (first) { first = false; d(chunk(snapshotEvent([claudeProvider]))); d(chunk(sourcesEvent(hubPayload()))); return; }
		d({ _tag: "Exit", requestId: "1", exit: { _tag: "Failure", cause: "down" } });
	}]);
	const { snaps } = await run(access, 2);
	assert.equal(snaps[1]!.ok, false);
	assert.equal(snaps[1]!.providers.length, 6);
});

test("readConfigStream: a snapshot alone resolves after the grace wait; no snapshot is an error; malformed frames are ignored", async () => {
	const lone = new StreamSocket((_r, d) => { d("not json"); d({ _tag: "Ping" }); d(chunk(null, 5, { type: "other" }, snapshotEvent([claudeProvider]))); });
	const p = readConfigStream(lone as unknown as WebSocket, 20);
	lone.onopen?.();
	const read = await p;
	assert.equal(read.hub, undefined);
	assert.equal(read.providers.length, 1);
	assert.ok(lone.sent.some((f) => f._tag === "Pong"));
	const none = new StreamSocket((_r, d) => d({ _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: null } }));
	const q = readConfigStream(none as unknown as WebSocket, 20);
	none.onopen?.();
	await assert.rejects(q, /ended/);
});
