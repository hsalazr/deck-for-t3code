import assert from "node:assert/strict";
import { mock, test } from "node:test";
import vm from "node:vm";

import {
	chordFor,
	DICTATE_SCRIPT,
	DictateRefusal,
	Dictation,
	dictationShortcut,
	eventFlags,
	FLAG,
	KEY_CODES,
	keyCodeFor,
	parseScriptOutput,
	scriptArgs,
	isModifierKeyCode,
	LOOKUP_WAIT_MS,
	nothingPosted,
	POST_TARGET,
	shortcutLabel,
	type DictationShortcut,
	type RunScript,
} from "../src/dictate.ts";

// ---------- Which shortcut ----------

/** The rule a stock v0.1.9 server sends for dictation (`server.getConfig().keybindings`). */
const STOCK = {
	command: "composer.dictation",
	shortcut: { key: "d", metaKey: false, ctrlKey: false, shiftKey: true, altKey: false, modKey: true },
	whenAst: { type: "not", node: { type: "identifier", name: "terminalFocus" } },
};
const rule = (command: string, key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "modKey", boolean>> = {}, whenAst?: unknown) => ({
	command,
	shortcut: { key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, modKey: false, ...mods },
	...(whenAst ? { whenAst } : {}),
});
const id = (name: string) => ({ type: "identifier", name });

test("the stock rule: mod (Command on macOS) + shift + d", () => {
	const s = dictationShortcut([rule("terminal.splitVertical", "d", { modKey: true, shiftKey: true }, id("terminalFocus")), STOCK, rule("diff.toggle", "d", { modKey: true }, { type: "not", node: id("terminalFocus") })]);
	assert.deepEqual(s, { key: "d", command: true, control: false, shift: true, option: false });
	assert.deepEqual(chordFor(s!), { keyCode: 0x02, flags: FLAG.command | FLAG.shift, label: "shift+cmd+d", char: "d" });
	assert.equal(eventFlags(s!), 0x120000);
});

test("several rules: the last one that applies wins, as in T3 Code's own label", () => {
	// A user rule appended after the default one replaces it.
	assert.equal(dictationShortcut([STOCK, rule("composer.dictation", "f5")])?.key, "f5");
	// A later rule whose `when` is false where the label is computed doesn't count.
	assert.equal(dictationShortcut([STOCK, rule("composer.dictation", "f5", {}, id("terminalFocus"))])?.key, "d");
	assert.equal(dictationShortcut([STOCK, rule("composer.dictation", "f5", {}, id("isDesktop"))])?.key, "f5");
	assert.equal(dictationShortcut([STOCK, rule("composer.dictation", "f5", {}, { type: "and", left: id("isDesktop"), right: id("previewFocus") })])?.key, "d");
	assert.equal(dictationShortcut([STOCK, rule("composer.dictation", "f5", {}, { type: "or", left: id("false"), right: id("true") })])?.key, "f5");
	// A later rule for another command claims the same chord, so dictation falls back to its earlier rule.
	const f5 = rule("composer.dictation", "f5");
	assert.equal(dictationShortcut([f5, STOCK, rule("chat.new", "d", { metaKey: true, shiftKey: true })])?.key, "f5");
	// metaKey and modKey are the same chord on macOS.
	assert.equal(dictationShortcut([f5, STOCK, rule("chat.new", "d", { modKey: true, shiftKey: true })])?.key, "f5");
	assert.equal(dictationShortcut([f5, STOCK, rule("chat.new", "d", { modKey: true })])?.key, "d");
});

