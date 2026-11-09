/**
 * Renders the device carousel pictures on the site: the Thread Actions page on
 * the Stream Deck XL, the 15-key Stream Deck, the Stream Deck Neo and the
 * Stream Deck Mini, each on Elgato's own device preview from their official
 * Stream Deck Templates Figma file (marketing/device-template.ts; Elgato's
 * guidelines ask for official resources wherever their hardware is shown), with
 * the plugin's key images under the template's glass and a soft shadow under
 * the device.
 *
 *   nice -n 10 node --experimental-strip-types marketing/render-devices.ts
 *
 * Every key image comes from src/render.ts (renderActionKey, renderBackKey,
 * which draws the thread header through renderThreadKey), laid out exactly as
 * the bundled profiles in scripts/build-profile.mjs, with the plugin's default
 * quick messages (DEFAULT_MESSAGES), in the screen colours of the other
 * marketing pictures (screen-colors.ts). A message slot with no default message
 * stays dark, as it does on a real deck. The thread is invented. The Neo's
 * info bar is left dark.
 *
 * Output (docs/assets/devices/):
 *   <device>.webp   2080×1180, used by the site through <picture>
 *   <device>.png    1040×590, the fallback for browsers without WebP
 *
 * Needs macOS for SF Pro (the key text), the headless Chrome that T3 Code ships
 * (~/.t3/tools/chrome-headless-shell, or $CHROME) and cwebp (Homebrew `webp`).
 * Scratch files go to /tmp/t3deck-devices/. Re-run after changing a renderer or
 * a bundled layout, then commit the images.
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ThreadCard } from "../src/model.ts";
import { renderActionKey, renderBackKey, type ActionKeyInput } from "../src/render.ts";
import { PROFILES } from "../scripts/build-profile.mjs";
import { EXAMPLE_MESSAGES } from "./quick-messages.ts";
import { MINI, MK2, NEO, TEMPLATE_CSS, templateDeck, templateHeight, XL, type TemplateDevice } from "./device-template.ts";
import { soften } from "./screen-colors.ts";

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

interface Device {
	out: string;
	profile: string;
	device: TemplateDevice;
	/** Height the device is drawn at in the 1040×590 frame; smaller decks are drawn smaller. */
	height: number;
}

const DEVICES: Device[] = [
	{ out: "stream-deck-xl", profile: "Deck for T3 Code XL", device: XL, height: 440 },
	{ out: "stream-deck", profile: "Deck for T3 Code", device: MK2, height: 440 },
	{ out: "stream-deck-neo", profile: "Deck for T3 Code Neo", device: NEO, height: 430 },
	{ out: "stream-deck-mini", profile: "Deck for T3 Code Mini", device: MINI, height: 390 },
];

const FRAME_W = 1040;
const FRAME_H = 590;

function deviceHtml(d: Device): string {
	const profile = PROFILES.find((p: { file: string }) => p.file === d.profile)! as Profile;
	const keys = actionRows(profile).flat().map(soften);
	const width = Math.round((d.height * d.device.w) / d.device.h);
	const height = templateHeight(d.device, width);
	const left = (FRAME_W - width) / 2;
	const top = 44 + (452 - height) / 2; // the rest of the frame is room for the shadow
	return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
html,body{margin:0;width:${FRAME_W}px;height:${FRAME_H}px;overflow:hidden;background:transparent}
${TEMPLATE_CSS}
.floor{position:absolute;left:${FRAME_W / 2 - width * 0.46}px;top:${top + height - 22}px;width:${width * 0.92}px;height:60px;border-radius:50%;
  background:radial-gradient(50% 50% at 50% 50%,#000000d0,#00000080 45%,transparent 72%);filter:blur(10px)}
.glow{position:absolute;left:${FRAME_W / 2 - width * 0.4}px;top:${top + height + 4}px;width:${width * 0.8}px;height:40px;border-radius:50%;
  background:radial-gradient(50% 50% at 50% 50%,oklch(0.72 0.15 252 / 0.14),transparent 70%)}
.dev{position:absolute;left:${left}px;top:${top}px}
</style></head><body>
<div class="floor"></div><div class="glow"></div>
<div class="dev">${templateDeck(d.device, keys, width)}</div>
</body></html>`;
}

for (const d of DEVICES) {
	const html = deviceHtml(d);
	const png2x = join(SCRATCH, `${d.out}@2x.png`);
	shot(d.out, html, png2x, FRAME_W, FRAME_H, 2);
	execFileSync("nice", ["-n", "10", "cwebp", "-quiet", "-q", "90", "-alpha_q", "100", "-m", "6", "-sharp_yuv", png2x, "-o", join(OUT, `${d.out}.webp`)]);
	shot(`${d.out}-1x`, html, join(OUT, `${d.out}.png`), FRAME_W, FRAME_H, 1);
	console.log(`wrote docs/assets/devices/${d.out}.webp and .png`);
}
