import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AppLocator, bundleIdOverride, discoverHome, enclosingApp, liveServerPid, t3AppInstalled, t3BundleIdOf, validBundleId, type AppDeps } from "../src/t3/app.ts";
import { locate, type T3Location } from "../src/t3/auth.ts";

/** A fake Mac: apps with their Info.plist values, processes, and runtime files. */
interface FakeApp {
	id: string;
	schemes?: string[];
	/** Store the plist as binary (bplist) instead of XML; both must be found. */
	binary?: boolean;
}

function fakeMac(opts: { dirs?: Record<string, Record<string, FakeApp>>; procs?: Record<number, string>; runtime?: Record<string, unknown>; alive?: number[] }) {
	const dirs = opts.dirs ?? {};
	const apps = new Map<string, FakeApp>();
	for (const [dir, entries] of Object.entries(dirs)) for (const [name, app] of Object.entries(entries)) apps.set(`${dir}/${name}`, app);
	const calls: string[] = [];
	const plistOf = (file: string) => apps.get(file.replace(/\/Contents\/Info\.plist$/, ""));
	const deps: AppDeps = {
		readdir: async (dir) => {
			if (!dirs[dir]) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return Object.keys(dirs[dir]!);
		},
		readFile: async (file) => {
			const runtime = opts.runtime?.[file];
			if (runtime !== undefined) return Buffer.from(JSON.stringify(runtime));
			const app = plistOf(file);
			if (!app) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			const schemes = (app.schemes ?? []).map((s) => `<string>${s}</string>`).join("");
			return Buffer.from(app.binary ? `bplist00\u0000${app.id}\u0001${(app.schemes ?? []).join("\u0002")}` : `<?xml?><plist><string>${app.id}</string>${schemes}</plist>`, "latin1");
		},
		exec: async (file, args) => {
			calls.push(`${file.split("/").pop()} ${args.join(" ")}`);
			if (file === "/bin/ps") {
				const exe = opts.procs?.[Number(args[1])];
				if (!exe) throw new Error("no such process");
				return `${exe}\n`;
			}
			const app = plistOf(args.at(-1)!);
			if (!app) throw new Error("no plist");
			if (args[1] === "CFBundleIdentifier") return `${app.id}\n`;
			if (!app.schemes) throw new Error("No value at that key path");
			return JSON.stringify([{ CFBundleURLName: "x", CFBundleURLSchemes: app.schemes }]);
		},
		alive: (pid) => (opts.alive ?? []).includes(pid),
	};
	return { deps, calls };
}

const HOME = "/Users/me/.t3-custom";
const RUNTIME = `${HOME}/userdata/server-runtime.json`;
const loc = (extra: Partial<T3Location> = {}): T3Location => ({ home: HOME, cli: `${HOME}/bin/t3`, custom: true, ...extra });
const CUSTOM_EXE = "/Users/me/Applications/T3 Acme.app/Contents/MacOS/T3 Acme";
const customBuild: FakeApp = { id: "com.t3tools.t3code.custom", schemes: ["t3code"] };

test("validBundleId / bundleIdOverride: reverse-DNS only, never an option", () => {
	assert.ok(validBundleId("com.t3tools.t3code.custom"));
	assert.ok(!validBundleId("-a Terminal"));
	assert.ok(!validBundleId("com.example app"));
	assert.equal(bundleIdOverride("  com.example.t3  "), "com.example.t3");
	assert.equal(bundleIdOverride("--args"), undefined);
	assert.equal(bundleIdOverride(""), undefined);
	assert.equal(bundleIdOverride(42), undefined);
	assert.equal(locate({ t3AppBundleId: "com.example.t3" }, {}).appBundleId, "com.example.t3");
	assert.equal(locate({ t3AppBundleId: "-b x" }, {}).appBundleId, undefined);
	assert.equal(locate({}, {}).appBundleId, undefined);
});

test("enclosingApp: the outermost .app, even from an Electron helper", () => {
	assert.equal(enclosingApp(CUSTOM_EXE), "/Users/me/Applications/T3 Acme.app");
	assert.equal(
		enclosingApp("/Applications/T3 Code.app/Contents/Frameworks/T3 Code Helper.app/Contents/MacOS/T3 Code Helper"),
		"/Applications/T3 Code.app",
	);
	assert.equal(enclosingApp("/usr/local/bin/node"), undefined, "a server started from the CLI has no app");
	assert.equal(enclosingApp("node"), undefined);
});

