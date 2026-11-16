/**
 * The Dictate key: presses T3 Code's own dictation shortcut (`composer.dictation`)
 * in the T3 Code app, because T3 Code can start voice input only from that
 * shortcut or its microphone button (no link, RPC or menu item does it).
 *
 * This is the one place the plugin sends keystrokes, so it is narrow on purpose:
 * - only the shortcut bound to `composer.dictation`, read from T3 Code's
 *   `server.getConfig` and mapped through a fixed key table, never arbitrary keys or text;
 * - only through one fixed script (DICTATE_SCRIPT) run by `/usr/bin/osascript`,
 *   with every value passed as an argument, never spliced into the script;
 * - only while T3 Code (by bundle id) is the frontmost app, which the script checks itself;
 * - only on a key press, and only while "Enable the Dictate key" is on (off by default).
 */
import { execFile } from "node:child_process";

import { validBundleId } from "./t3/app.ts";

/** Dictate keys: which thread the shortcut lands in. */
export type DictateThread = "open" | "urgent";

/** A shortcut as T3 Code resolves it for macOS: `mod` is Command there. */
export interface DictationShortcut {
	key: string;
	command: boolean;
	control: boolean;
	shift: boolean;
	option: boolean;
}

/** What the script posts: a virtual key code, the modifier flags for the key-down, and a label for logs. */
export interface Chord {
	keyCode: number;
	flags: number;
	label: string;
}

/** Where and what to send for one press. */
export interface DictateTarget {
	bundleId: string;
	chord: Chord;
}

export type DictatePhase = "tap" | "down" | "up";

export type RefusalReason = "disabled" | "no-app" | "unbound" | "unmapped" | "lookup-failed" | "not-permitted" | "not-frontmost";

/** The plugin decided not to send (or the script refused to post), for a known reason. */
export class DictateRefusal extends Error {
	readonly reason: RefusalReason;
	constructor(reason: RefusalReason, message: string) {
		super(message);
		this.name = "DictateRefusal";
		this.reason = reason;
	}
}

// ---------- Which shortcut ----------

export const DICTATION_COMMAND = "composer.dictation";

/** T3 Code's `when` tree, as `server.getConfig` sends it (`whenAst`). */
type WhenNode = { type: "identifier"; name: string } | { type: "not"; node: WhenNode } | { type: "and" | "or"; left: WhenNode; right: WhenNode };

const MAX_WHEN_DEPTH = 64;

function isWhenNode(value: unknown, depth = 0): value is WhenNode {
	if (depth > MAX_WHEN_DEPTH || !value || typeof value !== "object") return false;
	const n = value as Record<string, unknown>;
	switch (n.type) {
		case "identifier":
			return typeof n.name === "string" && n.name.length > 0;
		case "not":
			return isWhenNode(n.node, depth + 1);
		case "and":
		case "or":
			return isWhenNode(n.left, depth + 1) && isWhenNode(n.right, depth + 1);
		default:
			return false;
	}
}

/**
 * The context T3 Code uses when it shows the dictation shortcut in its UI
 * (`useDictationShortcut` → `shortcutLabelForCommand`): the desktop app, no
 * terminal, preview or editor focus. Every other identifier is false.
 */
const LABEL_CONTEXT: Readonly<Record<string, boolean>> = { isDesktop: true, isWeb: false, terminalFocus: false, terminalOpen: false, previewFocus: false, previewOpen: false, editableFocus: false };

function evaluateWhen(node: WhenNode): boolean {
	switch (node.type) {
		case "identifier":
			if (node.name === "true") return true;
			if (node.name === "false") return false;
			return LABEL_CONTEXT[node.name] === true;
		case "not":
			return !evaluateWhen(node.node);
		case "and":
			return evaluateWhen(node.left) && evaluateWhen(node.right);
		case "or":
			return evaluateWhen(node.left) || evaluateWhen(node.right);
	}
}

interface Rule {
	command: string;
	shortcut: DictationShortcut;
	when?: WhenNode;
}

