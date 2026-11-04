// Linked environments: threads from the user's other machines, listed through the local server.
// Fakes only; nothing touches a live T3 server or the real credential folder.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { deepLinkFor, type ThreadSummary } from "../src/model.ts";
import { TokenStore } from "../src/t3/auth.ts";
import type { WatchTarget } from "../src/t3/context-watcher.ts";
import { ToolError, UnreachableError } from "../src/t3/mcp.ts";
import { Monitor, type ContextSource } from "../src/t3/monitor.ts";
import { linksOf, REMOTE_ACTIVE_MIN_MS, REMOTE_DROP_AFTER_MS } from "../src/t3/remotes.ts";

const T0 = Date.parse("2026-11-03T12:00:00Z");
const LOCAL = "env-local";

const summary = (id: string, env = LOCAL, extra: Partial<ThreadSummary> = {}): ThreadSummary => ({
	threadId: id,
	projectId: env === LOCAL ? "p" : `p-${env}`,
	title: id,
	link: `http://127.0.0.1:3773/${env}/${id}`,
	status: "completed",
	latestRunId: `${id}-run`,
	parentThreadId: null,
	relationshipToParent: null,
	settled: false,
	snoozed: false,
	createdAt: new Date(T0 - 86_400_000).toISOString(),
	updatedAt: new Date(T0 - 3600_000).toISOString(),
	...extra,
});

class FakeContext extends EventEmitter implements ContextSource {
	targets: ReadonlyMap<string, WatchTarget> = new Map();
	get() {
		return undefined;
	}
	watch(targets: ReadonlyMap<string, WatchTarget>) {
		this.targets = targets;
	}
}

interface Env {
	label: string;
	status: string;
	active: ThreadSummary[];
	recent: ThreadSummary[];
	fail?: Error;
}

const monitors: Monitor[] = [];
after(() => {
	for (const m of monitors) m.stop();
});

/** A local server that knows `envs` as links. `links` = "off" refuses like T3 does while the Labs setting is off. */
async function setup() {
	let clock = T0;
	const server = {
		local: { active: [] as ThreadSummary[], recent: [] as ThreadSummary[] },
		envs: new Map<string, Env>(),
		links: "on" as "on" | "off" | "weird" | "down",
		calls: [] as { name: string; args: Record<string, unknown> }[],
	};
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deck-remotes-"));
	const tokens = new TokenStore({ dir, run: async () => "", checkCli: async () => undefined, cooldownMs: 0 });
	const m = new Monitor({
		tokens,
		now: () => clock,
		call: async (name, args) => {
			server.calls.push({ name, args });
			if (name === "t3_environment_links") {
				if (server.links === "off") throw new ToolError("t3_environment_links: Linked environments is off on this machine.");
				if (server.links === "down") throw new UnreachableError("T3 Code server stopped responding");
				if (server.links === "weird") return { threads: [] };
				return {
					environmentId: LOCAL,
					links: [...server.envs].map(([environmentId, e]) => ({ environmentId, label: e.label, status: e.status, access: "read-only", expiresAt: "", lastError: null })),
					notListed: "",
				};
			}
			const env = typeof args.environmentId === "string" ? server.envs.get(args.environmentId) : undefined;
			if (args.environmentId !== undefined && !env) throw new ToolError(`unknown environment ${String(args.environmentId)}`);
			if (env?.fail) throw env.fail;
			if (name === "t3_project_list") return { projects: [{ id: env ? `p-${String(args.environmentId)}` : "p", name: env ? env.label : "proj" }], nextCursor: null };
			const source = env ?? server.local;
			const list = args.statuses ? source.active : source.recent.slice(0, Number(args.limit));
			return { threads: list, nextCursor: null };
		},
	});
	monitors.push(m);
	m.configure({});
	m.start();
	return { m, server, setClock: (t: number) => (clock = t) };
}

const remoteCalls = (calls: { name: string; args: Record<string, unknown> }[]) => calls.filter((c) => c.args.environmentId !== undefined);

