import zlib from "node:zlib";
import { type Fn, fail, ok } from "../registry";
import { staged } from "../stage";
import { type ByteBudget, byteBudget, errMsg, FANOUT_BUDGET_MS, FANOUT_BYTE_BUDGET, fromB64, isHttpUrl, oj, pool, putBlob, toB64, writeNamedProjection } from "./_util";
import { fetchBytes, MAX_STORE_BYTES } from "./batch_fetch";
import { dropboxPut, hasDropbox } from "./dropbox";
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
	dropbox_path?: string;
	r2_path?: string;
};

type Opts = { method: string; pdf: boolean; gzip: boolean; ttlSeconds?: number; dropboxFolder?: string; r2Path?: string };

// pdf auto-detects pdf/png/jpg from magic bytes; only HTML needs an explicit kind
// (its bytes carry no magic, so auto would render the raw markup as plain text).
const pdfKind = (ct: string): "html" | "auto" => (/html/i.test(ct) ? "html" : "auto");

/** URL's last path segment, sanitized to a safe Dropbox filename (mirrors ingest.ts's urlName). */
function urlBasename(u: string): string {
	try {
		const last = decodeURIComponent(new URL(u).pathname.split("/").filter(Boolean).pop() ?? "");
		const safe = last.replace(/[^\w.-]+/g, "_");
		return safe || "file";
	} catch {
		return "file";
	}
}

/** Disambiguate a filename against every name already assigned in this batch (-2, -3, …)
 *  so two URLs sharing a basename never race to overwrite each other's Dropbox projection. */
function dedupeName(used: Set<string>, name: string): string {
	if (!used.has(name)) {
		used.add(name);
		return name;
	}
	const dot = name.lastIndexOf(".");
	const base = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	let n = 2;
	let candidate = `${base}-${n}${ext}`;
	while (used.has(candidate)) candidate = `${base}-${++n}${ext}`;
	used.add(candidate);
	return candidate;
}

/** Normalize a folder param to a clean, absolute app-folder path with no trailing slash
 *  (root folds to "" so `${folder}/${name}` still comes out as "/name"). */
function normDropboxFolder(p: string): string {
	const trimmed = String(p).trim().replace(/^\/+|\/+$/g, "");
	return trimmed ? `/${trimmed}` : "";
}

/** Same "strip absolute leading/trailing slashes" shape as normDropboxFolder, reused
 *  here (not duplicated) for the r2_path folder prefix — aliased under its own name so
 *  a reader isn't confused seeing a Dropbox-named helper normalize an unrelated R2 param. */
const normR2Folder = normDropboxFolder;

/** Fire-and-forget R2→Dropbox projection for one stored file (#1381): the /s/ ref stays
 *  canonical, this is a best-effort COPY that never round-trips bytes through context and
 *  never fails the put — a failed projection just logs one line. Held open past the response
 *  via ctx.waitUntil when an execution context is available (mirrors ingest.ts's
 *  backgroundAssimilate); without one it still runs, just detached. */
function projectToDropbox(env: any, path: string, bytes: Uint8Array): void {
	const task = dropboxPut(env, path, bytes, { overwrite: false })
		.then((r) => {
			if (r && "error" in r) console.warn(`put: dropbox projection failed for ${path} — ${r.error}`);
		})
		.catch((e) => console.warn(`put: dropbox projection failed for ${path} — ${errMsg(e)}`));
	const ctx = env._egress?.ctx;
	if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(task);
}

/** Download → optional pdf → optional gzip → store, for one URL. Every failure
 * mode (bad URL, fetch throw, oversize, pdf error) is captured per-URL so one bad
 * input never aborts the batch. */
