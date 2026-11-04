/**
 * Renders the device carousel pictures on the site: the Thread Actions page on
 * the 15-key Stream Deck, the Stream Deck Neo and the Stream Deck Mini, each
 * drawn as a physical device in the visual language of the hero animation
 * (marketing/demo/render-demo.ts): a dark rounded slab, recessed key wells,
 * glossy key faces, a soft shadow and a faint reflection. No logos, and no
 * product photography: everything here is CSS.
 *
 *   nice -n 10 node --experimental-strip-types marketing/render-devices.ts
 *
 * Every key image comes from src/render.ts (renderActionKey, renderBackKey,
 * which draws the thread header through renderThreadKey), laid out exactly as
 * the bundled profiles in scripts/build-profile.mjs, with the plugin's default
 * quick messages (DEFAULT_MESSAGES). A message slot with no default message
 * stays dark, as it does on a real deck. The thread is invented.
 *
 * Output (docs/assets/devices/):
 *   <device>.webp   2080×1180, used by the site through <picture>
 *   <device>.png    1040×590, the fallback for browsers without WebP
 *
 * Needs the headless Chrome that T3 Code ships (~/.t3/tools/chrome-headless-shell,
 * or $CHROME) and cwebp (Homebrew `webp`). Scratch files go to /tmp/t3deck-devices/.
 * Re-run after changing a renderer or a bundled layout, then commit the images.
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ThreadCard } from "../src/model.ts";
import { renderActionKey, renderBackKey, type ActionKeyInput } from "../src/render.ts";
import { PROFILES } from "../scripts/build-profile.mjs";
import { EXAMPLE_MESSAGES } from "./quick-messages.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = process.env.DEVICES_SCRATCH ?? "/tmp/t3deck-devices";
const OUT = join(ROOT, "docs/assets/devices");
for (const d of [SCRATCH, OUT]) mkdirSync(d, { recursive: true });

const CHROME =
	process.env.CHROME ??
	execSync(`find "$HOME/.t3/tools/chrome-headless-shell" -name chrome-headless-shell -type f -perm +111 | head -1`, { encoding: "utf8", shell: "/bin/bash" }).trim();
if (!CHROME) throw new Error("headless Chrome not found; set $CHROME");

/** Screenshots an HTML file on a transparent background. `w`×`h` are CSS pixels. */
function shot(name: string, html: string, out: string, w: number, h: number, scale: number): void {
	const file = join(SCRATCH, `${name}.html`);
	writeFileSync(file, html);
	execFileSync(
		"nice",
		[
			"-n", "10", CHROME, "--disable-gpu", "--hide-scrollbars", "--no-sandbox",
			`--window-size=${w},${h}`, `--force-device-scale-factor=${scale}`, "--default-background-color=00000000",
			"--virtual-time-budget=2000", `--screenshot=${out}`, `file://${file}`,
		],
		{ stdio: ["ignore", "ignore", "ignore"] },
	);
}

// ---------------------------------------------------------------- keys

const ok = { kind: "ok" } as const;
/** Same clock as the other marketing renders, so spinners sit at the same angle. */
const BASE = Math.round(Date.parse("2026-11-03T12:00:00Z") / 50_400) * 50_400;
const QUICK_MESSAGES = EXAMPLE_MESSAGES;

type Profile = (typeof PROFILES)[number];
type Slot = string | { action: string; index: number };

/** The Thread Actions page of one bundled profile, row by row. */
function actionRows(profile: Profile): string[][] {
	const card: ThreadCard = {
		threadId: "t", projectId: "acme-web", title: "Add retry to checkout flow", link: "", state: "working", ownStatus: "running",
		subagentsWorking: 0, subagentsWaiting: 0, background: 0, inputFromSubagent: false, activeRunId: "run-1", context: { used: 74_000, max: 200_000 },
		ackKey: "", updatedAt: 0, createdAt: 0,
	};
	return (profile.actions as Slot[][]).map((row) =>
		row.map((slot) => {
			const setting = typeof slot === "string" ? { action: slot } : slot;
			if (setting.action === "back") return renderBackKey(false);
			const input: ActionKeyInput = {
				action: setting.action as ActionKeyInput["action"],
				card,
				message: "index" in setting ? QUICK_MESSAGES[setting.index]?.label : undefined,
				projectName: card.projectId,
				connection: ok,
				animation: "smooth",
				now: BASE + 1000,
			};
			return renderActionKey(input);
		}),
	);
}

