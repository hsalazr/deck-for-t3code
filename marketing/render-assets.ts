/**
 * Regenerates every picture used by the site (docs/assets), the README and the
 * Marketplace listing (marketing/) from the plugin's own renderers.
 *
 *   node --experimental-strip-types marketing/render-assets.ts
 *
 * It imports src/render.ts, feeds it invented data (acme-* projects, made-up
 * thread titles), lays the keys out on a Stream Deck XL mock-up, and
 * rasterises the result with the headless Chrome that T3 Code ships
 * (~/.t3/tools/chrome-headless-shell), or the binary named by $CHROME.
 * Scratch files go to /tmp/t3deck-docs2/. `ONLY=icons` renders just the icons.
 *
 * The Thread Actions pages are laid out from the same PROFILES table that
 * builds the bundled profiles (scripts/build-profile.mjs), and the quick
 * messages go through the plugin's own parser, so the pictures can't drift
 * from what the plugin ships. Re-run this after any change to the renderers
 * or the profile layouts, then commit the refreshed PNGs.
 *
 * Needs macOS (uses `sips` to crop sheets) and Node 22+ (type stripping).
 * Run it niced on a busy machine: `nice -n 10 node --experimental-strip-types …`.
 */
import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseQuickMessages, type ThreadCard } from "../src/model.ts";
import { renderActionKey, renderBackKey, renderOverview, renderThreadKey, renderUsageKey, type ActionKeyInput } from "../src/render.ts";
import { pace, type UsageMetric } from "../src/usage.ts";
import { PROFILES } from "../scripts/build-profile.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = "/tmp/t3deck-docs2";
const ASSETS = join(ROOT, "docs/assets");
const KEYS = join(ASSETS, "keys");
const MARKETING = ROOT + "/marketing";
const ICONS = join(MARKETING, "icon");
for (const d of [SCRATCH, ASSETS, KEYS, MARKETING, ICONS]) mkdirSync(d, { recursive: true });

// ---------------------------------------------------------------- headless Chrome

const CHROME =
	process.env.CHROME ??
	execSync(`find "$HOME/.t3/tools/chrome-headless-shell" -name chrome-headless-shell -type f -perm +111 | head -1`, { encoding: "utf8", shell: "/bin/bash" }).trim();
if (!CHROME) throw new Error("headless Chrome not found; set $CHROME");

/** Screenshots an HTML string. `w`×`h` are CSS pixels; the PNG is scaled by `scale`. */
function shot(name: string, html: string, out: string, w: number, h: number, scale = 1, transparent = false): void {
	const file = join(SCRATCH, `${name}.html`);
	writeFileSync(file, html);
	execFileSync(
		"nice",
		[
			"-n", "10", CHROME, "--disable-gpu", "--hide-scrollbars", "--no-sandbox",
			`--window-size=${w},${h}`, `--force-device-scale-factor=${scale}`,
			`--default-background-color=${transparent ? "00000000" : "ff000000"}`,
			"--virtual-time-budget=2000", `--screenshot=${out}`, `file://${file}`,
		],
		{ stdio: ["ignore", "ignore", "ignore"] },
	);
}

/** Crops a region (device pixels) out of a PNG with sips. */
function crop(src: string, dst: string, x: number, y: number, w: number, h: number): void {
	execFileSync("sips", ["-c", String(h), String(w), "--cropOffset", String(y), String(x), src, "--out", dst], { stdio: "ignore" });
}

// ---------------------------------------------------------------- invented data

const ok = { kind: "ok" } as const;
/** A clock that sits on a multiple of every flash/spin period, so `BASE + t` behaves like `t`. */
const BASE = Math.round(Date.parse("2026-11-03T12:00:00Z") / 50_400) * 50_400;

interface Spec {
	title: string;
	project: string;
	state: ThreadCard["state"];
	t?: number;
	subagents?: number;
	background?: number;
	waitingOn?: string;
	ctx?: number;
	pausedIn?: number;
	subagentAsks?: boolean;
}

