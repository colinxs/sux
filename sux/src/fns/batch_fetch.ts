import { type Fn, type RtEnv, fail, ok } from "../registry";
import { type BlobRef, byteBudget, FANOUT_BUDGET_MS, FANOUT_BYTE_BUDGET, FANOUT_STORE_TTL_S, FETCH_TEXT_MAX_BYTES, fetchText, getBlob, isHttpUrl, noCacheOn4xx, noCacheOnMutation, pool, putBlob, readBodyBytes, storeRefUuid, oj } from "./_util";
import { smartFetch } from "../proxy";

// Fetch many URLs concurrently through the residential proxy (direct fallback).
// Concurrency is capped; each URL is fetched inside its own try/catch so one
// failure never aborts the batch.
//
// as:"text" (default) — read each body as text, truncated to max_bytes; returns
//   { url, status, bytes, text }. The token-cheap preview mode.
// as:"url" — server-side bulk DOWNLOAD: store each successful response's RAW
//   BYTES to the content-addressed R2 store binary-safely and return a compact
//   /s/<uuid> ref { url, status, bytes, ref } instead of the body — so an agent
//   can pull many files (images, PDFs, zips) without dragging megabytes through
//   its context.

const CONCURRENCY = 8;

// Amplification cap: one batch_fetch call may drive at most this many upstream
// fetches. Mirrors batch's MAX_CALLS — a fetch fan-out is the same DoS surface.
const MAX_URLS = 100;

// Raw-byte cap for as:"url" downloads. This is a size guard on stored objects,
// distinct from max_bytes (a text-preview cap). Oversize is reported per-URL, so
// one huge file never fails the whole batch.
const MAX_STORE_BYTES = 25 * 1024 * 1024;

type UrlResult = {
	url: string;
	status?: number;
	bytes?: number;
	text?: string;
	ref?: string;
	oversize?: boolean;
	error?: string;
};

// Raw-byte cap for as:"url" downloads, exported so `put` (which composes
// fetchBytes) shares the same store-size guard.
export { MAX_STORE_BYTES };

/** Fetch raw bytes for as:"url", preserving the HTTP status (a 4xx error page is
 * still transport content here) and short-circuiting the worker's own /s/<uuid>
 * CAS refs to a direct KV→R2 read. Binary-safe: smartFetch decodes base64 proxy
 * bodies to raw bytes so images/pdfs/zips survive byte-for-byte. Exported so `put`
 * reuses the exact download path instead of re-hand-rolling it. */
export async function fetchBytes(
	env: RtEnv,
	url: string,
	method: string,
): Promise<{ status: number; bytes: Uint8Array; contentType: string; oversize?: boolean }> {
	const uuid = storeRefUuid(url);
	if (uuid && env.R2) {
		const blob = await getBlob(env, uuid);
		if (!blob) return { status: 404, bytes: new Uint8Array(), contentType: "application/octet-stream" };
		return { status: 200, bytes: blob.bytes, contentType: blob.contentType };
	}
	const resp = await smartFetch(env, url, { method });
	const contentType = resp.headers.get("content-type") ?? "application/octet-stream";
	// Bound the read: a huge body must abort (content-length pre-check + mid-stream cap)
	// rather than buffer the whole thing — CONCURRENCY (8) of these would OOM the isolate.
	try {
		return { status: resp.status, bytes: await readBodyBytes(resp, MAX_STORE_BYTES), contentType };
	} catch (e) {
		if (/too large|exceeds/i.test(String((e as Error)?.message ?? e))) return { status: resp.status, bytes: new Uint8Array(0), contentType, oversize: true };
		throw e;
	}
}

