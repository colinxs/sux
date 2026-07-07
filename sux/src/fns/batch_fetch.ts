import { type Fn, type RtEnv, fail, ok } from "../registry";
import { type BlobRef, fetchText, getBlob, isHttpUrl, noCacheOn4xx, putBlob, storeRefUuid } from "./_util";
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
): Promise<{ status: number; bytes: Uint8Array; contentType: string }> {
	const uuid = storeRefUuid(url);
	if (uuid && env.R2) {
		const blob = await getBlob(env, uuid);
		if (!blob) return { status: 404, bytes: new Uint8Array(), contentType: "application/octet-stream" };
		return { status: 200, bytes: blob.bytes, contentType: blob.contentType };
	}
	const resp = await smartFetch(env, url, { method });
	return {
		status: resp.status,
		bytes: new Uint8Array(await resp.arrayBuffer()),
		contentType: resp.headers.get("content-type") ?? "application/octet-stream",
	};
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

		const results: UrlResult[] = new Array(urls.length);
		let next = 0;
		async function worker(): Promise<void> {
			for (;;) {
				const i = next++;
				if (i >= urls.length) return;
				const raw = urls[i];
				const url = typeof raw === "string" ? raw : "";
				if (!isHttpUrl(url)) {
					results[i] = { url, error: "not an absolute http(s) URL." };
					continue;
				}
				try {
					if (as === "url") {
						const r = await fetchBytes(env, url, method);
						if (r.bytes.length > MAX_STORE_BYTES) {
							// Oversize isolated to this URL — report it, don't store, don't fail the batch.
							results[i] = { url, status: r.status, bytes: r.bytes.length, oversize: true };
							continue;
						}
						const ref: BlobRef = await putBlob(env, r.bytes, r.contentType);
						results[i] = { url, status: r.status, bytes: r.bytes.length, ref: ref.url };
					} else {
						const r = await fetchText(env, url, { method, maxBytes });
						results[i] = { url, status: r.status, bytes: r.text.length, text: r.text };
					}
				} catch (e) {
					results[i] = { url, error: String((e as Error)?.message ?? e) };
				}
			}
		}

		const pool = Math.min(CONCURRENCY, urls.length);
		await Promise.all(Array.from({ length: pool }, () => worker()));

		// Worst status across the batch decides cacheability — a per-URL `error`
		// (network blip) counts as a 5xx so one bad URL never poisons the cache.
		const worst = results.reduce((m, r) => Math.max(m, r.error !== undefined ? 599 : r.status ?? 0), 0);
		return noCacheOn4xx(ok(JSON.stringify(results, null, 2)), worst);
	},
};