function threadKey(s: Spec, i = 0, showLabel = false): string {
	const now = BASE + (s.t ?? (i * 337) % 2400);
	const own = s.state === "input" ? "waiting" : s.state === "working" ? (s.background && !s.subagents ? "completed" : "running") : s.state === "done" ? "completed" : s.state === "failed" ? "failed" : "idle";
	const card: ThreadCard = {
		threadId: s.title, projectId: s.project, title: s.title, link: "", state: s.state, ownStatus: own,
		subagentsWorking: s.subagents ?? 0, subagentsWaiting: s.subagentAsks ? 1 : 0, background: s.background ?? 0,
		inputFromSubagent: Boolean(s.subagentAsks), waitingOn: s.waitingOn,
		pausedUntil: s.pausedIn ? now + s.pausedIn : undefined,
		context: s.ctx === undefined ? undefined : { used: s.ctx * 2000, max: 200_000 },
		ackKey: "", updatedAt: 0, createdAt: 0,
	};
	return renderThreadKey({ card, projectName: s.project, connection: ok, animation: "smooth", now, showLabel });
}

const T = (title: string, project: string, state: Spec["state"], extra: Partial<Spec> = {}): Spec => ({ title, project, state, ...extra });

/** 24 invented threads for the hero deck, in deck order. */
const HERO_THREADS: Spec[] = [
	T("Add retry to checkout flow", "acme-web", "input", { t: 0 }),
	T("Paginate the orders endpoint", "acme-api", "working", { ctx: 19 }),
	T("Cache CI artifacts", "acme-infra", "working", { subagents: 2, ctx: 36 }),
	T("Fix flaky login test", "acme-web", "done"),
	T("Migrate docs to new wiki", "acme-docs", "working", { ctx: 11 }),
	T("Upgrade to Node 24", "acme-api", "working", { background: 1, waitingOn: "PR #42 CI", ctx: 48 }),
	T("Rate-limit the public API", "acme-api", "idle"),
	T("Add dark mode toggle", "acme-web", "working"),
	T("Trim Docker image size", "acme-infra", "input", { t: 600 }),
	T("Rotate staging secrets", "acme-infra", "paused", { pausedIn: 2 * 3_600_000 + 10 * 60_000 }),
	T("Add CSV export to reports", "acme-web", "working", { subagents: 1, ctx: 88 }),
	T("Fix timezone bug in reports", "acme-api", "idle"),
	T("Write the onboarding guide", "acme-docs", "working", { ctx: 27 }),
	T("Clean up old feature flags", "acme-web", "done"),
	T("Speed up image uploads", "acme-api", "working", { background: 1, waitingOn: "PR #57 CI", ctx: 63 }),
	T("Add Playwright smoke tests", "acme-web", "working", { ctx: 55 }),
	T("Review the webhook handler", "acme-api", "idle"),
	T("Add an audit log", "acme-api", "working", { ctx: 31 }),
	T("Reduce cold start time", "acme-infra", "idle"),
	T("Refactor invoice emails", "acme-api", "working", { ctx: 42 }),
	T("Document the release process", "acme-docs", "idle"),
	T("Add i18n to the signup page", "acme-web", "working", { subagents: 1 }),
	T("Set up Renovate for the monorepo", "acme-infra", "idle"),
	T("Fix 500 on empty cart", "acme-web", "idle"),
];

function metric(id: string, label: string, usedPercent: number, windowMins: number, elapsedPercent: number): UsageMetric {
	const resetsAt = new Date(BASE + (1 - elapsedPercent / 100) * windowMins * 60_000).toISOString();
	const window = { id, label, usedPercent, resetsAt, windowDurationMins: windowMins };
	return { key: `acme:${id}`, provider: "Claude", label, window };
}
const usageKey = (m: UsageMetric, style: "bar" | "ring"): string => renderUsageKey({ metric: m, pace: pace(m.window, BASE), ok: true, loading: false, style });
const WEEKLY_AHEAD = metric("seven_day", "Weekly", 64, 10_080, 52);
const WEEKLY_UNDER = metric("seven_day", "Weekly", 38, 10_080, 57);
const FIVE_HOUR = metric("five_hour", "5-hour", 31, 300, 48);
const WEEKLY_HOT = metric("seven_day", "Weekly", 93, 10_080, 71);

