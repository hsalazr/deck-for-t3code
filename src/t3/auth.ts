/**
 * Finds the running T3 Code server and manages the plugin's own credentials.
 *
 * The plugin mints its tokens with the local `t3` CLI, e.g.
 *   t3 auth session issue --subject mcp-client --scope orchestration:read --ttl 30d
 * Tokens live in 0600 files outside the plugin folder, so they survive plugin
 * updates. Read tokens last 30 days and are renewed once half their lifetime
 * has passed; the actions token lasts 24 hours and is only ever minted while
 * Thread Actions are turned on. Every replaced token is revoked, and a revoke
 * that fails is kept in `pending-revoke.json` and retried on later starts, so
 * the plugin never loses track of a token it minted.
 *
 * Credentials are only ever sent to a loopback origin (see `loopbackOrigin`).
 */
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { APP_DIRS, bundleIdOverride, t3AppInstalled } from "./app.ts";

export { t3AppInstalled };

/** Why the plugin can't reach T3, so keys can say what to do about it. */
export type ConnectionReason = "not-installed" | "not-running" | "cli-missing" | "sign-in-failed" | "signed-out" | "server-error";

/** A failure with a reason the keys and the property inspector can explain. */
export class T3Error extends Error {
	readonly reason: ConnectionReason;

	constructor(reason: ConnectionReason, message: string) {
		super(message);
		this.name = "T3Error";
		this.reason = reason;
	}

	/** Nothing is wrong, the plugin just isn't connected: T3 isn't there, or the user signed out. */
	get offline(): boolean {
		return this.reason === "not-installed" || this.reason === "not-running" || this.reason === "signed-out";
	}
}

/** Thread actions (stop, snooze, settle, send) are turned off in the plugin settings. */
export class ActionsDisabledError extends Error {
	constructor() {
		super("Thread actions are turned off. Turn on Thread Actions in the plugin settings to use them.");
		this.name = "ActionsDisabledError";
	}
}

/** The user signed out from the property inspector; nothing is minted until they sign in again. */
export class SignedOutError extends T3Error {
	constructor() {
		super("signed-out", "Signed out of T3 Code. Sign in again from the key settings (or restart the plugin).");
		this.name = "SignedOutError";
	}
}

export interface T3Location {
	/** T3 Code home, normally ~/.t3. Must be absolute; `readServerOrigin` rejects anything else. */
	home: string;
	/** Path to the `t3` launcher script, always `<home>/bin/t3`. */
	cli: string;
	/** The home came from a setting or T3CODE_HOME rather than the default. */
	custom: boolean;
	/** "T3 app bundle id" setting: when set, it is the app to open, and detection is skipped. */
	appBundleId?: string;
}

export const expandHome = (p: string): string => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);

export function locate(overrides: { t3Home?: string; t3AppBundleId?: string } = {}, env: NodeJS.ProcessEnv = process.env): T3Location {
	const configured = overrides.t3Home?.trim() || env.T3CODE_HOME?.trim() || "";
	const home = configured ? expandHome(configured) : path.join(os.homedir(), ".t3");
	const appBundleId = bundleIdOverride(overrides.t3AppBundleId);
	return { home, cli: path.join(home, "bin", "t3"), custom: configured !== "", ...(appBundleId ? { appBundleId } : {}) };
}

/** T3 home must be an absolute path once `~` is expanded. */
export function checkHome(loc: T3Location): void {
	if (!path.isAbsolute(loc.home)) {
		throw new T3Error("not-installed", `T3 home "${loc.home}" must be an absolute path (or start with ~/). Fix it in the key settings.`);
	}
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The only place that decides where credentials may go: an http(s) origin on
 * this machine (127.0.0.1, localhost or ::1) with no user info. Anything else
 * in server-runtime.json is refused before a token is minted or sent.
 */
export function loopbackOrigin(raw: unknown): string {
	if (typeof raw !== "string" || raw.trim() === "") throw new T3Error("server-error", "server-runtime.json has no origin");
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new T3Error("server-error", "server-runtime.json has an origin that isn't a URL; not sending credentials");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new T3Error("server-error", `T3 Code's server origin uses ${url.protocol} (only http and https are allowed); not sending credentials`);
	}
	if (url.username || url.password) {
		throw new T3Error("server-error", "T3 Code's server origin contains a user name or password; not sending credentials");
	}
	if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
		throw new T3Error(
			"server-error",
			`T3 Code's server origin ${url.host} is not on this machine (only 127.0.0.1, localhost or ::1 are allowed); not sending credentials`,
		);
	}
	return url.origin;
}

