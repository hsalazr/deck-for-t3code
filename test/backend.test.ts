// Backend hardening: origin checks, tokens, sign-out, shell stream, monitor scheduling and seeding, context fetches.
// Every test uses temp folders and fakes; nothing touches the real credential folder or a live T3 server.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { ThreadSummary } from "../src/model.ts";
import {
	ActionsDisabledError,
	checkCli,
	locate,
	loopbackOrigin,
	needsRenewal,
	readServerOrigin,
	SignedOutError,
	T3Error,
	TokenStore,
	type CredentialKind,
	type StoredCredential,
	type T3Location,
} from "../src/t3/auth.ts";
import { ThreadCommands } from "../src/t3/commands.ts";
import { ContextWatcher, LINGER_MS, isDue, pickNext, retryDelay, type FetchRecord, type WatchTarget } from "../src/t3/context-watcher.ts";
import { collapseRepeats, redact, redactLogger, redactValue, REDACTED } from "../src/t3/log.ts";
import { AuthRejectedError, McpClient, UnreachableError } from "../src/t3/mcp.ts";
import {
	completedAtOf,
	connectionFor,
	Monitor,
	pruneSeen,
	reparent,
	SEEN_TTL_MS,
	shouldSeed,
	threadListOf,
	type ContextSource,
	type ShellSource,
} from "../src/t3/monitor.ts";
import { RpcAccess } from "../src/t3/rpc.ts";
import { ShellState, ShellStream, type PendingTask } from "../src/t3/shell-stream.ts";
import { checkedKey, nextRefreshDelay, REFRESH_MAX_MS, REFRESH_MS } from "../src/t3/usage-monitor.ts";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "t3deck-test-"));
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const reasonOf = (error: unknown) => (error instanceof T3Error ? error.reason : undefined);

async function rejectsWith(promise: Promise<unknown>, check: (error: unknown) => boolean, message?: string): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		assert.ok(check(error), message ?? `unexpected error: ${String(error)}`);
		return error;
	}
	assert.fail("expected a rejection");
}

// ---------------------------------------------------------------- origin (item 1)

test("loopbackOrigin accepts only http(s) on 127.0.0.1, localhost or ::1", () => {
	assert.equal(loopbackOrigin("http://127.0.0.1:3773"), "http://127.0.0.1:3773");
	assert.equal(loopbackOrigin("http://127.0.0.1:3773/some/path/"), "http://127.0.0.1:3773");
	assert.equal(loopbackOrigin("http://LOCALHOST:9"), "http://localhost:9");
	assert.equal(loopbackOrigin("https://[::1]:8443"), "https://[::1]:8443");
	for (const bad of [
		"http://192.168.1.5:3773",
		"http://127.0.0.1.evil.example:3773",
		"http://localhost.evil.example",
		"http://evil.example/?h=127.0.0.1",
		"ftp://127.0.0.1",
		"ws://127.0.0.1:3773",
		"file:///etc/passwd",
		"not a url",
		"",
		42,
		null,
	]) {
		assert.throws(() => loopbackOrigin(bad), (e: unknown) => reasonOf(e) === "server-error", `should reject ${String(bad)}`);
	}
});

test("loopbackOrigin rejects user info without echoing it", () => {
	assert.throws(
		() => loopbackOrigin("http://me:hunter2@127.0.0.1:3773"),
		(e: unknown) => reasonOf(e) === "server-error" && !(e as Error).message.includes("hunter2"),
	);
	assert.throws(() => loopbackOrigin("http://me@localhost"), (e: unknown) => reasonOf(e) === "server-error");
});

async function t3Home(runtime?: unknown): Promise<T3Location> {
	const home = await tmp();
	if (runtime !== undefined) {
		await fs.mkdir(path.join(home, "userdata"), { recursive: true });
		await fs.writeFile(path.join(home, "userdata", "server-runtime.json"), typeof runtime === "string" ? runtime : JSON.stringify(runtime));
	}
	return { home, cli: path.join(home, "bin", "t3"), custom: true };
}

test("readServerOrigin validates the runtime file's origin", async () => {
	assert.equal(await readServerOrigin(await t3Home({ origin: "http://127.0.0.1:3773/", pid: process.pid })), "http://127.0.0.1:3773");
	assert.equal(await readServerOrigin(await t3Home({ port: 4000 })), "http://127.0.0.1:4000");
	await rejectsWith(readServerOrigin(await t3Home({ origin: "http://10.0.0.2:3773" })), (e) => reasonOf(e) === "server-error");
	await rejectsWith(readServerOrigin(await t3Home({ origin: "http://user:pw@127.0.0.1:3773" })), (e) => reasonOf(e) === "server-error");
	await rejectsWith(readServerOrigin(await t3Home("{not json")), (e) => reasonOf(e) === "server-error");
	await rejectsWith(readServerOrigin(await t3Home({ pid: process.pid })), (e) => reasonOf(e) === "server-error");
});

test("readServerOrigin: a pid that belongs to another user is not-running", { skip: process.getuid?.() === 0 ? "root can signal anything" : false }, async () => {
	// pid 1 (launchd/init) exists but isn't ours: kill(1, 0) fails with EPERM.
	await rejectsWith(readServerOrigin(await t3Home({ origin: "http://127.0.0.1:3773", pid: 1 })), (e) => reasonOf(e) === "not-running" && /another user/.test((e as Error).message));
});

