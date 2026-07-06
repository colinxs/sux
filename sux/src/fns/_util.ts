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

/** Fetch a URL via the residential proxy (direct fallback) and read it as text. */
export async function fetchText(
	env: RtEnv,
	url: string,
	init?: { method?: string; headers?: Record<string, string>; body?: string; maxBytes?: number },
): Promise<Fetched> {
	const resp = await smartFetch(env, url, { method: init?.method, headers: init?.headers, body: init?.body });
	const text = await resp.text();
	return { status: resp.status, text: init?.maxBytes ? text.slice(0, init.maxBytes) : text, headers: resp.headers, url };
}

/**
 * Resolve the HTML an extract-style fn should operate on: prefer inline `html`,
 * else fetch `url` via the proxy. Returns `{ error }` for the caller to `fail()`.
 */
export async function loadHtml(env: RtEnv, args: any): Promise<{ html: string } | { error: string }> {
	if (typeof args?.html === "string" && args.html) return { html: args.html };
	if (args?.url) {
		if (!isHttpUrl(args.url)) return { error: "url must be an absolute http(s) URL." };
		const fetched = await fetchText(env, String(args.url));
		// An error page is not content — extracting from it would silently succeed
		// with garbage (and get cached). Surface the status instead.
		if (fetched.status >= 400) return { error: `Fetch failed: HTTP ${fetched.status} for ${args.url}` };
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

export const STORE_BASE = "https://sux.colinxs.workers.dev";
export const STORE_KV_PREFIX = "store:";

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
	await env.R2.put(key, bytes, { httpMetadata: { contentType }, customMetadata: { sha256 } });
	const uuid = crypto.randomUUID();
	await env.OAUTH_KV.put(`${STORE_KV_PREFIX}${uuid}`, JSON.stringify({ key, content_type: contentType, size: bytes.length, sha256 }));
	return { uuid, url: `${STORE_BASE}/s/${uuid}`, key, sha256, size: bytes.length, content_type: contentType };
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