const exists = (p: string): Promise<boolean> =>
	fs.stat(p).then(
		() => true,
		() => false,
	);

/** Reads `userdata/server-runtime.json`, which T3 rewrites on every start, and returns its (validated) origin. */
export async function readServerOrigin(loc: T3Location, deps: { appInstalled?: () => Promise<boolean> } = {}): Promise<string> {
	checkHome(loc);
	const file = path.join(loc.home, "userdata", "server-runtime.json");
	let raw: string;
	try {
		raw = await fs.readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new T3Error("server-error", `can't read ${file}: ${(error as Error).message}`);
		}
		const installed = await (deps.appInstalled ?? (() => t3AppInstalled(APP_DIRS, { override: loc.appBundleId })))();
		if (!(await exists(loc.home))) {
			if (loc.custom) throw new T3Error("not-installed", `T3 home ${loc.home} does not exist. Check T3 home in the key settings.`);
			if (!installed) throw new T3Error("not-installed", "T3 Code isn't installed (no T3 Code app in /Applications or ~/Applications, and no ~/.t3).");
			throw new T3Error("not-running", "T3 Code has never run on this Mac. Open it once.");
		}
		if (!installed && !loc.custom) throw new T3Error("not-installed", "T3 Code isn't installed (no T3 Code app in /Applications or ~/Applications).");
		throw new T3Error("not-running", "T3 Code is not running (no server-runtime.json).");
	}
	let state: { origin?: unknown; port?: unknown; pid?: unknown };
	try {
		state = JSON.parse(raw) as typeof state;
	} catch {
		throw new T3Error("server-error", "server-runtime.json is not valid JSON");
	}
	if (typeof state.pid === "number" && Number.isInteger(state.pid) && state.pid > 0) {
		try {
			process.kill(state.pid, 0);
		} catch (error) {
			// ESRCH: gone. EPERM: the pid exists but belongs to another user, so it isn't
			// your T3 Code (a stale file whose pid was reused); don't talk to its port.
			const why = (error as NodeJS.ErrnoException).code === "EPERM" ? `pid ${state.pid} belongs to another user` : `pid ${state.pid} is gone`;
			throw new T3Error("not-running", `T3 Code is not running (${why}).`);
		}
	}
	if (state.origin !== undefined && state.origin !== null && state.origin !== "") return loopbackOrigin(state.origin);
	if (typeof state.port === "number" && Number.isInteger(state.port) && state.port > 0 && state.port < 65536) {
		return loopbackOrigin(`http://127.0.0.1:${state.port}`);
	}
	throw new T3Error("server-error", "server-runtime.json has no origin");
}

/**
 * The CLI is only run if it is a regular file owned by you (or root) that
 * nobody else can write to; otherwise another user could swap in their own
 * program and have it run with your T3 access.
 */