async function processUrl(env: any, rawUrl: unknown, opts: Opts, budget: ByteBudget, dropboxNames: Set<string>, r2Names: Set<string>): Promise<UrlResult> {
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
		let dropboxPath: string | undefined;
		if (opts.dropboxFolder !== undefined) {
			const name = dedupeName(dropboxNames, urlBasename(url));
			dropboxPath = opts.dropboxFolder ? `${opts.dropboxFolder}/${name}` : `/${name}`;
			projectToDropbox(env, dropboxPath, bytes);
		}
		let r2Path: string | undefined;
		if (opts.r2Path !== undefined) {
			// A SEPARATE dedup Set from dropboxNames: these are independent projections
			// (files/ vs. the Dropbox app folder) that could collide differently, so one
			// batch's name choices for one must never be influenced by the other's.
			const name = dedupeName(r2Names, urlBasename(url));
			try {
				r2Path = await writeNamedProjection(env, `${opts.r2Path}/${name}`, bytes, contentType);
			} catch (e) {
				// projection is best-effort — a failed files/ write must never fail this URL's result.
				console.warn(`put: r2_path projection failed for ${opts.r2Path}/${name} — ${errMsg(e)}`);
			}
		}
		return { url, status: got.status, src_bytes: srcBytes, bytes: bytes.length, content_type: contentType, ref: ref.url, ...(applied.length ? { applied } : {}), ...(dropboxPath ? { dropbox_path: dropboxPath } : {}), ...(r2Path ? { r2_path: r2Path } : {}) };
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
		"Optional per-file transforms applied before storing: pdf:true converts each download to PDF (HTML/text/images → PDF), gzip:true gzips it (level 9). ttl_seconds is an OPT-IN ephemeral knob — the handle is PERMANENT by default (R2+CAS makes keeping everything nearly free); pass ttl_seconds only for a scratch download that should self-clean. " +
		"dropbox: an app-folder folder path (e.g. '/Downloads') — when set, each stored file is ALSO projected R2→Dropbox in the background (fire-and-forget, best-effort; a failed projection never fails the put). R2 stays canonical (this is a COPY, not a move); the response's ref is unaffected, and each item gains a `dropbox_path` (filename derived from the URL basename, sanitized and de-duplicated against the rest of this batch). " +
		"r2_path: an app-managed browsable folder prefix (e.g. 'library') — when set, each stored file is ALSO written under files/<r2_path>/<name> in the same R2 bucket, so it shows up in a Finder-grade S3-client browse (Cyberduck/Mountain Duck/rclone) alongside the opaque cas/ objects. The canonical /s/ ref is unaffected; each item gains an `r2_path` (filename derived from the URL basename, sanitized and de-duplicated against the rest of this batch and any existing object at that path — collisions are suffixed, never overwritten). " +
		"Each ref is a world-readable, unauthenticated URL, so a FRESH put STAGES A PREVIEW BY DEFAULT (nothing fetched or written) — re-call with the returned commit_token to run, or pass force:true to run in one shot. " +
		"Returns a JSON array of { url, status, src_bytes, bytes, content_type, ref, applied?, dropbox_path?, r2_path? } (or { url, error } / { url, oversize } for a skipped one). Composes batch_fetch (download), pdf (convert) and the store — the bulk sibling of `store`.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["urls"],
		properties: {
			urls: { type: "array", items: { type: "string" }, maxItems: 100, description: "Absolute http(s) URLs to download and store (max 100)." },
			method: { type: "string", default: "GET", description: "HTTP method (default GET)." },
			pdf: { type: "boolean", default: false, description: "Convert each downloaded file to PDF before storing (HTML/text/images → PDF)." },
			gzip: { type: "boolean", default: false, description: "Gzip each file (level 9) before storing." },
			ttl_seconds: { type: "integer", minimum: 1, description: "Seconds until each uuid handle self-expires. Handles are permanent by default; pass this only for a scratch download that should self-clean." },
			dropbox: { type: "string", description: "App-folder folder path (e.g. '/Downloads') to also stream each stored file into, R2→Dropbox, in the background. Omit to skip the Dropbox projection entirely (R2-only, today's default)." },
			r2_path: { type: "string", description: "App-managed browsable folder prefix (e.g. 'library') under which each stored file is ALSO written as files/<r2_path>/<name> — the canonical /s/ ref is unaffected. Filename derived from the URL basename (sanitized, de-duplicated against the rest of this batch and any existing R2 object at that path — collisions are suffixed, never overwritten). Omit to skip this projection entirely (R2-CAS-only, today's default)." },
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
		let dropboxFolder: string | undefined;
		if (args?.dropbox !== undefined) {
			if (typeof args.dropbox !== "string" || !args.dropbox.trim()) return fail("`dropbox` must be a non-empty folder path (e.g. '/Downloads').");
			if (!hasDropbox(env)) return fail("`dropbox` requires Dropbox to be configured (DROPBOX_REFRESH_TOKEN + DROPBOX_APP_KEY, or DROPBOX_TOKEN) — set it, or omit `dropbox` to store in R2 only.");
			dropboxFolder = normDropboxFolder(args.dropbox);
		}
		let r2Path: string | undefined;
		if (args?.r2_path !== undefined) {
			if (typeof args.r2_path !== "string" || !args.r2_path.trim()) return fail("`r2_path` must be a non-empty folder path (e.g. 'library').");
			r2Path = normR2Folder(args.r2_path);
		}
		// R2+CAS makes keeping everything nearly free — a fresh put's handle is permanent
		// unless the caller opts into a self-expiring one via ttl_seconds.
		const opts: Opts = { method: String(args?.method ?? "GET").toUpperCase(), pdf: args?.pdf === true, gzip: args?.gzip === true, ttlSeconds, dropboxFolder, r2Path };

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
			// Shared across the whole batch (not per-URL) so two URLs whose basenames collide
			// get distinct Dropbox filenames instead of racing to overwrite each other.
			const dropboxNames = new Set<string>();
			// Independent Set from dropboxNames (#1382) — files/ and the Dropbox app folder
			// are separate projections that can each have their own collision history.
			const r2Names = new Set<string>();
			const raw = await pool(urls, CONCURRENCY, (rawUrl) => processUrl(env, rawUrl, opts, budget, dropboxNames, r2Names), deadline);
			// Un-run URLs (time budget hit) come back undefined; surface each as skipped so
			// the array stays 1:1 with `urls` and the caller sees exactly what didn't run.
			return raw.map((r, i) => r ?? { url: typeof urls[i] === "string" ? (urls[i] as string) : "", error: "[timeout] skipped: put time budget reached before this URL was processed." });
		};

		const payload = { urls, method: opts.method, pdf: opts.pdf, gzip: opts.gzip, ttl_seconds: opts.ttlSeconds, dropbox: opts.dropboxFolder ?? null, r2_path: opts.r2Path ?? null };
		const preview = { action: "put batch", url_count: urls.length, ttl_seconds: opts.ttlSeconds ?? "permanent", ...(opts.pdf || opts.gzip ? { transforms: [...(opts.pdf ? ["pdf"] : []), ...(opts.gzip ? ["gzip"] : [])] } : {}), ...(opts.dropboxFolder !== undefined ? { dropbox: opts.dropboxFolder } : {}), ...(opts.r2Path !== undefined ? { r2_path: opts.r2Path } : {}), sample_urls: urls.slice(0, 5).map((u) => (typeof u === "string" ? u : "")) };
		const gateArgs = { stage: args?.stage === true, commit_token: args?.commit_token ? String(args.commit_token) : undefined, force: args?.force === true };
		try {
			const out = await staged(env, "put_batch", gateArgs, payload, preview, runBatch);
			return ok(oj("stageResult" in out ? out.stageResult : out.result));
		} catch (e) {
			return fail(errMsg(e));
		}
	},
};