test("token-carrying requests refuse redirects", async () => {
	const http = await import("node:http");
	let landed = 0;
	const server = http.createServer((req, res) => {
		if (req.url === "/landing") {
			landed++;
			res.end("{}");
		} else {
			res.writeHead(307, { location: "/landing" }).end();
		}
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	try {
		const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
		await assert.rejects(new McpClient(origin, "secret").callTool("x", {}), UnreachableError);
		const loc = await t3Home({ origin, pid: process.pid });
		const tokens = { withToken: async (_l: unknown, _o: unknown, _k: unknown, fn: (t: string) => Promise<string>) => fn("secret") } as unknown as TokenStore;
		await assert.rejects(new RpcAccess(() => loc, "rpc", { tokens }).open(), (e) => reasonOf(e) === "not-running");
		assert.equal(landed, 0, "the redirect was never followed");
	} finally {
		server.close();
	}
});

test("readServerOrigin: dead pid is not-running", async () => {
	await rejectsWith(readServerOrigin(await t3Home({ origin: "http://127.0.0.1:3773", pid: 2 ** 22 + 12345 })), (e) => reasonOf(e) === "not-running");
});

test("readServerOrigin: missing runtime file maps to not-installed or not-running", async () => {
	const installed = async () => true;
	const absent = async () => false;
	const loc = await t3Home();
	await rejectsWith(readServerOrigin(loc, { appInstalled: installed }), (e) => reasonOf(e) === "not-running");
	// Default home, no app: not installed.
	await rejectsWith(readServerOrigin({ ...loc, custom: false }, { appInstalled: absent }), (e) => reasonOf(e) === "not-installed");
	// Default home missing but the app is there: it has never run.
	const missing = { home: path.join(loc.home, "nope"), cli: "", custom: false };
	await rejectsWith(readServerOrigin(missing, { appInstalled: installed }), (e) => reasonOf(e) === "not-running");
	await rejectsWith(readServerOrigin(missing, { appInstalled: absent }), (e) => reasonOf(e) === "not-installed");
	// A custom home that doesn't exist says so.
	await rejectsWith(
		readServerOrigin({ ...missing, custom: true }, { appInstalled: installed }),
		(e) => reasonOf(e) === "not-installed" && /does not exist/.test((e as Error).message),
	);
});

// ---------------------------------------------------------------- T3 home and CLI (item 4)

test("T3 home: ~ expands, relative paths are rejected as not-installed, no t3Cli override", async () => {
	const home = locate({ t3Home: "~/somewhere" }, {});
	assert.equal(home.home, path.join(os.homedir(), "somewhere"));
	assert.equal(home.cli, path.join(os.homedir(), "somewhere", "bin", "t3"));
	assert.equal(locate({}, { T3CODE_HOME: "/opt/t3" }).home, "/opt/t3");
	assert.equal(locate({}, {}).home, path.join(os.homedir(), ".t3"));
	assert.equal(locate({}, {}).custom, false);
	// The old hidden t3Cli setting is ignored.
	assert.equal(locate({ t3Cli: "/tmp/evil" } as { t3Home?: string }, {}).cli, path.join(os.homedir(), ".t3", "bin", "t3"));
	for (const relative of ["t3", "./t3", "~other/.t3"]) {
		await rejectsWith(readServerOrigin(locate({ t3Home: relative }, {})), (e) => reasonOf(e) === "not-installed" && /absolute/.test((e as Error).message));
	}
});

test("checkCli: only a regular, executable file owned by you that others can't write", async () => {
	const dir = await tmp();
	const cli = path.join(dir, "t3");
	await fs.writeFile(cli, "#!/bin/sh\n");
	await fs.chmod(cli, 0o755);
	await checkCli(cli);
	const uid = process.getuid!();
	await rejectsWith(checkCli(cli, uid + 4242), (e) => reasonOf(e) === "cli-missing" && /another user/.test((e as Error).message));
	await fs.chmod(cli, 0o775);
	await rejectsWith(checkCli(cli), (e) => reasonOf(e) === "cli-missing" && /other users/.test((e as Error).message));
	await fs.chmod(cli, 0o757);
	await rejectsWith(checkCli(cli), (e) => reasonOf(e) === "cli-missing");
	await fs.chmod(cli, 0o644);
	await rejectsWith(checkCli(cli), (e) => reasonOf(e) === "cli-missing" && /not executable/.test((e as Error).message));
	await rejectsWith(checkCli(dir), (e) => reasonOf(e) === "cli-missing" && /regular file/.test((e as Error).message));
	await rejectsWith(checkCli(path.join(dir, "missing")), (e) => reasonOf(e) === "cli-missing");
	await rejectsWith(checkCli("relative/t3"), (e) => reasonOf(e) === "cli-missing");
});

// ---------------------------------------------------------------- tokens (items 2, 3, 12, 18)

const DAY = 24 * 3600_000;
const cred = (issued: number, lifetimeMs: number, extra: Partial<StoredCredential> = {}): StoredCredential => ({
	origin: "http://127.0.0.1:1",
	sessionId: "s1",
	token: "tok",
	expiresAt: new Date(issued + lifetimeMs).toISOString(),
	issuedAt: new Date(issued).toISOString(),
	...extra,
});

test("needsRenewal: renew once less than half the lifetime remains", () => {
	const t0 = Date.parse("2026-11-01T00:00:00Z");
	assert.equal(needsRenewal(cred(t0, 30 * DAY), "mcp", t0 + DAY), false);
	assert.equal(needsRenewal(cred(t0, 30 * DAY), "mcp", t0 + 14 * DAY), false);
	assert.equal(needsRenewal(cred(t0, 30 * DAY), "rpc", t0 + 16 * DAY), true);
	assert.equal(needsRenewal(cred(t0, DAY), "operate", t0 + 11 * 3600_000), false);
	assert.equal(needsRenewal(cred(t0, DAY), "operate", t0 + 13 * 3600_000), true);
	assert.equal(needsRenewal(cred(t0, 30 * DAY), "mcp", t0 + 31 * DAY), true, "expired");
	// Tokens from older versions: no issuedAt, or minted for a year.
	assert.equal(needsRenewal({ ...cred(t0, 365 * DAY), issuedAt: undefined }, "mcp", t0 + DAY), true);
	assert.equal(needsRenewal(cred(t0, 365 * DAY), "mcp", t0 + DAY), true);
});

interface FakeCli {
	calls: string[][];
	failRevoke: Set<string>;
	failIssue?: string;
	issued: number;
	run: (cli: string, args: string[]) => Promise<string>;
}

function fakeCli(): FakeCli {
	const cli: FakeCli = {
		calls: [],
		failRevoke: new Set(),
		issued: 0,
		run: async (_cli, args) => {
			cli.calls.push(args);
			if (args[2] === "issue") {
				if (cli.failIssue) throw new Error(cli.failIssue);
				cli.issued++;
				const ttl = args[args.indexOf("--ttl") + 1];
				const ms = ttl === "24h" ? DAY : 30 * DAY;
				return `noise\n${JSON.stringify({ sessionId: `sess-${cli.issued}`, token: `token-${cli.issued}`, expiresAt: new Date(Date.now() + ms).toISOString() })}`;
			}
			if (args[2] === "revoke") {
				if (cli.failRevoke.has(args[3])) throw new Error(`revoke ${args[3]} failed`);
				return `Revoked session ${args[3]}.\n`;
			}
			throw new Error(`unexpected ${args.join(" ")}`);
		},
	};
	return cli;
}

async function store(cli = fakeCli(), opts: { cooldownMs?: number } = {}) {
	const dir = path.join(await tmp(), "creds");
	const loc: T3Location = { home: await tmp(), cli: "/fake/t3", custom: true };
	const tokens = new TokenStore({ dir, run: cli.run, checkCli: async () => undefined, cooldownMs: opts.cooldownMs ?? 0 });
	return { tokens, cli, dir, loc };
}

const issueArgs = (cli: FakeCli) => cli.calls.filter((c) => c[2] === "issue");
const revokeArgs = (cli: FakeCli) => cli.calls.filter((c) => c[2] === "revoke").map((c) => c[3]);

test("mint: 30-day read tokens, 0600 file in a 0700 folder, issuedAt recorded", async () => {
	const { tokens, cli, dir, loc } = await store();
	const minted = await tokens.mint(loc, "http://127.0.0.1:3773", "mcp");
	assert.equal(minted.token, "token-1");
	assert.ok(minted.issuedAt);
	const args = issueArgs(cli)[0];
	assert.deepEqual(args.slice(0, 3), ["auth", "session", "issue"]);
	assert.equal(args[args.indexOf("--ttl") + 1], "30d");
	assert.equal(args[args.indexOf("--subject") + 1], "mcp-client");
	assert.equal(args[args.indexOf("--scope") + 1], "orchestration:read");
	assert.equal((await fs.stat(tokens.file("mcp"))).mode & 0o777, 0o600);
	assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
	const rpc = await tokens.mint(loc, "http://127.0.0.1:3773", "rpc");
	const rpcArgs = issueArgs(cli)[1];
	assert.equal(rpcArgs.includes("--subject"), false);
	assert.equal(rpcArgs[rpcArgs.indexOf("--ttl") + 1], "30d");
	assert.equal(rpc.token, "token-2");
});

test("mint: the replaced token is revoked; a failed revoke is kept in pending-revoke.json and retried", async () => {
	const { tokens, cli, loc } = await store();
	await tokens.mint(loc, "http://127.0.0.1:1", "rpc");
	await tokens.mint(loc, "http://127.0.0.1:1", "rpc");
	await settle();
	assert.deepEqual(revokeArgs(cli), ["sess-1"]);
	assert.deepEqual(await tokens.pending(), []);

	cli.failRevoke.add("sess-2");
	await tokens.mint(loc, "http://127.0.0.1:1", "rpc");
	await settle();
	const pending = await tokens.pending();
	assert.deepEqual(pending.map((p) => [p.sessionId, p.kind]), [["sess-2", "rpc"]]);
	assert.equal((await fs.stat(tokens.pendingFile)).mode & 0o777, 0o600);

	cli.failRevoke.clear();
	const result = await tokens.retryRevokes(loc);
	assert.equal(result.revoked, 1);
	assert.deepEqual(await tokens.pending(), []);
	await assert.rejects(fs.stat(tokens.pendingFile), "pending file removed once empty");
});

test("retryRevokes drops expired entries and never revokes a token still in use", async () => {
	const { tokens, cli, loc } = await store();
	const current = await tokens.mint(loc, "http://127.0.0.1:1", "mcp");
	await fs.writeFile(
		tokens.pendingFile,
		JSON.stringify({
			version: 1,
			sessions: [
				{ sessionId: "old-expired", kind: "mcp", expiresAt: "2020-01-01T00:00:00Z", addedAt: "2020-01-01T00:00:00Z" },
				{ sessionId: current.sessionId, kind: "mcp", addedAt: "2026-01-01T00:00:00Z" },
				{ sessionId: "--flag-looking", kind: "rpc", addedAt: "2026-01-01T00:00:00Z" },
			],
		}),
	);
	await tokens.retryRevokes(loc);
	assert.deepEqual(revokeArgs(cli), [], "nothing revoked: one expired, one current, one not a session id");
	assert.deepEqual((await tokens.pending()).map((p) => p.sessionId), [current.sessionId]);
});

test("token(): any loopback origin may use the stored token; renewal falls back to the current token", async () => {
	const { tokens, cli, loc } = await store();
	await tokens.mint(loc, "http://127.0.0.1:1111", "mcp");
	assert.equal(await tokens.token(loc, "http://localhost:2222", "mcp"), "token-1");
	assert.equal(issueArgs(cli).length, 1, "no re-mint for a different origin");

	// A year-long token from an older version is renewed...
	await fs.writeFile(tokens.file("rpc"), JSON.stringify({ origin: "x", sessionId: "legacy", token: "legacy-token", expiresAt: new Date(Date.now() + 300 * DAY).toISOString() }));
	assert.equal(await tokens.token(loc, "http://127.0.0.1:1", "rpc"), "token-2");
	await settle();
	assert.ok(revokeArgs(cli).includes("legacy"));

	// ...but if renewal fails, the still-valid token keeps working.
	await fs.writeFile(tokens.file("rpc"), JSON.stringify({ origin: "x", sessionId: "legacy2", token: "legacy-token-2", expiresAt: new Date(Date.now() + 300 * DAY).toISOString() }));
	cli.failIssue = "server busy";
	assert.equal(await tokens.token(loc, "http://127.0.0.1:1", "rpc"), "legacy-token-2");
});

test("replace(): reloads the file before minting", async () => {
	const { tokens, cli, loc } = await store();
	await tokens.mint(loc, "http://127.0.0.1:1", "rpc");
	// Someone else already replaced the rejected token: use theirs.
	assert.equal(await tokens.replace(loc, "http://127.0.0.1:1", "rpc", "some-older-token"), "token-1");
	assert.equal(issueArgs(cli).length, 1);
	// The file still holds the rejected token: mint.
	assert.equal(await tokens.replace(loc, "http://127.0.0.1:1", "rpc", "token-1"), "token-2");
});

test("withToken(): retries once with a new token; a rejected fresh token is sign-in-failed", async () => {
	const { tokens, loc } = await store(fakeCli(), { cooldownMs: 60_000 });
	// A token from an earlier run that T3 no longer accepts.
	await fs.mkdir(tokens.dir, { recursive: true });
	await fs.writeFile(tokens.file("mcp"), JSON.stringify(cred(Date.now() - DAY, 30 * DAY, { sessionId: "old", token: "old-token" })));
	const seen: string[] = [];
	const ok = await tokens.withToken(loc, "http://127.0.0.1:1", "mcp", async (token) => {
		seen.push(token);
		if (seen.length === 1) throw new AuthRejectedError("401");
		return "done";
	}, (e) => e instanceof AuthRejectedError);
	assert.equal(ok, "done");
	assert.deepEqual(seen, ["old-token", "token-1"]);

	const error = await rejectsWith(
		tokens.withToken(loc, "http://127.0.0.1:1", "mcp", async () => {
			throw new AuthRejectedError("401");
		}, (e) => e instanceof AuthRejectedError),
		(e) => reasonOf(e) === "sign-in-failed",
	);
	assert.doesNotMatch((error as Error).message, /waiting to retry/);
});

test("mint cooldown keeps the real error instead of a generic message", async () => {
	const cli = fakeCli();
	cli.failIssue = "database is locked";
	const { tokens, loc } = await store(cli, { cooldownMs: 60_000 });
	const first = await rejectsWith(tokens.mint(loc, "http://127.0.0.1:1", "mcp"), (e) => reasonOf(e) === "sign-in-failed" && /database is locked/.test((e as Error).message));
	const second = await rejectsWith(tokens.mint(loc, "http://127.0.0.1:1", "mcp"), (e) => reasonOf(e) === "sign-in-failed");
	assert.equal(second, first, "same error during the cooldown");
	assert.equal(issueArgs(cli).length, 1, "only one CLI call during the cooldown");
});

test("an unsafe or missing CLI is cli-missing and is never run", async () => {
	const cli = fakeCli();
	const dir = await tmp();
	const tokens = new TokenStore({ dir: path.join(dir, "creds"), run: cli.run, cooldownMs: 0 });
	const loc: T3Location = { home: dir, cli: path.join(dir, "bin", "t3"), custom: true };
	await rejectsWith(tokens.mint(loc, "http://127.0.0.1:1", "mcp"), (e) => reasonOf(e) === "cli-missing");
	await fs.mkdir(path.join(dir, "bin"));
	await fs.writeFile(loc.cli, "#!/bin/sh\n", { mode: 0o777 });
	await fs.chmod(loc.cli, 0o777);
	await rejectsWith(tokens.mint(loc, "http://127.0.0.1:1", "mcp"), (e) => reasonOf(e) === "cli-missing");
	assert.equal(cli.calls.length, 0);
});

test("the actions token can't be minted or used unless actionsEnabled; 24 h when it is", async () => {
	const { tokens, cli, loc } = await store();
	await rejectsWith(tokens.mint(loc, "http://127.0.0.1:1", "operate"), (e) => e instanceof ActionsDisabledError);
	await rejectsWith(tokens.token(loc, "http://127.0.0.1:1", "operate"), (e) => e instanceof ActionsDisabledError);
	const access = new RpcAccess(() => loc, "operate", { tokens });
	await rejectsWith(access.open(), (e) => e instanceof ActionsDisabledError);
	assert.equal(cli.calls.length, 0);

	tokens.actionsEnabled = true;
	await tokens.mint(loc, "http://127.0.0.1:1", "operate");
	const args = issueArgs(cli)[0];
	assert.equal(args[args.indexOf("--ttl") + 1], "24h");
	assert.deepEqual(args.filter((_, i) => args[i - 1] === "--scope"), ["orchestration:read", "orchestration:operate"]);
	assert.equal(await tokens.has("operate"), true);

	// Turning actions off revokes and deletes it.
	tokens.actionsEnabled = false;
	assert.equal(await tokens.discard(loc, "operate"), true);
	assert.equal(await tokens.has("operate"), false);
	assert.deepEqual(revokeArgs(cli), ["sess-1"]);
});

/** A WebSocket stand-in: records what is sent, lets the test deliver frames. */
class FakeSocket {
	sent: unknown[] = [];
	closed = false;
	onopen: (() => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;
	onclose: ((ev: { code: number }) => void) | null = null;
	onerror: (() => void) | null = null;
	autoReply?: (msg: Record<string, unknown>) => unknown;

	send(data: string): void {
		const msg = JSON.parse(data) as Record<string, unknown>;
		this.sent.push(msg);
		const reply = this.autoReply?.(msg);
		if (reply) setImmediate(() => this.deliver(reply));
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		setImmediate(() => this.onclose?.({ code: 1000 }));
	}

	deliver(frame: unknown): void {
		this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
	}
}

class FakeAccess {
	opened: FakeSocket[] = [];
	fail?: Error;
	readonly tokens: TokenStore;
	reply?: (msg: Record<string, unknown>) => unknown;

	constructor(tokens = new TokenStore({ dir: path.join(os.tmpdir(), "t3deck-unused") })) {
		this.tokens = tokens;
	}

	async open(): Promise<FakeSocket> {
		if (this.fail) throw this.fail;
		const ws = new FakeSocket();
		ws.autoReply = this.reply;
		this.opened.push(ws);
		setImmediate(() => ws.onopen?.());
		return ws;
	}
}

test("ThreadCommands refuse with ActionsDisabledError while actions are off; send uses creationSource web", async () => {
	const access = new FakeAccess();
	access.reply = (msg) => (msg._tag === "Request" ? { _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: null } } : undefined);
	let enabled = false;
	const commands = new ThreadCommands(access as unknown as RpcAccess, () => enabled);
	await rejectsWith(commands.send("t1", "hi"), (e) => e instanceof ActionsDisabledError);
	await rejectsWith(commands.stop("t1", "r1"), (e) => e instanceof ActionsDisabledError);
	await rejectsWith(commands.snooze("t1", new Date()), (e) => e instanceof ActionsDisabledError);
	await rejectsWith(commands.settle("t1"), (e) => e instanceof ActionsDisabledError);
	assert.equal(access.opened.length, 0, "no socket, no token");

	enabled = true;
	await commands.send("t1", "hello");
	const request = access.opened[0].sent[0] as { tag: string; payload: Record<string, unknown> };
	assert.equal(request.tag, "orchestration.dispatchCommand");
	assert.equal(request.payload.type, "message.dispatch");
	assert.equal(request.payload.creationSource, "web");
	assert.equal(request.payload.createdBy, "user");
});

test("signOut revokes all three tokens, deletes the files, records failures, and blocks minting until signIn", async () => {
	const { tokens, cli, loc } = await store();
	tokens.actionsEnabled = true;
	for (const kind of ["mcp", "rpc", "operate"] as CredentialKind[]) await tokens.mint(loc, "http://127.0.0.1:1", kind);
	cli.failRevoke.add("sess-2");
	const result = await tokens.signOut(loc);
	assert.equal(result.ok, false);
	assert.equal(result.revoked, 2);
	assert.equal(result.failed, 1);
	assert.deepEqual(revokeArgs(cli).sort(), ["sess-1", "sess-2", "sess-3"]);
	for (const kind of ["mcp", "rpc", "operate"] as CredentialKind[]) await assert.rejects(fs.stat(tokens.file(kind)));
	assert.deepEqual((await tokens.pending()).map((p) => p.sessionId), ["sess-2"]);

	await rejectsWith(tokens.token(loc, "http://127.0.0.1:1", "mcp"), (e) => e instanceof SignedOutError && reasonOf(e) === "signed-out");
	assert.equal(issueArgs(cli).length, 3);
	tokens.signIn();
	assert.equal(await tokens.token(loc, "http://127.0.0.1:1", "mcp"), "token-4");
});

test("signing out while a mint is running doesn't keep the new token", async () => {
	const cli = fakeCli();
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const run = cli.run;
	cli.run = async (c, args) => {
		if (args[2] === "issue") await gate;
		return run(c, args);
	};
	const { tokens, loc } = await store(cli);
	const minting = tokens.mint(loc, "http://127.0.0.1:1", "mcp");
	await settle();
	const signingOut = tokens.signOut(loc);
	release();
	await rejectsWith(minting, (e) => e instanceof SignedOutError);
	await signingOut;
	await settle();
	assert.equal(await tokens.has("mcp"), false);
	assert.ok(revokeArgs(cli).includes("sess-1"));
});

// ---------------------------------------------------------------- reasons (item 18)

test("connectionFor maps failures to reasons", () => {
	assert.deepEqual(connectionFor(new T3Error("not-installed", "x")), { kind: "offline", detail: "x", reason: "not-installed" });
	assert.deepEqual(connectionFor(new T3Error("not-running", "x")), { kind: "offline", detail: "x", reason: "not-running" });
	assert.deepEqual(connectionFor(new T3Error("cli-missing", "x")), { kind: "error", detail: "x", reason: "cli-missing" });
	assert.deepEqual(connectionFor(new T3Error("sign-in-failed", "x")), { kind: "error", detail: "x", reason: "sign-in-failed" });
	assert.deepEqual(connectionFor(new UnreachableError("down")), { kind: "offline", detail: "down", reason: "not-running" });
	assert.deepEqual(connectionFor(new AuthRejectedError("401")), { kind: "error", detail: "401", reason: "sign-in-failed" });
	assert.deepEqual(connectionFor(new Error("odd")), { kind: "error", detail: "odd", reason: "server-error" });
	assert.deepEqual(connectionFor(new SignedOutError()), { kind: "offline", detail: new SignedOutError().message, reason: "signed-out" });
});

// ---------------------------------------------------------------- redaction (item 5)

test("redact: token-like runs of 32+ base64url/hex characters never reach the log", () => {
	const token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCd";
	const hex = "0123456789abcdef0123456789abcdef0123456789abcdef";
	assert.equal(redact(`Bearer ${token} ok`), `Bearer ${REDACTED} ok`);
	assert.equal(redact(`ticket=${hex}&x=1`), `ticket=${REDACTED}&x=1`);
	assert.equal(redact("poll failed: T3 Code rejected the credential (401)"), "poll failed: T3 Code rejected the credential (401)");
	assert.equal(redact("short_token_abc123"), "short_token_abc123");
	const error = redactValue(new Error(`boom ${token}`)) as Error;
	assert.ok(!error.message.includes(token) && !String(error.stack).includes(token));
	assert.equal(redactValue({ token }), `{"token":"${REDACTED}"}`);
	assert.equal(redactValue(7), 7);
});

test("redactLogger redacts every entry written through the logger", () => {
	const written: unknown[][] = [];
	const logger = {
		write(entry: { data: unknown[]; level: string }) {
			written.push(entry.data);
			return this;
		},
		info(...data: unknown[]) {
			return this.write({ data, level: "info" });
		},
	};
	redactLogger(logger);
	logger.info("token abcdefghijklmnopqrstuvwxyzABCDEFGH1234 here", new Error("x"));
	assert.equal(written[0][0], `token ${REDACTED} here`);
	assert.ok(written[0][1] instanceof Error);
});

// ---------------------------------------------------------------- shell stream (items 7, 9)

const shellThread = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	latestRunId: "run-1",
	latestRunCompletedAt: "2026-11-03T10:00:00Z",
	lastVisitedAt: "2026-11-03T10:05:00Z",
	activeRunId: null,
	updatedAt: "2026-11-03T10:00:00Z",
	...extra,
});