export async function checkCli(cli: string, uid: number = process.getuid?.() ?? -1): Promise<void> {
	if (!path.isAbsolute(cli)) throw new T3Error("cli-missing", `T3 Code's command-line tool path ${cli} is not absolute.`);
	let st: Awaited<ReturnType<typeof fs.stat>>;
	try {
		st = await fs.stat(cli);
	} catch {
		throw new T3Error("cli-missing", `T3 Code's command-line tool isn't at ${cli}. Open T3 Code once so it installs it.`);
	}
	if (!st.isFile()) throw new T3Error("cli-missing", `${cli} is not a regular file; not running it.`);
	if ((st.mode & 0o022) !== 0) {
		throw new T3Error("cli-missing", `${cli} can be changed by other users (mode ${(st.mode & 0o777).toString(8)}); not running it. Fix with: chmod go-w "${cli}"`);
	}
	if (uid >= 0 && st.uid !== uid && st.uid !== 0) throw new T3Error("cli-missing", `${cli} belongs to another user (uid ${st.uid}); not running it.`);
	if ((st.mode & 0o100) === 0) throw new T3Error("cli-missing", `${cli} is not executable.`);
}

/**
 * Three credentials:
 * - "mcp": an mcp-client session for POST /mcp (threads).
 * - "rpc": a plain bearer session for the /ws RPC socket, which refuses
 *   mcp-client tokens. Used for the live shell stream, context usage and usage limits.
 * - "operate": a plain bearer session that may also act on threads (stop,
 *   snooze, settle, send), through the same dispatchCommand path T3's UI uses.
 *   Only the Thread Actions keys use it, and only while they are turned on.
 */
export type CredentialKind = "mcp" | "rpc" | "operate";

export const CREDENTIAL_KINDS: readonly CredentialKind[] = ["mcp", "rpc", "operate"];

const DAY_MS = 24 * 3600_000;

export const KINDS: Record<CredentialKind, { file: string; subject?: string; label: string; scopes: string[]; ttl: string; ttlMs: number }> = {
	mcp: { file: "credential.json", subject: "mcp-client", label: "Stream Deck (Deck for T3 Code)", scopes: ["orchestration:read"], ttl: "30d", ttlMs: 30 * DAY_MS },
	rpc: { file: "credential-rpc.json", label: "Stream Deck (Deck for T3 Code usage)", scopes: ["orchestration:read"], ttl: "30d", ttlMs: 30 * DAY_MS },
	operate: {
		file: "credential-operate.json",
		label: "Stream Deck (Deck for T3 Code actions)",
		scopes: ["orchestration:read", "orchestration:operate"],
		ttl: "24h",
		ttlMs: DAY_MS,
	},
};

export interface StoredCredential {
	/** Origin it was minted for. Informational: any loopback origin may use it. */
	origin: string;
	sessionId: string;
	token: string;
	expiresAt: string;
	/** When the plugin minted it (absent on tokens from older versions). */
	issuedAt?: string;
}

/** A token that was replaced or signed out but not revoked yet. */
export interface PendingRevoke {
	sessionId: string;
	kind: CredentialKind;
	/** Once it has expired there is nothing left to revoke. */
	expiresAt?: string;
	addedAt: string;
}

export const isExpired = (cred: Pick<StoredCredential, "expiresAt">, now: number): boolean => !(Date.parse(cred.expiresAt) > now);

/**
 * Renew once less than half the token's lifetime remains. Tokens from older
 * versions (no `issuedAt`, minted for 365 days) and tokens that live longer
 * than the current policy are renewed right away.
 */
export function needsRenewal(cred: StoredCredential, kind: CredentialKind, now: number): boolean {
	const expires = Date.parse(cred.expiresAt);
	const issued = cred.issuedAt ? Date.parse(cred.issuedAt) : Number.NaN;
	if (!Number.isFinite(expires) || expires <= now) return true;
	if (!Number.isFinite(issued) || issued >= expires) return true;
	const lifetime = expires - issued;
	if (lifetime > KINDS[kind].ttlMs * 1.5) return true;
	return expires - now < lifetime / 2;
}

