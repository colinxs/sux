// Shared helpers for the function library. Keep this tiny and dependency-free —
// it is imported by many fns, so a bug here is a bug everywhere. Web-standard
// APIs only (they run identically in Workers and in vitest/node).

import type { RtEnv } from "../registry";
import { smartFetch } from "../proxy";

/** True for an absolute http(s) URL. */
export function isHttpUrl(u: unknown): u is string {
	return typeof u === "string" && /^https?:\/\//i.test(u);
}

/** Truncate a string, appending a byte-count marker when it was cut. */
export function clamp(s: string, maxBytes = 100_000): string {
	return s.length > maxBytes ? `${s.slice(0, maxBytes)}\n… [truncated at ${maxBytes} bytes]` : s;
}

/** base64 of raw bytes (chunked so large inputs don't blow the call stack). */
export function toB64(bytes: Uint8Array): string {
	let s = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	return btoa(s);
}

/** raw bytes from a base64 string. */
export function fromB64(b64: string): Uint8Array {
	const bin = atob(b64.trim());
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export type Fetched = { status: number; text: string; headers: Headers; url: string };

/** Default byte cap for text fetches — generous enough that full-body consumers
 * (feeds, sitemaps) aren't silently truncated, small enough to bound memory. */
export const FETCH_TEXT_MAX_BYTES = 2_000_000;

/** Read a response body as text, streaming, and cancel the stream once
 * `maxBytes` have been consumed — so a huge body is never fully buffered. */
async function readBodyText(resp: Response, maxBytes: number): Promise<string> {
	if (!resp.body) return (await resp.text()).slice(0, maxBytes);
	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let out = "";
	let consumed = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		const keep = Math.min(value.byteLength, maxBytes - consumed);
		consumed += value.byteLength;
		out += decoder.decode(keep === value.byteLength ? value : value.subarray(0, keep), { stream: true });
		if (consumed >= maxBytes) {
			// Truncated: drop (don't flush) a multi-byte char cut at the boundary.
			await reader.cancel().catch(() => {});
			return out;
		}
	}
	return out + decoder.decode();
}

/**
 * Fetch a URL via the residential proxy (direct fallback) and read it as text.
 * The worker's own /s/<uuid> CAS refs are short-circuited to a direct KV→R2
 * read, so text fns accept blob refs without a network round-trip. Bodies are
 * streamed and capped at `maxBytes` (default 2MB) — the stream is aborted, not
 * buffered, past the cap.
 */
export async function fetchText(
	env: RtEnv,
	url: string,
	init?: { method?: string; headers?: Record<string, string>; body?: string; maxBytes?: number },
): Promise<Fetched> {
	const maxBytes = init?.maxBytes ?? FETCH_TEXT_MAX_BYTES;
	const uuid = storeRefUuid(url);
	if (uuid && env.R2) {
		const blob = await getBlob(env, uuid);
		if (!blob) return { status: 404, text: `No stored object for '${uuid}'.`, headers: new Headers(), url };
		const text = new TextDecoder().decode(blob.bytes);
		return { status: 200, text: text.slice(0, maxBytes), headers: new Headers({ "content-type": blob.contentType }), url };
	}
	const resp = await smartFetch(env, url, { method: init?.method, headers: init?.headers, body: init?.body });
	return { status: resp.status, text: await readBodyText(resp, maxBytes), headers: resp.headers, url };
}

/**
 * THE fetch-validation seam for content-consuming fns: isHttpUrl check, fetch
 * via the proxy, and a unified `{ error }` on both a thrown fetch and an HTTP
 * >= 400 — an error page is not content; parsing/scanning it would silently
 * succeed with garbage (and get cached). Transport fns (proxy/scrape/…)
 * instead return error pages faithfully with noCacheOn4xx.
 */
export async function fetchTextOk(
	env: RtEnv,
	url: unknown,
	init?: { method?: string; headers?: Record<string, string>; body?: string; maxBytes?: number },
): Promise<{ text: string; headers: Headers; status: number } | { error: string }> {
	if (!isHttpUrl(url)) return { error: "url must be an absolute http(s) URL." };
	let fetched: Fetched;
	try {
		fetched = await fetchText(env, url, init);
	} catch (e) {
		return { error: `Fetch failed: ${String((e as Error).message ?? e)}` };
	}
	if (fetched.status >= 400) return { error: `Fetch failed: HTTP ${fetched.status} for ${url}` };
	return { text: fetched.text, headers: fetched.headers, status: fetched.status };
}

/**
 * Transport fns (proxy/geo_fetch/protocol/scrape/batch_fetch) faithfully return
 * error pages too — the raw response IS their content — but a transient
 * 403/429/consent wall must never enter the KV cache, or it poisons repeat
 * calls for an hour. Content-consuming fns instead fail() on >= 400 (see
 * fetchTextOk).
 */
export function noCacheOn4xx<T extends { noCache?: boolean }>(result: T, status: number): T {
	if (status >= 400) result.noCache = true;
	return result;
}

/**
 * Load raw bytes from an inline base64 payload or a URL — THE binary input path,
 * shared by every bytes-consuming fn. URL fetches go through the residential
 * proxy binary-safely (the proxy transports binary bodies base64-encoded, see
 * proxy.ts bodyEncoding), reject HTTP >= 400 consistently, and the worker's own
 * /s/<uuid> CAS refs short-circuit to a direct KV→R2 read. Throws on failure —
 * callers wrap with their own fail() message.
 */
