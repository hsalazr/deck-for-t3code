import streamDeck from "@elgato/streamdeck";

import { BackKey, OverviewKey, runtime, ThreadActionKey, ThreadKey, UsageKey } from "./actions.ts";
import { Deck } from "./deck.ts";
import type { AnimationMode } from "./render.ts";
import { defaultTokens } from "./t3/auth.ts";
import { ThreadCommands } from "./t3/commands.ts";
import { ContextWatcher } from "./t3/context-watcher.ts";
import { collapseRepeats, describe, redact, redactLogger } from "./t3/log.ts";
import { Monitor, signOutReply, type MonitorSettings } from "./t3/monitor.ts";
import { RpcAccess } from "./t3/rpc.ts";
import { ShellStream } from "./t3/shell-stream.ts";
import { UsageMonitor } from "./t3/usage-monitor.ts";

type GlobalSettings = Partial<MonitorSettings> & { animation?: AnimationMode; showLabels?: boolean; messages?: string; actionsEnabled?: boolean };

streamDeck.logger.setLevel("info");
// Every log line, whoever writes it, goes through redact(): no token ever lands in the log files.
redactLogger(streamDeck.logger);
const log = (line: string): void => void streamDeck.logger.info(redact(line));

// A bad frame or a bug in one key must not take the whole plugin down.
process.on("uncaughtException", (error) => streamDeck.logger.error(redact(`uncaught exception: ${describe(error)}`)));
process.on("unhandledRejection", (reason) => streamDeck.logger.error(redact(`unhandled rejection: ${describe(reason)}`)));

const tokens = defaultTokens;
const monitor = new Monitor({ tokens });
// Threads over MCP; background work (live) and usage limits over the /ws RPC socket.
const rpc = new RpcAccess(() => monitor.location, "rpc", { tokens });
const shell = new ShellStream(rpc);
monitor.attachShell(shell);
const context = new ContextWatcher(rpc);
monitor.attachContext(context);
const usage = new UsageMonitor(rpc);
// Thread actions (stop, snooze, settle, send) use a separate token that may act on threads,
// minted only while the actionsEnabled global setting is on.
const commands = new ThreadCommands(new RpcAccess(() => monitor.location, "operate", { tokens }), () => tokens.actionsEnabled);
const deck = new Deck(monitor, usage, commands);
runtime.deck = deck;

// A closed T3 makes the shell stream and the usage monitor report the same failure every ~30 s;
// log it once, then once more with a count after 10 minutes.
const logOnce = collapseRepeats(log);
for (const [name, source] of Object.entries({ monitor, usage, shell, context, tokens })) source.on("log", (line: string) => logOnce(name, line));

let lastConnection = "";
monitor.on("change", (snapshot) => {
	const c = snapshot.connection;
	const summary = c.kind === "ok" || c.kind === "connecting" ? c.kind : `${c.kind} (${c.reason ?? "unknown"}): ${c.detail}`;
	if (summary === lastConnection) return;
	lastConnection = summary;
	log(`T3 connection ${summary}`);
	// Keep an open property inspector's status row current.
	sendStatus().catch((error: unknown) => log(`status update failed: ${describe(error)}`));
});

async function sendStatus(): Promise<void> {
	const status = await monitor.status();
	await streamDeck.ui.sendToPropertyInspector({ type: "status", ...status });
}

/**
 * Messages from any action's property inspector:
 * - `{type:"status"}` → `{type:"status", connection, reason, detail, actionsTokenPresent, signedOut}`
 * - `{type:"signOut"}` → revokes and deletes every token → `{type:"signedOut", ok, revoked, failed}`; `ok` = signed out, `failed` = tokens not revoked yet
 * - `{type:"signIn"}` → resumes after a sign-out → `{type:"signedIn", ok}`
 */
streamDeck.ui.onSendToPlugin((ev) => {
	const type = (ev.payload as { type?: unknown } | null)?.type;
	const reply = (payload: Parameters<typeof streamDeck.ui.sendToPropertyInspector>[0]) => streamDeck.ui.sendToPropertyInspector(payload);
	const run = async (): Promise<void> => {
		if (type === "status") return sendStatus();
		if (type === "signOut") {
			try {
				const result = await monitor.signOut();
				await reply(signOutReply(result));
			} catch (error) {
				log(`sign out failed: ${describe(error)}`);
				await reply({ type: "signedOut", ok: false, revoked: 0, failed: 0 });
			}
			return sendStatus();
		}
		if (type === "signIn") {
			await monitor.signIn();
			usage.refresh();
			await reply({ type: "signedIn", ok: monitor.snapshot.connection.kind === "ok" });
			return sendStatus();
		}
	};
	run().catch((error: unknown) => log(`property inspector message ${String(type)} failed: ${describe(error)}`));
});

let lastHome: string | undefined;
let lastActions: boolean | undefined;

function applyGlobal(settings: GlobalSettings): void {
	const home = settings.t3Home?.trim() ?? "";
	monitor.configure(settings);
	if (home !== lastHome && lastHome !== undefined) shell.restart();
	lastHome = home;
	const actions = settings.actionsEnabled === true;
	tokens.actionsEnabled = actions;
	if (!actions && lastActions !== false) {
		// Actions off: the token that may act on threads shouldn't exist at all.
		// Wait for T3 home to be found, so the revoke uses that home's CLI.
		monitor
			.located()
			.then(() => tokens.discard(monitor.location, "operate"))
			.then((had) => had && log("thread actions are off: revoked the actions token"))
			.catch((error: unknown) => log(`couldn't revoke the actions token: ${describe(error)}`));
	}
	lastActions = actions;
	deck.animation = settings.animation === "off" ? "off" : "smooth";
	deck.showLabels = settings.showLabels === true;
	deck.actionsEnabled = actions;
	deck.messages = typeof settings.messages === "string" ? settings.messages : undefined;
}

streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => applyGlobal(ev.settings));

streamDeck.actions.registerAction(new ThreadKey());
streamDeck.actions.registerAction(new OverviewKey());
streamDeck.actions.registerAction(new UsageKey());
streamDeck.actions.registerAction(new BackKey());
streamDeck.actions.registerAction(new ThreadActionKey());

await streamDeck.connect();
applyGlobal(await streamDeck.settings.getGlobalSettings<GlobalSettings>());
monitor.start();
await monitor.located().catch((error: unknown) => log(`finding T3 home failed: ${describe(error)}`))
shell.start();
context.start();
usage.start();