/** One `keybindings` entry, or undefined when it is malformed (T3 Code drops those too). */
function ruleOf(raw: unknown): Rule | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	const s = r.shortcut as Record<string, unknown> | null | undefined;
	if (typeof r.command !== "string" || !s || typeof s !== "object") return undefined;
	if (typeof s.key !== "string" || s.key.length === 0 || s.key.length > 64) return undefined;
	const flags = ["metaKey", "ctrlKey", "shiftKey", "altKey", "modKey"] as const;
	if (flags.some((f) => typeof s[f] !== "boolean")) return undefined;
	if (r.whenAst !== undefined && !isWhenNode(r.whenAst)) return undefined;
	return {
		command: r.command,
		// On macOS, T3 Code reads `mod` as Command.
		shortcut: { key: s.key, command: s.metaKey === true || s.modKey === true, control: s.ctrlKey === true, shift: s.shiftKey === true, option: s.altKey === true },
		when: r.whenAst as WhenNode | undefined,
	};
}

const chordKey = (s: DictationShortcut): string => [s.key, s.command, s.control, s.shift, s.option].join("|");

/**
 * The shortcut T3 Code itself shows for dictation, picked the way its
 * `effectiveShortcutsForCommand` does: the last rule wins, rules whose `when`
 * is false in the label context are skipped, and a later rule for another
 * command claims its chord. Undefined when nothing is bound.
 */
export function dictationShortcut(keybindings: unknown): DictationShortcut | undefined {
	if (!Array.isArray(keybindings)) return undefined;
	const claimed = new Set<string>();
	for (let i = keybindings.length - 1; i >= 0; i--) {
		const rule = ruleOf(keybindings[i]);
		if (!rule || (rule.when && !evaluateWhen(rule.when))) continue;
		const key = chordKey(rule.shortcut);
		if (claimed.has(key)) continue;
		claimed.add(key);
		if (rule.command === DICTATION_COMMAND) return rule.shortcut;
	}
	return undefined;
}

// ---------- Which key code ----------

/**
 * macOS virtual key codes (`kVK_ANSI_*`, `kVK_F*`, `kVK_Space` in Carbon's
 * Events.h) for the key names T3 Code's keybindings use, US ANSI layout.
 * Key codes are positions, not characters: on a non-QWERTY layout a letter
 * shortcut lands on another letter. Anything not here is refused.
 */
export const KEY_CODES: Readonly<Record<string, number>> = Object.freeze({
	a: 0x00, s: 0x01, d: 0x02, f: 0x03, h: 0x04, g: 0x05, z: 0x06, x: 0x07, c: 0x08, v: 0x09,
	b: 0x0b, q: 0x0c, w: 0x0d, e: 0x0e, r: 0x0f, y: 0x10, t: 0x11, o: 0x1f, u: 0x20, i: 0x22,
	p: 0x23, l: 0x25, j: 0x26, k: 0x28, n: 0x2d, m: 0x2e,
	"1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17, "9": 0x19, "7": 0x1a, "8": 0x1c, "0": 0x1d,
	"=": 0x18, "-": 0x1b, "]": 0x1e, "[": 0x21, "'": 0x27, ";": 0x29, "\\": 0x2a, ",": 0x2b, "/": 0x2c, ".": 0x2f, "`": 0x32,
	// T3 Code stores "space" as " ".
	" ": 0x31,
	f1: 0x7a, f2: 0x78, f3: 0x63, f4: 0x76, f5: 0x60, f6: 0x61, f7: 0x62, f8: 0x64, f9: 0x65, f10: 0x6d,
	f11: 0x67, f12: 0x6f, f13: 0x69, f14: 0x6b, f15: 0x71, f16: 0x6a, f17: 0x40, f18: 0x4f, f19: 0x50, f20: 0x5a,
});

export const keyCodeFor = (key: string): number | undefined => (Object.hasOwn(KEY_CODES, key) ? KEY_CODES[key] : undefined);

/** CGEventFlags masks (CGEventTypes.h). */
export const FLAG = { shift: 0x20000, control: 0x40000, option: 0x80000, command: 0x100000 } as const;

/** Modifier flags for the key-down. */
export function eventFlags(s: DictationShortcut): number {
	return (s.shift ? FLAG.shift : 0) | (s.control ? FLAG.control : 0) | (s.option ? FLAG.option : 0) | (s.command ? FLAG.command : 0);
}