test("ShellState tolerates malformed items and fields", () => {
	const state = new ShellState();
	for (const junk of [null, 1, "x", [], { kind: "snapshot" }, { kind: "snapshot", snapshot: { threads: "nope" } }, { kind: "thread.updated" }, { kind: "thread.updated", thread: { noId: true } }, { kind: "thread.removed", threadId: 5 }]) {
		state.apply(junk);
	}
	state.apply({
		kind: "snapshot",
		snapshot: {
			threads: [
				null,
				{ id: 7 },
				shellThread("a", {
					lineage: "bad",
					pendingBackgroundTasks: [null, { kind: "command" }, { taskId: 9 }, { taskId: "toolu_1", kind: "command", description: "npm test" }, { taskId: "pull-request-watch:h/r#1" }],
					pullRequests: [null, { host: 5 }, { host: "h", repository: "r", number: 1, watch: "x" }],
					limitRecovery: "bad",
					latestRunCompletedAt: 12,
				}),
				shellThread("child", { lineage: { rootThreadId: "a", parentThreadId: "a" }, pendingBackgroundTasks: [{ taskId: "agent_1", kind: "subagent" }] }),
			],
		},
	});
	assert.equal(state.size, 2);
	assert.deepEqual(state.extras("a"), { lastVisitedAt: Date.parse("2026-11-03T10:05:00Z"), latestRunId: "run-1", latestRunCompletedAt: null, activeRunId: null, limitResetAt: null, pendingInput: false, updatedAt: Date.parse("2026-11-03T10:00:00Z") });
	assert.equal(state.rootOf("child"), "a");
	assert.deepEqual(
		state.pendingByRoot().get("a")?.map((t: PendingTask) => t.taskId),
		["toolu_1", "agent_1"],
	);
	state.apply({ kind: "thread.updated", location: "archive", thread: { id: "child" } });
	assert.equal(state.rootOf("child"), undefined);
	state.apply({ kind: "thread.removed", threadId: "a" });
	assert.equal(state.size, 0);
});

