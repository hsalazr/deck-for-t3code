// Runs the Dictate key's script on this Mac in dry-run mode: it builds the key events
// and reads them back, checks the frontmost app and the Accessibility permission, and
// prints one line of JSON. It posts nothing and asks for nothing. macOS only.
// Usage: node --experimental-strip-types scripts/dictate-dry-run.ts [--bundle-id com.t3tools.t3code] [--key d] [--mods cmd,shift] [--mode tap|down|up] [--wait-ms 5000] [--print]
//   --wait-ms  time to switch to T3 Code after starting it (default 5000)
//   --print    print the osascript command line instead of running it
import { chordFor, DICTATE_SCRIPT, runOsascript, scriptArgs, type DictatePhase } from "../src/dictate.ts";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
const mods = new Set(opt("--mods", "cmd,shift").split(",").filter(Boolean));
const chord = chordFor({ key: opt("--key", "d"), command: mods.has("cmd"), control: mods.has("ctrl"), shift: mods.has("shift"), option: mods.has("option") });
const argv = scriptArgs(opt("--mode", "tap") as DictatePhase, { bundleId: opt("--bundle-id", "com.t3tools.t3code"), chord }, { dryRun: true, waitMs: Number(opt("--wait-ms", "5000")) });

if (args.includes("--print")) {
	console.log(DICTATE_SCRIPT);
	console.log(`# run with: osascript -l JavaScript -e "$SCRIPT" ${argv.join(" ")}`);
} else {
	console.error(`dry run of ${chord.label} (key code ${chord.keyCode}, flags ${chord.flags}); switch to T3 Code within ${opt("--wait-ms", "5000")} ms`);
	const { code, stdout, stderr } = await runOsascript(argv, Number(opt("--wait-ms", "5000")) + 5000);
	process.stdout.write(stdout);
	if (stderr.trim()) console.error(stderr.trim());
	console.error(`exit ${code}`);
	process.exitCode = code;
}
