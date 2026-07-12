import { type Fn, type RtEnv, fail, ok } from "../registry";
import { type BlobRef, FANOUT_BUDGET_MS, fetchText, getBlob, isHttpUrl, noCacheOn4xx, noCacheOnMutation, pool, putBlob, readBodyBytes, storeRefUuid } from "./_util";
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

/** Fetch raw bytes for as:"url", preserving the HTTP status (a 4xx error page is
 * still transport content here) and short-circuiting the worker's own /s/<uuid>
 * CAS refs to a direct KV→R2 read. Binary-safe: smartFetch decodes base64 proxy
 * bodies to raw bytes so images/pdfs/zips survive byte-for-byte. */
async function fetchBytes(
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
		'as: "url" is server-side bulk DOWNLOAD: it stores each successful response\'s raw bytes to the content-addressed R2 store (binary-safe — images, PDFs, zips) and returns a compact /s/<uuid> ref { url, status, bytes, ref } instead of inlining the body, so you can bulk-download files without pulling megabytes through context. ' +
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
			max_bytes: { type: "integer", minimum: 1, default: 20000, description: 'Max bytes of body text to return per URL (as:"text" only).' },
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
		const maxBytes = args?.max_bytes === undefined ? 20000 : Number(args.max_bytes);
		if (!Number.isInteger(maxBytes) || maxBytes < 1) return fail("`max_bytes` must be a positive integer.");
		if (as === "url" && !env.R2) return fail('`as: "url"` needs the R2 store (bucket binding missing).');

		// Time budget: stop firing new fetches near the hard deadline so a wide batch
		// returns the URLs it managed instead of the whole run being killed with none.
		const deadline = Date.now() + FANOUT_BUDGET_MS;
		const raw = await pool(urls, CONCURRENCY, async (rawUrl): Promise<UrlResult> => {
			const url = typeof rawUrl === "string" ? rawUrl : "";
			if (!isHttpUrl(url)) return { url, error: "not an absolute http(s) URL." };
			try {
				if (as === "url") {
					const r = await fetchBytes(env, url, method);
					// Oversize isolated to this URL — report it, don't store, don't fail the batch.
					// r.oversize means the read aborted before buffering (no OOM); the length check is a belt.
					if (r.oversize || r.bytes.length > MAX_STORE_BYTES) return { url, status: r.status, bytes: r.bytes.length, oversize: true };
					const ref: BlobRef = await putBlob(env, r.bytes, r.contentType);
					return { url, status: r.status, bytes: r.bytes.length, ref: ref.url };
				}
				const r = await fetchText(env, url, { method, maxBytes });
				return { url, status: r.status, bytes: r.text.length, text: r.text };
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
		return noCacheOnMutation(noCacheOn4xx(ok(JSON.stringify(results, null, 2)), worst), method);
	},
};
