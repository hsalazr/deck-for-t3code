// Builds the bundled "Deck for T3 Code" profiles, one per device type, installed with the plugin.
// Each has two pages:
//   page 0 · T3 Threads: Back (to your profile) in the top-left, Thread tiles everywhere else.
//   page 1 · Thread Actions: Back (to page 0), the thread, then the actions that fit,
//            with the destructive ones (Settle, Stop) last, in the bottom-right corner.
// Both pages live in one profile so the Threads page's Back still returns to your own profile.
//
// Usage: node scripts/build-profile.mjs   (re-run after changing a layout)
// Output: io.github.hsalazr.deck-for-t3code.sdPlugin/profiles/<file>.streamDeckProfile
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const plugin = JSON.parse(fs.readFileSync(path.join(root, "io.github.hsalazr.deck-for-t3code.sdPlugin/manifest.json"), "utf8"));

const msg = (index) => ({ action: "message", index });
const messages = (from, count) => Array.from({ length: count }, (_, i) => msg(from + i));

/**
 * Thread Actions page per device, row by row. Strings are actions; objects
 * carry settings (messages). Device models come from Elgato's own bundled
 * default profiles (Stream Deck.app/Contents/Resources/DefaultProfiles); a
 * profile applies to every device of its DeviceType, the model sets the grid.
 */
export const PROFILES = [
	{
		file: "Deck for T3 Code XL",
		name: "Deck for T3 Code",
		deviceType: 2,
		model: "20GAT9901", // Stream Deck XL
		columns: 8,
		rows: 4,
		// Fixed ids so a rebuilt profile replaces the installed one instead of adding another.
		profileId: "4C1F7A92-3E6B-4D85-9A2C-8B5E1D0F6A37",
		pageIds: ["1A6E3B8C-5D2F-4A97-8C14-7E0B9D3F2A65", "8D3B5F1E-2A7C-4E96-B4D0-6C1A9F5E3B28"],
		// 21 quick messages; the bottom row is kept apart, with gaps, and Stop alone in the corner.
		actions: [
			["back", "header", "open", ...messages(0, 5)],
			messages(5, 8),
			messages(13, 8),
			["compact", "snooze1h", "snoozeTomorrow", "blank", "blank", "blank", "settle", "stop"],
		],
	},
	{
		file: "Deck for T3 Code",
		name: "Deck for T3 Code",
		deviceType: 0,
		model: "20GBA9901", // Stream Deck MK.2 (Elgato's own default for this type uses 20GAA9902; both are 5×3)
		columns: 5,
		rows: 3,
		profileId: "FEFDB576-F293-483B-9710-FBA7B97CF7D9",
		pageIds: ["A45950E8-E3B6-40FA-89B7-DE609248472E", "4C4BBA01-07C5-4E61-9B8E-B9F3B53BEF00"],
		actions: [
			["back", "header", "open", msg(0), msg(1)],
			messages(2, 5),
			["compact", "snooze1h", "snoozeTomorrow", "settle", "stop"],
		],
	},
	{
		file: "Deck for T3 Code Mini",
		name: "Deck for T3 Code",
		deviceType: 1,
		model: "20GAI9901", // Stream Deck Mini
		columns: 3,
		rows: 2,
		profileId: "2EB7AAAD-AFE9-4B04-9BB1-B288EC767B90",
		pageIds: ["ED29B2C6-8225-45E0-922C-DFF492EB7D97", "B0F22605-7B16-41FD-8E38-C5DA529599BC"],
		// No room for messages; the header opens the thread.
		actions: [
			["back", "header", "snooze1h"],
			["compact", "settle", "stop"],
		],
	},
	{
		file: "Deck for T3 Code Neo",
		name: "Deck for T3 Code",
		deviceType: 9,
		model: "20GBJ9901", // Stream Deck Neo (keypad only; the touch points stay empty)
		columns: 4,
		rows: 2,
		profileId: "4E889C9A-1501-462F-8C30-1E979D0D00F5",
		pageIds: ["3B1994B6-876F-42DF-945C-64BFA9FCE20B", "65B1E738-9CE6-4859-8A7C-99A57698AECC"],
		actions: [
			["back", "header", msg(0), msg(1)],
			["snooze1h", "compact", "settle", "stop"],
		],
	},
];

