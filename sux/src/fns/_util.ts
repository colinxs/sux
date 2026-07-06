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
