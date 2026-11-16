/**
 * Scheduled tasks for the Scheduled key: parsing what T3 Code's
 * `scheduledTasks.subscribe` stream sends, picking the task a key shows, and
 * the wording and timing maths. Pure; the stream itself lives in
 * t3/scheduled-monitor.ts.
 *
 * Everything here comes from T3's schema (`ScheduledTask` in its contracts),
 * not from observed data, so every field except the id is treated as optional.
 * The task's prompt is never read: it can hold anything the user typed, and
 * nothing on a key needs it.
 */

export type ScheduleKind = "interval" | "fixed_time" | "once" | "webhook" | "unknown";

export interface TaskSchedule {
	kind: ScheduleKind;
	/** Interval schedules: the gap between runs. */
	everyMs?: number;
	/** Fixed-time schedules: local "HH:MM". */
	timeOfDay?: string;
	/** Fixed-time schedules: 0 = Sunday … 6 = Saturday. Empty or absent = every day. */
	weekdays?: number[];
}

/** "unknown" covers a status this plugin doesn't know (a newer T3) or a missing one. */
export type RunStatus = "never" | "running" | "succeeded" | "failed" | "unknown";

export interface ScheduledTask {
	id: string;
	title: string;
	enabled: boolean;
	schedule: TaskSchedule;
	/** The thread runs are posted into; null while each run starts its own. */
	threadId: string | null;
	nextRunAt: number | null;
	lastRunAt: number | null;
	lastRunStatus: RunStatus;
	/** T3 says a managed policy stops this task (today: webhook tasks). The reason text is never shown. */
	blocked: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const ms = (v: unknown): number | null => {
	if (typeof v !== "string" || !v) return null;
	const t = Date.parse(v);
	return Number.isFinite(t) ? t : null;
};

export const DEFAULT_TITLE = "Scheduled task";
const STATUSES: ReadonlySet<string> = new Set(["never", "running", "succeeded", "failed"]);

function parseSchedule(raw: unknown): TaskSchedule {
	if (!isObject(raw)) return { kind: "unknown" };
	switch (raw.type) {
		case "interval":
			return typeof raw.everyMs === "number" && Number.isFinite(raw.everyMs) && raw.everyMs > 0 ? { kind: "interval", everyMs: raw.everyMs } : { kind: "interval" };
		case "fixed_time": {
			const time = typeof raw.timeOfDay === "string" ? /^(\d{1,2}):(\d{2})$/.exec(raw.timeOfDay.trim()) : null;
			const schedule: TaskSchedule = { kind: "fixed_time" };
			if (time && Number(time[1]) < 24 && Number(time[2]) < 60) schedule.timeOfDay = `${time[1]!.padStart(2, "0")}:${time[2]}`;
			if (Array.isArray(raw.weekdays)) {
				const days = raw.weekdays.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6);
				schedule.weekdays = [...new Set(days)].sort((a, b) => a - b);
			}
			return schedule;
		}
		case "once":
			return { kind: "once" };
		case "webhook":
			return { kind: "webhook" };
		default:
			return { kind: "unknown" };
	}
}

/** One task from the stream, or null when it has no usable id. */
export function parseTask(raw: unknown): ScheduledTask | null {
	if (!isObject(raw)) return null;
	const id = str(raw.id);
	if (!id) return null;
	const status = typeof raw.lastRunStatus === "string" && STATUSES.has(raw.lastRunStatus) ? (raw.lastRunStatus as RunStatus) : "unknown";
	return {
		id,
		title: str(raw.title)?.trim() ?? DEFAULT_TITLE,
		// T3 always sends it; a missing flag is more likely a newer shape than a paused task.
		enabled: raw.enabled !== false,
		schedule: parseSchedule(raw.schedule),
		threadId: str(raw.threadId),
		nextRunAt: ms(raw.nextRunAt),
		lastRunAt: ms(raw.lastRunAt),
		lastRunStatus: status,
		// `blockedByPolicy` is the reason text; any string at all means blocked.
		blocked: typeof raw.blockedByPolicy === "string" && raw.blockedByPolicy !== "",
	};
}

/**
 * One stream item, `{ tasks: [...] }`: the whole list, not a change. Null when
 * the item isn't a list at all, so a malformed item never wipes a good list;
 * entries without an id are dropped.
 */
export function parseTaskList(item: unknown): ScheduledTask[] | null {
	if (!isObject(item) || !Array.isArray(item.tasks)) return null;
	const out: ScheduledTask[] = [];
	const seen = new Set<string>();
	for (const raw of item.tasks) {
		const task = parseTask(raw);
		if (!task || seen.has(task.id)) continue;
		seen.add(task.id);
		out.push(task);
	}
	return out;
}