test("ShellStream: state disappears on close; restart reconnects at once; bad frames are logged, not thrown", async () => {
	const access = new FakeAccess();
	const stream = new ShellStream(access as unknown as RpcAccess);
	const logs: string[] = [];
	let changes = 0;
	stream.on("log", (l) => logs.push(l));
	stream.on("change", () => changes++);
	stream.start();
	await settle(5);
	const ws = access.opened[0];
	assert.ok(ws, "opened");
	assert.equal((ws.sent[0] as { tag: string }).tag, "orchestration.subscribeShell");
	ws.deliver("not json");
	ws.deliver({ _tag: "Chunk", requestId: "1", values: "nope" });
	ws.deliver({ _tag: "Chunk", requestId: "1", values: [{ kind: "snapshot", snapshot: { threads: [shellThread("a", { activeRunId: "run-2", pendingBackgroundTasks: [{ taskId: "t", kind: "command" }] })] } }] });
	assert.equal(stream.connected, true);
	assert.equal(stream.extras("a")?.activeRunId, "run-2");
	assert.equal(stream.pendingByRoot().get("a")?.length, 1);
	assert.ok(changes >= 1);

	// The socket drops: nothing stale remains visible.
	ws.onclose?.({ code: 1006 });
	assert.equal(stream.connected, false);
	assert.equal(stream.extras("a"), undefined);
	assert.equal(stream.pendingByRoot().size, 0);

	// A reconnect is pending with backoff; restart() connects now instead.
	stream.restart();
	await settle(5);
	assert.equal(access.opened.length, 2);
	const ws2 = access.opened[1];
	ws2.deliver({ _tag: "Chunk", requestId: "1", values: [{ kind: "thread.updated", location: "active", thread: shellThread("b") }] });
	assert.equal(stream.connected, true);
	assert.equal(stream.extras("a"), undefined, "a fresh connection starts from its own snapshot");
	assert.ok(stream.extras("b"));

	// kick() does nothing while connected.
	stream.kick();
	await settle(5);
	assert.equal(access.opened.length, 2);
	stream.stop();
	await settle(5);
	assert.equal(stream.connected, false);
	assert.ok(ws2.closed);
});

