import zlib from "node:zlib";
import { type Fn, fail, ok } from "../registry";
import { errMsg, FANOUT_BUDGET_MS, fromB64, isHttpUrl, pool, putBlob, toB64 } from "./_util";
import { fetchBytes, MAX_STORE_BYTES } from "./batch_fetch";
import { pdf as pdfFn } from "./pdf";

// Smart bulk PUT — the download-and-shelve verb. Fans many URLs out through the
// shared pool()+time-budget, DOWNLOADS each (batch_fetch's fetchBytes), optionally
// CONVERTS it to PDF (the pdf fn) and/or GZIPs it, then content-addresses the
// result into the R2 store and hands back a compact /s/<uuid> handle. It's the
// bulk sibling of `store`: pull dozens of pages/files server-side and get back a
// list of refs instead of dragging megabytes through the model's context. Composes
// existing fns (batch_fetch download, pdf convert, store) rather than adding an
// engine; per-URL failures and oversize files are isolated, never sinking the run.

const CONCURRENCY = 8;
// Amplification cap — mirrors batch_fetch's MAX_URLS; a put fan-out is the same
// outbound-fetch DoS surface.
const MAX_URLS = 100;
const Z = zlib as { gzipSync: (buf: Uint8Array, opts?: unknown) => Uint8Array };

type UrlResult = {
	url: string;
	status?: number;
	src_bytes?: number;
	bytes?: number;
	content_type?: string;
	ref?: string;
	applied?: string[];
	oversize?: boolean;
	error?: string;
};

type Opts = { method: string; pdf: boolean; gzip: boolean; ttlSeconds?: number };

// pdf auto-detects pdf/png/jpg from magic bytes; only HTML needs an explicit kind
// (its bytes carry no magic, so auto would render the raw markup as plain text).
const pdfKind = (ct: string): "html" | "auto" => (/html/i.test(ct) ? "html" : "auto");

/** Download → optional pdf → optional gzip → store, for one URL. Every failure
 * mode (bad URL, fetch throw, oversize, pdf error) is captured per-URL so one bad
 * input never aborts the batch. */
async function processUrl(env: any, rawUrl: unknown, opts: Opts): Promise<UrlResult> {
	const url = typeof rawUrl === "string" ? rawUrl : "";
	if (!isHttpUrl(url)) return { url, error: "not an absolute http(s) URL." };
	try {
		const got = await fetchBytes(env, url, opts.method);
		// Oversize aborts before buffering (no OOM) — report it, store nothing.
		if (got.oversize || got.bytes.length > MAX_STORE_BYTES) return { url, status: got.status, bytes: got.bytes.length, oversize: true };

		let bytes = got.bytes;
		let contentType = got.contentType;
		const srcBytes = bytes.length;
		const applied: string[] = [];

		if (opts.pdf) {
			const pr = await pdfFn.run(env, { sources: [{ data: toB64(bytes), kind: pdfKind(contentType) }] });
			if (pr.isError) return { url, status: got.status, src_bytes: srcBytes, error: `pdf convert failed: ${pr.content?.[0]?.text ?? "unknown"}` };
			bytes = fromB64(JSON.parse(pr.content[0].text).base64);
			contentType = "application/pdf";
			applied.push("pdf");
		}
		if (opts.gzip) {
			// compress fn is text-only on the compress path, so gzip the raw bytes
			// directly (same node:zlib level-9 gzip it uses internally).
			bytes = new Uint8Array(Z.gzipSync(bytes, { level: 9 }));
			contentType = "application/gzip";
			applied.push("gzip");
		}

		const ref = await putBlob(env, bytes, contentType, opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : undefined);
		return { url, status: got.status, src_bytes: srcBytes, bytes: bytes.length, content_type: contentType, ref: ref.url, ...(applied.length ? { applied } : {}) };
	} catch (e) {
		return { url, error: errMsg(e) };
	}
}

export const put: Fn = {
	name: "put",
	description:
		"Bulk DOWNLOAD-and-shelve: fetch many URLs concurrently via the residential proxy and content-address each into sux's R2 store, returning a compact /s/<uuid> handle per URL instead of dragging the bytes through context. urls: array of absolute http(s) URLs (max 100); method: GET (default). Runs ~8 at a time under a time budget — a wide run near the hard deadline returns the URLs it managed (the rest come back as skipped [timeout] entries) rather than losing everything; per-URL failures and oversize files (>25MB) are isolated. " +
		"Optional per-file transforms applied before storing: pdf:true converts each download to PDF (HTML/text/images → PDF), gzip:true gzips it (level 9). ttl_seconds sets an ephemeral handle expiry (omit for a permanent handle). " +
		"Returns a JSON array of { url, status, src_bytes, bytes, content_type, ref, applied? } (or { url, error } / { url, oversize } for a skipped one). Composes batch_fetch (download), pdf (convert) and the store — the bulk sibling of `store`.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["urls"],
		properties: {
			urls: { type: "array", items: { type: "string" }, maxItems: 100, description: "Absolute http(s) URLs to download and store (max 100)." },
			method: { type: "string", default: "GET", description: "HTTP method (default GET)." },
			pdf: { type: "boolean", default: false, description: "Convert each downloaded file to PDF before storing (HTML/text/images → PDF)." },
			gzip: { type: "boolean", default: false, description: "Gzip each file (level 9) before storing." },
			ttl_seconds: { type: "integer", minimum: 1, description: "Optional seconds until each uuid handle self-expires (ephemeral); omit for a permanent handle." },
		},
	},
	cacheable: false,
	annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
	run: async (env, args) => {
		if (!Array.isArray(args?.urls)) return fail("`urls` must be an array of http(s) URLs.");
		const urls: unknown[] = args.urls;
		if (!urls.length) return fail("`urls` must not be empty.");
		if (urls.length > MAX_URLS) return fail(`Too many urls: ${urls.length} (max ${MAX_URLS} per put).`);
		if (!env.R2) return fail("`put` needs the R2 store (bucket binding missing).");

		let ttlSeconds: number | undefined;
		if (args?.ttl_seconds !== undefined) {
			ttlSeconds = Number(args.ttl_seconds);
			if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) return fail("`ttl_seconds` must be a positive integer.");
		}
		const opts: Opts = { method: String(args?.method ?? "GET").toUpperCase(), pdf: args?.pdf === true, gzip: args?.gzip === true, ttlSeconds };

		// Time budget: stop firing new downloads near the hard deadline so a wide run
		// returns the URLs it stored instead of the whole run being killed with none.
		const deadline = Date.now() + FANOUT_BUDGET_MS;
		const raw = await pool(urls, CONCURRENCY, (rawUrl) => processUrl(env, rawUrl, opts), deadline);
		// Un-run URLs (time budget hit) come back undefined; surface each as skipped so
		// the array stays 1:1 with `urls` and the caller sees exactly what didn't run.
		const results: UrlResult[] = raw.map((r, i) => r ?? { url: typeof urls[i] === "string" ? (urls[i] as string) : "", error: "[timeout] skipped: put time budget reached before this URL was processed." });
		return ok(JSON.stringify(results, null, 2));
	},
};