test("t3BundleIdOf: by bundle id prefix, by t3code:// scheme, or by the override", async () => {
	const { deps } = fakeMac({
		dirs: {
			"/Applications": {
				"Stock.app": { id: "com.t3tools.t3code" },
				"Rebrand.app": { id: "com.acme.agentdesk", schemes: ["acme", "t3code"] },
				"Other.app": { id: "com.acme.other", schemes: ["acme"] },
			},
		},
	});
	assert.equal(await t3BundleIdOf("/Applications/Stock.app", deps), "com.t3tools.t3code");
	assert.equal(await t3BundleIdOf("/Applications/Rebrand.app", deps), "com.acme.agentdesk");
	assert.equal(await t3BundleIdOf("/Applications/Other.app", deps), undefined);
	assert.equal(await t3BundleIdOf("/Applications/Other.app", { ...deps, override: "com.acme.other" }), "com.acme.other");
});

test("t3AppInstalled: stock name fast path, then Info.plist by scheme or bundle id", async () => {
	// Stock name: found without reading a single plist.
	const stock = fakeMac({ dirs: { "/Applications": { "T3 Code (Beta).app": { id: "com.t3tools.t3code" } } } });
	assert.equal(await t3AppInstalled(["/Applications", "/nope"], stock.deps), true);
	assert.deepEqual(stock.calls, []);

	// A custom build in ~/Applications, other apps around it: only the candidate costs a plutil run.
	const custom = fakeMac({
		dirs: {
			"/Applications": { "Safari.app": { id: "com.apple.Safari", schemes: ["http"] }, "Notes.app": { id: "com.apple.Notes", binary: true } },
			"/Users/me/Applications": { "T3 Acme.app": customBuild },
		},
	});
	assert.equal(await t3AppInstalled(["/Applications", "/Users/me/Applications"], custom.deps), true);
	assert.ok(custom.calls.every((c) => c.includes("T3 Acme.app")), custom.calls.join("\n"));

	// Claims t3code:// under another bundle id, stored as a binary plist.
	const rebrand = fakeMac({ dirs: { "/Applications": { "Agent Desk.app": { id: "com.acme.agentdesk", schemes: ["t3code"], binary: true } } } });
	assert.equal(await t3AppInstalled(["/Applications"], rebrand.deps), true);

	// Only the override identifies it.
	const odd = fakeMac({ dirs: { "/Applications": { "Odd.app": { id: "com.acme.odd" } } } });
	assert.equal(await t3AppInstalled(["/Applications"], odd.deps), false);
	assert.equal(await t3AppInstalled(["/Applications"], { ...odd.deps, override: "com.acme.odd" }), true);

	// Mentions t3code somewhere but is neither: not T3.
	const lookalike = fakeMac({ dirs: { "/Applications": { "Notes for t3code.app": { id: "com.acme.notes", schemes: ["notes"] } } } });
	assert.equal(await t3AppInstalled(["/Applications"], lookalike.deps), false);
	assert.equal(await t3AppInstalled(["/missing"], lookalike.deps), false);
});

test("liveServerPid: only a pid that is alive", async () => {
	assert.equal(await liveServerPid(loc(), fakeMac({ runtime: { [RUNTIME]: { pid: 4242 } }, alive: [4242] }).deps), 4242);
	assert.equal(await liveServerPid(loc(), fakeMac({ runtime: { [RUNTIME]: { pid: 4242 } } }).deps), undefined, "gone");
	assert.equal(await liveServerPid(loc(), fakeMac({ runtime: { [RUNTIME]: { pid: "4242" } }, alive: [4242] }).deps), undefined);
	assert.equal(await liveServerPid(loc(), fakeMac({}).deps), undefined, "no runtime file");
});

test("AppLocator.bundleIdForPid: ps → enclosing .app → Info.plist, cached per pid", async () => {
	const mac = fakeMac({
		dirs: { "/Users/me/Applications": { "T3 Acme.app": customBuild }, "/Applications": { "Music.app": { id: "com.apple.Music" } } },
		procs: { 4242: CUSTOM_EXE, 777: "/Applications/Music.app/Contents/MacOS/Music", 900: "/usr/local/bin/node" },
	});
	const locator = new AppLocator(mac.deps);
	assert.equal(await locator.bundleIdForPid(4242), "com.t3tools.t3code.custom");
	const plistReads = mac.calls.filter((c) => c.startsWith("plutil")).length;
	assert.equal(await locator.bundleIdForPid(4242), "com.t3tools.t3code.custom");
	assert.equal(mac.calls.filter((c) => c.startsWith("plutil")).length, plistReads, "second lookup is cached");
	// A stale runtime file whose pid now belongs to some other app: not T3, never opened.
	assert.equal(await locator.bundleIdForPid(777), undefined);
	assert.equal(await locator.bundleIdForPid(900), undefined, "CLI server, no app");
	assert.equal(await locator.bundleIdForPid(31337), undefined, "no such process");
});

