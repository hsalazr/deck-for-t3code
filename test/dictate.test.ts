import assert from "node:assert/strict";
import { test } from "node:test";
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
	SHORTCUT_REFRESH_MS,
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
	assert.deepEqual(chordFor(s!), { keyCode: 0x02, flags: FLAG.command | FLAG.shift, label: "shift+cmd+d" });
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
	assert.throws(() => chordFor(s({ key: "enter", command: true })), (e: unknown) => e instanceof DictateRefusal && e.reason === "unmapped" && /cmd\+enter/.test(e.message));
});

// ---------- Script arguments ----------

const target = { bundleId: "com.t3tools.t3code", chord: { keyCode: 2, flags: 0x120000, label: "shift+cmd+d" } };

test("script arguments: tap, down, up and dry run; all after --, all plain values", () => {
	const base = ["--bundle-id", "com.t3tools.t3code", "--key-code", "2", "--flags", "1179648", "--wait-ms", "1500"];
	assert.deepEqual(scriptArgs("tap", target), ["--", "tap", ...base]);
	assert.deepEqual(scriptArgs("down", target), ["--", "down", ...base]);
	assert.deepEqual(scriptArgs("up", target), ["--", "up", ...base]);
	assert.deepEqual(scriptArgs("tap", target, { dryRun: true, waitMs: 5000 }), ["--", "tap", ...base.slice(0, -1), "5000", "--dry-run"]);
});