/** "ctrl+option+shift+cmd+d", for logs. */
export function shortcutLabel(s: DictationShortcut): string {
	const key = s.key === " " ? "space" : s.key;
	return [s.control && "ctrl", s.option && "option", s.shift && "shift", s.command && "cmd", key].filter(Boolean).join("+");
}

/** The chord to post for a shortcut, or a refusal when its key isn't in the table. */
export function chordFor(s: DictationShortcut): Chord {
	const keyCode = keyCodeFor(s.key);
	const label = shortcutLabel(s);
	if (keyCode === undefined) throw new DictateRefusal("unmapped", `the dictation shortcut ${label} uses a key the Dictate key can't press; bind composer.dictation to a letter, digit or function key in T3 Code`);
	return { keyCode, flags: eventFlags(s), label };
}

// ---------- The script ----------

/** How long the script waits for T3 Code to come forward before refusing. */
export const FRONT_WAIT_MS = 1500;
/** The plugin gives up on the script after this long. */
export const SCRIPT_TIMEOUT_MS = 5000;

/**
 * The only script the plugin runs to press keys (JavaScript for Automation).
 * Every input is an argument; nothing is ever added to this text.
 *
 *   osascript -l JavaScript -e DICTATE_SCRIPT -- <tap|down|up> --bundle-id <id> --key-code <n> --flags <n> [--wait-ms <n>] [--dry-run]
 *
 * - `tap`: key-down with the flags, 40 ms, key-up. `down` / `up`: one event each.
 * - Key-ups carry no modifier flags: AppKit may not deliver a key-up while
 *   Command is set on it (T3 Code's own dictation code says so), and T3 Code
 *   ends a held dictation on the key-up of the same physical key (`event.code`),
 *   whatever the modifiers. No modifier key events are ever posted, so nothing can stay held.
 * - Posts only while the frontmost app's bundle id equals `--bundle-id`, waiting up to `--wait-ms` (default 1500) for it.
 * - Without permission to post events (Accessibility), asks once and posts nothing.
 * - `--dry-run` builds the events and reads them back, checks the front app and
 *   the permission, but posts nothing and asks for nothing.
 * - Prints one line of JSON. Exit 0: posted (or, dry run, would post); 1: error;
 *   2: bad arguments; 3: T3 Code not frontmost; 4: not permitted.
 */