test("ShellStream.kick(): after a failed connect, retries now instead of after the backoff", async () => {
	const access = new FakeAccess();
	access.fail = new T3Error("not-running", "T3 Code is not running");
	const stream = new ShellStream(access as unknown as RpcAccess);
	const logs: string[] = [];
	stream.on("log", (l) => logs.push(l));
	stream.start();
	await settle(5);
	assert.equal(access.opened.length, 0);
	assert.match(logs[0], /not running/);
	access.fail = undefined;
	stream.kick();
	await settle(5);
	assert.equal(access.opened.length, 1);
	stream.stop();
	await settle(5);
});

// ---------------------------------------------------------------- monitor (items 9-15)

const T0 = Date.parse("2026-11-03T12:00:00Z");
const summary = (id: string, extra: Partial<ThreadSummary> = {}): ThreadSummary => ({
	threadId: id,
	projectId: "p",
	title: id,
	link: `http://127.0.0.1:3773/env/${id}`,
	status: "completed",
	latestRunId: `${id}-run`,
	parentThreadId: null,
	relationshipToParent: null,
	settled: false,
	snoozed: false,
	createdAt: new Date(T0 - DAY).toISOString(),
	updatedAt: new Date(T0 - 3600_000).toISOString(),
	...extra,
});

class FakeShell extends EventEmitter implements ShellSource {
	connected = true;
	state = new ShellState();
	kicks = 0;
	extras(id: string) {
		return this.connected ? this.state.extras(id) : undefined;
	}
	pendingByRoot() {
		return this.connected ? this.state.pendingByRoot() : new Map<string, PendingTask[]>();
	}
	rootOf(id: string) {
		return this.connected ? this.state.rootOf(id) : undefined;
	}
	kick() {
		this.kicks++;
	}
	put(thread: Record<string, unknown>) {
		this.state.apply({ kind: "thread.updated", location: "active", thread });
	}
}

class FakeContext extends EventEmitter implements ContextSource {
	targets: ReadonlyMap<string, WatchTarget> = new Map();
	get() {
		return undefined;
	}
	watch(targets: ReadonlyMap<string, WatchTarget>) {
		this.targets = targets;
	}
}

const monitors: Monitor[] = [];
after(() => {
	for (const m of monitors) m.stop();
});

