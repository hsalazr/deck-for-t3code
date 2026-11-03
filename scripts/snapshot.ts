// Prints what the deck would show, without Stream Deck.
// Usage: node --experimental-strip-types scripts/snapshot.ts [polls=3]
import { contextPercent } from "../src/render.ts";
import { ContextWatcher } from "../src/t3/context-watcher.ts";
import { Monitor } from "../src/t3/monitor.ts";
import { RpcAccess } from "../src/t3/rpc.ts";
import { ShellStream } from "../src/t3/shell-stream.ts";

const polls = Number(process.argv[2] ?? 3);
const m = new Monitor();
m.configure({ pollSeconds: 2 });
const rpc = new RpcAccess(() => m.location);
const shell = new ShellStream(rpc);
const context = new ContextWatcher(rpc);
m.attachShell(shell);
m.attachContext(context);
for (const source of [m, shell, context]) source.on("log", (l: string) => console.error("log:", l));
let n = 0;
let last = 0;
m.on("change", (s) => {
	// No deck here: pretend every visible thread is on a key, so context usage is fetched for them.
	m.setDeckThreads(s.visible.map((c) => c.threadId));
	if (s.connection.kind === "connecting" || Date.now() - last < 1500) return;
	last = Date.now();
	console.log(`--- snapshot ${++n} connection: ${JSON.stringify(s.connection)} shell: ${shell.connected ? "live" : "down"}`);
	for (const c of [...s.visible].sort((a, b) => b.updatedAt - a.updatedAt)) {
		const extra = [
			c.waitingOn && `waiting on: ${c.waitingOn}`,
			c.context && `context ${contextPercent(c.context)}%`,
			c.pausedUntil && `paused until ${new Date(c.pausedUntil).toISOString()}`,
			c.activeRunId && "run active",
		].filter(Boolean).join(", ");
		console.log(`${c.state.padEnd(8)} bg:${c.background} ${(s.projectNames.get(c.projectId) ?? "?").padEnd(11)} ${c.title.slice(0, 38).padEnd(38)} ${extra}`);
	}
	if (n >= polls) {
		m.stop();
		shell.stop();
		context.stop();
		process.exit(0);
	}
});
m.start();
shell.start();
context.start();