test("AppLocator.openArgs: override, then the running app, then the t3code:// scheme", async () => {
	const mac = fakeMac({
		dirs: { "/Users/me/Applications": { "T3 Acme.app": customBuild }, "/Applications": { "T3 Code.app": { id: "com.t3tools.t3code", schemes: ["t3code"] } } },
		procs: { 4242: CUSTOM_EXE, 5000: "/Applications/T3 Code.app/Contents/MacOS/T3 Code", 900: "/usr/local/bin/node" },
		runtime: { [RUNTIME]: { pid: 4242 } },
		alive: [4242, 5000, 900],
	});
	const locator = new AppLocator(mac.deps);
	// Custom build running: its own bundle id.
	assert.deepEqual(await locator.openArgs(loc()), ["-b", "com.t3tools.t3code.custom"]);
	// The override wins over detection, without asking ps at all.
	const before = mac.calls.length;
	assert.deepEqual(await locator.openArgs(loc({ appBundleId: "com.acme.pinned" })), ["-b", "com.acme.pinned"]);
	assert.equal(mac.calls.length, before);
	// Stock build running: the stock id, as before.
	const stock = new AppLocator(fakeMac({ ...{ procs: { 5000: "/Applications/T3 Code.app/Contents/MacOS/T3 Code" } }, dirs: { "/Applications": { "T3 Code.app": { id: "com.t3tools.t3code" } } }, runtime: { [RUNTIME]: { pid: 5000 } }, alive: [5000] }).deps);
	assert.deepEqual(await stock.openArgs(loc()), ["-b", "com.t3tools.t3code"]);
	// Not running (pid gone, or no runtime file): the scheme launches whichever app owns t3code://.
	const stopped = new AppLocator(fakeMac({ runtime: { [RUNTIME]: { pid: 4242 } } }).deps);
	assert.deepEqual(await stopped.openArgs(loc()), ["t3code://new"]);
	assert.deepEqual(await new AppLocator(fakeMac({}).deps).openArgs(loc()), ["t3code://new"]);
	// Running from the CLI (no .app): the scheme too.
	const cli = new AppLocator(fakeMac({ procs: { 900: "/usr/local/bin/node" }, runtime: { [RUNTIME]: { pid: 900 } }, alive: [900] }).deps);
	assert.deepEqual(await cli.openArgs(loc()), ["t3code://new"]);
});

/** A fake home folder for discoverHome: folders with owner and mode; anything else is a symlink. */
function fakeHomes(entries: Record<string, { uid?: number; mode?: number; symlink?: boolean }>, opts: { unreadable?: boolean } = {}) {
	const ME = 501;
	const calls: string[] = [];
	const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	const deps = {
		uid: ME,
		readdir: async (dir: string) => {
			calls.push(`readdir ${dir}`);
			if (opts.unreadable) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
			return [...new Set(Object.keys(entries).filter((p) => path.dirname(p) === dir).map((p) => path.basename(p)))];
		},
		lstat: async (p: string) => {
			calls.push(`lstat ${p}`);
			const e = entries[p];
			if (!e) throw enoent();
			return { isDirectory: () => !e.symlink, uid: e.uid ?? ME, mode: e.mode ?? 0o40755 };
		},
		stat: async (p: string) => {
			calls.push(`stat ${p}`);
			if (!entries[p]) throw enoent();
			return { isDirectory: () => true };
		},
	};
	return { deps, calls };
}

const base = (extra: Partial<T3Location> = {}): T3Location => ({ home: "/Users/me/.t3", cli: "/Users/me/.t3/bin/t3", custom: false, ...extra });
const owned = (name: string) => ({ [`/Users/me/${name}`]: {}, [`/Users/me/${name}/userdata`]: {} });

