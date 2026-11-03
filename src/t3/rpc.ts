/**
 * Access to T3 Code's `/ws` RPC socket (Effect RPC, JSON frames), which the
 * T3 UI itself uses. It refuses mcp-client tokens, so this uses the plugin's
 * second read-only credential ("rpc" kind), exchanged for a one-time
 * WebSocket ticket on every connect.
 *
 * Frames: client sends `{_tag:"Request", id, tag, payload, headers:[]}`, must
 * answer each `Chunk` with `{_tag:"Ack", requestId}` (the server waits for it
 * before sending more) and `Ping` with `Pong`. A request ends with `Exit`.
 */
import { randomUUID } from "node:crypto";

import { ActionsDisabledError, defaultTokens, loopbackOrigin, readServerOrigin, T3Error, type CredentialKind, type T3Location, type TokenStore } from "./auth.ts";

export class RpcAuthError extends Error {}

const TICKET_TIMEOUT_MS = 15_000;

/** Shared by everything that talks to /ws with one kind of token. */
export class RpcAccess {
	readonly location: () => T3Location;
	readonly kind: CredentialKind;
	readonly tokens: TokenStore;

	constructor(location: () => T3Location, kind: CredentialKind = "rpc", opts: { tokens?: TokenStore } = {}) {
		this.location = location;
		this.kind = kind;
		this.tokens = opts.tokens ?? defaultTokens;
	}

	/**
	 * Opens an authenticated socket. When T3 rejects the token, first reloads
	 * the credential file (another component may have just minted), then mints.
	 */
	async open(): Promise<WebSocket> {
		if (this.kind === "operate" && !this.tokens.actionsEnabled) throw new ActionsDisabledError();
		const loc = this.location();
		const origin = await readServerOrigin(loc);
		const ticket = await this.tokens.withToken(
			loc,
			origin,
			this.kind,
			(token) => this.#ticket(origin, token),
			(error) => error instanceof RpcAuthError,
		);
		const url = new URL("/ws", origin);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		url.searchParams.set("orchestrationProtocol", "2");
		url.searchParams.set("wsTicket", ticket);
		return new WebSocket(url.href);
	}

	async #ticket(origin: string, token: string): Promise<string> {
		let res: Response;
		try {
			res = await fetch(new URL("/api/auth/websocket-ticket", loopbackOrigin(origin)), {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: "{}",
				redirect: "error",
				signal: AbortSignal.timeout(TICKET_TIMEOUT_MS),
			});
		} catch (error) {
			throw new T3Error("not-running", `T3 Code unreachable: ${(error as Error).message}`);
		}
		if (res.status === 401 || res.status === 403) {
			await res.body?.cancel();
			throw new RpcAuthError(`T3 Code rejected the ${this.kind} credential (${res.status})`);
		}
		if (!res.ok) {
			await res.body?.cancel();
			throw new T3Error("server-error", `websocket-ticket returned ${res.status}`);
		}
		let ticket: unknown;
		try {
			ticket = ((await res.json()) as { ticket?: unknown } | null)?.ticket;
		} catch {
			throw new T3Error("server-error", "websocket-ticket answered with something that isn't JSON");
		}
		if (typeof ticket !== "string" || !ticket) throw new T3Error("server-error", "websocket-ticket returned no ticket");
		return ticket;
	}
}

export interface RpcFrame {
	_tag?: string;
	requestId?: string;
	values?: unknown[];
	exit?: { _tag: string; value?: unknown; cause?: unknown };
}

/** Parses a frame and answers the protocol chatter (Ping, Chunk acks). Null for anything that isn't a frame object. */
export function handleFrame(ws: Pick<WebSocket, "send">, data: unknown): RpcFrame | null {
	let frame: unknown;
	try {
		frame = JSON.parse(String(data));
	} catch {
		return null;
	}
	if (!frame || typeof frame !== "object" || Array.isArray(frame)) return null;
	const f = frame as RpcFrame;
	if (f._tag === "Ping") {
		ws.send(JSON.stringify({ _tag: "Pong" }));
		return null;
	}
	if (f._tag === "Chunk" && typeof f.requestId === "string") ws.send(JSON.stringify({ _tag: "Ack", requestId: f.requestId }));
	return f;
}

export const request = (id: string, tag: string, payload: unknown): string =>
	JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] });

/** Closes a socket, whatever state it is in. */
export function closeQuietly(ws: WebSocket | undefined): void {
	try {
		ws?.close();
	} catch {
		// already closed
	}
}

/**
 * One orchestration command, the way T3's UI sends it
 * (`orchestration.dispatchCommand`). Needs an "operate" RpcAccess.
 */
export async function dispatch(access: RpcAccess, command: Record<string, unknown>): Promise<void> {
	const ws = await access.open();
	const payload = { commandId: randomUUID(), ...command };
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error(`${String(command.type)} timed out`)), 15_000);
		let done = false;
		function finish(error: Error | null): void {
			if (done) return;
			done = true;
			clearTimeout(timer);
			closeQuietly(ws);
			if (error) reject(error);
			else resolve();
		}
		ws.onopen = () => {
			try {
				ws.send(request("1", "orchestration.dispatchCommand", payload));
			} catch (error) {
				finish(error as Error);
			}
		};
		ws.onmessage = (event) => {
			try {
				const frame = handleFrame(ws, event.data);
				if (frame?._tag !== "Exit" || frame.requestId !== "1") return;
				if (frame.exit?._tag === "Success") finish(null);
				else finish(new Error(commandError(frame.exit?.cause) ?? `${String(command.type)} failed`));
			} catch (error) {
				finish(error as Error);
			}
		};
		ws.onerror = () => finish(new Error("T3 Code WebSocket error"));
		ws.onclose = (event) => finish(new Error(`socket closed (${event.code})`));
	});
}

function commandError(cause: unknown): string | undefined {
	const first = Array.isArray(cause) ? cause[0] : cause;
	const message = (first as { error?: { message?: unknown } } | undefined)?.error?.message;
	return typeof message === "string" ? message : undefined;
}
