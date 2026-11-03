/**
 * Minimal MCP client for T3 Code's streamable-HTTP endpoint (`POST /mcp`).
 * Only what the plugin needs: initialize once, then `tools/call`.
 */
import { PLUGIN_NAME, PLUGIN_VERSION } from "../version.ts";
import { loopbackOrigin } from "./auth.ts";

/** 401/403: the token was revoked or expired. */
export class AuthRejectedError extends Error {}
/** The request never got an answer (server not listening, connection dropped). */
export class UnreachableError extends Error {}
/** The server answered with an HTTP error or something that isn't JSON-RPC. */
export class HttpError extends Error {}
export class ToolError extends Error {}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id?: number;
	result?: { structuredContent?: unknown; content?: { type: string; text?: string }[]; isError?: boolean };
	error?: { code: number; message: string };
}

export class McpClient {
	readonly #endpoint: string;
	readonly #token: string;
	#sessionId: string | undefined;
	#initialized: Promise<void> | undefined;
	#nextId = 1;

	constructor(origin: string, token: string) {
		// Never send the token anywhere but this machine.
		this.#endpoint = new URL("/mcp", loopbackOrigin(origin)).href;
		this.#token = token;
	}

	get token(): string {
		return this.#token;
	}

	/** Ends the server-side MCP session. Fire and forget. */
	close(): void {
		const session = this.#sessionId;
		this.#sessionId = undefined;
		this.#initialized = undefined;
		if (!session) return;
		fetch(this.#endpoint, {
			method: "DELETE",
			headers: { authorization: `Bearer ${this.#token}`, "mcp-session-id": session },
			redirect: "error",
			signal: AbortSignal.timeout(3000),
		})
			.then((res) => res.body?.cancel())
			.catch(() => undefined);
	}

	async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
		await this.#ensureInitialized();
		let response: JsonRpcResponse | undefined;
		try {
			response = await this.#request("tools/call", { name, arguments: args });
		} catch (error) {
			// The server forgot our session (restart): start over once.
			if (!(error instanceof SessionLostError)) throw error;
			this.#initialized = undefined;
			this.#sessionId = undefined;
			await this.#ensureInitialized();
			response = await this.#request("tools/call", { name, arguments: args });
		}
		if (response?.error) throw new ToolError(`${name}: ${response.error.message}`);
		const result = response?.result;
		if (!result) throw new ToolError(`${name}: empty result`);
		const text = result.content?.find((part) => typeof part.text === "string")?.text;
		if (result.isError) throw new ToolError(`${name}: ${text ?? "tool failed"}`);
		if (result.structuredContent !== undefined) return result.structuredContent as T;
		if (text === undefined) throw new ToolError(`${name}: no content`);
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new ToolError(`${name}: result isn't JSON`);
		}
	}

	#ensureInitialized(): Promise<void> {
		this.#initialized ??= (async () => {
			await this.#request("initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
			});
			await this.#request("notifications/initialized", {}, true);
		})().catch((error) => {
			this.#initialized = undefined;
			throw error;
		});
		return this.#initialized;
	}

	async #request(method: string, params: unknown, notification = false): Promise<JsonRpcResponse | undefined> {
		const id = notification ? undefined : this.#nextId++;
		const headers: Record<string, string> = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			authorization: `Bearer ${this.#token}`,
			"mcp-protocol-version": "2025-06-18",
		};
		if (this.#sessionId) headers["mcp-session-id"] = this.#sessionId;

		let res: Response;
		try {
			res = await fetch(this.#endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify({ jsonrpc: "2.0", method, params, ...(id === undefined ? {} : { id }) }),
				redirect: "error",
				signal: AbortSignal.timeout(15_000),
			});
		} catch (error) {
			throw new UnreachableError(`T3 Code server unreachable: ${(error as Error).message}`);
		}
		const session = res.headers.get("mcp-session-id");
		if (session) this.#sessionId = session;

		if (res.status === 401 || res.status === 403) {
			await res.body?.cancel();
			throw new AuthRejectedError(`T3 Code rejected the credential (${res.status})`);
		}
		if (res.status === 404 && this.#sessionId && method !== "initialize") {
			await res.body?.cancel();
			throw new SessionLostError();
		}
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new HttpError(`T3 Code /mcp returned ${res.status}: ${body.slice(0, 200)}`);
		}
		if (notification || res.status === 202) {
			await res.body?.cancel();
			return undefined;
		}
		const contentType = res.headers.get("content-type") ?? "";
		let body: string;
		try {
			body = await res.text();
		} catch (error) {
			throw new UnreachableError(`T3 Code server stopped responding: ${(error as Error).message}`);
		}
		if (contentType.includes("text/event-stream")) return parseSse(body, id);
		try {
			return JSON.parse(body) as JsonRpcResponse;
		} catch {
			throw new HttpError(`T3 Code /mcp answered ${method} with something that isn't JSON`);
		}
	}
}

class SessionLostError extends Error {}

function parseSse(body: string, id: number | undefined): JsonRpcResponse | undefined {
	for (const event of body.split(/\r?\n\r?\n/)) {
		const data = event
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (!data) continue;
		try {
			const message = JSON.parse(data) as JsonRpcResponse;
			if (message.id === id) return message;
		} catch {
			// keep looking
		}
	}
	return undefined;
}