async function monitor(opts: { shell?: FakeShell } = {}) {
	let clock = T0;
	const server = { active: [] as ThreadSummary[], recent: [] as ThreadSummary[], calls: [] as Record<string, unknown>[], fail: undefined as Error | undefined };
	const { tokens } = await store();
	const m = new Monitor({
		tokens,
		now: () => clock,
		call: async (name, args) => {
			if (server.fail) throw server.fail;
			if (name === "t3_project_list") return { projects: [{ id: "p", name: "proj" }], nextCursor: null };
			server.calls.push(args);
			const list = args.statuses ? server.active : server.recent.slice(0, Number(args.limit));
			return { threads: list, nextCursor: null, total: list.length };
		},
	});
	monitors.push(m);
	if (opts.shell) m.attachShell(opts.shell);
	m.configure({});
	m.start();
	return { m, server, setClock: (t: number) => (clock = t), clock: () => clock };
}

const stateOf = (m: Monitor, id: string) => m.snapshot.cards.get(id)?.state;

test("monitor: the first poll seeds acks; later threads that finished after start still light up", async () => {
	const { m, server, setClock } = await monitor();
	server.recent = [summary("old-done"), summary("old-failed", { status: "failed" })];
	server.active = [summary("running", { status: "running" })];
	await m.refresh();
	assert.equal(m.snapshot.connection.kind, "ok");
	assert.equal(stateOf(m, "old-done"), "idle");
	assert.equal(stateOf(m, "old-failed"), "idle");
	assert.equal(stateOf(m, "running"), "working");

	setClock(T0 + 60_000);
	server.active = [];
	server.recent = [
		summary("running"), // finished while we watched
		summary("old-done"),
		summary("old-failed", { status: "failed" }),
		summary("new-after-start", { updatedAt: new Date(T0 + 30_000).toISOString() }),
		summary("new-before-start", { updatedAt: new Date(T0 - 60_000).toISOString() }),
	];
	await m.refresh();
	assert.equal(stateOf(m, "running"), "done");
	assert.equal(stateOf(m, "new-after-start"), "done", "first seen later, finished after the plugin started");
	assert.equal(stateOf(m, "new-before-start"), "idle", "first seen later, but finished before start");
	m.stop();
});

test("shouldSeed / completedAtOf / pruneSeen", () => {
	assert.equal(shouldSeed({ firstPoll: true, active: false, completedAt: T0, startedAt: T0 - 1, now: T0 }), true);
	assert.equal(shouldSeed({ firstPoll: true, active: true, completedAt: null, startedAt: T0, now: T0 }), false);
	assert.equal(shouldSeed({ firstPoll: false, active: false, completedAt: T0 + 5, startedAt: T0, now: T0 + 10 }), false);
	assert.equal(shouldSeed({ firstPoll: false, active: false, completedAt: T0 - 5, startedAt: T0, now: T0 + 10 }), true);
	// Long-running plugin: a thread forgotten after a day and seen again doesn't flash its old result.
	assert.equal(shouldSeed({ firstPoll: false, active: false, completedAt: T0 + 1000, startedAt: T0, now: T0 + 2 * DAY }), true);

	const shell = new ShellState();
	shell.apply({ kind: "thread.updated", thread: { id: "a", latestRunId: "a-run", latestRunCompletedAt: new Date(T0 - 5000).toISOString() } });
	assert.equal(completedAtOf(summary("a"), shell), T0 - 5000);
	assert.equal(completedAtOf(summary("a", { latestRunId: "other" }), shell), T0 - 3600_000, "different run: fall back to updatedAt");

	const seen = new Map([["fresh", T0], ["stale", T0 - 2 * DAY]]);
	const acked = new Map([["fresh", "k"], ["stale", "k"], ["unknown", "k"]]);
	pruneSeen(seen, acked, T0 - SEEN_TTL_MS);
	assert.deepEqual([...seen.keys()], ["fresh"]);
	assert.deepEqual([...acked.keys()], ["fresh"]);
});

test("monitor: threads unseen for a day are forgotten", async () => {
	const { m, server, setClock } = await monitor();
	server.recent = [summary("a"), summary("b")];
	await m.refresh();
	setClock(T0 + DAY + 60_000);
	server.recent = [summary("b")];
	await m.refresh();
	// "a" was forgotten; it comes back with a result that predates the plugin: seeded again, not flashing.
	setClock(T0 + DAY + 120_000);
	server.recent = [summary("a"), summary("b")];
	await m.refresh();
	assert.equal(stateOf(m, "a"), "idle");
	m.stop();
});

test("monitor: Seen in T3 only when the shell is connected and describes the same run", async () => {
	const shell = new FakeShell();
	const { m, server } = await monitor({ shell });
	server.active = [summary("t", { status: "running" })];
	await m.refresh();
	server.active = [];
	server.recent = [summary("t", { latestRunId: "t-run" })];
	// The shell still describes an older run that the user opened afterwards.
	shell.put({ id: "t", latestRunId: "older-run", latestRunCompletedAt: new Date(T0 - 10_000).toISOString(), lastVisitedAt: new Date(T0).toISOString() });
	await m.refresh();
	assert.equal(stateOf(m, "t"), "done", "a visit after an older run doesn't clear this one");

	// Shell down: its visit data is ignored even when it matches.
	shell.put({ id: "t", latestRunId: "t-run", latestRunCompletedAt: new Date(T0 - 10_000).toISOString(), lastVisitedAt: new Date(T0).toISOString() });
	shell.connected = false;
	await m.refresh();
	assert.equal(stateOf(m, "t"), "done");

	shell.connected = true;
	await m.refresh();
	assert.equal(stateOf(m, "t"), "idle", "opened in T3 after this run finished");
	m.stop();
});

test("monitor: shell-derived state is ignored while the shell is disconnected", async () => {
	const shell = new FakeShell();
	const { m, server } = await monitor({ shell });
	server.recent = [summary("t", { status: "completed" })];
	shell.put({ id: "t", latestRunId: "t-run", activeRunId: "r9", usageLimitResetAt: new Date(T0 + 3600_000).toISOString(), pendingBackgroundTasks: [{ taskId: "x", kind: "command" }] });
	await m.refresh();
	let card = m.snapshot.cards.get("t")!;
	assert.equal(card.background, 1);
	assert.equal(card.activeRunId, "r9");
	shell.connected = false;
	await m.refresh();
	card = m.snapshot.cards.get("t")!;
	assert.equal(card.background, 0);
	assert.equal(card.activeRunId, undefined);
	assert.equal(card.pausedUntil, undefined);
	assert.notEqual(card.state, "paused");
	m.stop();
});

test("monitor: recent list is roots only and paged; active list includes subagents", async () => {
	const { m, server } = await monitor();
	await m.refresh();
	const active = server.calls.find((c) => c.statuses)!;
	const recent = server.calls.find((c) => !c.statuses)!;
	assert.equal(active.includeSubagents, true);
	assert.equal(recent.includeSubagents, false);
	assert.equal(recent.settled, false);
	assert.equal(recent.snoozed, false);
	assert.equal(recent.limit, 100);
	assert.equal(recent.cursor, 0);
	m.stop();
});

