import assert from "node:assert/strict";
import { test } from "node:test";

import { checkSvg } from "./assets.test.ts";
import { MIN_FONT_PX, renderUpdatesKey } from "../src/render.ts";
import { UpdatesMonitor, type UpdatesSource } from "../src/t3/updates-monitor.ts";
import { channelOf, compareVersions, displayVersion, pendingUpdates, providerUpdates, serverVersionOf, t3Update, type UpdatesSnapshot } from "../src/updates.ts";

test("versions compare like semver, nightlies by date and build", () => {
	assert.ok(compareVersions("0.1.8", "0.1.7") > 0);
	assert.ok(compareVersions("0.1.10", "0.1.9") > 0);
	assert.equal(compareVersions("v2.1.319", "2.1.319"), 0);
	assert.ok(compareVersions("0.1.8", "0.1.8-nightly.20261106.4288") > 0, "a release is newer than its nightlies");
	assert.ok(compareVersions("0.1.8-nightly.20261106.4288", "0.1.7") > 0);
	assert.ok(compareVersions("0.1.8-nightly.20261106.4288", "0.1.8-nightly.20261105.4271") > 0);
	assert.ok(compareVersions("0.1.8-nightly.20261106.4290", "0.1.8-nightly.20261106.4288") > 0);
	assert.ok(compareVersions("1.0.0-beta.2", "1.0.0-beta.11") < 0, "numeric parts compare as numbers");
});

test("channel and display: nightly builds follow nightly", () => {
	assert.equal(channelOf("0.1.7"), "latest");
	assert.equal(channelOf("0.1.8-nightly.20261106.4288"), "nightly");
	assert.equal(channelOf(null), "latest");
	assert.equal(displayVersion("0.1.8-nightly.20261106.4288"), "0.1.8 nightly");
	assert.equal(displayVersion("2.1.319"), "2.1.319");
});

const CONFIG = {
	environment: { serverVersion: "0.1.7" },
	providers: [
		{ instanceId: "codex", displayName: "Codex", enabled: false, installed: false, version: null },
		{ instanceId: "claudeAgent", displayName: "Claude", enabled: true, installed: true, version: "2.1.319", versionAdvisory: { status: "current", currentVersion: "2.1.319", latestVersion: "2.1.319" } },
		{ instanceId: "acme", displayName: "Acme CLI", enabled: true, installed: true, version: "1.0.0", versionAdvisory: { status: "behind_latest", currentVersion: "1.0.0", latestVersion: "1.2.0" } },
		{ instanceId: "nolookup", displayName: "Plain", enabled: true, installed: true, version: "3.0.0" },
	],
};

test("reads T3 Code's version and the enabled providers' advisories", () => {
	assert.equal(serverVersionOf(CONFIG), "0.1.7");
	assert.equal(serverVersionOf({}), null);
	assert.deepEqual(providerUpdates(CONFIG), [
		{ name: "Claude", current: "2.1.319", latest: "2.1.319", available: false },
		{ name: "Acme CLI", current: "1.0.0", latest: "1.2.0", available: true },
		{ name: "Plain", current: "3.0.0", latest: null, available: false },
	]);
	assert.equal(t3Update("0.1.7", "0.1.8").available, true);
	assert.equal(t3Update("0.1.7", null).available, false);
	assert.equal(t3Update("0.1.8", "0.1.7").available, false);
});

function assertLegible(svg: string): void {
	assert.deepEqual(checkSvg(svg), []);
	const sizes = [...svg.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
	assert.ok(sizes.every((s) => s >= MIN_FONT_PX), `font sizes ${sizes.join(",")}`);
}

test("updates tile: up to date with versions, or a count and what's waiting", () => {
	const base: UpdatesSnapshot = { ok: true, fetchedAt: 1, t3: t3Update("0.1.7", "0.1.7"), providers: [{ name: "Claude", current: "2.1.319", latest: "2.1.319", available: false }] };
	const fresh = renderUpdatesKey(base);
	assertLegible(fresh);
	for (const s of [">UPDATES<", ">✓ Up to date<", ">T3 0.1.7<", ">Claude 2.1.319<"]) assert.ok(fresh.includes(s), s);

	const waiting: UpdatesSnapshot = { ...base, t3: t3Update("0.1.8-nightly.20261105.4271", "0.1.8-nightly.20261106.4288"), providers: providerUpdates(CONFIG) };
	assert.equal(pendingUpdates(waiting).length, 2);
	const svg = renderUpdatesKey(waiting);
	assertLegible(svg);
	for (const s of [">2<", ">updates<", ">T3 0.1.8 nightly<", ">Acme CLI 1.2.0<"]) assert.ok(svg.includes(s), s);

	const many: UpdatesSnapshot = { ...base, providers: ["A", "B", "C", "D"].map((n) => ({ name: n, current: "1", latest: "2", available: true })) };
	assert.ok(renderUpdatesKey(many).includes(">+2 more<"));
	assert.ok(renderUpdatesKey({ ...base, ok: false }).includes(">UPDATES · STALE<"));
	assert.ok(renderUpdatesKey({ ok: false, detail: "Loading…", providers: [], fetchedAt: 0 }).includes(">Loading…<"));
	assert.ok(renderUpdatesKey({ ok: false, detail: "refused", providers: [], fetchedAt: 0 }).includes(">T3 offline<"));
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the monitor asks for the release on this build's channel, and keeps provider news when that lookup fails", async (t) => {
	const specs: string[] = [];
	let config: unknown = { ...CONFIG, environment: { serverVersion: "0.1.8-nightly.20261105.4271" } };
	let releaseFails = false;
	const source: UpdatesSource = {
		getConfig: async () => config,
		getNpmRelease: async (spec) => {
			specs.push(spec);
			if (releaseFails) throw new Error("npm unreachable");
			return { version: "0.1.8-nightly.20261106.4288" };
		},
	};
	const monitor = new UpdatesMonitor(source);
	t.after(() => monitor.stop());
	const logs: string[] = [];
	monitor.on("log", (l) => logs.push(l));
	monitor.start();
	await settle();
	assert.deepEqual(specs, [], "no Updates key: nothing asked");
	monitor.setWanted(true);
	await settle();
	assert.deepEqual(specs, ["nightly"]);
	assert.equal(monitor.snapshot.t3?.available, true);

	config = CONFIG;
	releaseFails = true;
	monitor.refresh();
	await settle();
	assert.deepEqual(specs, ["nightly", "latest"]);
	assert.equal(monitor.snapshot.ok, true);
	assert.equal(monitor.snapshot.t3?.latest, null);
	assert.equal(pendingUpdates(monitor.snapshot).map((u) => u.name).join(), "Acme CLI");
	assert.ok(logs.some((l) => l.includes("npm unreachable")));
	monitor.stop();
});

test("updates glance: a big check when current, a big count when not", () => {
	const base: UpdatesSnapshot = { ok: true, fetchedAt: 1, t3: t3Update("0.1.7", "0.1.7"), providers: [] };
	const current = renderUpdatesKey(base, "glance");
	assertLegible(current);
	assert.ok(current.includes(">UP TO DATE<") && current.includes("<path"));
	const waiting = renderUpdatesKey({ ...base, t3: t3Update("0.1.7", "0.1.8"), providers: providerUpdates(CONFIG) }, "glance");
	assertLegible(waiting);
	assert.ok(waiting.includes(">2<") && waiting.includes(">UPDATES<"));
	assert.ok(renderUpdatesKey({ ...base, ok: false }, "glance").includes(">STALE<"));
});