// ---------------------------------------------------------------- devices

const KEY = 144;
const GAP = 34;

interface Device {
	out: string;
	profile: string;
	/** Body padding around the key grid: [top, sides, bottom], in key-image pixels. */
	pad: [number, number, number];
	radius: number;
	/** Height the body is drawn at in the 1040×590 frame; smaller decks are drawn smaller. */
	height: number;
	/** Neo: the info bar and two touch points under the keys. */
	infoBar?: boolean;
}

// Proportions follow the real decks' fronts: 15-key about 1.4:1, Mini about 1.4:1,
// Neo closer to square with its info bar row. Key size is the same on all three.
const DEVICES: Device[] = [
	{ out: "stream-deck-xl", profile: "Deck for T3 Code XL", pad: [110, 100, 110], radius: 64, height: 452 },
	{ out: "stream-deck", profile: "Deck for T3 Code", pad: [126, 104, 126], radius: 58, height: 436 },
	{ out: "stream-deck-neo", profile: "Deck for T3 Code Neo", pad: [96, 88, 64], radius: 58, height: 452, infoBar: true },
	{ out: "stream-deck-mini", profile: "Deck for T3 Code Mini", pad: [86, 86, 86], radius: 52, height: 372 },
];

const INFO_GAP = 34;
const INFO_H = 66;

const FRAME_W = 1040;
const FRAME_H = 590;

