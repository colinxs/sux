// Shared helpers for the function library. Keep this tiny and dependency-free —
// it is imported by many fns, so a bug here is a bug everywhere. Web-standard
// APIs only (they run identically in Workers and in vitest/node).
//
// This file is a thin barrel: the scoped concerns (byte/base64 codecs, fan-out
// budget/pool, fetch dedup cache, cache-control mutators, HTML stripping,
// content-addressed store refs) live under ./_util/* (#565) and are re-exported
// below so the ~100 fns importing `from "./_util"` don't need to change. What
// stays HERE is the fetch/render orchestration that genuinely ties those
// concerns together (fetchText, loadBytes, loadHtml, …).

import type { RtEnv } from "../registry";
import { smartFetch } from "../proxy";
import { errMsg, isHttpUrl, oj } from "../prim";
import { storeRefUuid, getBlob } from "./_util/store-ref";
import { fetchDedupActive, fetchCacheGet, fetchCacheSet, FETCH_CACHE_MAX_TEXT } from "./_util/fetch-cache";
import { fromB64 } from "./_util/bytes";

// Re-exported for the ~100 fns that import these alongside the blob-store/registry
// helpers below — the definitions themselves live in ../prim (dependency-free,
// so proxy.ts can import errMsg without a proxy.ts <-> fns/_util.ts cycle, #620).
export { errMsg, isHttpUrl, oj };

export * from "./_util/bytes";
export * from "./_util/fanout";
export * from "./_util/fetch-cache";
export * from "./_util/cache-control";
export * from "./_util/html";
export * from "./_util/store-ref";

// Cloudflare's edge-to-origin error family: the CF edge itself answered, but
// couldn't reach/resolve whatever sits behind it — a dead Tunnel or broken DNS on
// a self-hosted origin, NOT an app-level error from the origin service. Both the
// Mac render bridge and the Obsidian remote-search backend sit behind tunneled
// origins, so a 530 (or its siblings) from either is an availability signal, not
// something a caller can retry its way out of. See #551.
const CF_ORIGIN_UNREACHABLE_STATUSES = new Set([521, 522, 523, 524, 525, 526, 530]);

/** A short hint appended to an error message when `status` is one of Cloudflare's
 * edge-to-origin codes — empty string for any other status. */
export function cfOriginHint(status: number): string {
	return CF_ORIGIN_UNREACHABLE_STATUSES.has(status) ? ` Likely a dead Tunnel, not an app error — check whether it's up.` : "";
}

/** The vault owner's LOCAL calendar day as YYYY-MM-DD (default Pacific). A Worker
 * runs in UTC, so a plain toISOString() date rolls to tomorrow from ~5pm Pacific —
 * wrong for daily-note targeting and capture filenames. en-CA renders ISO order. */
export function vaultToday(tz?: string): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/**
 * Fetch a URL as post-JS HTML via the `render` mac backend (headed browser +
 * CapSolver). The path for sites that gate content behind JS / bot walls
 * (Google, LinkedIn, Google Shopping). Delegates to the render fn through the
 * registry (dynamic import breaks the index.ts→fns cycle); throws on render
 * failure so callers can wrap with their own message. Was triplicated inline.
 */
export async function renderHtml(env: RtEnv, url: string, opts?: { solve?: boolean; wait_ms?: number; backend?: "cf" | "mac" }): Promise<string> {
	const { FUNCTIONS } = (await import("./index")) as { FUNCTIONS: Array<{ name: string; run: (e: RtEnv, a: unknown) => Promise<{ content?: Array<{ text?: string }>; isError?: boolean }> }> };
	const render = FUNCTIONS.find((f) => f.name === "render");
	if (!render) throw new Error("the `render` fn is not available");
	const r = await render.run(env, { url, backend: opts?.backend ?? "mac", as: "html", solve: opts?.solve ?? true, wait_ms: opts?.wait_ms ?? 6000 });
	if (r?.isError) throw new Error(r.content?.[0]?.text ?? "render failed");
	return r.content?.[0]?.text ?? "";
}

export type Fetched = { status: number; text: string; headers: Headers; url: string };

/** Default byte cap for text fetches — generous enough that full-body consumers
 * (feeds, sitemaps) aren't silently truncated, small enough to bound memory. */
export const FETCH_TEXT_MAX_BYTES = 2_000_000;

/** Default byte cap for binary (bytes) fetches — larger than the text cap since
 * binary consumers (pdf, image, ocr) legitimately handle bigger inputs, but still
 * bounded so a hostile/huge remote file can't OOM the isolate. */
export const FETCH_BYTES_MAX_BYTES = 32_000_000;

/** Read a response body as raw bytes, streaming, and abort once `maxBytes` have
 * been consumed — so a huge/hostile body is never fully buffered (the bytes
 * analogue of readBodyText). Rejects up front on an oversized Content-Length and
 * mid-stream once the running total exceeds the cap; throws rather than truncate
 * (a partial binary is not usable input). */
