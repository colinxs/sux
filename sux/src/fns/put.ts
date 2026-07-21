import zlib from "node:zlib";
import { type Fn, fail, ok } from "../registry";
import { staged } from "../stage";
import { type ByteBudget, byteBudget, errMsg, FANOUT_BUDGET_MS, FANOUT_BYTE_BUDGET, FANOUT_STORE_TTL_S, fromB64, isHttpUrl, oj, pool, putBlob, toB64 } from "./_util";
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
async function processUrl(env: any, rawUrl: unknown, opts: Opts, budget: ByteBudget): Promise<UrlResult> {
	const url = typeof rawUrl === "string" ? rawUrl : "";
	if (!isHttpUrl(url)) return { url, error: "not an absolute http(s) URL." };
	// Reserve the worst-case bytes this item may buffer BEFORE downloading, so N
	// concurrent downloads can't sum past the isolate memory ceiling (the per-item
	// MAX_STORE_BYTES cap bounds only one). pdf conversion holds the input, its
	// base64 copy, and the pdf-lib output at once — reserve extra headroom for it.
	const reserve = MAX_STORE_BYTES * (opts.pdf ? 3 : 1);
	await budget.acquire(reserve);
	try {
		const got = await fetchBytes(env, url, opts.method);
		// Oversize aborts before buffering (no OOM) — report it, store nothing.
		if (got.oversize || got.bytes.length > MAX_STORE_BYTES) return { url, status: got.status, bytes: got.bytes.length, oversize: true };

		let bytes = got.bytes;
		let contentType = got.contentType;
		const srcBytes = bytes.length;
		const applied: string[] = [];

		if (opts.pdf) {
			// Explicit as:"base64" — this is an internal reuse of the pdf fn to grab its
			// raw output bytes for further gzip/store below, not the final delivery, so it
			// must stay exempt from deliverBytes' size-based auto-ref (else a >150KB
			// converted PDF would come back as a ref with no `base64` key and break the
			// fromB64 below).
			const pr = await pdfFn.run(env, { sources: [{ data: toB64(bytes), kind: pdfKind(contentType) }], as: "base64" });
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
	} finally {
		budget.release(reserve);
	}
}

export const put: Fn = {
	name: "put",
	description:
		"Bulk DOWNLOAD-and-shelve: fetch many URLs concurrently via the residential proxy and content-address each into sux's R2 store, returning a compact /s/<uuid> handle per URL instead of dragging the bytes through context. urls: array of absolute http(s) URLs (max 100); method: GET (default). Runs ~8 at a time under a time budget — a wide run near the hard deadline returns the URLs it managed (the rest come back as skipped [timeout] entries) rather than losing everything; per-URL failures and oversize files (>25MB) are isolated. " +
		"Optional per-file transforms applied before storing: pdf:true converts each download to PDF (HTML/text/images → PDF), gzip:true gzips it (level 9). ttl_seconds sets the handle expiry (default 7 days — bulk downloads are staging artifacts that self-expire; pass a larger value to keep them longer, or use `store` for a permanent handle). " +
		"Each ref is a world-readable, unauthenticated URL, so a FRESH put STAGES A PREVIEW BY DEFAULT (nothing fetched or written) — re-call with the returned commit_token to run, or pass force:true to run in one shot. " +
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
			ttl_seconds: { type: "integer", minimum: 1, description: "Seconds until each uuid handle self-expires (default 7 days; pass a larger value to keep longer, or use `store` for a permanent handle)." },
			stage: { type: "boolean", description: "Preview + commit_token, no fetch/write." },
			commit_token: { type: "string", description: "Commit a previously staged put (the payload must match what was staged)." },
			force: { type: "boolean", description: "Skip staging and run in one shot (the ! override). By default a fresh put stages a preview first." },
		},
	},
	cacheable: false,
	// destructiveHint mirrors its egress siblings (store/ingest/dropbox/kv_put in registry.ts's
	// WRITE_DESTRUCTIVE): a put mints a world-readable, unauthenticated /s/<uuid> URL for arbitrary
	// bytes, so a client should drive a confirm prompt. openWorldHint stays true — put also fetches.
	annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
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
		// Bulk downloads are staging artifacts — default them to a self-expiring handle
		// (FANOUT_STORE_TTL_S) so a wide run doesn't accrete permanent storage; a caller
		// wanting longer passes an explicit ttl_seconds.
		const opts: Opts = { method: String(args?.method ?? "GET").toUpperCase(), pdf: args?.pdf === true, gzip: args?.gzip === true, ttlSeconds: ttlSeconds ?? FANOUT_STORE_TTL_S };

		// The whole fan-out (download → transform → mint a public ref per URL) is one
		// side-effect — an egress channel higher-amplification than store.put — so it
		// routes through the stage guard by default (STAGE_KINDS.put_batch), fetching
		// nothing until the caller commits or forces.
		const runBatch = async (): Promise<UrlResult[]> => {
			// Time budget: stop firing new downloads near the hard deadline so a wide run
			// returns the URLs it stored instead of the whole run being killed with none.
			const deadline = Date.now() + FANOUT_BUDGET_MS;
			// Aggregate memory budget shared across the pool: workers reserve/release bytes
			// so CONCURRENCY downloads can't sum past the isolate ceiling.
			const budget = byteBudget(FANOUT_BYTE_BUDGET);
			const raw = await pool(urls, CONCURRENCY, (rawUrl) => processUrl(env, rawUrl, opts, budget), deadline);
			// Un-run URLs (time budget hit) come back undefined; surface each as skipped so
			// the array stays 1:1 with `urls` and the caller sees exactly what didn't run.
			return raw.map((r, i) => r ?? { url: typeof urls[i] === "string" ? (urls[i] as string) : "", error: "[timeout] skipped: put time budget reached before this URL was processed." });
		};

		const payload = { urls, method: opts.method, pdf: opts.pdf, gzip: opts.gzip, ttl_seconds: opts.ttlSeconds };
		const preview = { action: "put batch", url_count: urls.length, ttl_seconds: opts.ttlSeconds, ...(opts.pdf || opts.gzip ? { transforms: [...(opts.pdf ? ["pdf"] : []), ...(opts.gzip ? ["gzip"] : [])] } : {}), sample_urls: urls.slice(0, 5).map((u) => (typeof u === "string" ? u : "")) };
		const gateArgs = { stage: args?.stage === true, commit_token: args?.commit_token ? String(args.commit_token) : undefined, force: args?.force === true };
		try {
			const out = await staged(env, "put_batch", gateArgs, payload, preview, runBatch);
			return ok(oj("stageResult" in out ? out.stageResult : out.result));
		} catch (e) {
			return fail(errMsg(e));
		}
	},
};
