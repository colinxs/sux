// Shared helpers for the function library. Keep this tiny and dependency-free —
// it is imported by many fns, so a bug here is a bug everywhere. Web-standard
// APIs only (they run identically in Workers and in vitest/node).

import type { RtEnv } from "../registry";
import { smartFetch } from "../proxy";
import { maybeCompress, maybeDecompress } from "./_gzip";

/** An Error/thrown value → its message string (the `catch (e)` idiom every fn shares). */
export const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

/** Compact JSON for LLM-facing fn output — no pretty indentation (a model reads
 * the structure fine and pays for every whitespace token). The one serializer
 * every fn's text envelope goes through; browser-rendered surfaces (observability
 * /metrics,/logs,/feedback) stay pretty-printed and don't use this. */
export const oj = (x: unknown): string => JSON.stringify(x);

/** True for an absolute http(s) URL. */
export function isHttpUrl(u: unknown): u is string {
	return typeof u === "string" && /^https?:\/\//i.test(u);
}

/** The vault owner's LOCAL calendar day as YYYY-MM-DD (default Pacific). A Worker
 * runs in UTC, so a plain toISOString() date rolls to tomorrow from ~5pm Pacific —
 * wrong for daily-note targeting and capture filenames. en-CA renders ISO order. */
export function vaultToday(tz?: string): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** Truncate a string, appending a byte-count marker when it was cut. */
export function clamp(s: string, maxBytes = 100_000): string {
	return s.length > maxBytes ? `${s.slice(0, maxBytes)}\n… [truncated at ${maxBytes} bytes]` : s;
}

/**
 * Fetch a URL as post-JS HTML via the `render` mac backend (headed browser +
 * CapSolver). The path for sites that gate content behind JS / bot walls
 * (Google, LinkedIn, Google Shopping). Delegates to the render fn through the
 * registry (dynamic import breaks the index.ts→fns cycle); throws on render
 * failure so callers can wrap with their own message. Was triplicated inline.
 */
export async function renderHtml(env: RtEnv, url: string, opts?: { solve?: boolean; wait_ms?: number }): Promise<string> {
	const { FUNCTIONS } = (await import("./index")) as { FUNCTIONS: Array<{ name: string; run: (e: RtEnv, a: unknown) => Promise<{ content?: Array<{ text?: string }>; isError?: boolean }> }> };
	const render = FUNCTIONS.find((f) => f.name === "render");
	if (!render) throw new Error("the `render` fn is not available");
	const r = await render.run(env, { url, backend: "mac", as: "html", solve: opts?.solve ?? true, wait_ms: opts?.wait_ms ?? 6000 });
	if (r?.isError) throw new Error(r.content?.[0]?.text ?? "render failed");
	return r.content?.[0]?.text ?? "";
}

// Fan-out time budget. A fn.run is killed by index.ts's FN_DEADLINE_MS (60s) with
// ZERO partials returned — so a wide batch/pipe/batch_fetch that runs long yields
// nothing. Each fan-out site stops DISPATCHING new work at this soft budget (< the
// 60s hard deadline, leaving headroom to reduce + serialize the collected partials)
// and returns what it has, flagged truncated. Kept here so the sites share one number.
export const FANOUT_BUDGET_MS = 50_000;

/** Default self-expiry for the CAS handles a bulk fan-out download mints (put /
 * batch_fetch as:"url"). These are staging artifacts, not durable records — a
 * permanent handle per URL would accrete R2/KV storage forever, so they expire
 * unless the caller overrides. Reach for `store` directly when you want permanence. */
export const FANOUT_STORE_TTL_S = 7 * 24 * 60 * 60;

/** Aggregate in-flight download budget for a SINGLE fan-out run. The per-item cap
 * (MAX_STORE_BYTES) bounds ONE download; CONCURRENCY (8) of them buffered at once
 * would blow the isolate's ~128MB ceiling, so a run shares this budget across its
 * workers via byteBudget(). Sized to admit a few full-size downloads concurrently
 * while leaving isolate headroom. */
export const FANOUT_BYTE_BUDGET = 96 * 1024 * 1024;

export type ByteBudget = { acquire: (n: number) => Promise<void>; release: (n: number) => void };

/**
 * A FIFO byte-budget gate for fan-out downloads: a worker `acquire()`s the bytes it
 * may buffer before starting a download and `release()`s them after storing, so the
 * concurrent downloads in one run can never sum past `cap` (the per-item cap alone
 * bounds only a single download — 8 × 25MB would OOM the isolate). A single request
 * larger than `cap` is clamped to the whole budget (it is already per-item bounded)
 * so it runs alone instead of deadlocking. FIFO ordering keeps a large reservation
 * from being starved by an endless stream of small ones. Always pair acquire(n)/
 * release(n) with the SAME n (a try/finally) so the ledger stays balanced.
 */