test("script arguments: a bad bundle id, key code or flags never reach osascript", () => {
	assert.throws(() => scriptArgs("tap", { ...target, bundleId: "-e" }), DictateRefusal);
	assert.throws(() => scriptArgs("tap", { ...target, bundleId: "com.acme;rm" }), DictateRefusal);
	assert.throws(() => scriptArgs("tap", { ...target, chord: { ...target.chord, keyCode: 128 } }));
	assert.throws(() => scriptArgs("tap", { ...target, chord: { ...target.chord, keyCode: 1.5 } }));
	assert.throws(() => scriptArgs("tap", { ...target, chord: { ...target.chord, flags: 0x800000 } }));
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

/** Runs the script in a sandbox with a fake ObjC bridge: what it would post, print and exit with. */
function runScript(argv: string[], o: { front?: string[]; permitted?: boolean; bridged?: boolean; frontAfter?: string } = {}) {
	const posted: FakeEvent[] = [];
	const bound: string[] = [];
	const out: string[] = [];
	let exitCode: number | undefined;
	let requested = 0;
	let polls = 0;
	const fronts = o.front ?? ["com.t3tools.t3code"];
	let current = fronts[0]!;
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
			posted.push({ ...e });
			if (o.frontAfter) current = o.frontAfter;
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
		NSWorkspace: { sharedWorkspace: { get frontmostApplication() { return { bundleIdentifier: { value: current } }; } } },
		NSRunLoop: { currentRunLoop: { runUntilDate: () => { polls++; current = fronts[Math.min(polls, fronts.length - 1)]!; } } },
		NSDate: { dateWithTimeIntervalSinceNow: (s: number) => s },
		NSThread: { sleepForTimeInterval: () => {} },
	}) as unknown as Record<string, unknown>;
	const extra = o.bridged === false ? ["CGPreflightPostEventAccess", "CGRequestPostEventAccess"] : [];
	for (const [name, fn] of Object.entries(cg)) if (!extra.includes(name)) $[name] = fn;
	const ObjC = {
		import: () => {},
		bindFunction: (name: string, signature: unknown) => {
			assert.ok(Array.isArray(signature));
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
	return { result: JSON.parse(out[0]!) as Record<string, unknown>, exitCode, posted, bound, requested, polls };
}

const argv = (phase: string, ...more: string[]) => scriptArgs(phase as "tap", target).concat(more);

test("script, tap: key-down with Command+Shift, then a key-up with no flags", () => {
	const r = runScript(argv("tap"));
	assert.equal(r.exitCode, 0);
	assert.equal(r.result.ok, true);
	assert.equal(r.result.posted, 2);
	assert.deepEqual(r.posted, [{ code: 2, down: true, flags: 0x120000 }, { code: 2, down: false, flags: 0 }]);
	assert.deepEqual(r.result.events, [{ type: 10, keyDown: true, keyCode: 2, flags: 0x120000 }, { type: 11, keyDown: false, keyCode: 2, flags: 0 }]);
	assert.equal(r.result.frontmost, "com.t3tools.t3code");
	assert.equal(r.result.postPermitted, true);
	assert.deepEqual(r.bound, []);
});

test("script, down and up: one event each", () => {
	assert.deepEqual(runScript(argv("down")).posted, [{ code: 2, down: true, flags: 0x120000 }]);
	assert.deepEqual(runScript(argv("up")).posted, [{ code: 2, down: false, flags: 0 }]);
	// osascript may or may not pass the "--" through; both work.
	assert.deepEqual(runScript(argv("up").slice(1)).posted, [{ code: 2, down: false, flags: 0 }]);
});

test("script, dry run: builds and reads back, checks front app and permission, posts nothing", () => {
	const r = runScript(argv("tap", "--dry-run"));
	assert.equal(r.exitCode, 0);
	assert.equal(r.result.ok, true);
	assert.equal(r.result.dryRun, true);
	assert.equal(r.result.posted, 0);
	assert.deepEqual(r.posted, []);
	assert.equal((r.result.events as unknown[]).length, 2);
	assert.deepEqual(r.result.imports, { Foundation: "ok", AppKit: "ok", CoreGraphics: "ok", stdlib: "ok" });
	assert.deepEqual(r.result.functions, Object.fromEntries(["CGEventCreateKeyboardEvent", "CGEventSetFlags", "CGEventGetFlags", "CGEventGetIntegerValueField", "CGEventGetType", "CGEventPost", "CGPreflightPostEventAccess", "CGRequestPostEventAccess"].map((n) => [n, "bridge"])));
	// Without permission a dry run says so, and doesn't ask.
	const denied = runScript(argv("tap", "--dry-run"), { permitted: false });
	assert.equal(denied.exitCode, 4);
	assert.equal(denied.result.reason, "not-permitted");
	assert.equal(denied.requested, 0);
	assert.deepEqual(denied.posted, []);
});

test("script: functions the bridge doesn't import are bound, and reported", () => {
	const r = runScript(argv("tap", "--dry-run"), { bridged: false });
	assert.deepEqual(r.bound, ["CGPreflightPostEventAccess", "CGRequestPostEventAccess"]);
	assert.equal((r.result.functions as Record<string, string>).CGPreflightPostEventAccess, "bound");
	assert.equal(r.result.ok, true);
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
});

test("script: not permitted, asks once and posts nothing", () => {
	const r = runScript(argv("tap"), { permitted: false });
	assert.equal(r.exitCode, 4);
	assert.equal(r.result.reason, "not-permitted");
	assert.equal(r.requested, 1);
	assert.deepEqual(r.posted, []);
});

test("script: bad arguments are refused before anything is built", () => {
	const cases: string[][] = [
		[],
		["--", "press", "--bundle-id", "com.t3tools.t3code", "--key-code", "2", "--flags", "0"],
		["--", "tap", "--bundle-id", "-x", "--key-code", "2", "--flags", "0"],
		["--", "tap", "--bundle-id", "com.t3tools.t3code", "--key-code", "200", "--flags", "0"],
		["--", "tap", "--bundle-id", "com.t3tools.t3code", "--key-code", "-1", "--flags", "0"],
		["--", "tap", "--bundle-id", "com.t3tools.t3code", "--key-code", "2", "--flags", String(0x800000)],
		["--", "tap", "--bundle-id", "com.t3tools.t3code", "--key-code", "2", "--flags", String(0x100001)],
		["--", "tap", "--bundle-id", "com.t3tools.t3code", "--key-code", "2"],
		["--", "tap", "--bundle-id", "com.t3tools.t3code", "--key-code", "2", "--flags", "0", "--text", "hello"],
		["--", "tap", "--bundle-id", "com.t3tools.t3code", "--key-code", "2", "--flags"],
		["--", "tap", "--bundle-id", "com.t3tools.t3code", "--key-code", "0x2", "--flags", "0"],
	];
	for (const c of cases) {
		const r = runScript(c);
		assert.equal(r.exitCode, 2, c.join(" "));
		assert.equal(r.result.ok, false);
		assert.equal(r.result.reason, "bad-args");
		assert.deepEqual(r.posted, []);
	}
});

// ---------- Lookup cache and sending ----------

test("the shortcut is looked up once, then served from the cache and refreshed in the background", async () => {
	let now = 1_000;
	let calls = 0;
	let config: unknown = { keybindings: [STOCK] };
	const d = new Dictation({ getConfig: async () => (calls++, config), now: () => now, run: async () => ({ code: 0, stdout: '{"ok":true}', stderr: "" }) });
	assert.deepEqual(await d.chord(), { keyCode: 2, flags: 0x120000, label: "shift+cmd+d" });
	await d.chord();
	assert.equal(calls, 1);
	// Old: the press uses the cached chord while a fresh one is fetched.
	now += SHORTCUT_REFRESH_MS;
	config = { keybindings: [STOCK, rule("composer.dictation", "f5")] };
	assert.equal((await d.chord()).label, "shift+cmd+d");
	await new Promise((r) => setImmediate(r));
	assert.equal(calls, 2);
	assert.equal((await d.chord()).label, "f5");
});

test("lookups: nothing bound and unmapped keys are refusals; a failed request isn't cached", async () => {
	let fail = true;
	const d = new Dictation({ getConfig: async () => { if (fail) throw new Error("socket closed"); return { keybindings: [rule("composer.dictation", "enter", { modKey: true })] }; } });
	await assert.rejects(d.chord(), (e: unknown) => e instanceof DictateRefusal && e.reason === "lookup-failed");
	fail = false;
	await assert.rejects(d.chord(), (e: unknown) => e instanceof DictateRefusal && e.reason === "unmapped");
	const none = new Dictation({ getConfig: async () => ({ keybindings: [] }) });
	await assert.rejects(none.chord(), (e: unknown) => e instanceof DictateRefusal && e.reason === "unbound");
});

test("send: runs the script with the arguments; failures say why and refresh the shortcut", async () => {
	const runs: string[][] = [];
	let reply = { code: 0, stdout: '{"ok":true,"posted":2}\n', stderr: "" };
	let calls = 0;
	const run: RunScript = async (args) => (runs.push(args), reply);
	const d = new Dictation({ getConfig: async () => (calls++, { keybindings: [STOCK] }), run });
	await d.send("tap", target);
	assert.deepEqual(runs, [scriptArgs("tap", target)]);
	await d.chord();
	assert.equal(calls, 1);
	reply = { code: 4, stdout: '{"ok":false,"reason":"not-permitted"}', stderr: "" };
	await assert.rejects(d.send("tap", target), (e: unknown) => e instanceof DictateRefusal && e.reason === "not-permitted");
	await new Promise((r) => setImmediate(r));
	assert.equal(calls, 2, "a failed send looks the shortcut up again");
	reply = { code: 3, stdout: '{"ok":false,"reason":"not-frontmost","frontmost":"com.acme.editor"}', stderr: "" };
	await assert.rejects(d.send("down", target), (e: unknown) => e instanceof DictateRefusal && e.reason === "not-frontmost" && /com\.acme\.editor/.test(e.message));
	reply = { code: 1, stdout: "", stderr: "execution error: something broke (-2700)" };
	await assert.rejects(d.send("up", target), /exited 1: execution error: something broke/);
	// Exit 0 without an ok line is not a success.
	reply = { code: 0, stdout: "", stderr: "" };
	await assert.rejects(d.send("tap", target), /exited 0/);
});
