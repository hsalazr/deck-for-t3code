import streamDeck, {
	action,
	type DidReceiveSettingsEvent,
	type KeyDownEvent,
	type KeyUpEvent,
	type SendToPluginEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import type { JsonValue } from "@elgato/utils";

import type { Deck, KeyKind, KeySettings } from "./deck.ts";

/** Shared between both actions; set once in plugin.ts. */
export const runtime: { deck?: Deck } = {};

abstract class T3KeyAction extends SingletonAction<KeySettings> {
	protected abstract readonly kind: KeyKind;

	override onWillAppear(ev: WillAppearEvent<KeySettings>): void {
		if (!ev.action.isKey()) return;
		runtime.deck?.add(this.kind, ev.action, ev.payload.settings);
	}

	override onWillDisappear(ev: WillDisappearEvent<KeySettings>): void {
		runtime.deck?.remove(ev.action.id);
	}

	override onKeyDown(ev: KeyDownEvent<KeySettings>): void {
		runtime.deck?.keyDown(ev.action.id);
	}

	override async onKeyUp(ev: KeyUpEvent<KeySettings>): Promise<void> {
		await runtime.deck?.keyUp(ev.action.id);
	}
}

@action({ UUID: "io.github.hsalazr.deck-for-t3code.thread" })
export class ThreadKey extends T3KeyAction {
	protected readonly kind = "thread";
}

@action({ UUID: "io.github.hsalazr.deck-for-t3code.overview" })
export class OverviewKey extends T3KeyAction {
	protected readonly kind = "overview";
}

/** Top-left key of the bundled T3 Threads page: back to the previous profile. */
@action({ UUID: "io.github.hsalazr.deck-for-t3code.back" })
export class BackKey extends T3KeyAction {
	protected readonly kind = "back";
}

/** Keys of the bundled Thread Actions page; their settings name the action. */
@action({ UUID: "io.github.hsalazr.deck-for-t3code.thread-action" })
export class ThreadActionKey extends T3KeyAction {
	protected readonly kind = "action";
}

@action({ UUID: "io.github.hsalazr.deck-for-t3code.usage" })
export class UsageKey extends T3KeyAction {
	protected readonly kind = "usage";

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<KeySettings>): void {
		runtime.deck?.updateSettings(ev.action.id, ev.payload.settings);
	}

	/** The property inspector asks which limit windows exist, to fill its picker. */
	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, KeySettings>): Promise<void> {
		if ((ev.payload as { type?: string } | null)?.type !== "listMetrics" || !runtime.deck) return;
		await streamDeck.ui.sendToPropertyInspector({ type: "metrics", metrics: runtime.deck.usageMetrics() });
	}
}