test("linksOf: keeps well-formed links, drops this machine and junk; null for something that isn't a links answer", () => {
	assert.deepEqual(
		linksOf({
			environmentId: "me",
			links: [
				{ environmentId: "a", label: "Linux box", status: "reachable" },
				{ environmentId: "me", label: "self", status: "reachable" },
				{ environmentId: 3 },
				null,
				{ environmentId: "b" },
			],
		}),
		[
			{ environmentId: "a", label: "Linux box", status: "reachable" },
			{ environmentId: "b", label: "b", status: "unknown" },
		],
	);
	assert.equal(linksOf({ threads: [] }), null);
	assert.equal(linksOf(undefined), null);
});

test("remote deep link: a linked machine's thread opens in its own environment", () => {
	assert.equal(deepLinkFor("http://100.64.0.7:3773/env-linux/t9", "t9"), "t3code://threads/env-linux/t9");
});

test("linked machines' threads join the snapshot with their environment id and project names", async () => {
	const { m, server } = await setup();
	server.local.recent = [summary("local-1")];
	server.envs.set("env-linux", { label: "Linux box", status: "reachable", active: [summary("r-run", "env-linux", { status: "running" })], recent: [summary("r-idle", "env-linux")] });
	await m.refresh();
	await m.refreshRemotes();
	const cards = m.snapshot.cards;
	assert.equal(cards.get("local-1")?.environmentId, undefined);
	assert.equal(cards.get("r-run")?.environmentId, "env-linux");
	assert.equal(cards.get("r-run")?.state, "working");
	assert.equal(cards.get("r-idle")?.state, "idle", "a machine's first answer doesn't flash old results");
	assert.equal(m.snapshot.projectNames.get("p-env-linux"), "Linux box");
	assert.equal(m.snapshot.projectNames.get("p"), "proj");
	const remote = remoteCalls(server.calls).filter((c) => c.name === "t3_thread_list");
	assert.ok(remote.every((c) => c.args.environmentId === "env-linux" && c.args.allProjects === true));
	assert.ok(remote.some((c) => c.args.statuses && c.args.includeSubagents === true));
	assert.ok(remote.some((c) => !c.args.statuses && c.args.includeSubagents === false && c.args.settled === false));
	assert.deepEqual([...m.linkedEnvironments.keys()], ["env-linux"]);
	m.stop();
});

test("a remote run that finishes while we watch lights up, like a local one", async () => {
	const { m, server, setClock } = await setup();
	const env: Env = { label: "Linux box", status: "reachable", active: [summary("r", "env-linux", { status: "running" })], recent: [] };
	server.envs.set("env-linux", env);
	await m.refresh();
	await m.refreshRemotes();
	setClock(T0 + 60_000);
	env.active = [];
	env.recent = [summary("r", "env-linux", { updatedAt: new Date(T0 + 30_000).toISOString() })];
	await m.refreshRemotes();
	assert.equal(m.snapshot.cards.get("r")?.state, "done");
	m.stop();
});

test("Linked environments off, a strange answer, or no links: the local deck works and nothing remote is asked", async () => {
	for (const links of ["off", "weird"] as const) {
		const { m, server } = await setup();
		server.links = links;
		server.local.recent = [summary("local-1")];
		server.envs.set("env-linux", { label: "Linux box", status: "reachable", active: [], recent: [summary("r")] });
		await m.refresh();
		await m.refreshRemotes();
		assert.equal(m.snapshot.connection.kind, "ok", links);
		assert.deepEqual([...m.snapshot.cards.keys()], ["local-1"], links);
		assert.deepEqual(remoteCalls(server.calls), [], links);
		m.stop();
	}
});

test("turning Linked environments off drops the remote tiles", async () => {
	const { m, server, setClock } = await setup();
	server.envs.set("env-linux", { label: "Linux box", status: "reachable", active: [], recent: [summary("r", "env-linux")] });
	await m.refresh();
	await m.refreshRemotes();
	assert.ok(m.snapshot.cards.has("r"));
	server.links = "off";
	setClock(T0 + 60_000);
	await m.refreshRemotes();
	assert.equal(m.snapshot.cards.has("r"), false);
	m.stop();
});

