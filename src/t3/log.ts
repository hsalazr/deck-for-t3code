/**
 * Log hygiene: nothing that looks like a token reaches the plugin's log files.
 */

/** Any run of 32+ base64url or hex characters: bearer tokens, tickets, session secrets. */
const TOKEN_LIKE = /[A-Za-z0-9_-]{32,}/g;

export const REDACTED = "[redacted]";

export function redact(text: string): string {
	return text.replace(TOKEN_LIKE, REDACTED);
}

/** One log argument, made safe: strings and errors redacted, objects stringified then redacted. */
export function redactValue(value: unknown): unknown {
	if (typeof value === "string") return redact(value);
	if (value instanceof Error) {
		const safe = new Error(redact(value.message));
		safe.name = value.name;
		safe.stack = redact(value.stack ?? `${value.name}: ${value.message}`);
		return safe;
	}
	if (value !== null && typeof value === "object") {
		try {
			return redact(JSON.stringify(value));
		} catch {
			return redact(String(value));
		}
	}
	return value;
}

/** Human-readable text for anything thrown. */
export function describe(error: unknown): string {
	if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
	try {
		return typeof error === "string" ? error : JSON.stringify(error);
	} catch {
		return String(error);
	}
}

interface LogEntryLike {
	data: unknown[];
}

/**
 * Wraps a logger's `write` so every entry is redacted, whoever logs it
 * (the plugin, the deck, or the Stream Deck SDK on an uncaught exception).
 */
export function redactLogger<L extends { write(entry: never): unknown }>(logger: L): L {
	const write = logger.write.bind(logger) as (entry: LogEntryLike) => unknown;
	(logger as unknown as { write: (entry: LogEntryLike) => unknown }).write = (entry: LogEntryLike) =>
		write({ ...entry, data: Array.isArray(entry.data) ? entry.data.map(redactValue) : entry.data });
	return logger;
}

/** Identical messages from one source are logged once per this long. */
export const REPEAT_WINDOW_MS = 10 * 60_000;

/**
 * Collapses repeats: while T3 is closed the shell stream and the usage monitor
 * each report the same failure every ~30 s. The first occurrence is logged, identical
 * (redacted) messages from the same source are then dropped for `windowMs`,
 * and the next one after that is logged once with how many were dropped.
 */
export function collapseRepeats(
	write: (line: string) => void,
	opts: { windowMs?: number; now?: () => number } = {},
): (source: string, message: string) => void {
	const windowMs = opts.windowMs ?? REPEAT_WINDOW_MS;
	const now = opts.now ?? Date.now;
	const seen = new Map<string, { since: number; dropped: number }>();
	return (source, message) => {
		const line = redact(message);
		const key = `${source}\u0000${line}`;
		const t = now();
		const entry = seen.get(key);
		if (entry && t - entry.since < windowMs) {
			entry.dropped++;
			return;
		}
		seen.set(key, { since: t, dropped: 0 });
		write(entry && entry.dropped > 0 ? `${line} (repeated ${entry.dropped} times)` : line);
		if (seen.size > 200) for (const [k, e] of seen) if (t - e.since >= windowMs) seen.delete(k);
	};
}
