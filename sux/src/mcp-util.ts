import { idempotencyKey } from "@suxos/lib";
import { packForCache } from "./cache-codec";

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

// Stale-while-revalidate grace window. An entry's SOFT TTL is the fn's intended
// freshness lifetime (fn.ttl or CACHE_TTL_SECONDS); the KV HARD TTL (when the entry
// is evicted) extends that by this grace so a request landing after soft-expiry —
// but before hard-expiry — can be served the stale value IMMEDIATELY while a
// background refresh recomputes and rewrites the entry. The soft-expiry instant
// rides in KV metadata (see CacheMeta), leaving the stored value byte-identical.
export const CACHE_STALE_GRACE_SECONDS = 86_400;

// Metadata stored alongside a cache value. `softExpiresAt` is an epoch-ms instant:
// at/after it, the entry is stale (serve + refresh); before it, fresh (serve as-is).
// Legacy entries written before SWR carry no metadata and read back as fresh.
export type CacheMeta = { softExpiresAt: number };

// Canonical-JSON + hashing delegated to @suxos/lib's idempotencyKey (#1104) — it's a strict
// superset of the hand-rolled stableStringify this used to carry (Date special-cased instead
// of collapsed to {}, cycle detection instead of a stack overflow).
export async function cacheKey(toolName: string, args: unknown): Promise<string> {
	return `cache:${await idempotencyKey(toolName, args ?? {})}`;
}

// Write side of the KV cache used by index.ts tools/call. Three invariants:
// - error and noCache results (e.g. upstream 4xx/5xx bodies) are returned to the
//   caller but never cached — caching those poisons repeat calls for an hour;
// - the internal noCache flag is always stripped so it never leaks into the MCP
//   response (and never into the stored value); the caller returns the cleaned
//   result this fn hands back rather than the raw one it passed in;
// - the write itself happens off the response path via ctx.waitUntil (same
//   pattern as recordCall — a KV put costs tens of ms and the caller shouldn't
//   wait for it), and a failed put is swallowed: caching is best-effort.
// The optional ttl lets a fn override the global lifetime (registry Fn.ttl);
// an unset/invalid ttl falls back to CACHE_TTL_SECONDS, so callers that don't
// pass one keep the existing behavior.
//
// Cacheability is decided from — and noCache stripped into — a fresh object, so
// the input `result` is never mutated. Under single-flight coalescing, one run
// result is shared by every coalesced caller and each caller runs this write
// path once; mutating that shared object (the old `delete result.noCache`) let
// the first caller's strip flip a later caller's noCache check to cacheable and
// poison an upstream 4xx/5xx body into the cache as a success. Cloning keeps the
// decision identical for all callers and the flag out of both value and response.
export function deferCacheWrite(
	kv: { put: (key: string, value: string | ArrayBufferView | ArrayBuffer, opts: { expirationTtl: number; metadata?: CacheMeta }) => Promise<unknown> },
	ctx: { waitUntil: (promise: Promise<unknown>) => void },
	key: string | null,
	result: { isError?: boolean; noCache?: boolean; [k: string]: unknown },
	ttl?: number,
): { isError?: boolean; [k: string]: unknown } {
	const cacheable = key && !result.isError && !result.noCache;
	const { noCache, ...clean } = result;
	void noCache;
	// Soft TTL = the fn's intended freshness lifetime; the KV hard TTL extends it by
	// the stale grace window so an entry past soft-expiry stays alive to be served
	// stale (with a background refresh) instead of missing outright. The soft-expiry
	// instant is written as KV metadata — NOT into the value — so the stored value
	// stays byte-identical and legacy (metadata-less) entries read back as fresh.
	const softTtl = typeof ttl === "number" && ttl > 0 ? ttl : CACHE_TTL_SECONDS;
	const expirationTtl = softTtl + CACHE_STALE_GRACE_SECONDS;
	const metadata: CacheMeta = { softExpiresAt: Date.now() + softTtl * 1000 };
	// packForCache transparently compresses large JSON payloads (zstd→brotli) and
	// returns the plain string for small ones; index.ts reverses it on read.
	if (cacheable) ctx.waitUntil(kv.put(key, packForCache(JSON.stringify(clean)), { expirationTtl, metadata }).catch(() => {}));
	return clean;
}