test("a failing linked machine never breaks the local poll; its tiles go after it has failed for a while", async () => {
	const { m, server, setClock } = await setup();
	server.local.recent = [summary("local-1")];
	const env: Env = { label: "Linux box", status: "reachable", active: [], recent: [summary("r", "env-linux")] };
	server.envs.set("env-linux", env);
	await m.refresh();
	await m.refreshRemotes();
	assert.ok(m.snapshot.cards.has("r"));

	env.fail = new ToolError("The linked environment stopped answering.");
	setClock(T0 + REMOTE_ACTIVE_MIN_MS);
	await m.refresh(); // this machine's poll; the linked one it starts runs on
	await m.refreshRemotes();
	assert.equal(m.snapshot.connection.kind, "ok");
	assert.ok(m.snapshot.cards.has("local-1"));
	assert.ok(m.snapshot.cards.has("r"), "kept through a short outage");
	assert.equal(m.linkedEnvironments.get("env-linux")?.failing, true);

	setClock(T0 + REMOTE_ACTIVE_MIN_MS + REMOTE_DROP_AFTER_MS);
	await m.refreshRemotes();
	assert.equal(m.snapshot.cards.has("r"), false, "dropped after failing for REMOTE_DROP_AFTER_MS");
	assert.ok(m.snapshot.cards.has("local-1"));
	m.stop();
});

test("a link that is unreachable or expired is not polled; one that disappears is dropped at once", async () => {
	const { m, server, setClock } = await setup();
	server.envs.set("env-a", { label: "A", status: "reachable", active: [], recent: [summary("a1", "env-a")] });
	server.envs.set("env-b", { label: "B", status: "expired", active: [], recent: [summary("b1", "env-b")] });
	await m.refresh();
	await m.refreshRemotes();
	assert.ok(m.snapshot.cards.has("a1"));
	assert.equal(m.snapshot.cards.has("b1"), false);
	assert.ok(!remoteCalls(server.calls).some((c) => c.args.environmentId === "env-b"));
	server.envs.delete("env-a");
	setClock(T0 + 1000);
	await m.refreshRemotes();
	assert.equal(m.snapshot.cards.has("a1"), false);
	m.stop();
});

test("this machine's server not answering the links call keeps the remote tiles", async () => {
	const { m, server, setClock } = await setup();
	server.envs.set("env-a", { label: "A", status: "reachable", active: [], recent: [summary("a1", "env-a")] });
	await m.refresh();
	await m.refreshRemotes();
	server.links = "down";
	setClock(T0 + 1000);
	await m.refreshRemotes();
	assert.ok(m.snapshot.cards.has("a1"));
	m.stop();
});

test("remote active lists are polled at most every REMOTE_ACTIVE_MIN_MS, not on every local poll", async () => {
	const { m, server, setClock } = await setup();
	server.envs.set("env-a", { label: "A", status: "reachable", active: [], recent: [] });
	await m.refresh();
	await m.refreshRemotes();
	server.calls.length = 0;
	setClock(T0 + 3000);
	await m.refresh();
	assert.deepEqual(remoteCalls(server.calls), [], "too soon");
	setClock(T0 + REMOTE_ACTIVE_MIN_MS);
	await m.refresh();
	const remote = remoteCalls(server.calls);
	assert.equal(remote.filter((c) => c.name === "t3_thread_list" && c.args.statuses).length, 1);
	m.stop();
});

test("linked machines' threads are never handed to the context watcher", async () => {
	const { m, server } = await setup();
	const context = new FakeContext();
	m.attachContext(context);
	server.local.recent = [summary("local-1")];
	server.envs.set("env-a", { label: "A", status: "reachable", active: [], recent: [summary("a1", "env-a")] });
	await m.refresh();
	await m.refreshRemotes();
	m.setDeckThreads(["local-1", "a1"]);
	assert.deepEqual([...context.targets.keys()], ["local-1"]);
	m.stop();
});