function deviceHtml(d: Device): { html: string; bodyW: number; bodyH: number } {
	const profile = PROFILES.find((p: { file: string }) => p.file === d.profile)! as Profile;
	const rows = actionRows(profile);
	const gridW = profile.columns * KEY + (profile.columns - 1) * GAP;
	const gridH = profile.rows * KEY + (profile.rows - 1) * GAP;
	const [top, side, bottom] = d.pad;
	const bodyW = gridW + 2 * side;
	const bodyH = top + gridH + (d.infoBar ? INFO_GAP + INFO_H : 0) + bottom;

	const keys = rows
		.flatMap((row, r) =>
			row.map((svg, c) => {
				const x = side + c * (KEY + GAP);
				const y = top + r * (KEY + GAP);
				return `<div class="well" style="left:${x - 7}px;top:${y - 7}px"></div><div class="key" style="left:${x}px;top:${y}px">${svg}<i></i></div>`;
			}),
		)
		.join("");

	let info = "";
	if (d.infoBar) {
		// Info bar between two round touch points, under the first and last columns. Left dark: nothing on it.
		const y = top + gridH + INFO_GAP;
		const pad = (c: number): string => `<div class="touch" style="left:${side + c * (KEY + GAP) + KEY / 2 - 27}px;top:${y + INFO_H / 2 - 27}px"></div>`;
		const barX = side + KEY + GAP - 4;
		const barW = 2 * KEY + GAP + 8;
		info = `${pad(0)}<div class="info" style="left:${barX}px;top:${y}px;width:${barW}px;height:${INFO_H}px"></div>${pad(profile.columns - 1)}`;
	}

	const scale = d.height / bodyH;
	const left = (FRAME_W - bodyW * scale) / 2;
	const topY = 44 + (452 - d.height) / 2; // the rest of the frame is room for the reflection

	const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
html,body{margin:0;width:${FRAME_W}px;height:${FRAME_H}px;overflow:hidden;background:transparent}
.floor{position:absolute;left:${FRAME_W / 2 - bodyW * scale * 0.48}px;top:${topY + d.height - 18}px;width:${bodyW * scale * 0.96}px;height:70px;border-radius:50%;
  background:radial-gradient(50% 50% at 50% 50%,#000000f0,#000000a0 45%,transparent 72%);filter:blur(10px)}
.glow{position:absolute;left:${FRAME_W / 2 - bodyW * scale * 0.42}px;top:${topY + d.height + 6}px;width:${bodyW * scale * 0.84}px;height:44px;border-radius:50%;
  background:radial-gradient(50% 50% at 50% 50%,oklch(0.72 0.15 252 / 0.16),transparent 70%)}
.dev{position:absolute;left:${left}px;top:${topY}px;width:${bodyW}px;height:${bodyH}px;transform:scale(${scale});transform-origin:0 0}
/* the reflection: the same device flipped under itself, faint and fading out fast, without its shadows */
.dev.refl{transform:translateY(${2 * d.height + 10}px) scale(${scale},${-scale});opacity:.16;
  -webkit-mask-image:linear-gradient(to top,#000 0%,#0006 7%,transparent 20%);mask-image:linear-gradient(to top,#000 0%,#0006 7%,transparent 20%)}
.refl .slab{box-shadow:0 0 0 1.5px #ffffff17,inset 0 1.5px 0 #ffffff2a}
.slab{position:absolute;inset:0;border-radius:${d.radius}px;
  background:linear-gradient(180deg,#1d1e23 0%,#141519 36%,#0c0d10 100%);
  box-shadow:0 0 0 1.5px #ffffff17,inset 0 1.5px 0 #ffffff2a,inset 0 -2px 0 #00000099,inset 0 0 0 1px #00000066,0 10px 0 -2px #08080a,0 10px 0 -1px #ffffff0d,0 36px 70px #000d}
.sheen{position:absolute;inset:0;border-radius:${d.radius}px;pointer-events:none;
  background:linear-gradient(112deg,transparent 16%,#ffffff0a 32%,#ffffff03 46%,transparent 58%);z-index:3}
.well{position:absolute;width:${KEY + 14}px;height:${KEY + 14}px;border-radius:26px;background:#030304;
  box-shadow:inset 0 3px 7px #000,inset 0 0 0 1px #000,0 1.5px 0 #ffffff14}
.key{position:absolute;width:${KEY}px;height:${KEY}px;border-radius:19px;overflow:hidden;background:#050506;
  box-shadow:0 2px 3px #000,0 0 0 1px #000c;z-index:2}
.key svg{display:block}
/* bevel: a lit top edge, a darker bottom one, and a gloss on the glass */
.key i{position:absolute;inset:0;border-radius:19px;
  background:linear-gradient(162deg,#ffffff17 0%,#ffffff06 30%,transparent 46%);
  box-shadow:inset 0 1.5px 0 #ffffff24,inset 0 -2px 0 #0000008c,inset 0 0 0 1px #ffffff0a}
.info{position:absolute;border-radius:14px;background:linear-gradient(180deg,#050608,#0a0b0e);
  box-shadow:inset 0 2px 6px #000,inset 0 0 0 1px #000,0 1.5px 0 #ffffff12}
.info::after{content:"";position:absolute;inset:4px;border-radius:10px;background:linear-gradient(165deg,#ffffff0d,transparent 40%)}
.touch{position:absolute;width:54px;height:54px;border-radius:50%;
  background:radial-gradient(circle at 50% 40%,#1a1b20,#0b0c0f 70%);
  box-shadow:inset 0 2px 4px #000,inset 0 0 0 1px #000,0 1.5px 0 #ffffff14}
.touch::after{content:"";position:absolute;inset:19px;border-radius:50%;box-shadow:0 0 0 1.5px #ffffff1f}
</style></head><body>
<div class="floor"></div><div class="glow"></div>
<div class="dev refl" aria-hidden="true"><div class="slab"></div>${keys}${info}</div>
<div class="dev"><div class="slab"></div>${keys}${info}<div class="sheen"></div></div>
</body></html>`;
	return { html, bodyW, bodyH };
}

for (const d of DEVICES) {
	const { html } = deviceHtml(d);
	const png2x = join(SCRATCH, `${d.out}@2x.png`);
	shot(d.out, html, png2x, FRAME_W, FRAME_H, 2);
	execFileSync("nice", ["-n", "10", "cwebp", "-quiet", "-q", "90", "-alpha_q", "100", "-m", "6", "-sharp_yuv", png2x, "-o", join(OUT, `${d.out}.webp`)]);
	shot(`${d.out}-1x`, html, join(OUT, `${d.out}.png`), FRAME_W, FRAME_H, 1);
	console.log(`wrote docs/assets/devices/${d.out}.webp and .png`);
}