export const batch_fetch: Fn = {
	name: "batch_fetch",
	description:
		"Fetch many URLs concurrently via the residential proxy (direct fallback). urls: array of absolute http(s) URLs; method: GET (default). Runs ~8 at a time, isolating per-URL failures. " +
		'as: "text" (default) reads each body as text capped by max_bytes (default 20000) and returns { url, status, bytes, text }. ' +
		'as: "url" is server-side bulk DOWNLOAD: it stores each successful response\'s raw bytes to the content-addressed R2 store (binary-safe — images, PDFs, zips) and returns a compact /s/<uuid> ref { url, status, bytes, ref } instead of inlining the body, so you can bulk-download files without pulling megabytes through context (each ref self-expires after 7 days — use `store` for a permanent handle). ' +
		"Returns a JSON array of per-URL results, or { url, error } for a failed one.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["urls"],
		properties: {
			urls: { type: "array", items: { type: "string" }, maxItems: 100, description: "Absolute http(s) URLs to fetch (max 100)." },
			method: { type: "string", default: "GET", description: "HTTP method (default GET)." },
			as: {
				type: "string",
				enum: ["text", "url"],
				default: "text",
				description: 'Delivery: "text" inlines each body (capped by max_bytes) | "url" stores raw bytes to CAS and returns a /s/<uuid> ref (server-side bulk download).',
			},
			max_bytes: { type: "integer", minimum: 1, maximum: FETCH_TEXT_MAX_BYTES, default: 20000, description: 'Max bytes of body text to return per URL (as:"text" only).' },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		if (!Array.isArray(args?.urls)) return fail("`urls` must be an array of http(s) URLs.");
		const urls: unknown[] = args.urls;
		if (!urls.length) return fail("`urls` must not be empty.");
		if (urls.length > MAX_URLS) return fail(`Too many urls: ${urls.length} (max ${MAX_URLS} per batch_fetch).`);

		const method = String(args?.method ?? "GET").toUpperCase();
		const as = String(args?.as ?? "text");
		if (as !== "text" && as !== "url") return fail('`as` must be "text" or "url".');
		const rawMaxBytes = args?.max_bytes === undefined ? 20000 : Number(args.max_bytes);
		if (!Number.isInteger(rawMaxBytes) || rawMaxBytes < 1) return fail("`max_bytes` must be a positive integer.");
		// Clamp to the text-fetch ceiling: without a cap, maxBytes flows into
		// readBodyText's in-memory accumulator, and CONCURRENCY (8) huge reads would OOM.
		const maxBytes = Math.min(rawMaxBytes, FETCH_TEXT_MAX_BYTES);
		if (as === "url" && !env.R2) return fail('`as: "url"` needs the R2 store (bucket binding missing).');

		// Time budget: stop firing new fetches near the hard deadline so a wide batch
		// returns the URLs it managed instead of the whole run being killed with none.
		const deadline = Date.now() + FANOUT_BUDGET_MS;
		// Aggregate memory budget shared across the pool for as:"url" downloads: a
		// worker reserves the per-item cap before buffering and releases it after
		// storing, so CONCURRENCY concurrent downloads can't sum past the isolate
		// ceiling (8 × 25MB would OOM). as:"text" is bounded by max_bytes and needs none.
		const budget = byteBudget(FANOUT_BYTE_BUDGET);
		const raw = await pool(urls, CONCURRENCY, async (rawUrl): Promise<UrlResult> => {
			const url = typeof rawUrl === "string" ? rawUrl : "";
			if (!isHttpUrl(url)) return { url, error: "not an absolute http(s) URL." };
			try {
				if (as === "url") {
					await budget.acquire(MAX_STORE_BYTES);
					try {
						const r = await fetchBytes(env, url, method);
						// Oversize isolated to this URL — report it, don't store, don't fail the batch.
						// r.oversize means the read aborted before buffering (no OOM); the length check is a belt.
						if (r.oversize || r.bytes.length > MAX_STORE_BYTES) return { url, status: r.status, bytes: r.bytes.length, oversize: true };
						// Staging artifact — self-expiring handle so bulk downloads don't accrete storage.
						const ref: BlobRef = await putBlob(env, r.bytes, r.contentType, { ttlSeconds: FANOUT_STORE_TTL_S });
						return { url, status: r.status, bytes: r.bytes.length, ref: ref.url };
					} finally {
						budget.release(MAX_STORE_BYTES);
					}
				}
				const r = await fetchText(env, url, { method, maxBytes });
				// Count UTF-8 octets, not UTF-16 code units, so `bytes` matches the url branch and reality.
				return { url, status: r.status, bytes: new TextEncoder().encode(r.text).length, text: r.text };
			} catch (e) {
				return { url, error: String((e as Error)?.message ?? e) };
			}
		}, deadline);
		// Un-fetched URLs (time budget hit) come back undefined; surface each as a
		// skipped result so the returned array stays 1:1 with `urls` and the caller
		// sees exactly which ones didn't run.
		const results: UrlResult[] = raw.map((r, i) => r ?? { url: typeof urls[i] === "string" ? (urls[i] as string) : "", error: "[timeout] skipped: batch_fetch time budget reached before this URL was fetched." });

		// Worst status across the batch decides cacheability — a per-URL `error`
		// (network blip) counts as a 5xx so one bad URL never poisons the cache. A
		// truncated run is likewise non-cacheable (its partials shouldn't be frozen).
		const worst = results.reduce((m, r) => Math.max(m, r.error !== undefined ? 599 : r.status ?? 0), 0);
		return noCacheOnMutation(noCacheOn4xx(ok(oj(results)), worst), method);
	},
};