export const DICTATE_SCRIPT = String.raw`
// What each import gave; CoreGraphics' functions may also come through AppKit, or be bound below.
var IMPORTS = {};
["Foundation", "AppKit", "CoreGraphics", "stdlib"].forEach(function (framework) {
	try {
		ObjC.import(framework);
		IMPORTS[framework] = "ok";
	} catch (e) {
		IMPORTS[framework] = "failed: " + e;
	}
});

var FLAG_MASK = 0x20000 | 0x40000 | 0x80000 | 0x100000; // shift, control, option (alternate), command
var KEYCODE_FIELD = 9; // kCGKeyboardEventKeycode
var HID_EVENT_TAP = 0; // kCGHIDEventTap
var TAP_GAP_S = 0.04;
var BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

// Functions the bridge may not import from CoreGraphics' BridgeSupport (the two access checks are macOS 10.15+).
var SIGNATURES = {
	CGEventCreateKeyboardEvent: ["void *", ["void *", "unsigned short", "bool"]],
	CGEventSetFlags: ["void", ["void *", "unsigned long long"]],
	CGEventGetFlags: ["unsigned long long", ["void *"]],
	CGEventGetIntegerValueField: ["long long", ["void *", "unsigned int"]],
	CGEventGetType: ["unsigned int", ["void *"]],
	CGEventPost: ["void", ["unsigned int", "void *"]],
	CGPreflightPostEventAccess: ["bool", []],
	CGRequestPostEventAccess: ["bool", []]
};

function emit(result, code) {
	var line = JSON.stringify(result) + "\n";
	$.NSFileHandle.fileHandleWithStandardOutput.writeData($(line).dataUsingEncoding($.NSUTF8StringEncoding));
	$.exit(code);
}

function fail(code, reason, message) {
	var error = new Error(message);
	error.exitCode = code;
	error.reason = reason;
	return error;
}

function integer(name, value, min, max) {
	if (!/^[0-9]{1,10}$/.test(value)) throw fail(2, "bad-args", name + " must be a whole number");
	var n = Number(value);
	if (n < min || n > max) throw fail(2, "bad-args", name + " out of range");
	return n;
}

function parse(argv) {
	var args = [];
	for (var i = 0; i < argv.length; i++) args.push(String(argv[i]));
	if (args[0] === "--") args.shift();
	var o = { mode: args.shift(), dryRun: false, waitMs: 1500 };
	if (o.mode !== "tap" && o.mode !== "down" && o.mode !== "up") throw fail(2, "bad-args", "mode must be tap, down or up");
	while (args.length > 0) {
		var name = args.shift();
		if (name === "--dry-run") { o.dryRun = true; continue; }
		if (args.length === 0) throw fail(2, "bad-args", "missing value for " + name);
		var value = args.shift();
		if (name === "--bundle-id") o.bundleId = value;
		else if (name === "--key-code") o.keyCode = integer(name, value, 0, 127);
		else if (name === "--flags") o.flags = integer(name, value, 0, FLAG_MASK);
		else if (name === "--wait-ms") o.waitMs = integer(name, value, 0, 5000);
		else throw fail(2, "bad-args", "unknown argument " + name);
	}
	if (typeof o.bundleId !== "string" || o.bundleId.length > 255 || !BUNDLE_ID.test(o.bundleId)) throw fail(2, "bad-args", "--bundle-id is missing or invalid");
	if (o.keyCode === undefined) throw fail(2, "bad-args", "--key-code is missing");
	if (o.flags === undefined) throw fail(2, "bad-args", "--flags is missing");
	if ((o.flags & ~FLAG_MASK) !== 0) throw fail(2, "bad-args", "--flags may only hold shift, control, option and command");
	return o;
}

function isNil(value) {
	return value === undefined || value === null || (typeof value.isNil === "function" && value.isNil());
}

/** How each C function was found: "bridge" (BridgeSupport), "bound" (ObjC.bindFunction) or "missing: ...". */
function resolveFunctions() {
	var how = {};
	for (var name in SIGNATURES) {
		// Anything the bridge already knows by this name is used as is; only unknown names are bound.
		var found = false;
		try { found = $[name] !== undefined && $[name] !== null; } catch (e) {}
		if (found) { how[name] = "bridge"; continue; }
		try {
			ObjC.bindFunction(name, SIGNATURES[name]);
			how[name] = "bound";
		} catch (e) {
			how[name] = "missing: " + e;
		}
	}
	return how;
}

function frontmost() {
	var app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
	if (isNil(app)) return "";
	var id = app.bundleIdentifier;
	return isNil(id) ? "" : String(ObjC.unwrap(id));
}

/** Waits for the app to come forward, letting the run loop deliver activation changes meanwhile. */
function waitForFront(bundleId, waitMs) {
	var deadline = Date.now() + waitMs;
	var seen = frontmost();
	while (seen !== bundleId && Date.now() < deadline) {
		$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
		seen = frontmost();
	}
	return seen;
}

/** Key events for the mode: the key-down carries the flags, a key-up none. */
function plan(o) {
	if (o.mode === "tap") return [{ down: true, flags: o.flags }, { down: false, flags: 0 }];
	if (o.mode === "down") return [{ down: true, flags: o.flags }];
	return [{ down: false, flags: 0 }];
}

function build(keyCode, step) {
	var event = $.CGEventCreateKeyboardEvent(null, keyCode, step.down);
	if (isNil(event)) throw fail(1, "error", "CGEventCreateKeyboardEvent returned nothing");
	$.CGEventSetFlags(event, step.flags);
	return {
		event: event,
		read: {
			type: Number($.CGEventGetType(event)),
			keyDown: step.down,
			keyCode: Number($.CGEventGetIntegerValueField(event, KEYCODE_FIELD)),
			flags: Number($.CGEventGetFlags(event))
		}
	};
}

/** Fills in result and returns the exit code; posts only when every check passed. */
function main(argv, result) {
	var o = parse(argv);
	result.mode = o.mode;
	result.dryRun = o.dryRun;
	result.expected = o.bundleId;
	result.imports = IMPORTS;
	result.functions = resolveFunctions();
	var steps = plan(o);
	var events = steps.map(function (step) { return build(o.keyCode, step); });
	result.events = events.map(function (e) { return e.read; });
	for (var i = 0; i < events.length; i++) {
		var r = events[i].read;
		if (r.keyCode !== o.keyCode || (r.flags & FLAG_MASK) !== steps[i].flags) throw fail(1, "error", "a built event reads back differently");
	}
	result.postPermitted = Boolean($.CGPreflightPostEventAccess());
	if (!result.postPermitted && !o.dryRun) {
		result.reason = "not-permitted";
		result.requested = true;
		$.CGRequestPostEventAccess();
		return 4;
	}
	result.frontmost = waitForFront(o.bundleId, o.waitMs);
	if (result.frontmost !== o.bundleId) {
		result.reason = "not-frontmost";
		return 3;
	}
	if (!result.postPermitted) {
		result.reason = "not-permitted";
		return 4;
	}
	result.posted = 0;
	if (o.dryRun) {
		result.ok = true;
		return 0;
	}
	for (var j = 0; j < events.length; j++) {
		if (j > 0) {
			$.NSThread.sleepForTimeInterval(TAP_GAP_S);
			// The key-up only goes where the key-down went.
			result.frontmost = frontmost();
			if (result.frontmost !== o.bundleId) {
				result.reason = "not-frontmost";
				return 3;
			}
		}
		$.CGEventPost(HID_EVENT_TAP, events[j].event);
		result.posted++;
	}
	result.ok = true;
	return 0;
}

function run(argv) {
	var result = { ok: false };
	var code;
	try {
		code = main(argv, result);
	} catch (e) {
		result.ok = false;
		result.reason = e && e.reason ? e.reason : "error";
		result.detail = String(e && e.message ? e.message : e);
		code = e && e.exitCode ? e.exitCode : 1;
	}
	emit(result, code);
}
`;