export async function loadBytes(env: RtEnv, src: { url?: string; base64?: string }): Promise<{ bytes: Uint8Array; contentType?: string }> {
	if (typeof src.base64 === "string" && src.base64) return { bytes: fromB64(src.base64) };
	if (!isHttpUrl(src.url)) throw new Error("provide `base64` bytes or an absolute http(s) `url`");
	const url = String(src.url);
	const uuid = storeRefUuid(url);
	if (uuid && env.R2) {
		const blob = await getBlob(env, uuid);
		if (!blob) throw new Error(`No stored object for '${uuid}'.`);
		return blob;
	}
	const resp = await smartFetch(env, url, {});
	if (resp.status >= 400) throw new Error(`Fetch failed: HTTP ${resp.status} for ${url}`);
	return { bytes: new Uint8Array(await resp.arrayBuffer()), contentType: resp.headers.get("content-type") ?? undefined };
}

/**
 * Resolve the HTML an extract-style fn should operate on: prefer inline `html`,
 * else fetch `url` via the proxy. Returns `{ error }` for the caller to `fail()`.
 */
export async function loadHtml(env: RtEnv, args: any, maxBytes?: number): Promise<{ html: string } | { error: string }> {
	if (typeof args?.html === "string" && args.html) return { html: args.html };
	if (args?.url) {
		const fetched = await fetchTextOk(env, args.url, { maxBytes });
		if ("error" in fetched) return { error: fetched.error };
		return { html: fetched.text };
	}
	return { error: "Provide `html` or `url`." };
}

/** Strip tags/scripts/styles to readable plain text. */
export function stripHtml(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

// ---------- Content-addressed blob store (shared with the `store` fn) ----------

export const STORE_KV_PREFIX = "store:";

/**
 * Base URL for public /s/<uuid> handles. Configurable via the STORE_BASE env
 * var (wrangler `vars`) so staging/local deploys mint URLs that point at
 * themselves; falls back to the prod hostname.
 */
export function storeBase(env: RtEnv): string {
	const v = (env as { STORE_BASE?: string }).STORE_BASE;
	return (typeof v === "string" && v ? v : "https://sux.colinxs.workers.dev").replace(/\/+$/, "");
}

/** Accept a bare uuid or a .../s/<uuid> URL and return the uuid (shared with `store`). */
export function extractStoreId(s: string): string {
	const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(s);
	return m ? m[1].toLowerCase() : s.trim();
}

/** The uuid when `u` is a /s/<uuid> CAS handle URL (any host — the path shape is ours), else null. */
export function storeRefUuid(u: unknown): string | null {
	if (!isHttpUrl(u)) return null;
	try {
		const m = /^\/s\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(new URL(u).pathname);
		return m ? m[1].toLowerCase() : null;
	} catch {
		return null;
	}
}

/** Resolve a /s/<uuid> handle to its bytes via KV→R2 directly (no HTTP hop). */
export async function getBlob(env: RtEnv, uuid: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
	if (!env.R2) return null;
	const raw = await env.OAUTH_KV.get(`${STORE_KV_PREFIX}${uuid}`);
	if (!raw) return null;
	const ref = JSON.parse(raw) as { key: string; content_type?: string };
	const obj = await env.R2.get(ref.key);
	if (!obj) return null;
	return { bytes: new Uint8Array(await obj.arrayBuffer()), contentType: ref.content_type ?? obj.httpMetadata?.contentType ?? "application/octet-stream" };
}

export type BlobRef = { uuid: string; url: string; key: string; sha256: string; size: number; content_type: string };

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Content-address bytes into R2 (cas/<sha256> — identical bytes dedupe), mint a
 * uuid handle in KV, and return the public /s/<uuid> URL. The Nix-store move:
 * any fn's binary output becomes a ~100-token reference every other fn can take
 * as a `url` input. Throws when R2 is unbound.
 */
export async function putBlob(env: RtEnv, bytes: Uint8Array, contentType: string): Promise<BlobRef> {
	if (!env.R2) throw new Error("R2 is not available (bucket binding missing).");
	const sha256 = await sha256Hex(bytes);
	const key = `cas/${sha256}`;
	const uuid = crypto.randomUUID();
	// The R2 object and KV handle are independent writes — run them concurrently.
	await Promise.all([
		env.R2.put(key, bytes, { httpMetadata: { contentType }, customMetadata: { sha256 } }),
		env.OAUTH_KV.put(`${STORE_KV_PREFIX}${uuid}`, JSON.stringify({ key, content_type: contentType, size: bytes.length, sha256 })),
	]);
	return { uuid, url: `${storeBase(env)}/s/${uuid}`, key, sha256, size: bytes.length, content_type: contentType };
}

/**
 * Deliver binary output either inline (base64, the default — token-expensive but
 * self-contained) or `as: "url"` via the content-addressed store (~100 tokens,
 * consumable as any other fn's `url` input). Callers pass their own inline shape.
 */
export async function deliverBytes(
	env: RtEnv,
	bytes: Uint8Array,
	contentType: string,
	as: string | undefined,
	inline: () => { content: Array<{ type: "text"; text: string }> },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
	if (as === "url") {
		try {
			const ref = await putBlob(env, bytes, contentType);
			return { content: [{ type: "text", text: JSON.stringify({ url: ref.url, sha256: ref.sha256, size: ref.size, content_type: contentType }, null, 2) }] };
		} catch (e) {
			return { content: [{ type: "text", text: `as:"url" needs the R2 store: ${String((e as Error).message ?? e)}` }], isError: true };
		}
	}
	return inline();
}

/**
 * THE standard inline envelope for binary output: { mime, size (bytes), base64 }.
 * Every binary-output fn's default (non-url) delivery uses this one shape so
 * consumers can parse any of them identically.
 */
export function inlineB64(bytes: Uint8Array, mime: string): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text", text: JSON.stringify({ mime, size: bytes.length, base64: toB64(bytes) }) }] };
}
