/**
 * Thread actions, sent the way T3's own UI sends them
 * (`orchestration.dispatchCommand` with an "operate" credential).
 *
 * They only work while the global setting `actionsEnabled` is on; otherwise
 * every method rejects with `ActionsDisabledError` before any token is
 * minted or loaded.
 */
import { randomUUID } from "node:crypto";

import { ActionsDisabledError } from "./auth.ts";
import { dispatch, type RpcAccess } from "./rpc.ts";

export { ActionsDisabledError };

export class ThreadCommands {
	readonly #access: RpcAccess;
	readonly #enabled: () => boolean;

	/** @param enabled the `actionsEnabled` global setting; defaults to the token store's copy of it. */
	constructor(access: RpcAccess, enabled: () => boolean = () => access.tokens.actionsEnabled) {
		this.#access = access;
		this.#enabled = enabled;
	}

	get enabled(): boolean {
		return this.#enabled();
	}

	/** Interrupts the running turn; queued messages stay queued. */
	stop(threadId: string, runId: string): Promise<void> {
		return this.#dispatch({ type: "run.interrupt", threadId, runId, holdQueue: true });
	}

	snooze(threadId: string, until: Date): Promise<void> {
		return this.#dispatch({ type: "thread.snooze", threadId, snoozedUntil: until.toISOString() });
	}

	settle(threadId: string): Promise<void> {
		return this.#dispatch({ type: "thread.settle", threadId });
	}

	/**
	 * Like typing it in T3's composer: starts an idle thread or steers a running one.
	 * `creationSource` stays "web": T3 accepts web | mobile | mcp | provider | server, and
	 * only user messages from "web" or "mobile" count as the user typing in the UI.
	 */
	send(threadId: string, text: string): Promise<void> {
		return this.#dispatch({
			type: "message.dispatch",
			threadId,
			messageId: randomUUID(),
			text,
			attachments: [],
			createdBy: "user",
			creationSource: "web",
			deliveryIntent: "auto",
			dispatchMode: { type: "start_immediately" },
		});
	}

	async #dispatch(command: Record<string, unknown>): Promise<void> {
		if (!this.#enabled()) throw new ActionsDisabledError();
		await dispatch(this.#access, command);
	}
}

/** Tomorrow at 9:00 local time. */
export function tomorrowAt9(now = new Date()): Date {
	const d = new Date(now);
	d.setDate(d.getDate() + 1);
	d.setHours(9, 0, 0, 0);
	return d;
}