export async function readBodyBytes(resp: Response, maxBytes: number): Promise<Uint8Array> {
	const declared = Number(resp.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Response too large: ${declared} bytes exceeds ${maxBytes}-byte cap`);
	if (!resp.body) {
		const buf = new Uint8Array(await resp.arrayBuffer());
		if (buf.byteLength > maxBytes) throw new Error(`Response too large: ${buf.byteLength} bytes exceeds ${maxBytes}-byte cap`);
		return buf;
	}
	const reader = resp.body.getReader();
	const chunks: Uint8Array[] = [];
	let consumed = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		consumed += value.byteLength;
		if (consumed > maxBytes) {
			await reader.cancel().catch(() => {});
			throw new Error(`Response too large: exceeds ${maxBytes}-byte cap`);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(consumed);
	let off = 0;
	for (const c of chunks) {
		out.set(c, off);
		off += c.byteLength;
	}
	return out;
}

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
	// Dedup GET fetches within the isolate (bodyless, method GET/undefined only —
	// never cache a POST or a request with a body). A hit skips the whole proxy
	// round-trip; a miss populates for the rest of the chain.
	const method = (init?.method ?? "GET").toUpperCase();
	// Fold request headers into the key: a header can select different content for
	// the same URL (e.g. proxy's x-exit-geo, Accept-Language), so a header-blind
	// key would serve one variant's body for another's request.
	const headerSig = init?.headers ? JSON.stringify(init.headers) : "";
	const dedupKey = fetchDedupActive() && method === "GET" && !init?.body ? `${maxBytes}|${headerSig}|${url}` : null;
	if (dedupKey) {
		const hit = fetchCacheGet(dedupKey, Date.now());
		if (hit) return { status: hit.status, text: hit.text, headers: new Headers(hit.headers), url: hit.url };
	}
	const resp = await smartFetch(env, url, { method: init?.method, headers: init?.headers, body: init?.body });
	const text = await readBodyText(resp, maxBytes);
	// Only cache successful, reasonably-sized bodies (never an error page).
	if (dedupKey && resp.status < 400 && text.length <= FETCH_CACHE_MAX_TEXT) {
		fetchCacheSet(dedupKey, { at: Date.now(), status: resp.status, text, headers: Object.fromEntries(resp.headers), url });
	}
	return { status: resp.status, text, headers: resp.headers, url };
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
		return { error: `Fetch failed: ${errMsg(e)}` };
	}
	if (fetched.status >= 400) return { error: `Fetch failed: HTTP ${fetched.status} for ${url}` };
	return { text: fetched.text, headers: fetched.headers, status: fetched.status };
}

// Status codes a bot wall / auth gate typically answers with — the ones where a
// second rung (a JS-executing render) stands a real chance where a raw fetch
// doesn't. NOT the full >=400 range: a genuine 404/500 means the resource isn't
// there, and re-fetching it through the render fn would just burn a Browser Run
// session to relearn the same fact.
const ESCALATABLE_STATUSES = /HTTP (401|403|429) /;

/**
 * `fetchTextOk`, escalating to `render` (cf backend — cheap/fast, no CapSolver)
 * when the raw/residential-proxy fetch comes back blocked. THE extract-family
 * fetch seam (tables/readability/select/metadata/grep/extract_contacts/… via
 * loadHtml): those leaves used to hard-fail on any UA-gated site `render` itself
 * clears fine (e.g. Wikipedia's bare-UA block). GET-only (render only navigates);
 * falls straight back to the original error if the render leg also throws, so a
 * genuinely dead URL fails exactly like fetchTextOk always did.
 */
export async function fetchTextOkEscalating(
	env: RtEnv,
	url: unknown,
	init?: { method?: string; headers?: Record<string, string>; body?: string; maxBytes?: number },
): Promise<{ text: string; headers: Headers; status: number } | { error: string }> {
	const first = await fetchTextOk(env, url, init);
	if (!("error" in first)) return first;
	const method = (init?.method ?? "GET").toUpperCase();
	if (method !== "GET" || !ESCALATABLE_STATUSES.test(first.error)) return first;
	try {
		const html = await renderHtml(env, String(url), { backend: "cf" });
		if (html) return { text: html, headers: new Headers({ "content-type": "text/html" }), status: 200 };
	} catch {
		// render couldn't clear it either — surface the original fetch error below.
	}
	return first;
}

/**
 * Load raw bytes from an inline base64 payload or a URL — THE binary input path,
 * shared by every bytes-consuming fn. URL fetches go through the residential
 * proxy binary-safely (the proxy transports binary bodies base64-encoded, see
 * proxy.ts bodyEncoding), reject HTTP >= 400 consistently, and the worker's own
 * /s/<uuid> CAS refs short-circuit to a direct KV→R2 read. URL bodies are
 * streamed and capped at `maxBytes` (default 32MB) — a huge/hostile remote file
 * is aborted mid-stream, never fully buffered into an OOM. Throws on failure —
 * callers wrap with their own fail() message.
 */
export async function loadBytes(env: RtEnv, src: { url?: string; base64?: string }, maxBytes = FETCH_BYTES_MAX_BYTES): Promise<{ bytes: Uint8Array; contentType?: string }> {
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
	return { bytes: await readBodyBytes(resp, maxBytes), contentType: resp.headers.get("content-type") ?? undefined };
}

/**
 * Resolve the HTML an extract-style fn should operate on: prefer inline `html`,
 * else fetch `url` via the proxy. Returns `{ error }` for the caller to `fail()`.
 */
export async function loadHtml(env: RtEnv, args: any, maxBytes?: number): Promise<{ html: string } | { error: string }> {
	if (typeof args?.html === "string" && args.html) return { html: args.html };
	if (args?.url) {
		const fetched = await fetchTextOkEscalating(env, args.url, { maxBytes });
		if ("error" in fetched) return { error: fetched.error };
		return { html: fetched.text };
	}
	return { error: "Provide `html` or `url`." };
}