/** Session ids go to the CLI as an argument; never let one look like a flag. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export type CliRunner = (cli: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;

const execCli: CliRunner = (cli, args, env) =>
	new Promise((resolve, reject) => {
		execFile(cli, args, { timeout: 30_000, env, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(new Error(`t3 ${args.slice(0, 3).join(" ")} failed: ${String(stderr).trim() || error.message}`));
			else resolve(String(stdout));
		});
	});

const PLUGIN_ID = "io.github.hsalazr.deck-for-t3code";
export const DEFAULT_CREDENTIAL_DIR = path.join(os.homedir(), "Library", "Application Support", PLUGIN_ID);

const MINT_COOLDOWN_MS = 60_000;
/** After a renewal mint fails, keep using the current token and try again this much later. */
const RENEW_RETRY_MS = 10 * 60_000;

export interface TokenStoreOptions {
	dir?: string;
	run?: CliRunner;
	/** Replaces the CLI safety check (tests). */
	checkCli?: (cli: string) => Promise<void>;
	now?: () => number;
	cooldownMs?: number;
}

export interface SignOutResult {
	ok: boolean;
	/** Tokens revoked now. */
	revoked: number;
	/** Tokens that couldn't be revoked; kept in pending-revoke.json and retried later. */
	failed: number;
	detail?: string;
}

/**
 * The plugin's credentials. One instance is shared by everything (the
 * default export below) so mints are serialized per kind and the mint
 * cooldown is shared.
 */
export class TokenStore extends EventEmitter<{ log: [string] }> {
	readonly dir: string;
	readonly #run: CliRunner;
	readonly #checkCli: (cli: string) => Promise<void>;
	readonly #now: () => number;
	readonly #cooldownMs: number;
	readonly #minting = new Map<CredentialKind, Promise<StoredCredential>>();
	readonly #lastMint = new Map<CredentialKind, { at: number; error?: Error }>();
	readonly #renewFailedAt = new Map<CredentialKind, number>();
	#pendingLock: Promise<unknown> = Promise.resolve();

	/** The global setting: the actions token can only be minted or used while this is true. */
	actionsEnabled = false;
	/** Set by `signOut()`; nothing is minted until `signIn()`. */
	signedOut = false;

	constructor(opts: TokenStoreOptions = {}) {
		super();
		this.dir = opts.dir ?? DEFAULT_CREDENTIAL_DIR;
		this.#run = opts.run ?? execCli;
		this.#checkCli = opts.checkCli ?? ((cli) => checkCli(cli));
		this.#now = opts.now ?? Date.now;
		this.#cooldownMs = opts.cooldownMs ?? MINT_COOLDOWN_MS;
	}

	file(kind: CredentialKind): string {
		return path.join(this.dir, KINDS[kind].file);
	}

	get pendingFile(): string {
		return path.join(this.dir, "pending-revoke.json");
	}

	/** The stored credential as-is (expired or not), or null. */
	async load(kind: CredentialKind): Promise<StoredCredential | null> {
		try {
			const stored = JSON.parse(await fs.readFile(this.file(kind), "utf8")) as Partial<StoredCredential>;
			if (typeof stored.token !== "string" || !stored.token) return null;
			if (typeof stored.sessionId !== "string" || typeof stored.expiresAt !== "string") return null;
			return {
				origin: typeof stored.origin === "string" ? stored.origin : "",
				sessionId: stored.sessionId,
				token: stored.token,
				expiresAt: stored.expiresAt,
				...(typeof stored.issuedAt === "string" ? { issuedAt: stored.issuedAt } : {}),
			};
		} catch {
			return null;
		}
	}

