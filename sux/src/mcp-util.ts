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