/** What the monitor knows. `live`: a list arrived on the open stream. Anything else carries no tasks. */
export interface ScheduledSnapshot {
	state: "loading" | "live" | "down";
	tasks: ScheduledTask[];
}

export const LOADING: ScheduledSnapshot = { state: "loading", tasks: [] };

export type TaskPick = { task: ScheduledTask } | { task: undefined; reason: "none" | "missing" };

/**
 * The task a key shows. A saved id must still exist ("missing" otherwise, so a
 * deleted task isn't silently swapped for another). With none saved, "whichever
 * runs next": the soonest `nextRunAt` among enabled tasks that aren't blocked;
 * with no upcoming run (all webhook, paused or finished) a running task, then
 * the first enabled one, then the first by title.
 */
export function pickTask(tasks: readonly ScheduledTask[], id: string | undefined): TaskPick {
	if (tasks.length === 0) return { task: undefined, reason: "none" };
	if (id) {
		const found = tasks.find((t) => t.id === id);
		return found ? { task: found } : { task: undefined, reason: "missing" };
	}
	const upcoming = tasks.filter((t) => t.enabled && !t.blocked && t.nextRunAt !== null).sort((a, b) => a.nextRunAt! - b.nextRunAt! || a.id.localeCompare(b.id));
	if (upcoming[0]) return { task: upcoming[0] };
	const byTitle = [...tasks].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
	return { task: byTitle.find((t) => t.lastRunStatus === "running") ?? byTitle.find((t) => t.enabled && !t.blocked) ?? byTitle[0]! };
}

/** Whether "run now" makes sense: T3 refuses webhook tasks, and a task already running can't start twice. */
export const canRunNow = (t: ScheduledTask): boolean => t.schedule.kind !== "webhook" && t.lastRunStatus !== "running";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "every 2h", "every 90m", "daily 09:00", "weekdays 09:00", "Mon Wed 09:00", "once", "webhook". */
export function scheduleText(schedule: TaskSchedule): string {
	switch (schedule.kind) {
		case "interval": {
			if (!schedule.everyMs) return "repeats";
			const mins = Math.round(schedule.everyMs / 60_000);
			if (schedule.everyMs < 60_000) return `every ${Math.max(1, Math.round(schedule.everyMs / 1000))}s`;
			if (mins < 60) return `every ${mins}m`;
			if (mins % 1440 === 0) return `every ${mins / 1440}d`;
			if (mins % 60 === 0) return `every ${mins / 60}h`;
			return `every ${Math.floor(mins / 60)}h ${mins % 60}m`;
		}
		case "fixed_time": {
			const days = schedule.weekdays ?? [];
			const time = schedule.timeOfDay ? ` ${schedule.timeOfDay}` : "";
			if (days.length === 0 || days.length === 7) return `daily${time}`;
			if (days.join() === "1,2,3,4,5") return `weekdays${time}`;
			if (days.join() === "0,6") return `weekends${time}`;
			return `${days.map((d) => DAY_NAMES[d]).join(" ")}${time}`;
		}
		case "once":
			return "once";
		case "webhook":
			return "webhook";
		default:
			return "scheduled";
	}
}

/** The countdown on the key: "2h 15m", "<1m", "Due now". Whole minutes, as `formatDuration` counts them. */
export function countdownText(remainingMs: number, format: (ms: number) => string): string {
	if (remainingMs <= 0) return "Due now";
	if (remainingMs < 60_000) return "<1m";
	return format(remainingMs);
}

/** When the countdown's text next changes: the next whole-minute edge, or the due moment inside the last minute. */
export function nextCountdownChange(nextRunAt: number, now: number): number | undefined {
	const remaining = nextRunAt - now;
	if (remaining <= 0) return undefined; // "Due now" holds until T3 reports the next run
	if (remaining < 60_000) return nextRunAt;
	// formatDuration floors to minutes: the text changes the moment fewer whole minutes remain.
	return now + (remaining % 60_000) + 1;
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function agoText(elapsedMs: number): string {
	const e = Math.max(0, elapsedMs);
	if (e < 60_000) return "just now";
	if (e < 3_600_000) return `${Math.floor(e / 60_000)}m ago`;
	if (e < 86_400_000) return `${Math.floor(e / 3_600_000)}h ago`;
	return `${Math.floor(e / 86_400_000)}d ago`;
}

/** When `agoText` next changes. */
export function nextAgoChange(since: number, now: number): number {
	const elapsed = Math.max(0, now - since);
	const unit = elapsed < 3_600_000 ? 60_000 : elapsed < 86_400_000 ? 3_600_000 : 86_400_000;
	return since + (Math.floor(elapsed / unit) + 1) * unit;
}