	/** A usable, unexpired token of this kind is on disk. */
	async has(kind: CredentialKind): Promise<boolean> {
		const stored = await this.load(kind);
		return !!stored && !isExpired(stored, this.#now());
	}

	/**
	 * A token to use: the stored one (on any loopback origin), renewed when due.
	 * If renewal fails the current token keeps working until it expires.
	 */
	async token(loc: T3Location, origin: string, kind: CredentialKind): Promise<string> {
		this.#gate(kind);
		const stored = await this.load(kind);
		const now = this.#now();
		if (stored && !isExpired(stored, now)) {
			if (!needsRenewal(stored, kind, now)) return stored.token;
			if (now - (this.#renewFailedAt.get(kind) ?? -Infinity) < RENEW_RETRY_MS) return stored.token;
			try {
				return (await this.mint(loc, origin, kind)).token;
			} catch (error) {
				if (error instanceof ActionsDisabledError || error instanceof SignedOutError) throw error;
				this.#renewFailedAt.set(kind, now);
				this.emit("log", `renewing the ${kind} token failed (still valid until ${stored.expiresAt}): ${(error as Error).message}`);
				return stored.token;
			}
		}
		return (await this.mint(loc, origin, kind)).token;
	}

	/**
	 * T3 rejected `rejected`. Another component (or another copy of the
	 * plugin) may have just minted a new one, so reload the file first and
	 * only mint when it still holds the rejected token.
	 */
	async replace(loc: T3Location, origin: string, kind: CredentialKind, rejected: string): Promise<string> {
		this.#gate(kind);
		const stored = await this.load(kind);
		if (stored && stored.token !== rejected && !isExpired(stored, this.#now())) return stored.token;
		return (await this.mint(loc, origin, kind)).token;
	}

	/**
	 * Runs `attempt` with a token; when T3 rejects it (`isRejection`), retries
	 * with a replacement, at most twice. A token T3 rejects right after it was
	 * minted means signing in itself fails.
	 */
	async withToken<T>(loc: T3Location, origin: string, kind: CredentialKind, attempt: (token: string) => Promise<T>, isRejection: (error: unknown) => boolean): Promise<T> {
		let token = await this.token(loc, origin, kind);
		for (let tries = 0; ; tries++) {
			try {
				return await attempt(token);
			} catch (error) {
				if (!isRejection(error)) throw error;
				if (tries >= 2) throw new T3Error("sign-in-failed", `T3 Code rejected a freshly minted ${kind} token: ${(error as Error).message}`);
				token = await this.replace(loc, origin, kind, token);
			}
		}
	}

	/** Mints a fresh token, one at a time per kind and at most once a minute, replacing (and revoking) the previous one. */
	mint(loc: T3Location, origin: string, kind: CredentialKind): Promise<StoredCredential> {
		try {
			this.#gate(kind);
		} catch (error) {
			return Promise.reject(error);
		}
		const running = this.#minting.get(kind);
		if (running) return running;
		const last = this.#lastMint.get(kind);
		const now = this.#now();
		if (last && now - last.at < this.#cooldownMs) {
			const wait = Math.ceil((this.#cooldownMs - (now - last.at)) / 1000);
			// Keep the real reason visible instead of a generic "waiting" message.
			if (last.error) return Promise.reject(last.error);
			return Promise.reject(new T3Error("sign-in-failed", `T3 Code rejected the token minted ${Math.round((now - last.at) / 1000)} s ago; trying again in ${wait} s`));
		}
		const promise = this.#mintNow(loc, origin, kind)
			.then(
				(credential) => {
					this.#lastMint.set(kind, { at: this.#now() });
					this.#renewFailedAt.delete(kind);
					return credential;
				},
				(error: unknown) => {
					const failure = error instanceof Error ? error : new Error(String(error));
					if (!(failure instanceof ActionsDisabledError) && !(failure instanceof SignedOutError)) this.#lastMint.set(kind, { at: this.#now(), error: failure });
					throw failure;
				},
			)
			.finally(() => this.#minting.delete(kind));
		this.#minting.set(kind, promise);
		return promise;
	}

	async #mintNow(loc: T3Location, origin: string, kind: CredentialKind): Promise<StoredCredential> {
		checkHome(loc);
		await this.#checkCli(loc.cli);
		const spec = KINDS[kind];
		const previous = await this.load(kind);
		let stdout: string;
		try {
			stdout = await this.#run(
				loc.cli,
				[
					"auth",
					"session",
					"issue",
					...(spec.subject ? ["--subject", spec.subject] : []),
					...spec.scopes.flatMap((scope) => ["--scope", scope]),
					"--ttl",
					spec.ttl,
					"--label",
					spec.label,
					"--json",
				],
				this.#env(loc),
			);
		} catch (error) {
			throw new T3Error("sign-in-failed", `couldn't sign in to T3 Code: ${(error as Error).message}`);
		}
		let issued: { sessionId?: unknown; token?: unknown; expiresAt?: unknown };
		try {
			issued = JSON.parse(stdout.slice(stdout.indexOf("{"))) as typeof issued;
		} catch {
			throw new T3Error("sign-in-failed", "t3 auth session issue printed something that isn't JSON");
		}
		if (typeof issued.token !== "string" || !issued.token || typeof issued.sessionId !== "string" || typeof issued.expiresAt !== "string") {
			throw new T3Error("sign-in-failed", "t3 auth session issue returned no token");
		}
		const credential: StoredCredential = {
			origin,
			sessionId: issued.sessionId,
			token: issued.token,
			expiresAt: issued.expiresAt,
			issuedAt: new Date(this.#now()).toISOString(),
		};
		const replaced = previous && previous.sessionId !== credential.sessionId ? previous : null;
		// Record the old token before it disappears from its file, so it is revoked even if we crash now.
		if (replaced) await this.#addPending([{ sessionId: replaced.sessionId, kind, expiresAt: replaced.expiresAt }]);
		await this.#save(kind, credential);
		this.emit("log", `minted a new ${kind} token "${spec.label}" (valid until ${credential.expiresAt})`);
		// Actions may have been turned off (or the user signed out) while the CLI ran.
		if (this.signedOut || (kind === "operate" && !this.actionsEnabled)) {
			// Turned off mid-mint: don't keep what we just made.
			await this.discard(loc, kind);
			this.#gate(kind);
		}
		if (replaced) void this.#revoke(loc, replaced.sessionId);
		return credential;
	}

	/** Revokes and deletes one kind's token (e.g. the actions token when actions are turned off). */
	async discard(loc: T3Location, kind: CredentialKind): Promise<boolean> {
		const stored = await this.load(kind);
		if (!stored) {
			await fs.rm(this.file(kind), { force: true });
			return false;
		}
		await this.#addPending([{ sessionId: stored.sessionId, kind, expiresAt: stored.expiresAt }]);
		await fs.rm(this.file(kind), { force: true });
		await this.#revoke(loc, stored.sessionId);
		return true;
	}

	/** Revokes every token this plugin minted and deletes the credential files. Nothing is minted until `signIn()`. */
	async signOut(loc: T3Location): Promise<SignOutResult> {
		this.signedOut = true;
		const stored = (await Promise.all(CREDENTIAL_KINDS.map(async (kind) => ({ kind, cred: await this.load(kind) })))).filter(
			(s): s is { kind: CredentialKind; cred: StoredCredential } => s.cred !== null,
		);
		// Track them first: once the files are gone, this list is the only record.
		await this.#addPending(stored.map(({ kind, cred }) => ({ sessionId: cred.sessionId, kind, expiresAt: cred.expiresAt })));
		await Promise.all(CREDENTIAL_KINDS.map((kind) => fs.rm(this.file(kind), { force: true })));
		const { revoked, failed, detail } = await this.retryRevokes(loc);
		return { ok: failed === 0, revoked, failed, ...(detail ? { detail } : {}) };
	}

	signIn(): void {
		this.signedOut = false;
		this.#lastMint.clear();
	}

	async pending(): Promise<PendingRevoke[]> {
		try {
			const parsed = JSON.parse(await fs.readFile(this.pendingFile, "utf8")) as { sessions?: unknown };
			if (!Array.isArray(parsed.sessions)) return [];
			return parsed.sessions.filter(
				(e): e is PendingRevoke =>
					!!e && typeof e === "object" && typeof (e as PendingRevoke).sessionId === "string" && CREDENTIAL_KINDS.includes((e as PendingRevoke).kind),
			);
		} catch {
			return [];
		}
	}

	/**
	 * Retries revokes that failed earlier. Expired tokens are simply dropped;
	 * a session that is somehow still in a credential file is left alone.
	 */
	async retryRevokes(loc: T3Location): Promise<{ revoked: number; failed: number; detail?: string }> {
		const now = this.#now();
		const current = new Set((await Promise.all(CREDENTIAL_KINDS.map((kind) => this.load(kind)))).map((c) => c?.sessionId));
		const list = await this.pending();
		const expired = list.filter((e) => e.expiresAt !== undefined && isExpired({ expiresAt: e.expiresAt }, now)).map((e) => e.sessionId);
		if (expired.length > 0) await this.#removePending(expired);
		let revoked = 0;
		let failed = 0;
		let detail: string | undefined;
		for (const entry of list) {
			if (expired.includes(entry.sessionId) || current.has(entry.sessionId)) continue;
			const result = await this.#revoke(loc, entry.sessionId);
			if (result === true) revoked++;
			else {
				failed++;
				detail ??= result;
			}
		}
		return { revoked, failed, ...(detail ? { detail } : {}) };
	}

	/** Revokes one session; true on success, else the error message (and it stays pending). */
	async #revoke(loc: T3Location, sessionId: string): Promise<true | string> {
		if (!SESSION_ID.test(sessionId)) {
			await this.#removePending([sessionId]); // not something the CLI ever issued
			return true;
		}
		try {
			checkHome(loc);
			await this.#checkCli(loc.cli);
			// Exits 0 both when it revoked the session and when there was no such session.
			await this.#run(loc.cli, ["auth", "session", "revoke", sessionId], this.#env(loc));
			await this.#removePending([sessionId]);
			return true;
		} catch (error) {
			this.emit("log", `revoking an old token failed, will retry later: ${(error as Error).message}`);
			return (error as Error).message;
		}
	}

	#gate(kind: CredentialKind): void {
		if (kind === "operate" && !this.actionsEnabled) throw new ActionsDisabledError();
		if (this.signedOut) throw new SignedOutError();
	}

	#env(loc: T3Location): NodeJS.ProcessEnv {
		return { ...process.env, T3CODE_HOME: loc.home };
	}

	async #save(kind: CredentialKind, credential: StoredCredential): Promise<void> {
		await writePrivate(this.file(kind), JSON.stringify(credential), this.dir);
	}

	#addPending(entries: Omit<PendingRevoke, "addedAt">[]): Promise<void> {
		if (entries.length === 0) return Promise.resolve();
		return this.#updatePending((list) => {
			const known = new Set(list.map((e) => e.sessionId));
			const addedAt = new Date(this.#now()).toISOString();
			return [...list, ...entries.filter((e) => !known.has(e.sessionId)).map((e) => ({ ...e, addedAt }))];
		});
	}

	#removePending(sessionIds: string[]): Promise<void> {
		const drop = new Set(sessionIds);
		return this.#updatePending((list) => list.filter((e) => !drop.has(e.sessionId)));
	}

	/** Read-modify-write of pending-revoke.json, one at a time. */
	#updatePending(change: (list: PendingRevoke[]) => PendingRevoke[]): Promise<void> {
		const next = this.#pendingLock.then(async () => {
			const before = await this.pending();
			const after = change(before);
			if (after.length === before.length && after.every((e, i) => e.sessionId === before[i]?.sessionId)) return;
			if (after.length === 0) await fs.rm(this.pendingFile, { force: true });
			else await writePrivate(this.pendingFile, JSON.stringify({ version: 1, sessions: after }), this.dir);
		});
		this.#pendingLock = next.catch(() => undefined);
		return next;
	}
}

/** Atomic write of a 0600 file in a 0700 folder. */
async function writePrivate(file: string, content: string, dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		await fs.writeFile(tmp, content, { mode: 0o600 });
		await fs.rename(tmp, file);
	} catch (error) {
		await fs.rm(tmp, { force: true });
		throw error;
	}
}

/** Shared by the whole plugin. */
export const defaultTokens = new TokenStore();