/** Arguments after `osascript -l JavaScript -e DICTATE_SCRIPT`. */
export function scriptArgs(phase: DictatePhase, target: DictateTarget, options: { dryRun?: boolean; waitMs?: number } = {}): string[] {
	const { bundleId, chord } = target;
	if (!validBundleId(bundleId)) throw new DictateRefusal("no-app", "invalid T3 Code bundle id");
	if (!Number.isInteger(chord.keyCode) || chord.keyCode < 0 || chord.keyCode > 127) throw new Error(`bad key code ${chord.keyCode}`);
	if (!Number.isInteger(chord.flags) || (chord.flags & ~(FLAG.shift | FLAG.control | FLAG.option | FLAG.command)) !== 0) throw new Error(`bad flags ${chord.flags}`);
	return [
		"--",
		phase,
		"--bundle-id",
		bundleId,
		"--key-code",
		String(chord.keyCode),
		"--flags",
		String(chord.flags),
		"--wait-ms",
		String(options.waitMs ?? FRONT_WAIT_MS),
		...(options.dryRun ? ["--dry-run"] : []),
	];
}

export interface ScriptOutput {
	ok: boolean;
	reason?: string;
	detail?: string;
	frontmost?: string;
}

/** The script's JSON line (the last line of stdout), or undefined when there is none. */
export function parseScriptOutput(stdout: string): ScriptOutput | undefined {
	const line = stdout.trim().split("\n").at(-1);
	if (!line) return undefined;
	try {
		const value: unknown = JSON.parse(line);
		if (!value || typeof value !== "object" || typeof (value as { ok?: unknown }).ok !== "boolean") return undefined;
		const v = value as Record<string, unknown>;
		const str = (x: unknown): string | undefined => (typeof x === "string" ? x.slice(0, 300) : undefined);
		return { ok: v.ok as boolean, reason: str(v.reason), detail: str(v.detail), frontmost: str(v.frontmost) };
	} catch {
		return undefined;
	}
}