test("none bound, or malformed input: no shortcut, nothing guessed", () => {
	assert.equal(dictationShortcut([]), undefined);
	assert.equal(dictationShortcut(undefined), undefined);
	assert.equal(dictationShortcut({ keybindings: [STOCK] }), undefined);
	assert.equal(dictationShortcut([rule("chat.new", "n", { modKey: true })]), undefined);
	const bad = [
		null,
		"composer.dictation",
		{ command: "composer.dictation" },
		{ command: "composer.dictation", shortcut: { key: "d" } },
		{ command: "composer.dictation", shortcut: { ...STOCK.shortcut, key: "" } },
		{ command: "composer.dictation", shortcut: { ...STOCK.shortcut, shiftKey: "yes" } },
		{ ...STOCK, whenAst: "!terminalFocus" },
		{ ...STOCK, whenAst: { type: "not" } },
		{ ...STOCK, whenAst: { type: "xor", left: id("a"), right: id("b") } },
	];
	for (const b of bad) assert.equal(dictationShortcut([b]), undefined, JSON.stringify(b));
	// A malformed rule is dropped and doesn't hide a good one before it.
	assert.equal(dictationShortcut([STOCK, ...bad])?.key, "d");
	// A `when` tree deeper than T3 Code allows is malformed.
	let deep: unknown = id("isDesktop");
	for (let i = 0; i < 70; i++) deep = { type: "not", node: { type: "not", node: deep } };
	assert.equal(dictationShortcut([{ ...STOCK, whenAst: deep }]), undefined);
});

// ---------- Key table and flags ----------

test("key table: letters, digits, function keys, space and punctuation; nothing else", () => {
	assert.equal(keyCodeFor("a"), 0x00);
	assert.equal(keyCodeFor("d"), 0x02);
	assert.equal(keyCodeFor("z"), 0x06);
	assert.equal(keyCodeFor("0"), 0x1d);
	assert.equal(keyCodeFor("5"), 0x17);
	assert.equal(keyCodeFor(" "), 0x31);
	assert.equal(keyCodeFor("f1"), 0x7a);
	assert.equal(keyCodeFor("f6"), 0x61);
	assert.equal(keyCodeFor("f20"), 0x5a);
	assert.equal(keyCodeFor("/"), 0x2c);
	assert.equal(keyCodeFor("`"), 0x32);
	assert.equal(keyCodeFor("\\"), 0x2a);
	for (const key of ["enter", "escape", "arrowup", "tab", "+", "D", "f21", "toString", "__proto__", "constructor", ""]) assert.equal(keyCodeFor(key), undefined, key);
	const letters = "abcdefghijklmnopqrstuvwxyz".split("");
	const digits = "0123456789".split("");
	const fkeys = Array.from({ length: 20 }, (_, i) => `f${i + 1}`);
	for (const k of [...letters, ...digits, ...fkeys]) assert.ok(keyCodeFor(k) !== undefined, k);
	assert.equal(Object.keys(KEY_CODES).length, 26 + 10 + 20 + 1 + 11);
	// No two keys share a code; every code is a 7-bit virtual key.
	const codes = Object.values(KEY_CODES);
	assert.equal(new Set(codes).size, codes.length);
	for (const c of codes) assert.ok(Number.isInteger(c) && c >= 0 && c <= 127);
});

test("flags: one CGEventFlags mask per modifier; an unknown key is refused", () => {
	const s = (o: Partial<DictationShortcut>): DictationShortcut => ({ key: "d", command: false, control: false, shift: false, option: false, ...o });
	assert.equal(eventFlags(s({})), 0);
	assert.equal(eventFlags(s({ shift: true })), 0x20000);
	assert.equal(eventFlags(s({ control: true })), 0x40000);
	assert.equal(eventFlags(s({ option: true })), 0x80000);
	assert.equal(eventFlags(s({ command: true })), 0x100000);
	assert.equal(eventFlags(s({ command: true, control: true, option: true, shift: true })), 0x1e0000);
	assert.equal(shortcutLabel(s({ key: " ", control: true, option: true })), "ctrl+option+space");
	// Only letters carry a letter for the layout check; digits, punctuation, Space and F-keys are positions.
	assert.equal(chordFor(s({ key: "q" })).char, "q");
	for (const key of ["1", "/", " ", "f6"]) assert.equal(chordFor(s({ key })).char, undefined, key);
	// No table entry is a modifier key.
	for (const code of Object.values(KEY_CODES)) assert.ok(!isModifierKeyCode(code));
	assert.ok(isModifierKeyCode(54) && isModifierKeyCode(55) && isModifierKeyCode(63) && !isModifierKeyCode(53) && !isModifierKeyCode(64));
	assert.throws(() => chordFor(s({ key: "enter", command: true })), (e: unknown) => e instanceof DictateRefusal && e.reason === "unmapped" && /cmd\+enter/.test(e.message));
});

