/**
 * Finds the T3 Code app without assuming its name or bundle id: custom and
 * rebranded builds (say `T3 Acme.app`, `com.t3tools.t3code.custom`) use
 * their own. What counts as T3 Code: a bundle id starting with
 * `com.t3tools.t3code`, an app that claims the `t3code://` URL scheme, or the
 * bundle id set in the plugin settings.
 *
 * Detection only reads `Info.plist` files (through `plutil`) and asks `ps` for
 * an executable path. It never runs anything from the app, and never touches
 * the network.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { T3Location } from "./auth.ts";

export const STOCK_BUNDLE_ID = "com.t3tools.t3code";
export const URL_SCHEME = "t3code";
/** Opens (or launches) whichever app LaunchServices maps `t3code://` to. */
export const SCHEME_URL = `${URL_SCHEME}://new`;

/** App bundle folders checked when deciding whether T3 Code is installed at all. */
export const APP_DIRS: readonly string[] = ["/Applications", path.join(os.homedir(), "Applications")];

/** Stock builds ("T3 Code.app", "T3 Code (Beta).app"): found by name, no plist read needed. */
const STOCK_NAME = /^T3 Code.*\.app$/;

/** Runs a system tool and returns its stdout; rejects on failure. Swapped out in tests. */
export type Exec = (file: string, args: string[]) => Promise<string>;

const execTool: Exec = (file, args) =>
	new Promise((resolve, reject) =>
		execFile(file, args, { timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout)))),
	);

export interface AppDeps {
	exec?: Exec;
	readdir?: (dir: string) => Promise<string[]>;
	readFile?: (file: string) => Promise<Buffer>;
	/** Whether a pid is alive and yours (`process.kill(pid, 0)`). */
	alive?: (pid: number) => boolean;
}

const defaults = {
	exec: execTool,
	readdir: (dir: string) => fs.readdir(dir),
	readFile: (file: string) => fs.readFile(file),
	alive: (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	},
} satisfies Required<AppDeps>;

/**
 * A reverse-DNS bundle id. Anything else is refused, including a leading "-",
 * which `open -b` would read as an option.
 */
export function validBundleId(id: string): boolean {
	return id.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(id);
}

/** The bundle id override from the settings, if it is set and valid. */
export function bundleIdOverride(raw: unknown): string | undefined {
	const id = typeof raw === "string" ? raw.trim() : "";
	return id && validBundleId(id) ? id : undefined;
}

/** The outermost `.app` an executable lives in (Electron helpers sit in nested ones). */
export function enclosingApp(executable: string): string | undefined {
	if (!path.isAbsolute(executable)) return undefined;
	const parts = executable.split("/");
	const i = parts.findIndex((p) => p.endsWith(".app"));
	return i > 0 ? parts.slice(0, i + 1).join("/") : undefined;
}

const infoPlist = (app: string): string => path.join(app, "Contents", "Info.plist");

