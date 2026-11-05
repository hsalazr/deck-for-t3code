/**
 * Pure thread model: turns T3 Code's flat thread list into one "card" per
 * top-level thread, folding every subagent (and their subagents) into the
 * root thread's status. No Stream Deck or network code lives here.
 */

export type T3Status =
	| "idle"
	| "preparing"
	| "queued"
	| "starting"
	| "running"
	| "waiting"
	| "completed"
	| "interrupted"
	| "failed"
	| "cancelled"
	| "rolled_back";

/** The subset of `t3_thread_list` fields the plugin uses. */
export interface ThreadSummary {
	threadId: string;
	projectId: string;
	title: string;
	link: string;
	status: T3Status | string;
	latestRunId: string | null;
	parentThreadId: string | null;
	relationshipToParent: string | null;
	settled: boolean;
	snoozed: boolean;
	model?: string;
	providerInstanceId?: string;
	itemCount?: number;
	createdAt: string;
	updatedAt: string;
	/** Set by the plugin for threads in a linked environment (another machine); absent for this machine's. */
	environmentId?: string;
}

/**
 * What a key shows, most urgent first.
 * - `input`: the thread (or one of its subagents) is blocked on the user.
 * - `failed`: the latest run failed and nobody has looked yet.
 * - `done`: a run finished while we were watching and nobody has looked yet.
 * - `working`: the thread or any subagent is running.
 * - `idle`: nothing to do.
 */
export type CardState = "input" | "failed" | "done" | "working" | "paused" | "idle";

export const STATE_RANK: Record<CardState, number> = { input: 0, failed: 1, done: 2, working: 3, paused: 4, idle: 5 };

export interface ThreadCard {
	threadId: string;
	projectId: string;
	title: string;
	link: string;
	state: CardState;
	/** The root thread's own T3 status. */
	ownStatus: string;
	/** Active subagents folded into this card. */
	subagentsWorking: number;
	subagentsWaiting: number;
	/** Background tasks the thread waits on (subagents, commands, monitors, PR watches). */
	background: number;
	/** True when the `input` state comes from a subagent rather than the root. */
	inputFromSubagent: boolean;
	/** What it waits on when only background work runs: "PR #42 CI", "2 agents"… */
	waitingOn?: string;
	/** Paused by a usage limit until this time. */
	pausedUntil?: number;
	/** The running turn, if any (for Stop). */
	activeRunId?: string;
	/** Context window fill of the active session. */
	context?: { used: number; max: number };
	/** Changes whenever a new run finishes; used to acknowledge done/failed. */
	ackKey: string;
	updatedAt: number;
	createdAt: number;
	/** The linked environment (another machine) the thread lives in; absent for this machine's threads. */
	environmentId?: string;
}

const WORKING = new Set(["preparing", "queued", "starting", "running"]);
export const ACTIVE_STATUSES: T3Status[] = ["preparing", "queued", "starting", "running", "waiting"];

export const isWorking = (status: string): boolean => WORKING.has(status);
export const isWaiting = (status: string): boolean => status === "waiting";
export const isActive = (status: string): boolean => WORKING.has(status) || status === "waiting";

export const ackKeyOf = (t: ThreadSummary): string => `${t.latestRunId ?? "none"}|${t.status}`;

/** Walks `parentThreadId` up to the topmost known ancestor. */
export function rootOf(id: string, byId: ReadonlyMap<string, ThreadSummary>): string {
	let current = id;
	const seen = new Set<string>();
	for (;;) {
		const thread = byId.get(current);
		const parent = thread?.parentThreadId;
		if (!parent || seen.has(parent)) return current;
		seen.add(current);
		if (!byId.has(parent)) return current; // parent not loaded: this is as high as we can go
		current = parent;
	}
}

export interface BuildOptions {
	/**
	 * done/failed only light up for runs whose ack key differs from the one
	 * recorded here. The monitor seeds this on first sight of a thread, so
	 * runs that finished before the plugin started never flash.
	 */
	acked: ReadonlyMap<string, string>;
	/** Flash when a run completes. */
	flashOnDone: boolean;
	/** Flash when a run fails. */
	flashOnFailed: boolean;
	/**
	 * Root thread id → background tasks T3 says it is waiting on after its
	 * turn ended: subagents, background commands, monitors, PR watches.
	 * (Claude's native subagents always report "idle" on their own thread.)
	 */
	background?: ReadonlyMap<string, number>;
	/**
	 * Roots whose background subagents finished moments ago. They stay
	 * "working" briefly, because the main agent usually starts its next turn
	 * right after, and a DONE flash in between would be noise.
	 */
	subagentGrace?: ReadonlySet<string>;
}