test("monitor: an active subagent under an idle intermediate folds into its root via shell lineage", async () => {
	const shell = new FakeShell();
	const { m, server } = await monitor({ shell });
	server.recent = [summary("root")];
	server.active = [summary("grandchild", { status: "running", parentThreadId: "child", relationshipToParent: "subagent" })];
	shell.put({ id: "grandchild", lineage: { rootThreadId: "root", parentThreadId: "child" } });
	await m.refresh();
	assert.equal(m.snapshot.cards.has("grandchild"), false);
	assert.equal(m.snapshot.cards.get("root")?.subagentsWorking, 1);
	assert.deepEqual(reparent([summary("x", { parentThreadId: "missing" })], () => "nowhere")[0].parentThreadId, "missing");
	m.stop();
});

test("monitor: a root leaving the active list refreshes the newest roots before the next full poll", async () => {
	const shell = new FakeShell();
	const { m, server, setClock } = await monitor({ shell });
	server.active = [summary("r", { status: "running" })];
	server.recent = [summary("r", { status: "running" })];
	await m.refresh(); // full
	await settle(2100); // past "Refresh every" since that poll
	server.calls.length = 0;
	// A shell change drives an active-only poll (debounced).
	setClock(T0 + 5_000);
	server.active = [];
	server.recent = [summary("r", { status: "completed" })];
	shell.emit("change");
	await settle(400);
	const recentCalls = server.calls.filter((c) => !c.statuses);
	assert.equal(recentCalls.length, 1);
	assert.equal(recentCalls[0].limit, 20, "just the head, not the full 100");
	assert.equal(stateOf(m, "r"), "done");
	m.stop();
});

test("monitor: shell changes are debounced into one poll", async () => {
	const shell = new FakeShell();
	const { m, server } = await monitor({ shell });
	m.configure({ pollSeconds: 2 });
	await m.refresh();
	await settle(2100); // past "Refresh every", so the next change polls after the debounce only
	server.calls.length = 0;
	for (let i = 0; i < 10; i++) shell.emit("change");
	await settle(400);
	assert.equal(server.calls.filter((c) => c.statuses).length, 1);
	m.stop();
});

test("monitor: failures carry reasons; recovery kicks the shell stream", async () => {
	const shell = new FakeShell();
	const { m, server } = await monitor({ shell });
	server.fail = new T3Error("cli-missing", "no CLI");
	await m.refresh();
	assert.deepEqual(m.snapshot.connection, { kind: "error", detail: "no CLI", reason: "cli-missing" });
	server.fail = undefined;
	const kicks = shell.kicks;
	await m.refresh();
	assert.equal(m.snapshot.connection.kind, "ok");
	assert.ok(shell.kicks > kicks);
	const status = await m.status();
	assert.deepEqual(status, { connection: "ok", reason: null, detail: null, actionsTokenPresent: false, signedOut: false });
	m.stop();
});

test("monitor: pending revokes are retried when T3 comes back, not only at start", async () => {
	const { m, server } = await monitor();
	server.recent = [summary("a")];
	await m.refresh();
	let retries = 0;
	m.tokens.retryRevokes = async () => (retries++, { revoked: 0, failed: 0 });
	server.fail = new UnreachableError("down");
	await m.refresh();
	assert.equal(m.snapshot.connection.kind, "offline");
	assert.equal(retries, 0);
	await m.refresh();
	assert.equal(retries, 0, "still down: no retry");
	server.fail = undefined;
	await m.refresh();
	assert.equal(m.snapshot.connection.kind, "ok");
	assert.equal(retries, 1, "back online: retried once");
	await m.refresh();
	assert.equal(retries, 1, "and not on every poll");
	m.stop();
});

test("monitor: signOut reports signed-out status until signIn", async () => {
	const { m, server } = await monitor();
	server.recent = [summary("a")];
	await m.refresh();
	const result = await m.signOut();
	assert.equal(result.ok, true);
	let status = await m.status();
	assert.equal(status.signedOut, true);
	assert.equal(status.connection, "offline");
	assert.equal(status.reason, "signed-out");
	await m.refresh();
	assert.deepEqual([m.snapshot.connection.kind, (m.snapshot.connection as { reason?: string }).reason], ["offline", "signed-out"], "still signed out after the next poll");
	await m.signIn();
	status = await m.status();
	assert.equal(status.signedOut, false);
	assert.equal(status.connection, "ok");
	m.stop();
});

test("monitor: Refresh every is clamped to 2–30 s; t3Cli is gone from settings", async () => {
	const m = new Monitor({ call: async () => ({ threads: [], nextCursor: null }) });
	m.configure({ pollSeconds: 1 });
	assert.equal(m.settings.pollSeconds, 2);
	m.configure({ pollSeconds: 300 });
	assert.equal(m.settings.pollSeconds, 30);
	m.configure({ t3Cli: "/tmp/x" } as Partial<typeof m.settings>);
	assert.equal("t3Cli" in m.settings, false);
});

test("monitor: setDeckThreads hands exactly those threads to the context watcher", async () => {
	const shell = new FakeShell();
	const context = new FakeContext();
	const { m, server } = await monitor({ shell });
	m.attachContext(context);
	server.recent = [summary("a"), summary("b"), summary("c")];
	server.active = [summary("w", { status: "running" })];
	shell.put({ id: "a", latestRunId: "a-run", latestRunCompletedAt: new Date(T0 - 1000).toISOString() });
	await m.refresh();
	m.setDeckThreads(["a", "w", "gone"]);
	assert.deepEqual([...context.targets.keys()], ["a", "w"]);
	assert.deepEqual(context.targets.get("a"), { runKey: "a-run|completed", completedAt: T0 - 1000, working: false });
	assert.equal(context.targets.get("w")?.working, true);
	m.stop();
});

test("threadListOf drops malformed entries", () => {
	assert.throws(() => threadListOf(null));
	assert.throws(() => threadListOf({ threads: "x" }));
	const r = threadListOf({ threads: [null, { threadId: 1 }, summary("ok")], nextCursor: "7" });
	assert.deepEqual(r.threads.map((t) => t.threadId), ["ok"]);
	assert.equal(r.nextCursor, null);
});

// ---------------------------------------------------------------- context watcher (item 13)

const target = (runKey: string, working = false, completedAt: number | null = null): WatchTarget => ({ runKey, working, completedAt });
const record = (runKey: string, at: number, extra: Partial<FetchRecord> = {}): FetchRecord => ({ runKey, completedAt: null, working: false, at, failures: 0, retryAt: 0, ...extra });

test("context: fetch on first sight, when a run finishes, or every 2 min while working", () => {
	const now = T0;
	assert.equal(isDue(target("k"), undefined, now), true);
	assert.equal(isDue(target("k"), record("k", now - 10 * 60_000), now), false, "idle and unchanged: never refetched");
	assert.equal(isDue(target("k2"), record("k", now - 1000), now), true, "run finished");
	assert.equal(isDue(target("k", true), record("k", now - 60_000), now), false);
	assert.equal(isDue(target("k", true), record("k", now - 121_000), now), true);
	assert.equal(isDue(target("k"), record("k", now - 1000, { working: true }), now), true, "was mid-run at the last fetch");
	assert.equal(isDue(target("k", false, 5), record("k", now - 1000, { completedAt: 4 }), now), true, "shell says a run completed");
	assert.equal(isDue(target("k", false, null), record("k", now - 1000, { completedAt: 4 }), now), false, "shell down: no change");
	assert.equal(isDue(target("k"), record("k", 0, { failures: 2, retryAt: now + 1 }), now), false, "backing off");
	assert.equal(isDue(target("k"), record("k", 0, { failures: 2, retryAt: now }), now), true);
	assert.equal(retryDelay(1), 10_000);
	assert.equal(retryDelay(3), 40_000);
	assert.equal(retryDelay(20), 5 * 60_000);

	const wanted = new Map([
		["old", target("x2")],
		["new", target("y")],
		["older", target("z2")],
	]);
	const fetched = new Map([
		["old", record("x", now - 1000)],
		["older", record("z", now - 9000)],
	]);
	assert.equal(pickNext(wanted, fetched, now), "new", "never fetched first");
	fetched.set("new", record("y", now));
	assert.equal(pickNext(wanted, fetched, now), "older", "then least recently fetched");
});