/**
 * Page layouts as `{ "col,row": { uuid, name, settings } }`, without the
 * Stream Deck boilerplate; what tests check and what `buildProfile` writes.
 */
export function layoutOf(p) {
	const threads = {};
	const actions = {};
	for (let row = 0; row < p.rows; row++) {
		for (let col = 0; col < p.columns; col++) {
			threads[`${col},${row}`] = col === 0 && row === 0 ? { uuid: `${plugin.UUID}.back`, name: "Back", settings: {} } : { uuid: `${plugin.UUID}.thread`, name: "Thread", settings: {} };
			const slot = p.actions[row]?.[col];
			if (slot === undefined) throw new Error(`${p.file}: no action at ${col},${row}`);
			actions[`${col},${row}`] = { uuid: `${plugin.UUID}.thread-action`, name: "Thread Action", settings: typeof slot === "string" ? { action: slot } : slot };
		}
		if (p.actions[row].length !== p.columns) throw new Error(`${p.file}: row ${row} has ${p.actions[row].length} keys, expected ${p.columns}`);
	}
	if (p.actions.length !== p.rows) throw new Error(`${p.file}: ${p.actions.length} rows, expected ${p.rows}`);
	return [threads, actions];
}

const action = ({ name, uuid, settings }) => ({
	ActionID: randomUUID(),
	LinkedTitle: true,
	Name: name,
	Plugin: { Name: plugin.Name, UUID: plugin.UUID, Version: plugin.Version },
	Resources: null,
	Settings: settings,
	State: 0,
	States: [{ FontFamily: "", FontSize: 12, FontStyle: "", FontUnderline: false, OutlineThickness: 2, ShowTitle: false, TitleAlignment: "bottom", TitleColor: "#ffffff" }],
	UUID: uuid,
});

function buildProfile(p) {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "t3deck-profile-"));
	const profileDir = path.join(work, `${p.profileId}.sdProfile`);
	fs.mkdirSync(path.join(profileDir, "Images"), { recursive: true });
	layoutOf(p).forEach((layout, i) => {
		const pageDir = path.join(profileDir, "Profiles", p.pageIds[i]);
		fs.mkdirSync(path.join(pageDir, "Images"), { recursive: true });
		const actions = Object.fromEntries(Object.entries(layout).map(([pos, a]) => [pos, action(a)]));
		fs.writeFileSync(path.join(pageDir, "manifest.json"), JSON.stringify({ Controllers: [{ Actions: actions, Type: "Keypad" }], Icon: "", Name: "" }));
	});
	const ids = p.pageIds.map((id) => id.toLowerCase());
	fs.writeFileSync(
		path.join(profileDir, "manifest.json"),
		JSON.stringify({ Device: { Model: p.model, UUID: "" }, Name: p.name, Pages: { Current: ids[0], Default: ids[0], Pages: ids }, Version: "3.0" }),
	);
	const outDir = path.join(root, "io.github.hsalazr.deck-for-t3code.sdPlugin", "profiles");
	fs.mkdirSync(outDir, { recursive: true });
	const out = path.join(outDir, `${p.file}.streamDeckProfile`);
	fs.rmSync(out, { force: true });
	execFileSync("zip", ["-q", "-r", "-X", out, `${p.profileId}.sdProfile`], { cwd: work });
	fs.rmSync(work, { recursive: true, force: true });
	console.log(`wrote ${path.relative(root, out)} (${p.columns}×${p.rows}, ${p.pageIds.length} pages)`);
}

if (process.argv[1] && import.meta.url === url.pathToFileURL(path.resolve(process.argv[1])).href) {
	const manifestProfiles = new Set((plugin.Profiles ?? []).map((m) => `${m.Name}|${m.DeviceType}`));
	for (const p of PROFILES) {
		if (!manifestProfiles.has(`profiles/${p.file}|${p.deviceType}`)) console.warn(`warning: manifest.json has no Profiles entry for "profiles/${p.file}" (DeviceType ${p.deviceType})`);
		buildProfile(p);
	}
}