/**
 * Folds subagents into their root thread. A subagent whose parent is not in
 * `threads` becomes a root itself, so its activity is never hidden.
 */
export function buildCards(threads: readonly ThreadSummary[], opts: BuildOptions): Map<string, ThreadCard> {
	const byId = new Map(threads.map((t) => [t.threadId, t] as const));
	const cards = new Map<string, ThreadCard>();
	const isRoot = (t: ThreadSummary): boolean => rootOf(t.threadId, byId) === t.threadId;

	// Roots first, so subagents always find their card.
	for (const t of threads) {
		if (!isRoot(t)) continue;
		cards.set(t.threadId, {
			threadId: t.threadId,
			projectId: t.projectId,
			title: t.title || "Untitled thread",
			link: t.link,
			...(t.environmentId ? { environmentId: t.environmentId } : {}),
			state: ownState(t, opts),
			ownStatus: t.status,
			subagentsWorking: 0,
			subagentsWaiting: 0,
			background: 0,
			inputFromSubagent: false,
			ackKey: ackKeyOf(t),
			updatedAt: Date.parse(t.updatedAt) || 0,
			createdAt: Date.parse(t.createdAt) || 0,
		});
	}

	// Background work. A root that finished its turn while it waits on
	// subagents, commands, monitors or PR watches is still busy: working, not done.
	for (const [rootId, n] of opts.background ?? []) {
		const card = cards.get(rootId);
		if (!card || n <= 0) continue;
		card.background += n;
		if (card.state === "done" || card.state === "idle") card.state = "working";
	}
	for (const rootId of opts.subagentGrace ?? []) {
		const card = cards.get(rootId);
		if (card && (card.state === "done" || card.state === "idle")) card.state = "working";
	}

	for (const t of threads) {
		if (isRoot(t)) continue;
		const card = cards.get(rootOf(t.threadId, byId));
		if (!card) continue;
		const updated = Date.parse(t.updatedAt) || 0;
		if (updated > card.updatedAt) card.updatedAt = updated;
		if (isWaiting(t.status)) {
			card.subagentsWaiting++;
			if (STATE_RANK.input < STATE_RANK[card.state]) {
				card.state = "input";
				card.inputFromSubagent = true;
			}
		} else if (isWorking(t.status)) {
			card.subagentsWorking++;
			if (STATE_RANK.working < STATE_RANK[card.state]) card.state = "working";
		}
	}
	// A root that finished its own turn while its subagents (e.g. delegated
	// tasks) still run isn't done yet: it stays working until they finish.
	for (const card of cards.values()) {
		if (card.state === "done" && card.subagentsWorking > 0) card.state = "working";
	}
	return cards;
}

function ownState(t: ThreadSummary, opts: BuildOptions): CardState {
	if (isWaiting(t.status)) return "input";
	if (isWorking(t.status)) return "working";
	const unseen = opts.acked.get(t.threadId) !== ackKeyOf(t);
	if (t.status === "failed" && opts.flashOnFailed && unseen) return "failed";
	if (t.status === "completed" && opts.flashOnDone && unseen) return "done";
	return "idle";
}

/**
 * Did you open the thread after its run ended? When a run finishes while the
 * thread is on screen, T3 marks it visited *at the completion time*
 * (`markThreadVisited(thread, latestRun.completedAt)`), which only means it
 * was open as it ended. That doesn't count; a visit after that does.
 */
export function seenAfterRun(lastVisitedAt: number | null, completedAt: number | null): boolean {
	return lastVisitedAt !== null && completedAt !== null && lastVisitedAt > completedAt + 1000;
}

export const needsAttention = (s: CardState): boolean => s === "input" || s === "failed" || s === "done";