test("ContextWatcher: errors back off and retry; unwatched threads are pruned after 10 minutes", async () => {
	let fail = true;
	let clock = 1_000_000;
	const fetches: string[] = [];
	const watcher = new ContextWatcher({} as RpcAccess, {
		now: () => clock,
		fetch: async (id) => {
			fetches.push(id);
			if (fail) throw new Error("socket closed");
			return { used: 10, max: 100 };
		},
	});
	const logs: string[] = [];
	watcher.on("log", (l) => logs.push(l));
	watcher.watch(new Map([["a", target("k")]]));
	await watcher.tick();
	assert.equal(fetches.length, 1);
	assert.match(logs[0], /retry 1/);
	await watcher.tick();
	assert.equal(fetches.length, 1, "backing off");
	fail = false;
	watcher.retryNow();
	await watcher.tick();
	assert.equal(fetches.length, 2);
	assert.deepEqual(watcher.get("a"), { used: 10, max: 100 });
	await watcher.tick();
	assert.equal(fetches.length, 2, "unchanged: no refetch");

	let changed = 0;
	watcher.on("change", () => changed++);
	// Leaving the watched set (a page switch) keeps the value, and flipping back doesn't refetch.
	watcher.watch(new Map([["b", target("k")]]));
	assert.deepEqual(watcher.get("a"), { used: 10, max: 100 });
	assert.equal(changed, 0);
	clock += LINGER_MS - 1000;
	await watcher.tick(); // fetches b (never seen)
	watcher.watch(new Map([["a", target("k")], ["b", target("k")]]));
	const before = fetches.length;
	await watcher.tick();
	await watcher.tick();
	assert.equal(fetches.filter((id) => id === "a").length, 2, "a was not refetched after coming back");
	assert.equal(fetches.length, before);

	// Gone for the full 10 minutes: forgotten, and fetched afresh on return.
	watcher.watch(new Map([["b", target("k")]]));
	clock += LINGER_MS - 1;
	await watcher.tick();
	assert.deepEqual(watcher.get("a"), { used: 10, max: 100 }, "just under 10 minutes");
	clock += 1;
	await watcher.tick();
	assert.equal(watcher.get("a"), undefined);
	assert.equal(changed, 2, "b's first value, then a's removal");
	watcher.watch(new Map([["a", target("k")], ["b", target("k")]]));
	await watcher.tick();
	assert.equal(fetches.filter((id) => id === "a").length, 3);
	watcher.stop();
});

// ---------------------------------------------------------------- usage (item 16)

test("usage: 5 min refresh, backing off while T3's checkedAt doesn't move", () => {
	assert.equal(nextRefreshDelay(REFRESH_MS, undefined, "a"), REFRESH_MS);
	assert.equal(nextRefreshDelay(REFRESH_MS, "a", "a"), 2 * REFRESH_MS);
	assert.equal(nextRefreshDelay(2 * REFRESH_MS, "a", "a"), REFRESH_MAX_MS);
	assert.equal(nextRefreshDelay(REFRESH_MAX_MS, "a", "a"), REFRESH_MAX_MS);
	assert.equal(nextRefreshDelay(REFRESH_MAX_MS, "a", "b"), REFRESH_MS);
	assert.equal(
		checkedKey([
			{ instanceId: "b", displayName: "B", checkedAt: "2", windows: [] },
			{ instanceId: "a", displayName: "A", checkedAt: "1", windows: [] },
		]),
		"a=1,b=2",
	);
});

test("monitor: an open question or approval blinks amber even though T3 keeps the run 'running'", async () => {
	const shell = new FakeShell();
	const { m, server } = await monitor({ shell });
	server.active = [summary("root", { status: "running" }), summary("kid", { status: "running", parentThreadId: "root", relationshipToParent: "subagent" })];
	await m.refresh();
	assert.equal(stateOf(m, "root"), "working");
	shell.put({ id: "root", pendingRuntimeRequest: { id: "q1", kind: "user_input", blocking: true } });
	await m.refresh();
	assert.equal(stateOf(m, "root"), "input");
	assert.equal(m.snapshot.cards.get("root")?.inputFromSubagent, false);
	// Answered: back to working. A subagent's question lights its main thread.
	shell.put({ id: "root", pendingRuntimeRequest: null });
	shell.put({ id: "kid", lineage: { parentThreadId: "root", rootThreadId: "root" }, pendingRuntimeRequest: { kind: "approval", blocking: false } });
	await m.refresh();
	assert.equal(stateOf(m, "root"), "input");
	assert.equal(m.snapshot.cards.get("root")?.inputFromSubagent, true);
	m.stop();
});

test("monitor: subagents of a settled or missing main thread don't get their own keys unless they need you", async () => {
	const { m, server } = await monitor();
	// The main thread was settled, so it's in neither list; its finished subagents still are.
	server.active = [];
	server.recent = [
		summary("kid-done", { parentThreadId: "gone", relationshipToParent: "subagent", status: "completed" }),
		summary("kid-failed", { parentThreadId: "gone", relationshipToParent: "subagent", status: "failed", latestRunId: "late-run" }),
	];
	await m.refresh();
	const ids = m.snapshot.visible.map((c) => c.threadId);
	assert.ok(!ids.includes("kid-done"), "an idle orphan is hidden");
	m.stop();
});

test("log: identical messages from one source collapse for 10 minutes, then log once with a count", () => {
	let t = 0;
	const lines: string[] = [];
	const log = collapseRepeats((l) => lines.push(l), { now: () => t });
	log("shell", "shell stream: connect ECONNREFUSED");
	for (let i = 0; i < 5; i++) {
		t += 30_000;
		log("shell", "shell stream: connect ECONNREFUSED");
	}
	log("usage", "shell stream: connect ECONNREFUSED"); // another source: its own first occurrence
	log("shell", "shell stream: something else");
	assert.deepEqual(lines, ["shell stream: connect ECONNREFUSED", "shell stream: connect ECONNREFUSED", "shell stream: something else"]);
	t += 10 * 60_000;
	log("shell", "shell stream: connect ECONNREFUSED");
	assert.equal(lines.at(-1), "shell stream: connect ECONNREFUSED (repeated 5 times)");
	log("shell", "shell stream: connect ECONNREFUSED");
	assert.equal(lines.length, 4, "a new window started; suppressed again");
	// Tokens are redacted before comparing, so they never leak into the key or the line.
	log("x", `bad token ${"a".repeat(40)}`);
	assert.equal(lines.at(-1), `bad token ${REDACTED}`);
});