/** Runs osascript; resolves with the exit code and output, never rejects on a non-zero exit. Swapped out in tests. */
export type RunScript = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** `/usr/bin/osascript -l JavaScript -e DICTATE_SCRIPT <args>`, through execFile: no shell. */
export const runOsascript = (args: string[], timeoutMs = SCRIPT_TIMEOUT_MS): ReturnType<RunScript> =>
	new Promise((resolve, reject) =>
		execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", DICTATE_SCRIPT, ...args], { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
			if (error && typeof error.code !== "number") return reject(error.killed ? new Error(`osascript timed out after ${timeoutMs} ms`) : error);
			resolve({ code: error ? (error.code as number) : 0, stdout: String(stdout), stderr: String(stderr) });
		}),
	);

// ---------- What the deck uses ----------

/** What a Dictate key needs; swapped out in tests. */
export interface DictationPort {
	/** The chord to press. Throws a DictateRefusal when there is none. Only the first call waits on T3 Code. */
	chord(): Promise<Chord>;
	/** Posts one phase of the shortcut to the app. Throws a DictateRefusal or an Error when nothing (or not all) was posted. */
	send(phase: DictatePhase, target: DictateTarget): Promise<void>;
	/** Look the shortcut up now, in the background (a Dictate key appeared, or was enabled). */
	prefetch(): void;
}

/** Look the shortcut up again in the background once it is this old. */
export const SHORTCUT_REFRESH_MS = 10 * 60_000;
/** A press never waits longer than this for the first lookup. */
const LOOKUP_WAIT_MS = 3000;

type Lookup = { chord: Chord } | { refusal: DictateRefusal };

export interface DictationDeps {
	/** `server.getConfig` over the read-only socket. */
	getConfig(): Promise<unknown>;
	run?: RunScript;
	now?: () => number;
}

/**
 * The shortcut cache and the script runner. The shortcut is looked up once,
 * then served from the cache while a fresh copy is fetched in the background
 * when it is older than SHORTCUT_REFRESH_MS or after a failed send.
 */
export class Dictation implements DictationPort {
	readonly #deps: DictationDeps;
	#cached: { at: number; lookup: Lookup } | undefined;
	#inflight: Promise<Lookup> | undefined;

	constructor(deps: DictationDeps) {
		this.#deps = deps;
	}

	#now(): number {
		return (this.#deps.now ?? Date.now)();
	}

	prefetch(): void {
		if (!this.#cached || this.#now() - this.#cached.at >= SHORTCUT_REFRESH_MS) void this.#lookup();
	}

	async chord(): Promise<Chord> {
		let lookup: Lookup;
		if (this.#cached) {
			lookup = this.#cached.lookup;
			this.prefetch();
		} else {
			let timer: NodeJS.Timeout | undefined;
			lookup = await Promise.race([
				this.#lookup(),
				new Promise<Lookup>((resolve) => (timer = setTimeout(() => resolve({ refusal: new DictateRefusal("lookup-failed", "T3 Code didn't say its dictation shortcut in time") }), LOOKUP_WAIT_MS))),
			]).finally(() => clearTimeout(timer));
		}
		if ("refusal" in lookup) throw lookup.refusal;
		return lookup.chord;
	}

	/** One `server.getConfig`; an answer (even "nothing bound") is cached, a failed request is not. */
	#lookup(): Promise<Lookup> {
		this.#inflight ??= (async (): Promise<Lookup> => {
			try {
				const config = (await this.#deps.getConfig()) as { keybindings?: unknown } | null;
				const shortcut = dictationShortcut(config?.keybindings);
				let lookup: Lookup;
				if (!shortcut) lookup = { refusal: new DictateRefusal("unbound", "T3 Code has no shortcut bound to composer.dictation") };
				else {
					try {
						lookup = { chord: chordFor(shortcut) };
					} catch (error) {
						lookup = { refusal: error as DictateRefusal };
					}
				}
				this.#cached = { at: this.#now(), lookup };
				return lookup;
			} catch (error) {
				return { refusal: new DictateRefusal("lookup-failed", `couldn't read T3 Code's dictation shortcut: ${(error as Error)?.message ?? String(error)}`) };
			} finally {
				this.#inflight = undefined;
			}
		})();
		return this.#inflight;
	}

	async send(phase: DictatePhase, target: DictateTarget): Promise<void> {
		const run = this.#deps.run ?? ((args: string[]) => runOsascript(args));
		try {
			const { code, stdout, stderr } = await run(scriptArgs(phase, target));
			const out = parseScriptOutput(stdout);
			if (code === 0 && out?.ok) return;
			if (out?.reason === "not-permitted") throw new DictateRefusal("not-permitted", "Stream Deck isn't allowed to post key events (System Settings → Privacy & Security → Accessibility)");
			if (out?.reason === "not-frontmost") throw new DictateRefusal("not-frontmost", `T3 Code (${target.bundleId}) didn't come to the front; the frontmost app was ${out.frontmost || "unknown"}`);
			throw new Error(`dictation script (${phase} ${target.chord.label}) exited ${code}: ${out?.detail ?? (stderr.trim().slice(0, 300) || "no output")}`);
		} catch (error) {
			// The shortcut may have changed in T3 Code: look again before the next press.
			if (this.#cached) this.#cached.at = -Infinity;
			this.prefetch();
			throw error;
		}
	}
}

