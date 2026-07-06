export type JsonRpc = {
	jsonrpc?: string;
	id?: unknown;
	method?: string;
	params?: { name?: string; arguments?: unknown; [k: string]: unknown };
	result?: any;
	error?: any;
};

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

export function sseResponse(obj: unknown, status = 200): Response {
	return new Response(`event: message\ndata: ${JSON.stringify(obj)}\n\n`, {
		status,
		headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" },
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

export const CACHE_TTL_SECONDS = 3600;

function stableStringify(v: unknown): string {
	if (v === null || typeof v !== "object") return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
	const obj = v as Record<string, unknown>;
	return `{${Object.keys(obj)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
		.join(",")}}`;
}

export async function cacheKey(toolName: string, args: unknown): Promise<string> {
	const data = new TextEncoder().encode(`${toolName}:${stableStringify(args ?? {})}`);
	const buf = await crypto.subtle.digest("SHA-256", data);
	return `cache:${Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")}`;
}

// Write side of the KV cache used by index.ts tools/call. Three invariants:
// - error and noCache results (e.g. upstream 4xx/5xx bodies) are returned to the
//   caller but never cached — caching those poisons repeat calls for an hour;
// - the internal noCache flag is always stripped so it never leaks into the MCP
//   response (and never into the stored value, since the delete precedes the put);
// - the write itself happens off the response path via ctx.waitUntil (same
//   pattern as recordCall — a KV put costs tens of ms and the caller shouldn't
//   wait for it), and a failed put is swallowed: caching is best-effort.
export function deferCacheWrite(
	kv: { put: (key: string, value: string, opts: { expirationTtl: number }) => Promise<unknown> },
	ctx: { waitUntil: (promise: Promise<unknown>) => void },
	key: string | null,
	result: { isError?: boolean; noCache?: boolean; [k: string]: unknown },
): void {
	const cacheable = key && !result.isError && !result.noCache;
	delete result.noCache;
	if (cacheable) ctx.waitUntil(kv.put(key, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS }).catch(() => {}));
}