export function byteBudget(cap: number): ByteBudget {
	let available = cap;
	const waiters: Array<{ n: number; resolve: () => void }> = [];
	const pump = (): void => {
		while (waiters.length && waiters[0].n <= available) {
			const w = waiters.shift()!;
			available -= w.n;
			w.resolve();
		}
	};
	return {
		acquire(n: number): Promise<void> {
			const need = Math.min(Math.max(0, n), cap);
			// Head-of-line: a new claim only jumps the fast path when nothing is already
			// waiting, so a queued large reservation can't be starved.
			if (waiters.length === 0 && need <= available) {
				available -= need;
				return Promise.resolve();
			}
			return new Promise<void>((resolve) => {
				waiters.push({ n: need, resolve });
			});
		},
		release(n: number): void {
			available = Math.min(cap, available + Math.min(Math.max(0, n), cap));
			pump();
		},
	};
}

/**
 * Run `fn` over `items` with bounded concurrency, preserving input order in the
 * result. Index-claiming worker pool (was hand-rolled identically in batch and
 * batch_fetch). `fn` should handle its own per-item errors — a throw rejects the
 * whole pool.
 *
 * When `deadline` (an absolute epoch-ms timestamp) is given, workers stop CLAIMING
 * new items once `Date.now() >= deadline`, AND each in-flight leaf is raced against
 * the deadline — a single leaf that overruns must not push the whole fan-out past
 * index.ts's FN_DEADLINE_MS, where `withDeadline` drops the run promise and loses
 * ALL collected partials. On timeout the still-running leaf is abandoned (its value
 * dropped) and its slot stays `undefined`. The result array is DENSE (pre-filled),
 * so the caller can detect skipped items with `=== undefined` (a sparse-array
 * `.map`/`.filter` would silently skip holes) and report a partial/truncated result
 * instead of the whole run being abandoned at the hard deadline.
 */
export async function pool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>, deadline?: number): Promise<R[]> {
	const results = new Array<R>(items.length).fill(undefined as R);
	let next = 0;
	const workers = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
	// Distinguishes "the deadline fired" from any real value `fn` may resolve.
	const TIMED_OUT = Symbol("pool-deadline");
	await Promise.all(
		Array.from({ length: workers }, async () => {
			for (;;) {
				if (deadline !== undefined && Date.now() >= deadline) return;
				const i = next++;
				if (i >= items.length) return;
				if (deadline === undefined) {
					results[i] = await fn(items[i], i);
					continue;
				}
				// Race the leaf against the deadline: abandon an overrunning leaf (slot
				// stays `undefined`, the same partial/truncated path as an unclaimed
				// item) rather than let it sink the whole run. `.finally(clearTimeout)`
				// so the timer never leaks or holds the isolate open.
				let timer: ReturnType<typeof setTimeout>;
				const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
					timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, deadline - Date.now()));
				});
				const r = await Promise.race([fn(items[i], i), timeout]).finally(() => clearTimeout(timer));
				if (r === TIMED_OUT) return;
				results[i] = r as R;
			}
		}),
	);
	return results;
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

// ---------- In-isolate content-fetch dedup (substituter, PLAN Nix insight) ----------
// A pipe/batch/multi-tool chain runs in ONE isolate within a short window and
// often fetches the same URL from several tools (scrape → extract → readability
// → metadata …). Cache the fetched text in memory keyed by url+maxBytes so the
// residential round-trip happens once per chain. Per-isolate + short-TTL: it
// adds no latency (memory only), needs no ctx/KV, and can't break the fetch path
// (all ops are pure and wrapped around — never through — the live fetch). The
// tool-result KV cache still handles cross-isolate/identical-call dedup; this
// closes the CROSS-TOOL same-URL gap the result cache (keyed by tool+args) can't.

export type FetchCacheEntry = { at: number; status: number; text: string; headers: Record<string, string>; url: string };
const FETCH_CACHE = new Map<string, FetchCacheEntry>();
export const FETCH_CACHE_TTL_MS = 30_000;
export const FETCH_CACHE_MAX_ENTRIES = 64;
export const FETCH_CACHE_MAX_TEXT = 512_000; // don't pin very large bodies in memory

// Disabled under vitest so the module-level cache can't leak fetched bodies
// between the many fns tests that mock the fetch and assert on it. A test can
// force it on/off via setFetchDedup to exercise the integration in isolation.
let dedupForced: boolean | null = null;
const fetchDedupActive = (): boolean => dedupForced ?? !(typeof process !== "undefined" && process.env?.VITEST);

/** Test seam: force the fetch dedup on (true) / off (false) / default (null). */
export function setFetchDedup(on: boolean | null): void {
	dedupForced = on;
}

/** Fresh (non-expired) cache entry for `key`, or null. Evicts on expiry. */
export function fetchCacheGet(key: string, now: number): FetchCacheEntry | null {
	const e = FETCH_CACHE.get(key);
	if (!e) return null;
	if (now - e.at > FETCH_CACHE_TTL_MS) {
		FETCH_CACHE.delete(key);
		return null;
	}
	return e;
}