// ---------- One key's presses ----------

/**
 * Deck key released within this long: one quick press (key-down, 40 ms, key-up)
 * in one script run, so T3 Code always reads it as a tap, however slow the
 * script is to start. 200 ms is longer than a normal tap on a Stream Deck key,
 * and shorter than T3 Code's own 300 ms tap/hold threshold, so a press that
 * ends here would have been a tap on the keyboard too. Held longer: key-down now,
 * key-up on release, which T3 Code's "auto" and "hold" modes read as push-to-talk.
 */
export const DICTATE_TAP_MS = 200;

export interface DictateHooks {
	/** Brings T3 Code forward (opening a thread first, if set) and resolves where and what to send. */
	prepare(): Promise<DictateTarget>;
	send(phase: DictatePhase, target: DictateTarget): Promise<void>;
	/** The key's look changed (the tap window passed with the key down, or it was let go). */
	changed(): void;
	/** A tap was sent, or a held press's key-up. */
	sent(phase: "tap" | "up"): void;
	failed(error: unknown): void;
}

interface Press {
	hooks: DictateHooks;
	holding: boolean;
	released: boolean;
	timer?: NodeJS.Timeout;
	/** Resolves at the end of the tap window or on release, whichever is first. */
	decided: Promise<void>;
	/** Resolves on release. */
	releasedSignal: Promise<void>;
	release(): void;
}

/**
 * One Dictate key's presses, in order: each press runs only after the one
 * before it finished, and a key-up is never sent before its key-down.
 */
export class DictatePresses {
	#chain: Promise<void> = Promise.resolve();
	#current: Press | undefined;

	/** Held past the tap window and not let go yet. */
	get holding(): boolean {
		return this.#current?.holding === true;
	}

	down(hooks: DictateHooks): void {
		this.up(); // a press whose key-up never arrived ends here
		let decide!: () => void;
		let releaseNow!: () => void;
		const press: Press = {
			hooks,
			holding: false,
			released: false,
			decided: new Promise<void>((resolve) => (decide = resolve)),
			releasedSignal: new Promise<void>((resolve) => (releaseNow = resolve)),
			release: () => {
				if (press.released) return;
				press.released = true;
				clearTimeout(press.timer);
				press.timer = undefined;
				decide();
				releaseNow();
			},
		};
		press.timer = setTimeout(() => {
			press.timer = undefined;
			if (press.released) return;
			press.holding = true;
			decide();
			hooks.changed();
		}, DICTATE_TAP_MS);
		this.#current = press;
		this.#chain = this.#chain.then(() => this.#run(press));
	}

	/** The deck key came up (or went away mid-press). */
	up(): void {
		const press = this.#current;
		if (!press) return;
		this.#current = undefined;
		const wasHolding = press.holding;
		press.release();
		if (wasHolding) press.hooks.changed();
	}

	/** Resolves once every press so far has finished; for tests. */
	idle(): Promise<void> {
		return this.#chain;
	}

	async #run(press: Press): Promise<void> {
		const { hooks } = press;
		try {
			const target = await hooks.prepare();
			await press.decided;
			if (!press.holding) {
				await hooks.send("tap", target);
				hooks.sent("tap");
				return;
			}
			await hooks.send("down", target);
			await press.releasedSignal;
			await hooks.send("up", target);
			hooks.sent("up");
		} catch (error) {
			hooks.failed(error);
		}
	}
}