async function readBundleId(app: string, exec: Exec): Promise<string | undefined> {
	try {
		const id = (await exec("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPlist(app)])).trim();
		return validBundleId(id) ? id : undefined;
	} catch {
		return undefined;
	}
}

async function readUrlSchemes(app: string, exec: Exec): Promise<string[]> {
	try {
		const types: unknown = JSON.parse(await exec("/usr/bin/plutil", ["-extract", "CFBundleURLTypes", "json", "-o", "-", infoPlist(app)]));
		if (!Array.isArray(types)) return [];
		return types.flatMap((t: { CFBundleURLSchemes?: unknown }) =>
			Array.isArray(t?.CFBundleURLSchemes) ? t.CFBundleURLSchemes.filter((s): s is string => typeof s === "string") : [],
		);
	} catch {
		return [];
	}
}

const isT3Id = (id: string | undefined, override?: string): boolean =>
	id !== undefined && (id === override || id.startsWith(STOCK_BUNDLE_ID));

/** The app's bundle id if it is T3 Code (by bundle id or `t3code://` scheme), else undefined. */
export async function t3BundleIdOf(app: string, deps: AppDeps & { override?: string } = {}): Promise<string | undefined> {
	const exec = deps.exec ?? defaults.exec;
	const id = await readBundleId(app, exec);
	if (id === undefined) return undefined;
	if (isT3Id(id, deps.override)) return id;
	return (await readUrlSchemes(app, exec)).some((s) => s.toLowerCase() === URL_SCHEME) ? id : undefined;
}

/**
 * Whether T3 Code is installed in `/Applications` or `~/Applications`: a stock
 * name, or any app whose Info.plist makes it T3 Code. Info.plist files are
 * skimmed for "t3code" (or the override) before `plutil` confirms, so only
 * likely candidates cost a process.
 */
export async function t3AppInstalled(dirs: readonly string[] = APP_DIRS, deps: AppDeps & { override?: string } = {}): Promise<boolean> {
	const readdir = deps.readdir ?? defaults.readdir;
	const readFile = deps.readFile ?? defaults.readFile;
	const listed: { dir: string; apps: string[] }[] = [];
	for (const dir of dirs) {
		try {
			const apps = (await readdir(dir)).filter((name) => name.endsWith(".app"));
			if (apps.some((name) => STOCK_NAME.test(name))) return true;
			listed.push({ dir, apps });
		} catch {
			// folder missing or unreadable
		}
	}
	const needles = [URL_SCHEME, ...(deps.override ? [deps.override] : [])];
	for (const { dir, apps } of listed) {
		for (const name of apps) {
			const app = path.join(dir, name);
			let raw: string;
			try {
				// Binary plists keep ASCII strings as-is, so this works for both formats.
				raw = (await readFile(infoPlist(app))).toString("latin1");
			} catch {
				continue;
			}
			if (!needles.some((n) => raw.includes(n))) continue;
			if (await t3BundleIdOf(app, deps)) return true;
		}
	}
	return false;
}

/** The running server's pid from `server-runtime.json`, if that process is alive. */
export async function liveServerPid(loc: T3Location, deps: AppDeps = {}): Promise<number | undefined> {
	try {
		const raw = (await (deps.readFile ?? defaults.readFile)(path.join(loc.home, "userdata", "server-runtime.json"))).toString("utf8");
		const pid = (JSON.parse(raw) as { pid?: unknown }).pid;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
		return (deps.alive ?? defaults.alive)(pid) ? pid : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolves the T3 Code app behind a running process: its executable (`ps`),
 * the enclosing `.app`, then that app's bundle id, which must look like
 * T3 Code (so a stale runtime file whose pid now belongs to another app is
 * ignored). Results are cached per pid and executable.
 */
export class AppLocator {
	readonly #deps: AppDeps;
	#cached: { key: string; id: string | undefined } | undefined;

	constructor(deps: AppDeps = {}) {
		this.#deps = deps;
	}

	async bundleIdForPid(pid: number): Promise<string | undefined> {
		const exec = this.#deps.exec ?? defaults.exec;
		let executable: string;
		try {
			executable = (await exec("/bin/ps", ["-p", String(pid), "-o", "comm="])).trim();
		} catch {
			return undefined; // gone
		}
		const app = enclosingApp(executable);
		if (!app) return undefined; // a server started from the CLI, not from an app
		const key = `${pid}:${app}`;
		if (this.#cached?.key === key) return this.#cached.id;
		const id = await t3BundleIdOf(app, this.#deps);
		this.#cached = { key, id };
		return id;
	}

	/**
	 * `open` arguments that bring T3 Code forward, in this order:
	 * 1. the bundle id set in the settings;
	 * 2. the bundle id of the app running the server;
	 * 3. the `t3code://` scheme, which launches whichever app owns it.
	 */
	async openArgs(loc: T3Location): Promise<string[]> {
		if (loc.appBundleId) return ["-b", loc.appBundleId];
		const pid = await liveServerPid(loc, this.#deps);
		const id = pid === undefined ? undefined : await this.bundleIdForPid(pid);
		return id ? ["-b", id] : [SCHEME_URL];
	}
}
