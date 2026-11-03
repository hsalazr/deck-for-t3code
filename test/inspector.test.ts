import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { signOutReply } from "../src/t3/monitor.ts";

// The property inspector's shared script is a plain browser script; load its pure helpers.
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../io.github.hsalazr.deck-for-t3code.sdPlugin/ui/common.js"), "utf8");
const sandbox: Record<string, unknown> = { window: {}, document: {} };
vm.runInNewContext(src, sandbox);
// Results cross a vm realm; copy them so deepEqual compares plain objects.
const wrap = (fn: unknown) => (msg: unknown): { text: string; tone: string } => ({ ...(fn as (m: unknown) => { text: string; tone: string })(msg) });
const statusText = wrap(sandbox.statusText);
const signOutText = wrap(sandbox.signOutText);

test("sign-out wording: signed out, partly revoked, failed", () => {
	assert.deepEqual(signOutText({ type: "signedOut", ok: true, revoked: 3, failed: 0 }), { text: "Signed out", tone: "ok" });
	assert.deepEqual(signOutText({ type: "signedOut", ok: true, revoked: 2, failed: 1 }), { text: "Signed out — 1 token will be revoked later", tone: "ok" });
	assert.equal(signOutText({ type: "signedOut", ok: true, revoked: 1, failed: 2 }).text, "Signed out — 2 tokens will be revoked later");
	assert.deepEqual(signOutText({ type: "signedOut", ok: false, revoked: 0, failed: 0 }), { text: "Sign-out failed — see logs", tone: "bad" });
});

test("the plugin's sign-out reply says ok when it signed out, even if some revokes failed", () => {
	assert.deepEqual(signOutReply({ ok: false, revoked: 2, failed: 1, detail: "x" }), { type: "signedOut", ok: true, revoked: 2, failed: 1 });
	assert.equal(signOutText(signOutReply({ ok: false, revoked: 2, failed: 1 })).text, "Signed out — 1 token will be revoked later");
	assert.equal(signOutText(signOutReply({ ok: true, revoked: 3, failed: 0 })).text, "Signed out");
});

test("status row after a sign-out", () => {
	assert.deepEqual(statusText({ connection: "offline", reason: "signed-out", signedOut: true }), { text: "Signed out — use Sign in below", tone: "" });
	assert.equal(statusText({ connection: "offline", reason: "signed-out" }).text, "Signed out — use Sign in below");
	assert.equal(statusText({ connection: "ok" }).text, "Connected");
	assert.equal(statusText({ connection: "error", reason: "sign-in-failed" }).tone, "bad");
});