// ---------- Script arguments ----------

const target = { bundleId: "com.t3tools.t3code", chord: { keyCode: 2, flags: 0x120000, label: "shift+cmd+d", char: "d" } };
const f6 = { bundleId: "com.t3tools.t3code", chord: { keyCode: 0x61, flags: 0, label: "f6" } };

test("script arguments: tap, down, up and dry run; all after --, all plain values", () => {
	assert.equal(POST_TARGET, "pid");
	const base = ["--bundle-id", "com.t3tools.t3code", "--key-code", "2", "--flags", "1179648", "--char", "d", "--post", "pid", "--wait-ms", "1500"];
	assert.deepEqual(scriptArgs("tap", target), ["--", "tap", ...base]);
	assert.deepEqual(scriptArgs("down", target), ["--", "down", ...base]);
	assert.deepEqual(scriptArgs("up", target), ["--", "up", ...base]);
	assert.deepEqual(scriptArgs("tap", target, { dryRun: true, waitMs: 5000 }), ["--", "tap", ...base.slice(0, -1), "5000", "--dry-run"]);
	// A function key has no letter to check; the post target can be switched.
	assert.deepEqual(scriptArgs("tap", f6, { post: "hid" }), ["--", "tap", "--bundle-id", "com.t3tools.t3code", "--key-code", "97", "--flags", "0", "--post", "hid", "--wait-ms", "1500"]);
});

test("script arguments: a bad bundle id, key code, letter or flags never reach osascript", () => {
	assert.throws(() => scriptArgs("tap", { ...target, bundleId: "-e" }), DictateRefusal);
	assert.throws(() => scriptArgs("tap", { ...target, bundleId: "com.acme;rm" }), DictateRefusal);
	assert.throws(() => scriptArgs("tap", { ...target, chord: { ...target.chord, keyCode: 128 } }));
	assert.throws(() => scriptArgs("tap", { ...target, chord: { ...target.chord, keyCode: 1.5 } }));
	for (const code of [54, 55, 56, 58, 59, 63]) assert.throws(() => scriptArgs("tap", { ...f6, chord: { ...f6.chord, keyCode: code } }), /bad key code/, String(code));
	assert.throws(() => scriptArgs("tap", { ...target, chord: { ...target.chord, flags: 0x800000 } }));
	assert.throws(() => scriptArgs("tap", { ...target, chord: { ...target.chord, char: "e" } }), /bad letter/);
	assert.throws(() => scriptArgs("tap", { ...target, chord: { ...target.chord, char: "D" } }), /bad letter/);
	assert.throws(() => scriptArgs("tap", { ...target, chord: { ...target.chord, char: "dd" } }), /bad letter/);
	assert.throws(() => scriptArgs("tap", { ...f6, chord: { ...f6.chord, char: "d" } }), /bad letter/);
});

test("script output: the last JSON line, type-checked", () => {
	assert.deepEqual(parseScriptOutput('{"ok":true,"posted":2}\n'), { ok: true, reason: undefined, detail: undefined, frontmost: undefined });
	assert.equal(parseScriptOutput('noise\n{"ok":false,"reason":"not-frontmost","frontmost":"com.acme.editor"}')?.frontmost, "com.acme.editor");
	assert.equal(parseScriptOutput(""), undefined);
	assert.equal(parseScriptOutput("not json"), undefined);
	assert.equal(parseScriptOutput('{"ok":"yes"}'), undefined);
	assert.equal(parseScriptOutput('{"ok":false,"reason":42}')?.reason, undefined);
});

// ---------- The script itself ----------

