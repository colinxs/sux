import { type Fn, fail, ok } from "../registry";
import { fetchText, isHttpUrl, noCacheOn4xx } from "./_util";

// Fetch many URLs concurrently through the residential proxy (direct fallback).
// Concurrency is capped; each URL is fetched inside its own try/catch so one
// failure never aborts the batch. Bodies are truncated to max_bytes.

const CONCURRENCY = 8;

type UrlResult = { url: string; status?: number; bytes?: number; text?: string; error?: string };

export const batch_fetch: Fn = {
	name: "batch_fetch",
	description:
		"Fetch many URLs concurrently via the residential proxy (direct fallback). urls: array of absolute http(s) URLs; method: GET (default); max_bytes: cap per-response body (default 20000). Runs ~8 at a time, isolating per-URL failures. Returns JSON array of { url, status, bytes, text } or { url, error }.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["urls"],
		properties: {
			urls: { type: "array", items: { type: "string" }, description: "Absolute http(s) URLs to fetch." },
			method: { type: "string", default: "GET", description: "HTTP method (default GET)." },
			max_bytes: { type: "integer", minimum: 1, default: 20000, description: "Max bytes of body text to return per URL." },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		if (!Array.isArray(args?.urls)) return fail("`urls` must be an array of http(s) URLs.");
		const urls: unknown[] = args.urls;
		if (!urls.length) return fail("`urls` must not be empty.");

		const method = String(args?.method ?? "GET").toUpperCase();
		const maxBytes = args?.max_bytes === undefined ? 20000 : Number(args.max_bytes);
		if (!Number.isInteger(maxBytes) || maxBytes < 1) return fail("`max_bytes` must be a positive integer.");

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
					const r = await fetchText(env, url, { method, maxBytes });
					results[i] = { url, status: r.status, bytes: r.text.length, text: r.text };
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