const overviewKey = (counts: Partial<Record<"input" | "failed" | "done" | "working" | "background" | "idle", number>>, overflow: number, t: number): string =>
	renderOverview({ connection: ok, counts: { input: 0, failed: 0, done: 0, working: 0, background: 0, idle: 0, ...counts }, overflow, animation: "smooth", now: BASE + t });

const emptyKey = (): string => renderThreadKey({ card: undefined, projectName: "", connection: ok, animation: "smooth", now: BASE });

// ---------------------------------------------------------------- shared page styling

const ACCENT = "#6a96f5";
const SANS = `-apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", "Helvetica Neue", Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, "SF Mono", Menlo, monospace`;
const BASE_CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#000;color:#f5f5f5;font-family:${SANS};-webkit-font-smoothing:antialiased}
.deck{display:grid;gap:16px;padding:40px;border-radius:36px;
  background:linear-gradient(180deg,#17171b,#0d0d10);box-shadow:0 0 0 1px #ffffff1a,inset 0 1px 0 #ffffff14,0 50px 120px #000c}
.deck .k{width:144px;height:144px;border-radius:14px;overflow:hidden;background:#050506;box-shadow:0 0 0 1px #00000099}
.deck .k svg{display:block}
.glow{position:absolute;inset:0;background:radial-gradient(60% 55% at 50% 40%,#6a96f533,transparent 70%);z-index:0}
.stage{position:relative;overflow:hidden}
.stage>*:not(.glow){position:relative;z-index:1}
h1,h2,p{margin:0}
.muted{color:#a3a3a3}
.pill{display:inline-block;padding:6px 14px;border:1px solid #ffffff24;border-radius:999px;font-size:20px;color:#a3a3a3;background:#0d0d0d}
`;

const deck = (keys: string[], columns = 8): string => `<div class="deck" style="grid-template-columns:repeat(${columns},144px)">${keys.map((k) => `<div class="k">${k}</div>`).join("")}</div>`;

// ---------------------------------------------------------------- decks

/** Overview, two Usage tiles, then 24 threads; the rest of the XL stays empty. */
function heroKeys(): string[] {
	const keys = [
		overviewKey({ input: 2, done: 2, working: 12, background: 2, idle: 8 }, 0, 0), // 24 threads, all on keys: no overflow
		usageKey(WEEKLY_AHEAD, "bar"),
		usageKey(FIVE_HOUR, "ring"),
		...HERO_THREADS.map((s, i) => threadKey(s, i + 3)),
	];
	while (keys.length < 32) keys.push(emptyKey());
	return keys;
}

/** Quick messages as a user would type them in the settings: one per line, `Label | full text` allowed. */
const QUICK_MESSAGES = parseQuickMessages(`continue
run the tests and report
summarize where you are
Open PR | open a pull request for this branch
address the review comments
merge if CI is green
write a handoff file
add tests for this
explain the last change
check for flaky tests
rebase on main
update the changelog
list open TODOs`);

/** The Thread Actions page of one bundled profile for one thread, key by key, in reading order. */
function actionKeys(profile: (typeof PROFILES)[number]): string[] {
	const thread: ThreadCard = {
		threadId: "t", projectId: "acme-web", title: "Add retry to checkout flow", link: "", state: "working", ownStatus: "running",
		subagentsWorking: 0, subagentsWaiting: 0, background: 0, inputFromSubagent: false, activeRunId: "run-1", context: { used: 74_000, max: 200_000 },
		ackKey: "", updatedAt: 0, createdAt: 0,
	};
	const base = { card: thread, projectName: "acme-web", connection: ok, animation: "smooth", now: BASE + 1000 } as const;
	const keys: string[] = [];
	for (const row of profile.actions as (string | { action: string; index: number })[][]) {
		for (const slot of row) {
			const setting = typeof slot === "string" ? { action: slot } : slot;
			if (setting.action === "back") keys.push(renderBackKey(false));
			else keys.push(renderActionKey({ ...base, action: setting.action as ActionKeyInput["action"], message: "index" in setting ? QUICK_MESSAGES[setting.index]?.label : undefined }));
		}
	}
	return keys;
}

const profileFor = (file: string): (typeof PROFILES)[number] => PROFILES.find((p: { file: string }) => p.file === file)!;

// ---------------------------------------------------------------- key legend (site)

interface Legend { file: string; svg: string }
const LEGEND: Legend[] = [
	{ file: "needs-you", svg: threadKey(T("Add retry to checkout flow", "acme-web", "input", { t: 0 })) },
	{ file: "failed", svg: threadKey(T("Cache build artifacts in CI", "acme-infra", "failed", { t: 0 })) },
	{ file: "done", svg: threadKey(T("Fix flaky login test", "acme-web", "done")) },
	{ file: "working", svg: threadKey(T("Paginate the orders endpoint", "acme-api", "working", { t: 600, ctx: 23 })) },
	{ file: "subagents", svg: threadKey(T("Migrate docs to new wiki", "acme-docs", "working", { t: 1500, subagents: 2, ctx: 41 })) },
	{ file: "background", svg: threadKey(T("Upgrade to Node 24", "acme-api", "working", { t: 300, background: 1, waitingOn: "PR #42 CI", ctx: 48 })) },
	{ file: "limit", svg: threadKey(T("Rotate staging secrets", "acme-infra", "paused", { pausedIn: 2 * 3_600_000 + 10 * 60_000 })) },
	{ file: "idle", svg: threadKey(T("Document the release process", "acme-docs", "idle", { ctx: 12 })) },
	{ file: "context-high", svg: threadKey(T("Add CSV export to reports", "acme-web", "working", { t: 900, ctx: 88 })) },
	{ file: "overview", svg: overviewKey({ input: 2, done: 2, working: 12, background: 2, idle: 8 }, 3, 0) },
	{ file: "overview-working", svg: overviewKey({ working: 5, idle: 4 }, 0, 800) },
	{ file: "usage-bar", svg: usageKey(WEEKLY_AHEAD, "bar") },
	{ file: "usage-bar-under", svg: usageKey(WEEKLY_UNDER, "bar") },
	{ file: "usage-bar-hot", svg: usageKey(WEEKLY_HOT, "bar") },
	{ file: "usage-ring", svg: usageKey(WEEKLY_UNDER, "ring") },
	{ file: "usage-ring-5h", svg: usageKey(FIVE_HOUR, "ring") },
	{ file: "usage-ring-hot", svg: usageKey(WEEKLY_HOT, "ring") },
	{ file: "back", svg: renderBackKey(false) },
	{ file: "back-attention", svg: renderBackKey(true) },
	{ file: "back-more", svg: renderBackKey(true, 4) },
];

/** One screenshot of all keys at 2×, cropped into 288×288 PNGs. */
function renderKeyPngs(): void {
	const cols = 6;
	const rows = Math.ceil(LEGEND.length / cols);
	// The sheet starts one empty row down: sips treats a crop offset of 0,0 as "centre".
	const html = `<style>body{margin:0;background:#000;display:grid;grid-template-columns:repeat(${cols},144px)}svg{display:block}</style><div style="grid-column:1/-1;height:144px"></div>${LEGEND.map((l) => l.svg).join("")}`;
	const sheet = join(SCRATCH, "key-sheet.png");
	shot("key-sheet", html, sheet, cols * 144, (rows + 1) * 144, 2);
	LEGEND.forEach((l, i) => crop(sheet, join(KEYS, `${l.file}.png`), (i % cols) * 288, (Math.floor(i / cols) + 1) * 288, 288, 288));
}

// ---------------------------------------------------------------- icons (own mark; no T3 artwork)

/** The plugin mark: four keys, one amber, one with a spinner, one green, one idle. */
const markSvg = (size: number, radius = 0): string => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
<rect width="256" height="256" rx="${radius}" fill="#0b0c0f"/>
<rect x="30" y="30" width="92" height="92" rx="20" fill="#F5A524"/>
<rect x="134" y="30" width="92" height="92" rx="20" fill="#1a1e25"/>
<circle cx="180" cy="76" r="22" fill="none" stroke="#5B9CFF" stroke-width="9" opacity=".28"/>
<path d="M180 54 A22 22 0 0 1 202 76" fill="none" stroke="#5B9CFF" stroke-width="9" stroke-linecap="round"/>
<rect x="30" y="134" width="92" height="92" rx="20" fill="#3DD68C"/>
<rect x="134" y="134" width="92" height="92" rx="20" fill="#1a1e25"/>
<path d="M154 168h52M154 190h32" stroke="#f4f5f7" stroke-width="9" stroke-linecap="round"/>
</svg>`;

const W = "#FFFFFF";
const stroke = (width = 1.7, extra = ""): string => `fill="none" stroke="${W}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${extra ? " " + extra : ""}`;
/** White-on-transparent glyphs, drawn on a 20×20 grid (category icon: 28×28). */
const GLYPHS: Record<string, { size: number; body: string }> = {
	category: {
		size: 28,
		body: `<rect x="4" y="4" width="8.5" height="8.5" rx="2.4" fill="${W}"/><rect x="15.5" y="4" width="8.5" height="8.5" rx="2.4" ${stroke(2)}/><rect x="4" y="15.5" width="8.5" height="8.5" rx="2.4" ${stroke(2)}/><rect x="15.5" y="15.5" width="8.5" height="8.5" rx="2.4" ${stroke(2)}/>`,
	},
	thread: {
		size: 20,
		body: `<rect x="2.5" y="2.5" width="15" height="15" rx="4" ${stroke()}/><circle cx="6.6" cy="6.8" r="1.5" fill="${W}"/><path d="M5.8 11h8.4M5.8 14h5.4" ${stroke()}/>`,
	},
	overview: {
		size: 20,
		body: `<circle cx="4.6" cy="5" r="1.5" fill="${W}"/><circle cx="4.6" cy="10" r="1.5" fill="${W}"/><circle cx="4.6" cy="15" r="1.5" fill="${W}"/><path d="M9 5h7.5M9 10h7.5M9 15h5" ${stroke()}/>`,
	},
	usage: {
		size: 20,
		body: `<circle cx="10" cy="10" r="7" ${stroke(1.7, 'opacity=".45"')}/><path d="M10 3a7 7 0 1 1-6.1 10.4" ${stroke()}/><path d="M10 10l3.2-3.4" ${stroke()}/><circle cx="10" cy="10" r="1.2" fill="${W}"/>`,
	},
	back: {
		size: 20,
		body: `<path d="M12.5 4 6.5 10l6 6" ${stroke(2.2)}/>`,
	},
};
const glyphSvg = (name: string): string => {
	const { size, body } = GLYPHS[name]!;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`;
};

function renderIcons(): void {
	// Plugin icon (opaque, square).
	shot("plugin-256", `<style>body{margin:0}</style>${markSvg(256)}`, join(ICONS, "plugin-256.png"), 256, 256);
	shot("plugin-512", `<style>body{margin:0}</style>${markSvg(512)}`, join(ICONS, "plugin-512.png"), 512, 512);
	writeFileSync(join(ICONS, "plugin.svg"), markSvg(256));
	// Category and action-list icons: 1× and 2× from one sheet each.
	const names = Object.keys(GLYPHS);
	const cell = 32;
	const html = `<style>body{margin:0;background:transparent}svg{display:block}</style>${names.map((n, i) => `<div style="position:absolute;top:${i * cell}px;left:${cell}px">${glyphSvg(n)}</div>`).join("")}`;
	for (const [scale, suffix] of [[1, ""], [2, "@2x"]] as const) {
		const sheet = join(SCRATCH, `glyphs${suffix}.png`);
		shot(`glyphs${suffix}`, html, sheet, cell * 2, names.length * cell, scale, true);
		names.forEach((n, i) => {
			const px = GLYPHS[n]!.size * scale;
			crop(sheet, join(ICONS, `${n}${suffix}.png`), cell * scale, i * cell * scale, px, px); // x offset: sips reads 0,0 as "centre"
		});
	}
	for (const n of names) writeFileSync(join(ICONS, `${n}.svg`), glyphSvg(n));
	// Site: favicon and touch icon.
	writeFileSync(join(ASSETS, "favicon.svg"), markSvg(64, 56));
	copyFileSync(join(ICONS, "plugin-256.png"), join(ASSETS, "icon-256.png"));
}

// ---------------------------------------------------------------- Stream Deck frame shots

/** Outer size of a mock-up deck with this many keys across and down. */
const deckW = (columns: number): number => columns * 144 + (columns - 1) * 16 + 80;
const deckH = (rows: number): number => rows * 144 + (rows - 1) * 16 + 80;
const DECK_W = deckW(8); // 1360
const DECK_H = deckH(4); // 704

function renderDeckShots(): void {
	const hero = heroKeys();
	const actions = actionKeys(profileFor("Deck for T3 Code XL"));
	// Site images: just the deck, on transparent, at 2×.
	const bare = (keys: string[], columns = 8): string => `<style>${BASE_CSS}body{background:transparent;padding:0}.deck{box-shadow:0 0 0 1px #ffffff1a,inset 0 1px 0 #ffffff14}</style>${deck(keys, columns)}`;
	shot("hero", bare(hero), join(ASSETS, "hero.png"), DECK_W, DECK_H, 2, true);
	shot("actions-page", bare(actions), join(ASSETS, "thread-actions.png"), DECK_W, DECK_H, 2, true);
	// The same page on the other decks that ship one, straight from the bundled layouts.
	for (const [file, name] of [["Deck for T3 Code", "thread-actions-sd"], ["Deck for T3 Code Neo", "thread-actions-neo"], ["Deck for T3 Code Mini", "thread-actions-mini"]] as const) {
		const p = profileFor(file);
		shot(name, bare(actionKeys(p), p.columns), join(ASSETS, `${name}.png`), deckW(p.columns), deckH(p.rows), 2, true);
	}

	// Marketplace images (1920×960, black stage, glow, headline).
	const stage = (inner: string, css = ""): string => `<style>${BASE_CSS}${css}</style><div class="stage" style="width:1920px;height:960px"><div class="glow"></div>${inner}</div>`;
	const heading = (h: string, sub: string, align = "center", pad = true): string =>
		`<div style="text-align:${align};padding:${align === "center" && pad ? "64px 0 0" : "0"}"><h1 style="font-size:76px;font-weight:700;letter-spacing:-.025em;line-height:1.05">${h}</h1><p class="muted" style="font-size:30px;margin-top:14px">${sub}</p></div>`;
	const centered = (keys: string[], h: string, sub: string): string =>
		stage(`${heading(h, sub)}<div style="position:absolute;left:${(1920 - DECK_W) / 2}px;top:${960 - DECK_H - 44}px">${deck(keys)}</div>`);

	shot("thumbnail", centered(hero, "Deck for T3 Code", "Every thread on a key. Glance, tap, move on."), join(MARKETING, "thumbnail.png"), 1920, 960);
	shot("gallery-2", centered(actions, "Hold a key. Steer the thread.", "Quick messages, compact, snooze, settle and stop. The risky ones need a hold."), join(MARKETING, "gallery-2-thread-actions.png"), 1920, 960);

	// Gallery 1: the states.
	const states: [string, string, string][] = [
		["needs-you", "Needs you", "Amber blink"],
		["failed", "Failed", "Red blink"],
		["done", "Done", "Solid green"],
		["working", "Working", "Blue spinner"],
		["background", "Waiting on CI", "White spinner"],
		["limit", "Usage limit", "Resume time shown"],
		["subagents", "Subagents", "Folded into one key"],
		["idle", "Idle", "Nothing happening"],
	];
	const cells = states
		.map(([f, t, s]) => `<figure style="margin:0;text-align:center"><img src="file://${join(KEYS, f)}.png" width="192" height="192" style="border-radius:20px;display:block;box-shadow:0 0 0 1px #ffffff1a"><figcaption style="margin-top:18px;font-size:26px;font-weight:650">${t}</figcaption><div class="muted" style="font-size:20px;margin-top:4px">${s}</div></figure>`)
		.join("");
	shot(
		"gallery-1",
		stage(`<div style="display:flex;flex-direction:column;justify-content:center;height:960px">${heading("See who needs you.", "One glance tells you which agent is working, stuck, or done.", "center", false)}<div style="display:grid;grid-template-columns:repeat(4,192px);gap:54px 64px;justify-content:center;margin-top:56px">${cells}</div></div>`),
		join(MARKETING, "gallery-1-states.png"), 1920, 960,
	);

	// Gallery 3: Usage tiles.
	const big = (f: string, caption: string): string =>
		`<figure style="margin:0;text-align:center"><img src="file://${join(KEYS, f)}.png" width="288" height="288" style="border-radius:28px;display:block;box-shadow:0 0 0 1px #ffffff1a"><figcaption class="muted" style="margin-top:18px;font-size:22px">${caption}</figcaption></figure>`;
	shot(
		"gallery-3",
		stage(
			`<div style="display:flex;align-items:center;justify-content:center;gap:96px;height:960px">
<div style="width:640px">${heading("Pace your limits.", "A bar or a ring for any usage limit T3 Code reports. The white tick marks even pace, so you see if you're ahead or under.", "left")}</div>
<div style="display:flex;gap:40px">${big("usage-bar", "Bar · 12% ahead")}${big("usage-ring-5h", "Ring · 5-hour limit")}${big("usage-ring", "Ring · weekly, a segment per day")}</div></div>`,
		),
		join(MARKETING, "gallery-3-usage.png"), 1920, 960,
	);

	// Gallery 4: how it works.
	const box = (title: string, lines: string[], accent = false): string =>
		`<div style="width:460px;padding:36px 36px 40px;border-radius:16px;background:#0d0d0d;border:1px solid ${accent ? "#6a96f566" : "#ffffff1a"}"><div style="font-size:34px;font-weight:700">${title}</div>${lines.map((l) => `<div class="muted" style="font-size:24px;margin-top:12px">${l}</div>`).join("")}</div>`;
	const token = (title: string, sub: string): string => `<div style="width:330px;padding:22px 26px;border-radius:14px;background:#0d0d0d;border:1px solid #ffffff1a"><div style="font-size:26px;font-weight:650">${title}</div><div class="muted" style="font-size:20px;margin-top:6px">${sub}</div></div>`;
	const arrow = (label: string): string => `<div style="text-align:center;width:130px"><div style="font-size:19px;color:#a3a3a3;margin-bottom:6px">${label}</div><svg width="130" height="24" viewBox="0 0 130 24"><path d="M2 12h122M114 4l10 8-10 8" fill="none" stroke="${ACCENT}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`;
	shot(
		"gallery-4",
		stage(
			`<div style="display:flex;flex-direction:column;justify-content:center;height:960px">${heading("Stays on your Mac.", "No cloud, no account, no telemetry. The plugin only talks to the T3 Code app running on this machine.", "center", false)}
<div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-top:70px">
${box("T3 Code", ["Your local server", "Threads, runs, usage"])}${arrow("localhost")}${box("Deck for T3 Code", ["Three scoped tokens", "Two read-only, one opt-in"], true)}${arrow("keys")}${box("Stream Deck", ["Status on every key", "Tap, hold, done"])}</div>
<div style="display:flex;justify-content:center;gap:24px;margin-top:40px">${token("Threads", "Read-only, 30 days")}${token("Live status and usage", "Read-only, 30 days")}${token("Thread Actions", "Opt-in, 24 hours")}</div>
<div style="text-align:center;margin-top:48px"><span class="pill">macOS only · needs T3 Code installed</span></div></div>`,
		),
		join(MARKETING, "gallery-4-how-it-works.png"), 1920, 960,
	);

	// Open Graph image for the site.
	copyFileSync(join(MARKETING, "thumbnail.png"), join(ASSETS, "og.png"));
}

// ---------------------------------------------------------------- run

// ONLY=icons regenerates just the icons (and favicon); useful after touching the glyphs.
const only = process.env.ONLY;
if (!only) renderKeyPngs();
if (!only || only === "icons") renderIcons();
if (!only) renderDeckShots();
console.log("assets written to docs/assets and marketing/");
