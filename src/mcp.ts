// Composing helpers for the Kagi MCP proxy.
//
// The Worker is "mostly transparent": initialize / notifications / GET streams
// pass straight through. Only `tools/list` (for curation) and `tools/call` (for
// caching + audit) are intercepted, and any parse failure falls back to a plain
// passthrough — so a Kagi response shape we don't recognize can never break the
// connection.

export type JsonRpc = {
	jsonrpc?: string;
	id?: unknown;
	method?: string;
	params?: { name?: string; arguments?: unknown; [k: string]: unknown };
	result?: any;
	error?: any;
};

// ---- SSE <-> JSON-RPC ------------------------------------------------------
// Kagi answers tools/* as a single SSE frame: `event: message\ndata: {json}\n\n`.
// (notifications come back as 202 application/json.) Read either into an object.

export function extractRpcFromText(text: string, contentType: string | null): JsonRpc | null {
	if ((contentType ?? "").includes("text/event-stream")) {
		const dataLine = text
			.split("\n")
			.map((l) => l.trim())
			.reverse()
			.find((l) => l.startsWith("data:"));
		if (!dataLine) return null;
		try {
			return JSON.parse(dataLine.slice("data:".length).trim());
		} catch {
			return null;
		}
	}
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

// Re-emit an object in Kagi's exact SSE framing so clients see no difference.
export function sseResponse(obj: unknown, status = 200): Response {
	return new Response(`event: message\ndata: ${JSON.stringify(obj)}\n\n`, {
		status,
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache, no-transform",
		},
	});
}

export function parseJsonRpc(bodyText: string | undefined): JsonRpc | undefined {
	if (!bodyText) return undefined;
	try {
		return JSON.parse(bodyText) as JsonRpc;
	} catch {
		return undefined;
	}
}

// ---- Tool curation ---------------------------------------------------------
// Edit these to hide tools or sharpen their descriptions. Empty = expose Kagi's
// tools verbatim (default, fully transparent).

export const HIDDEN_TOOLS = new Set<string>([
	// e.g. "kagi_extract",
]);

export const TOOL_DESCRIPTION_OVERRIDES: Record<string, string> = {
	// e.g. kagi_search_fetch: "Search the web via Kagi. Prefer for current events.",
};

export function curateToolsResult(result: any): any {
	if (!result || !Array.isArray(result.tools)) return result;
	const tools = result.tools
		.filter((t: any) => !HIDDEN_TOOLS.has(t?.name))
		.map((t: any) =>
			t?.name && TOOL_DESCRIPTION_OVERRIDES[t.name]
				? { ...t, description: TOOL_DESCRIPTION_OVERRIDES[t.name] }
				: t,
		);
	return { ...result, tools };
}

// ---- Response caching ------------------------------------------------------
// Only cache read-only tools whose result is deterministic-ish for a TTL.

export const CACHEABLE_TOOLS = new Set<string>(["kagi_search_fetch", "kagi_extract"]);
export const CACHE_TTL_SECONDS = 3600;
const CACHE_PREFIX = "cache:";

export async function cacheKey(toolName: string, args: unknown): Promise<string> {
	const data = new TextEncoder().encode(`${toolName}:${JSON.stringify(args ?? {})}`);
	const buf = await crypto.subtle.digest("SHA-256", data);
	const hex = Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return CACHE_PREFIX + hex;
}

// A tool result is a JSON-RPC `result` object; Kagi signals tool failure with
// `result.isError === true` (still HTTP 200), which we must never cache.
export function isCacheableResult(rpc: JsonRpc | null): boolean {
	return Boolean(rpc && rpc.result && rpc.result.isError !== true && !rpc.error);
}

// ---- Audit -----------------------------------------------------------------
// Structured line → Workers Logs (observability is enabled), queryable in the
// dashboard. Logs metadata only: never the full result payload.

export function audit(entry: Record<string, unknown>): void {
	console.log(`audit ${JSON.stringify(entry)}`);
}
