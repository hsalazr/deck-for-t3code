import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every tracked SVG (and any new one that isn't ignored). */
const svgFiles = (): string[] =>
	execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.svg"], { cwd: ROOT, encoding: "utf8" })
		.split("\n")
		.filter(Boolean);

/** A small well-formedness check: balanced tags and no repeated attribute on one element. */
export function checkSvg(src: string): string[] {
	const problems: string[] = [];
	const body = src.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "");
	const stack: string[] = [];
	const tag = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = tag.exec(body))) {
		const between = body.slice(last, m.index);
		if (/[<>]/.test(between)) problems.push(`stray angle bracket near "${between.trim().slice(0, 30)}"`);
		last = tag.lastIndex;
		const [, closing, name, attrs, selfClose] = m;
		if (closing) {
			const open = stack.pop();
			if (open !== name) problems.push(`</${name}> closes <${open ?? "nothing"}>`);
			continue;
		}
		const seen = new Set<string>();
		for (const a of attrs!.matchAll(/([^\s=]+)\s*=/g)) {
			if (seen.has(a[1]!)) problems.push(`<${name}> repeats attribute ${a[1]}`);
			seen.add(a[1]!);
		}
		if (!selfClose) stack.push(name!);
	}
	if (/[<>]/.test(body.slice(last))) problems.push("stray angle bracket after the last tag");
	if (stack.length) problems.push(`unclosed: ${stack.join(", ")}`);
	return problems;
}

test("the checker catches duplicate attributes and unbalanced tags", () => {
	assert.deepEqual(checkSvg('<svg a="1"><path d="M0 0" fill="none"/></svg>'), []);
	assert.match(checkSvg('<svg><path stroke-width="1" stroke-width="2"/></svg>')[0]!, /repeats attribute stroke-width/);
	assert.ok(checkSvg("<svg><g></svg>").length > 0);
	assert.ok(checkSvg("<svg><path/>").length > 0);
});

test("every tracked SVG is well-formed", () => {
	const files = svgFiles();
	assert.ok(files.length >= 10, `found only ${files.length} svg files`);
	for (const f of files) assert.deepEqual(checkSvg(readFileSync(join(ROOT, f), "utf8")), [], f);
});

test("the plugin's icons are the ones the asset script produced", () => {
	const P = "io.github.hsalazr.deck-for-t3code.sdPlugin/imgs";
	const pairs: [string, string][] = [[`${P}/plugin/category.svg`, "marketing/icon/category.svg"]];
	for (const n of ["back", "overview", "thread", "usage"]) pairs.push([`${P}/actions/${n}/icon.svg`, `marketing/icon/${n}.svg`]);
	for (const [a, b] of pairs) assert.equal(readFileSync(join(ROOT, a), "utf8"), readFileSync(join(ROOT, b), "utf8"), a);
});

test("versions agree: manifest X.Y.Z.0, package X.Y.Z, MCP client constant", async () => {
	const { PLUGIN_NAME, PLUGIN_VERSION } = await import("../src/version.ts");
	const manifest = JSON.parse(readFileSync(join(ROOT, "io.github.hsalazr.deck-for-t3code.sdPlugin/manifest.json"), "utf8"));
	const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
	assert.equal(manifest.Version, `${PLUGIN_VERSION}.0`);
	assert.equal(pkg.version, PLUGIN_VERSION);
	assert.equal(pkg.name, PLUGIN_NAME);
	assert.equal(lock.version, PLUGIN_VERSION);
	assert.equal(lock.packages[""].name, PLUGIN_NAME);
});

test("third-party notices are current and ship in the plugin folder", async () => {
	// @ts-expect-error plain .mjs script, no types
	const { collect, render } = await import("../scripts/notices.mjs");
	const packages = collect() as { name: string }[];
	const names = packages.map((p) => p.name);
	for (const expected of ["@elgato/streamdeck", "ws", "zod"]) assert.ok(names.includes(expected), `${expected} is bundled`);
	const markdown = render(packages);
	assert.equal(readFileSync(join(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8"), markdown, "run `npm run notices`");
	assert.equal(readFileSync(join(ROOT, "io.github.hsalazr.deck-for-t3code.sdPlugin/THIRD_PARTY_NOTICES.md"), "utf8"), markdown, "run `npm run notices`");
	assert.ok(!/^THIRD_PARTY/m.test(readFileSync(join(ROOT, "io.github.hsalazr.deck-for-t3code.sdPlugin/.sdignore"), "utf8")), ".sdignore keeps the notices");
});