test("the script is plain JavaScript with a run(argv) handler, and has no interpolation left in it", () => {
	assert.doesNotThrow(() => new vm.Script(DICTATE_SCRIPT, { filename: "dictate.js" }));
	assert.match(DICTATE_SCRIPT, /^function run\(argv\) \{$/m);
	assert.ok(!DICTATE_SCRIPT.includes("${"));
	// Nothing in it shells out or runs other code.
	for (const banned of [/doShellScript/, /\beval\(/, /\bFunction\(/, /NSTask/, /\bApplication\(/, /\bkeystroke\b/]) assert.ok(!banned.test(DICTATE_SCRIPT), String(banned));
});

interface FakeEvent {
	code: number;
	down: boolean;
	flags: number;
}

/** What the US layout types on each character key (the table, read backwards). */
const US: Record<number, string> = Object.fromEntries(Object.entries(KEY_CODES).filter(([k]) => k.length === 1 && k !== " ").map(([k, code]) => [code, k]));
/** A layout: US with some keys changed. */
const layout = (changes: Record<number, string>): Record<number, string> => ({ ...US, ...changes });
/** Dvorak, the letters that matter here: QWERTY's D types "e", H types "d", E types ".". */
const DVORAK = layout({ 0x02: "e", 0x04: "d", 0x0e: "." });
/** AZERTY: A and Q swap, Z and W swap, digits type symbols unshifted. */
const AZERTY = layout({ 0x00: "q", 0x0c: "a", 0x06: "w", 0x0d: "z", 0x12: "&", 0x13: "é" });
/** A layout with no Latin letters (Cyrillic on the letter keys). */
const CYRILLIC = Object.fromEntries(Object.entries(US).map(([code, ch]) => [code, /^[a-z]$/.test(ch) ? String.fromCharCode(0x430 + (Number(code) % 32)) : ch]));

const PID = 4242;

/** Runs the script in a sandbox with a fake ObjC bridge: what it would post, print and exit with. */
function runScript(
	argv: string[],
	o: { front?: string[]; permitted?: boolean; bridged?: boolean; frontAfter?: string; pidAfter?: number; keys?: Record<number, string>; noPostToPid?: boolean } = {},
) {
	const posted: (FakeEvent & { to: string })[] = [];
	const bound: string[] = [];
	const out: string[] = [];
	const typedOn: number[] = [];
	let exitCode: number | undefined;
	let requested = 0;
	let polls = 0;
	const fronts = o.front ?? ["com.t3tools.t3code"];
	let current = fronts[0]!;
	let pid = PID;
	const keys = o.keys ?? US;
	const cg = {
		CGEventCreateKeyboardEvent: (source: unknown, code: number, down: boolean): FakeEvent => {
			assert.equal(source, null);
			return { code, down, flags: 0x100 }; // a real event carries the non-coalesced bit
		},
		CGEventSetFlags: (e: FakeEvent, flags: number) => void (e.flags = flags),
		CGEventGetFlags: (e: FakeEvent) => e.flags,
		CGEventGetIntegerValueField: (e: FakeEvent, field: number) => (field === 9 ? e.code : -1),
		CGEventGetType: (e: FakeEvent) => (e.down ? 10 : 11),
		CGEventPost: (tap: number, e: FakeEvent) => {
			assert.equal(tap, 0);
			posted.push({ ...e, to: "hid" });
			if (o.frontAfter) current = o.frontAfter;
			if (o.pidAfter) pid = o.pidAfter;
		},
		CGEventPostToPid: (to: number, e: FakeEvent) => {
			posted.push({ ...e, to: `pid ${to}` });
			if (o.frontAfter) current = o.frontAfter;
			if (o.pidAfter) pid = o.pidAfter;
		},
		CGPreflightPostEventAccess: () => o.permitted ?? true,
		CGRequestPostEventAccess: () => {
			requested++;
			return false;
		},
	};
	const $ = Object.assign((s: string) => ({ dataUsingEncoding: () => s }), {
		NSUTF8StringEncoding: 4,
		NSFileHandle: { fileHandleWithStandardOutput: { writeData: (d: string) => out.push(d) } },
		exit: (code: number) => {
			exitCode = code;
		},
		NSWorkspace: { sharedWorkspace: { get frontmostApplication() { return { bundleIdentifier: { value: current }, processIdentifier: pid }; } } },
		NSRunLoop: { currentRunLoop: { runUntilDate: () => { polls++; if (polls < fronts.length) current = fronts[polls]!; } } },
		NSDate: { dateWithTimeIntervalSinceNow: (s: number) => s },
		NSEvent: {
			eventWithCGEvent: (e: FakeEvent) => {
				assert.equal(e.flags & 0x1e0000, 0, "the layout is read without modifiers");
				assert.equal(e.down, true);
				typedOn.push(e.code);
				return { charactersIgnoringModifiers: { value: keys[e.code] ?? "" } };
			},
		},
		// No sleepForTimeInterval: the gap must let the run loop run.
	}) as unknown as Record<string, unknown>;
	const unbridged = o.bridged === false ? ["CGPreflightPostEventAccess", "CGRequestPostEventAccess", "CGEventPostToPid"] : [];
	for (const [name, fn] of Object.entries(cg)) if (!unbridged.includes(name)) $[name] = fn;
	if (o.noPostToPid) delete $.CGEventPostToPid;
	const ObjC = {
		import: () => {},
		bindFunction: (name: string, signature: unknown) => {
			assert.ok(Array.isArray(signature));
			if (o.noPostToPid && name === "CGEventPostToPid") throw new Error("no such symbol");
			bound.push(name);
			$[name] = cg[name as keyof typeof cg];
		},
		unwrap: (v: { value: string }) => v.value,
	};
	const sandbox: Record<string, unknown> = { $, ObjC };
	vm.runInNewContext(DICTATE_SCRIPT, sandbox);
	(sandbox.run as (argv: string[]) => void)(argv);
	assert.equal(out.length, 1, "exactly one line of output");
	assert.ok(out[0]!.endsWith("\n"));
	return { result: JSON.parse(out[0]!) as Record<string, any>, exitCode, posted, bound, requested, polls, typedOn };
}

const argv = (phase: string, ...more: string[]) => scriptArgs(phase as "tap", target).concat(more);
const to = `pid ${PID}`;

test("script, tap: key-down with Command+Shift, then a key-up with no flags, to T3 Code's process", () => {
	const r = runScript(argv("tap"));
	assert.equal(r.exitCode, 0);
	assert.equal(r.result.ok, true);
	assert.equal(r.result.posted, 2);
	assert.equal(r.result.post, "pid");
	assert.equal(r.result.pid, PID);
	assert.deepEqual(r.posted, [{ code: 2, down: true, flags: 0x120000, to }, { code: 2, down: false, flags: 0, to }]);
	assert.deepEqual(r.result.events, [{ type: 10, keyDown: true, keyCode: 2, flags: 0x120000 }, { type: 11, keyDown: false, keyCode: 2, flags: 0 }]);
	assert.equal(r.result.frontmost, "com.t3tools.t3code");
	assert.equal(r.result.postPermitted, true);
	assert.deepEqual(r.bound, []);
	assert.ok(r.polls >= 1, "the gap between key-down and key-up runs the run loop");
});

test("script, --post hid: the same events at the HID event tap", () => {
	const r = runScript(scriptArgs("tap", target, { post: "hid" }));
	assert.equal(r.exitCode, 0);
	assert.deepEqual(r.posted.map((p) => p.to), ["hid", "hid"]);
});

test("script, down and up: one event each", () => {
	assert.deepEqual(runScript(argv("down")).posted, [{ code: 2, down: true, flags: 0x120000, to }]);
	assert.deepEqual(runScript(argv("up")).posted, [{ code: 2, down: false, flags: 0, to }]);
	// osascript may or may not pass the "--" through; both work.
	assert.deepEqual(runScript(argv("up").slice(1)).posted, [{ code: 2, down: false, flags: 0, to }]);
});

test("script, dry run: builds and reads back, reads the layout, finds the process, posts nothing", () => {
	const r = runScript(argv("tap", "--dry-run"));
	assert.equal(r.exitCode, 0);
	assert.equal(r.result.ok, true);
	assert.equal(r.result.dryRun, true);
	assert.equal(r.result.posted, 0);
	assert.equal(r.result.pid, PID);
	assert.deepEqual(r.posted, []);
	assert.equal(r.result.events.length, 2);
	assert.deepEqual(r.result.layout, { tableKeyCode: 2, read: "d", check: "letter", expected: "d", keyCode: 2, searched: false });
	assert.deepEqual(r.result.imports, { Foundation: "ok", AppKit: "ok", CoreGraphics: "ok", stdlib: "ok" });
	assert.deepEqual(
		r.result.functions,
		Object.fromEntries(["CGEventCreateKeyboardEvent", "CGEventSetFlags", "CGEventGetFlags", "CGEventGetIntegerValueField", "CGEventGetType", "CGEventPost", "CGEventPostToPid", "CGPreflightPostEventAccess", "CGRequestPostEventAccess"].map((n) => [n, "bridge"])),
	);
	// Without permission a dry run says so, and doesn't ask.
	const denied = runScript(argv("tap", "--dry-run"), { permitted: false });
	assert.equal(denied.exitCode, 4);
	assert.equal(denied.result.reason, "not-permitted");
	assert.equal(denied.requested, 0);
	assert.deepEqual(denied.posted, []);
	// A function key: read for the report, no check, no search.
	const fkey = runScript(scriptArgs("tap", f6, { dryRun: true }));
	assert.equal(fkey.exitCode, 0);
	assert.deepEqual(fkey.result.layout, { tableKeyCode: 0x61, read: "", check: "position", keyCode: 0x61, searched: false });
	assert.deepEqual(fkey.typedOn, [0x61]);
	// A dry run on another layout shows the search.
	const dvorak = runScript(argv("tap", "--dry-run"), { keys: DVORAK });
	assert.equal(dvorak.exitCode, 0);
	assert.deepEqual(dvorak.result.layout, { tableKeyCode: 2, read: "e", check: "letter", expected: "d", searched: true, keyCode: 0x04, found: "letter" });
	assert.equal(dvorak.result.events[0].keyCode, 0x04);
	assert.deepEqual(dvorak.posted, []);
});

test("script: functions the bridge doesn't import are bound, and reported; a missing one is an error", () => {
	const r = runScript(argv("tap", "--dry-run"), { bridged: false });
	assert.deepEqual(r.bound, ["CGEventPostToPid", "CGPreflightPostEventAccess", "CGRequestPostEventAccess"]);
	assert.equal(r.result.functions.CGPreflightPostEventAccess, "bound");
	assert.equal(r.result.functions.CGEventPostToPid, "bound");
	assert.equal(r.result.ok, true);
	const missing = runScript(argv("tap"), { noPostToPid: true });
	assert.match(missing.result.functions.CGEventPostToPid, /^missing: /);
	assert.equal(missing.exitCode, 1);
	assert.deepEqual(missing.posted, []);
});

test("script, layouts: a letter goes on the key that types it", () => {
	// Dvorak: "d" is on QWERTY's H.
	const dvorak = runScript(argv("tap"), { keys: DVORAK });
	assert.equal(dvorak.exitCode, 0);
	assert.deepEqual(dvorak.posted.map((p) => p.code), [0x04, 0x04]);
	// AZERTY: a binding on "a" goes on QWERTY's Q (not Q itself, which would be ⇧⌘Q, Log Out).
	const a = { ...target, chord: { keyCode: 0x00, flags: 0x120000, label: "shift+cmd+a", char: "a" } };
	const azerty = runScript(scriptArgs("tap", a), { keys: AZERTY });
	assert.equal(azerty.result.layout.keyCode, 0x0c);
	assert.deepEqual(azerty.posted.map((p) => p.code), [0x0c, 0x0c]);
	// Where the layout already agrees, nothing is searched.
	const us = runScript(argv("tap"), { keys: AZERTY });
	assert.equal(us.result.layout.searched, false);
	assert.deepEqual(us.typedOn, [2]);
});

test("script, layouts: no Latin letters keeps the position (as T3 Code matches it); a missing letter is refused", () => {
	const cyrillic = runScript(argv("tap"), { keys: CYRILLIC });
	assert.equal(cyrillic.exitCode, 0);
	assert.equal(cyrillic.result.layout.found, "position");
	assert.deepEqual(cyrillic.posted.map((p) => p.code), [2, 2]);
	// The key types another Latin letter and no key types "d": refused, nothing posted.
	const noD = runScript(argv("tap"), { keys: layout({ 0x02: "x" }) });
	assert.equal(noD.exitCode, 5);
	assert.equal(noD.result.reason, "no-key");
	assert.deepEqual(noD.posted, []);
	// The search never looks at modifier, function, keypad or arrow keys.
	for (const code of noD.typedOn) assert.ok(code <= 0x32 || code === 0x5d || code === 0x5e, String(code));
	assert.ok(!noD.typedOn.some((c) => c >= 54 && c <= 63));
});

test("script: waits for T3 Code to come forward; refuses when another app stays in front", () => {
	const waited = runScript(argv("tap"), { front: ["com.acme.editor", "com.acme.editor", "com.t3tools.t3code"] });
	assert.equal(waited.exitCode, 0);
	assert.equal(waited.posted.length, 2);
	assert.ok(waited.polls >= 2);
	const refused = runScript(scriptArgs("tap", target, { waitMs: 100 }), { front: ["com.acme.editor"] });
	assert.equal(refused.exitCode, 3);
	assert.equal(refused.result.reason, "not-frontmost");
	assert.equal(refused.result.frontmost, "com.acme.editor");
	assert.deepEqual(refused.posted, []);
	// Another app came forward between key-down and key-up: the key-up isn't sent there.
	const moved = runScript(argv("tap"), { frontAfter: "com.acme.editor" });
	assert.equal(moved.exitCode, 3);
	assert.equal(moved.result.posted, 1);
	assert.equal(moved.posted.length, 1);
	// T3 Code restarted in between (another process): the same.
	const restarted = runScript(argv("tap"), { pidAfter: PID + 1 });
	assert.equal(restarted.exitCode, 3);
	assert.equal(restarted.posted.length, 1);
});

test("script: not permitted, asks once and posts nothing", () => {
	const r = runScript(argv("tap"), { permitted: false });
	assert.equal(r.exitCode, 4);
	assert.equal(r.result.reason, "not-permitted");
	assert.equal(r.requested, 1);
	assert.deepEqual(r.posted, []);
});

test("script: bad arguments are refused before anything is built", () => {
	const ok = ["--bundle-id", "com.t3tools.t3code", "--key-code", "2", "--flags", "0"];
	const cases: string[][] = [
		[],
		["--", "press", ...ok],
		["--", "tap", "--bundle-id", "-x", "--key-code", "2", "--flags", "0"],
		["--", "tap", "--bundle-id", "com.t3tools.t3code", "--key-code", "200", "--flags", "0"],
		["--", "tap", "--bundle-id", "com.t3tools.t3code", "--key-code", "-1", "--flags", "0"],
		["--", "tap", "--bundle-id", "com.t3tools.t3code", "--key-code", "55", "--flags", "0"],
		["--", "tap", "--bundle-id", "com.t3tools.t3code", "--key-code", "56", "--flags", "0"],
		["--", "tap", "--bundle-id", "com.t3tools.t3code", "--key-code", "2", "--flags", String(0x800000)],
		["--", "tap", "--bundle-id", "com.t3tools.t3code", "--key-code", "2", "--flags", String(0x100001)],
		["--", "tap", "--bundle-id", "com.t3tools.t3code", "--key-code", "2"],
		["--", "tap", ...ok, "--text", "hello"],
		["--", "tap", ...ok, "--flags"],
		["--", "tap", "--bundle-id", "com.t3tools.t3code", "--key-code", "0x2", "--flags", "0"],
		["--", "tap", ...ok, "--char", "D"],
		["--", "tap", ...ok, "--char", "dd"],
		["--", "tap", ...ok, "--char", "1"],
		["--", "tap", "--bundle-id", "com.t3tools.t3code", "--key-code", "97", "--flags", "0", "--char", "d"],
		["--", "tap", ...ok, "--post", "window"],
	];
	for (const c of cases) {
		const r = runScript(c);
		assert.equal(r.exitCode, 2, c.join(" "));
		assert.equal(r.result.ok, false);
		assert.equal(r.result.reason, "bad-args");
		assert.deepEqual(r.posted, []);
	}
});

// ---------- Lookup and sending ----------

test("the shortcut is looked up on every press: a change in T3 Code applies at once, nothing is cached", async () => {
	let calls = 0;
	let config: unknown = { keybindings: [STOCK] };
	const d = new Dictation({ getConfig: async () => (calls++, config) });
	assert.deepEqual(await d.chord(), { keyCode: 2, flags: 0x120000, label: "shift+cmd+d", char: "d" });
	config = { keybindings: [STOCK, rule("composer.dictation", "f5")] };
	assert.equal((await d.chord()).label, "f5");
	config = { keybindings: [] };
	await assert.rejects(d.chord(), (e: unknown) => e instanceof DictateRefusal && e.reason === "unbound");
	config = { keybindings: [STOCK] };
	assert.equal((await d.chord()).label, "shift+cmd+d");
	assert.equal(calls, 4);
});

test("lookups: a failed request, a slow one, or a key it can't press are refusals", async () => {
	const failing = new Dictation({ getConfig: async () => { throw new Error("socket closed"); } });
	await assert.rejects(failing.chord(), (e: unknown) => e instanceof DictateRefusal && e.reason === "lookup-failed" && /socket closed/.test(e.message));
	const enter = new Dictation({ getConfig: async () => ({ keybindings: [rule("composer.dictation", "enter", { modKey: true })] }) });
	await assert.rejects(enter.chord(), (e: unknown) => e instanceof DictateRefusal && e.reason === "unmapped");
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const slow = new Dictation({ getConfig: () => new Promise(() => {}) });
		const pending = assert.rejects(slow.chord(), (e: unknown) => e instanceof DictateRefusal && e.reason === "lookup-failed" && /within 3 s/.test(e.message));
		mock.timers.tick(LOOKUP_WAIT_MS);
		await pending;
	} finally {
		mock.timers.reset();
	}
});

test("send: runs the script with the arguments; failures say why, and which ones prove nothing was posted", async () => {
	const runs: string[][] = [];
	let reply = { code: 0, stdout: '{"ok":true,"posted":2}\n', stderr: "" };
	const run: RunScript = async (args) => (runs.push(args), reply);
	const d = new Dictation({ getConfig: async () => ({ keybindings: [STOCK] }), run });
	await d.send("tap", target);
	assert.deepEqual(runs, [scriptArgs("tap", target)]);
	const refused = async (stdout: string, reason: string, message?: RegExp) => {
		reply = { code: 9, stdout, stderr: "" };
		const error = await d.send("down", target).then(() => undefined, (e: unknown) => e);
		assert.ok(error instanceof DictateRefusal && error.reason === reason, stdout);
		if (message) assert.match(error.message, message);
		assert.equal(nothingPosted(error), true);
	};
	await refused('{"ok":false,"reason":"not-permitted"}', "not-permitted", /Accessibility/);
	await refused('{"ok":false,"reason":"not-frontmost","frontmost":"com.acme.editor"}', "not-frontmost", /com\.acme\.editor/);
	await refused('{"ok":false,"reason":"no-key"}', "no-key", /no key on the current keyboard layout types "d"/);
	await refused('{"ok":false,"reason":"bad-args","detail":"--post must be pid or hid"}', "bad-args", /--post/);
	// Anything else may have posted: a plain Error.
	reply = { code: 1, stdout: "", stderr: "execution error: something broke (-2700)" };
	const crashed = await d.send("down", target).then(() => undefined, (e: unknown) => e);
	assert.match((crashed as Error).message, /exited 1: execution error: something broke/);
	assert.equal(nothingPosted(crashed), false);
	assert.equal(nothingPosted(new Error("osascript timed out after 5000 ms")), false);
	// Exit 0 without an ok line is not a success.
	reply = { code: 0, stdout: "", stderr: "" };
	await assert.rejects(d.send("tap", target), /exited 0/);
});