/** Most urgent first, then most recently updated. */
export function byUrgency(a: ThreadCard, b: ThreadCard): number {
	return STATE_RANK[a.state] - STATE_RANK[b.state] || b.updatedAt - a.updatedAt;
}

/**
 * Compact layout for thread keys: threads fill keys from top-left to
 * bottom-right with no gaps. Threads keep their relative order (new ones join
 * at the end), and when one leaves, everything after it slides up.
 *
 * When there are more threads than keys, the most urgent ones get a key;
 * the rest are reported as overflow.
 *
 * @param order previous display order (thread ids); unknown ids are dropped.
 * @returns the new display order, the ids shown (one per key, in order), and the ids that didn't fit.
 */
export function layoutThreads(
	order: readonly string[],
	slotCount: number,
	visible: readonly ThreadCard[],
	previouslyShown: ReadonlySet<string> = new Set(),
): { order: string[]; shown: string[]; overflow: string[] } {
	const byId = new Map(visible.map((c) => [c.threadId, c] as const));
	const kept = order.filter((id) => byId.has(id));
	const known = new Set(kept);
	const added = visible.filter((c) => !known.has(c.threadId)).sort(byUrgency).map((c) => c.threadId);
	const nextOrder = [...kept, ...added];

	if (nextOrder.length <= slotCount) return { order: nextOrder, shown: nextOrder, overflow: [] };

	const winners = new Set(
		nextOrder
			.map((id) => byId.get(id)!)
			// Same urgency: threads already on a key keep it, so keys don't churn every poll.
			.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || Number(previouslyShown.has(b.threadId)) - Number(previouslyShown.has(a.threadId)) || byUrgency(a, b))
			.slice(0, slotCount)
			.map((c) => c.threadId),
	);
	return {
		order: nextOrder,
		shown: nextOrder.filter((id) => winners.has(id)),
		overflow: nextOrder.filter((id) => !winners.has(id)),
	};
}


//** `decodeURIComponent`, or the text as it is when isn't valid percent-encoding. */
const decodeSegment = (text: string): string => {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

/**
 * `t3code://threads/<environment>/<thread>` from a thread link. Accepts the
 * server's http form (`http://host/<env>/<thread>`), the same with a
 * `/threads/` prefix (`http://host/threads/<env>/<thread>`), and the 
 *  agent-facing `<t3-thread://v2/<env>/<thread>>` form. After a leading
 * `threads` segment is dropped, the environment is the segment before the 
 *  thread id, or the first segment when the link doesn't end in the thread id.
 */
export function deepLinkFor(link: string, threadId: string): string | null {
	try {
		const url = new URL(link.trim().replace(/^<|>$/g, ""));
		let parts = url.pathname.split("/").filter(Boolean).map(decodeSegment);
		if (parts[0] === "threads") parts = parts.slice(1);
		const endsInThread = parts.at(-1) === threadId;
		const env = endsInThread ? (parts.length >= 2 ? parts.at(-2) : undefined) : parts[0];
	
		if (!env) return null;
		return `t3code://threads/${encodeURIComponent(env)}/${encodeURIComponent(threadId)}`;
	} catch {
		return null;
	}
}

/** A quick message on the Thread Actions page: what the key shows, and what it sends. */
export interface QuickMessage {
	label: string;
	text: string;
}

/** Neutral defaults; users replace them in the Thread key settings. */
export const DEFAULT_MESSAGES = [
	"continue",
	"summarize where you are",
	"run the tests and report",
	"explain the last change",
	"what's left to do?",
	"write a handoff note",
];

/**
 * One message per line. `Label | full text` shows Label on the key and sends
 * the full text; a line without `|` is both. Blank lines are dropped.
 * `undefined` (never configured) gives the defaults; an empty string gives none.
 */
export function parseQuickMessages(value: string | undefined): QuickMessage[] {
	const lines = value === undefined ? DEFAULT_MESSAGES : value.split(/\r?\n/);
	const messages: QuickMessage[] = [];
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;
		const bar = line.indexOf("|");
		if (bar === -1) {
			messages.push({ label: line, text: line });
			continue;
		}
		const label = line.slice(0, bar).trim();
		const text = line.slice(bar + 1).trim();
		if (!label && !text) continue;
		messages.push({ label: label || text, text: text || label });
	}
	return messages;
}