test("discoverHome: a set T3 home, or ~/.t3 in use, is the default; nothing is listed", async () => {
	const custom = fakeHomes(owned(".t3-custom"));
	assert.equal(await discoverHome(base({ custom: true }), custom.deps), "default");
	assert.deepEqual(custom.calls, []);
	const inUse = fakeHomes({ "/Users/me/.t3/userdata": {}, ...owned(".t3-custom") });
	assert.equal(await discoverHome(base(), inUse.deps), "default");
	assert.deepEqual(inUse.calls, ["stat /Users/me/.t3/userdata"]);
});

test("discoverHome: the one ~/.t3-<name> folder you own is used, with its own CLI", async () => {
	const { deps } = fakeHomes({ "/Users/me/.t3": {}, ...owned(".t3-custom"), "/Users/me/Documents": {}, ...owned("t3-plain"), ...owned(".t3-") });
	// `t3-plain` (no dot) and a bare `.t3-` aren't custom homes, so they don't make it "several".
	assert.deepEqual(await discoverHome(base({ appBundleId: "com.example.t3" }), deps), {
		home: "/Users/me/.t3-custom",
		cli: "/Users/me/.t3-custom/bin/t3",
		custom: false,
		discovered: true,
		appBundleId: "com.example.t3",
	});
});

test("discoverHome: several candidates, or none, is no answer", async () => {
	assert.equal(await discoverHome(base(), fakeHomes({ ...owned(".t3-a"), ...owned(".t3-b") }).deps), undefined, "never guesses between two builds");
	assert.equal(await discoverHome(base(), fakeHomes({ "/Users/me/Documents": {} }).deps), undefined);
	assert.equal(await discoverHome(base(), fakeHomes(owned(".t3-a"), { unreadable: true }).deps), undefined, "home folder can't be listed");
});

test("discoverHome: a candidate must be a real folder you own that nobody else can write, with a userdata that is too", async () => {
	const rejected: Record<string, Record<string, { uid?: number; mode?: number; symlink?: boolean }>> = {
		"no userdata": { "/Users/me/.t3-x": {} },
		"symlinked folder": { "/Users/me/.t3-x": { symlink: true }, "/Users/me/.t3-x/userdata": {} },
		"symlinked userdata": { "/Users/me/.t3-x": {}, "/Users/me/.t3-x/userdata": { symlink: true } },
		"another owner": { "/Users/me/.t3-x": { uid: 0 }, "/Users/me/.t3-x/userdata": { uid: 0 } },
		"group-writable": { "/Users/me/.t3-x": { mode: 0o40775 }, "/Users/me/.t3-x/userdata": {} },
		"world-writable userdata": { "/Users/me/.t3-x": {}, "/Users/me/.t3-x/userdata": { mode: 0o40757 } },
	};
	for (const [why, entries] of Object.entries(rejected)) assert.equal(await discoverHome(base(), fakeHomes(entries).deps), undefined, why);
	// A rejected candidate doesn't count toward "several": the good one still wins.
	const mixed = fakeHomes({ ...owned(".t3-good"), "/Users/me/.t3-bad": { uid: 0 }, "/Users/me/.t3-bad/userdata": { uid: 0 } });
	assert.equal(((await discoverHome(base(), mixed.deps)) as T3Location).home, "/Users/me/.t3-good");
});

test("discoverHome on a real folder: finds the sibling, skips a symlink and a group-writable one", { skip: process.getuid === undefined ? "needs POSIX owners" : false }, async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3deck-home-"));
	try {
		const t3: T3Location = { home: path.join(root, ".t3"), cli: path.join(root, ".t3", "bin", "t3"), custom: false };
		await fs.mkdir(path.join(root, ".t3-custom", "userdata"), { recursive: true, mode: 0o755 });
		await fs.chmod(path.join(root, ".t3-custom"), 0o755);
		await fs.chmod(path.join(root, ".t3-custom", "userdata"), 0o755);
		await fs.symlink(path.join(root, ".t3-custom"), path.join(root, ".t3-link"));
		await fs.mkdir(path.join(root, ".t3-loose", "userdata"), { recursive: true });
		await fs.chmod(path.join(root, ".t3-loose"), 0o775);
		assert.equal(((await discoverHome(t3)) as T3Location).home, path.join(root, ".t3-custom"));
		// ~/.t3 comes into use: it wins.
		await fs.mkdir(path.join(root, ".t3", "userdata"), { recursive: true });
		assert.equal(await discoverHome(t3), "default");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