/** Insert an entry, evicting the oldest (Map insertion order) past the cap. */
export function fetchCacheSet(key: string, e: FetchCacheEntry): void {
	if (FETCH_CACHE.size >= FETCH_CACHE_MAX_ENTRIES && !FETCH_CACHE.has(key)) {
		const oldest = FETCH_CACHE.keys().next().value;
		if (oldest !== undefined) FETCH_CACHE.delete(oldest);
	}
	FETCH_CACHE.set(key, e);
}

/** Test seam: clear the per-isolate fetch cache. */
export function clearFetchCache(): void {
	FETCH_CACHE.clear();
}

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

/**
 * Transport fns (proxy/protocol/scrape/batch_fetch) faithfully return
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
 * Transport fns (proxy/scrape/batch_fetch) accept an arbitrary method, but their
 * results are content-addressed by args and cached for the fn TTL. A non-idempotent
 * request (POST/PUT/PATCH/DELETE/…) must never be memoized: caching it both serves
 * a stale response for a repeat mutation and silently skips re-executing the side
 * effect. Only GET/HEAD are safe to cache; mark everything else noCache.
 */
export function noCacheOnMutation<T extends { noCache?: boolean }>(result: T, method: unknown): T {
	const m = String(method ?? "GET").toUpperCase();
	if (m !== "GET" && m !== "HEAD") result.noCache = true;
	return result;
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

/** True when a handle's absolute unix-seconds `expiry` is set and in the past. */
export function isExpired(ref: { expiry?: number }, now = Date.now()): boolean {
	return typeof ref.expiry === "number" && ref.expiry * 1000 <= now;
}

/** Resolve a /s/<uuid> handle to its bytes via KV→R2 directly (no HTTP hop). */
export async function getBlob(env: RtEnv, uuid: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
	if (!env.R2) return null;
	const raw = await env.OAUTH_KV.get(`${STORE_KV_PREFIX}${uuid}`);
	if (!raw) return null;
	const ref = JSON.parse(raw) as { key: string; content_type?: string; expiry?: number };
	// An expired handle is a not-found (KV's own expirationTtl usually evicts it,
	// but enforce it here too and best-effort delete a handle KV hasn't reaped yet).
	if (isExpired(ref)) {
		await env.OAUTH_KV.delete(`${STORE_KV_PREFIX}${uuid}`).catch(() => {});
		return null;
	}
	const obj = await env.R2.get(ref.key);
	if (!obj) return null;
	// Stored bytes may be a transparent-gzip frame — inflate back to the original.
	const bytes = await maybeDecompress(new Uint8Array(await obj.arrayBuffer()));
	return { bytes, contentType: ref.content_type ?? obj.httpMetadata?.contentType ?? "application/octet-stream" };
}

export type BlobRef = { uuid: string; url: string; key: string; sha256: string; size: number; content_type: string; expiry?: number };

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
export async function putBlob(env: RtEnv, bytes: Uint8Array, contentType: string, opts?: { ttlSeconds?: number }): Promise<BlobRef> {
	if (!env.R2) throw new Error("R2 is not available (bucket binding missing).");
	const sha256 = await sha256Hex(bytes);
	const key = `cas/${sha256}`;
	const uuid = crypto.randomUUID();
	// Optional expiry (ephemeral artifacts — render screenshots/pdfs). Record an
	// absolute unix-seconds `expiry` in the handle JSON so any reader can enforce
	// it, and set KV's own expirationTtl so the handle self-evicts. KV rejects an
	// expirationTtl under 60s, so below that we lean on the JSON expiry alone — the
	// reader still treats it as not-found once past. No ttl = permanent handle.
	const ttl = typeof opts?.ttlSeconds === "number" && opts.ttlSeconds > 0 ? Math.floor(opts.ttlSeconds) : undefined;
	const expiry = ttl ? Math.floor(Date.now() / 1000) + ttl : undefined;
	const handle: Record<string, unknown> = { key, content_type: contentType, size: bytes.length, sha256 };
	if (expiry) handle.expiry = expiry;
	const kvOpts = ttl && ttl >= 60 ? { expirationTtl: ttl } : undefined;
	// Transparent gzip for text-ish blobs (marker-framed; getBlob/store/`/s/`
	// inflate on read). The CAS key stays the sha256 of the ORIGINAL bytes, so
	// dedup is unaffected and identical content still collapses to one object.
	const stored = await maybeCompress(bytes, contentType);
	// The R2 object and KV handle are independent writes — run them concurrently.
	await Promise.all([
		env.R2.put(key, stored, { httpMetadata: { contentType }, customMetadata: { sha256 } }),
		env.OAUTH_KV.put(`${STORE_KV_PREFIX}${uuid}`, JSON.stringify(handle), kvOpts),
	]);
	return { uuid, url: `${storeBase(env)}/s/${uuid}`, key, sha256, size: bytes.length, content_type: contentType, ...(expiry ? { expiry } : {}) };
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
			return { content: [{ type: "text", text: oj({ url: ref.url, sha256: ref.sha256, size: ref.size, content_type: contentType }) }] };
		} catch (e) {
			return { content: [{ type: "text", text: `as:"url" needs the R2 store: ${errMsg(e)}` }], isError: true };
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
