import { DROPBOX_CONTENT as CONTENT, type DropboxScope, dropboxFetch, dropboxRpc, headerSafeJson, MAX_INLINE_BYTES, scopeConfigured, TEXT_EXT } from "./_dropbox-core";
import { type RtEnv } from "../registry";
import { FANOUT_BUDGET_MS, fromB64, toB64 } from "./_util";
import { pdf } from "./pdf";

// Full-Dropbox (Mode B) client — READ/SEARCH and (separately armed) WRITE over the WHOLE
// Dropbox, behind a SEPARATE full-scope credential (DROPBOX_FULL_*) at a DISTINCT KV key.
// This never touches the App-folder credential (Mode A stays the /Apps/<app>/ safety wall).
// TWO gates, deliberately split: READ/search are dormant unless hasDropboxFull(env) (the
// credential); the WHOLE-ACCOUNT MUTATION verbs below (write/upload/delete/move/operate/
// transform) also require hasDropboxFullWrite(env) — a SEPARATE DROPBOX_FULL_WRITE_ENABLED
// toggle that is UNSET by default. So lighting up recall's files source (read) does NOT arm
// the injection-reachable delete/overwrite surface; whole-account write stays a deliberate,
// separately-flagged step. Design + adversarial review: the design-full-dropbox-mode-b workflow.
//
// Token lifecycle + fetch/rpc plumbing is the shared _dropbox-core (same mint/cache/
// self-heal as Mode A); only the credential set + KV key differ, captured in fullScope.
// Auth mirrors Mode A's public-client (PKCE, secretless) refresh.

const fullScope = (env: RtEnv): DropboxScope => ({
	tokenKey: "sux:dropbox:full:token",
	refreshToken: env.DROPBOX_FULL_REFRESH_TOKEN,
	appKey: env.DROPBOX_FULL_APP_KEY,
	appSecret: env.DROPBOX_FULL_APP_SECRET,
	staticToken: env.DROPBOX_FULL_TOKEN,
	label: "Dropbox-full",
	notConfigured: "Full-Dropbox not configured. Set DROPBOX_FULL_REFRESH_TOKEN + DROPBOX_FULL_APP_KEY (+ optional DROPBOX_FULL_APP_SECRET).",
});

/** True when the full-Dropbox (Mode B) credential is configured — gates READ/search. */
export const hasDropboxFull = (env: RtEnv): boolean => scopeConfigured(fullScope(env));

// A truthy toggle ("0"/"false"/"no"/"off"/empty ⇒ off), so an explicit DROPBOX_FULL_WRITE_ENABLED=0
// stays off rather than arming on mere presence — mirrors _mail_triage/_briefing's flagOn.
const flagOn = (v: string | undefined): boolean => {
	const s = String(v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
};

/** True when the whole-account WRITE verbs (write/upload/delete/move/operate/transform) are ARMED.
 *  Requires the read credential too — so a stray flag without DROPBOX_FULL_* never arms anything —
 *  AND the SEPARATE DROPBOX_FULL_WRITE_ENABLED toggle, which is unset by default. This is the
 *  security boundary: enabling Mode B READ (recall's files source) must NOT arm the injection-
 *  reachable whole-account mutation surface. An env flag is not injection-settable (unlike force:true). */
export const hasDropboxFullWrite = (env: RtEnv): boolean => hasDropboxFull(env) && flagOn(env.DROPBOX_FULL_WRITE_ENABLED);

/** Absolute Dropbox path: "" = account root; a file/folder is "/Foo/bar". Resolves '.'/'..'
 *  segments (clamped at root, never escaping above it) so protectedPrefixes' startsWith fence
 *  can't be bypassed by a path Dropbox would resolve differently server-side, e.g.
 *  '/Public/../Private/x' → '/Private/x'. */
export const normFull = (p: unknown): string => {
	const segs: string[] = [];
	for (const seg of String(p ?? "").trim().split("/")) {
		if (!seg || seg === ".") continue;
		if (seg === "..") segs.pop();
		else segs.push(seg);
	}
	return segs.length ? `/${segs.join("/")}` : "";
};

// Thin per-scope binders so the read/write/search call sites read as before.
const fullFetch = (env: RtEnv, url: string, build: (t: string) => RequestInit): Promise<Response> => dropboxFetch(env, fullScope(env), url, build);
const fullRpc = (env: RtEnv, path: string, body: unknown): Promise<{ status: number; json: any }> => dropboxRpc(env, fullScope(env), path, body);

const fileEntry = (m: any) => ({ kind: m?.[".tag"], name: m?.name, path: m?.path_display ?? m?.path_lower, size: m?.size, rev: m?.rev, modified: m?.server_modified, content_hash: m?.content_hash });

/** Whole-Dropbox search (files/search_v2). Read-only, handles only (never bytes). */
export async function searchFull(env: RtEnv, opts: { query: string; path_prefix?: string; ext?: string[]; max_results?: number; cursor?: string }): Promise<{ matches: any[]; has_more: boolean; cursor?: string }> {
	let r: { status: number; json: any };
	if (opts.cursor) {
		r = await fullRpc(env, "/files/search/continue_v2", { cursor: opts.cursor });
	} else {
		const options: Record<string, unknown> = { max_results: Math.min(1000, Math.max(1, opts.max_results ?? 100)), file_status: "active", filename_only: false };
		const pp = normFull(opts.path_prefix); // normalize FIRST — '/' → '' means whole account, so omit it
		if (pp) options.path = pp; // omit (incl. '/') → whole account; Dropbox rejects options.path:''
		if (opts.ext?.length) options.file_extensions = opts.ext.map((e) => String(e).replace(/^\./, ""));
		r = await fullRpc(env, "/files/search_v2", { query: opts.query, options });
	}
	if (r.status >= 400) throw new Error(`Dropbox search error: ${r.json?.error_summary ?? `HTTP ${r.status}`}`);
	const matches = (r.json?.matches ?? []).map((m: any) => fileEntry(m?.metadata?.metadata)).filter((e: any) => e.path);
	return { matches, has_more: !!r.json?.has_more, cursor: r.json?.has_more ? r.json?.cursor : undefined };
}

/** List an absolute Dropbox folder ("" = account root). Read-only. */
export async function listFull(env: RtEnv, path: string, cursor?: string): Promise<{ entries: any[]; has_more: boolean; cursor?: string }> {
	const r = cursor ? await fullRpc(env, "/files/list_folder/continue", { cursor }) : await fullRpc(env, "/files/list_folder", { path: normFull(path), recursive: false, include_mounted_folders: true, include_non_downloadable_files: false });
	if (r.status >= 400) throw new Error(`Dropbox list error: ${r.json?.error_summary ?? `HTTP ${r.status}`}`);
	return { entries: (r.json?.entries ?? []).map(fileEntry), has_more: !!r.json?.has_more, cursor: r.json?.has_more ? r.json?.cursor : undefined };
}

/** Whole-account change feed — RECURSIVE, INCLUDING deletions (unlike listFull, which hardcodes
 *  recursive:false and drops deletions). Built for incremental corpus tracking (_files_semantic.ts's
 *  cursor-keyed index), not browsing: a caller pages this the way it pages Email/changes, applying
 *  `entries` (live, upserted) and `deleted` (removed paths) to its own derived state. Unlike
 *  searchFull/listFull's has_more-gated cursor, list_folder/list_folder_continue's result ALWAYS
 *  carries a cursor (ListFolderResult/ListFolderContinueResult), so it's returned unconditionally —
 *  a caller anchors its next incremental call on it regardless of has_more. */
export async function listFullChanges(env: RtEnv, cursor?: string): Promise<{ entries: any[]; deleted: string[]; has_more: boolean; cursor?: string }> {
	const r = cursor
		? await fullRpc(env, "/files/list_folder/continue", { cursor })
		: await fullRpc(env, "/files/list_folder", { path: "", recursive: true, include_deleted: true, include_mounted_folders: true, include_non_downloadable_files: false });
	if (r.status >= 400) throw new Error(`Dropbox list error: ${r.json?.error_summary ?? `HTTP ${r.status}`}`);
	const raw: any[] = r.json?.entries ?? [];
	const entries = raw.filter((m) => m?.[".tag"] !== "deleted").map(fileEntry);
	const deleted = raw
		.filter((m) => m?.[".tag"] === "deleted")
		.map((m) => m?.path_display ?? m?.path_lower)
		.filter((p): p is string => typeof p === "string" && p.length > 0);
	return { entries, deleted, has_more: !!r.json?.has_more, cursor: r.json?.cursor };
}

/** Read one file at an absolute path. Oversize → a TEMPORARY (expiring, NON-public) link, never a permanent share.
 *  ONE reference (the plain path `p`) gates AND downloads — never a rev/id that could point elsewhere. Reading a
 *  specific revision is intentionally NOT supported: it would let the size gate check one object and the download
 *  fetch another, bypassing the oversize cap (adversarial-review: injection-reachable OOM). Mode A `get` is the same. */
export async function readFull(env: RtEnv, path: string): Promise<Record<string, unknown>> {
	const p = normFull(path);
	if (!p) throw new Error("read requires a file path.");
	const meta = await fullRpc(env, "/files/get_metadata", { path: p });
	if (meta.status >= 400) throw new Error(`Dropbox error: ${meta.json?.error_summary ?? `HTTP ${meta.status}`} (${p})`);
	if (meta.json?.[".tag"] === "folder") throw new Error(`'${p}' is a folder — use files_list.`);
	const size = Number(meta.json?.size);
	if (!Number.isFinite(size)) throw new Error(`Dropbox returned no size for '${p}'; refusing an unbounded download.`);
	if (size > MAX_INLINE_BYTES) {
		// TEMPORARY link (expires ~4h, NOT a public share) — a full-scope path must never
		// be turned into a permanent 'anyone with the link' URL (adversarial-review CRITICAL).
		const tl = await fullRpc(env, "/files/get_temporary_link", { path: p });
		if (tl.status >= 400 || !tl.json?.link) throw new Error(`Dropbox temporary-link error: ${tl.json?.error_summary ?? `HTTP ${tl.status}`} (${p})`);
		return { path: meta.json?.path_display ?? p, size, rev: meta.json?.rev, too_large_to_inline: true, temporary_link: tl.json.link, note: "temporary link, expires in ~4h" };
	}
	const resp = await fullFetch(env, `${CONTENT}/files/download`, (t) => ({ method: "POST", headers: { Authorization: `Bearer ${t}`, "Dropbox-API-Arg": headerSafeJson({ path: p }) }, signal: AbortSignal.timeout(60_000) }));
	if (resp.status >= 400) throw new Error(`Dropbox download error: ${(await resp.text().catch(() => "")).slice(0, 200) || `HTTP ${resp.status}`}`);
	const bytes = new Uint8Array(await resp.arrayBuffer());
	const textual = TEXT_EXT.test(p);
	return textual
		? { path: meta.json?.path_display ?? p, size: bytes.length, rev: meta.json?.rev, text: new TextDecoder().decode(bytes) }
		: { path: meta.json?.path_display ?? p, size: bytes.length, rev: meta.json?.rev, base64: toB64(bytes) };
}

// ── Mode B WRITE firewall ────────────────────────────────────────────────────
// Because Mode B's credential has NO scope wall (it can touch the whole account),
// every mutating verb carries the plan→confirm→mutate→report firewall from
// files.md §6. This is an ACCIDENT guard (not an injection boundary — an injected
// tool-call can set the same flags): the real containment is recoverability
// (Dropbox 'Deleted files' + version history + a pre-op .trash copy on overwrite),
// rev-conditioning (a concurrent edit fails loudly, never clobbers), dry-run by
// default (you always see the plan first), and a configurable protected-prefix
// deny-list. Read verbs above cannot reach any of this.

const TRASH_ROOT = "/.sux-trash";

/** Configured deny-list prefixes (absolute, lowercased). Empty when unset. */
const protectedPrefixes = (env: RtEnv): string[] =>
	String(env.DROPBOX_FULL_PROTECT_PREFIXES ?? "")
		.split(",")
		.map((s) => normFull(s).toLowerCase())
		.filter(Boolean);

/** Normalize + refuse a mutating target: never the account root, never under a protected prefix. */
function fenceFull(env: RtEnv, path: unknown): string {
	const p = normFull(path);
	if (!p) throw new Error("refusing to mutate the Dropbox account root ('').");
	const low = p.toLowerCase();
	for (const pre of protectedPrefixes(env)) {
		if (low === pre || low.startsWith(`${pre}/`)) throw new Error(`'${p}' is under a protected prefix (${pre}) — refused. Widen DROPBOX_FULL_PROTECT_PREFIXES to allow it.`);
	}
	return p;
}

/** Copy a file to /.sux-trash/<ts>/<path> so an overwrite is browsably recoverable (belt to version history's suspenders). */
async function copyToTrash(env: RtEnv, path: string, stamp: string): Promise<string> {
	const dest = `${TRASH_ROOT}/${stamp}${path}`;
	const r = await fullRpc(env, "/files/copy_v2", { from_path: path, to_path: dest, autorename: true });
	if (r.status >= 400) throw new Error(`Dropbox backup(copy) error: ${r.json?.error_summary ?? `HTTP ${r.status}`} (${path})`);
	return r.json?.metadata?.path_display ?? dest;
}

const stampNow = (): string => new Date().toISOString().replace(/[:.]/g, "-");

/** Write a file anywhere in the account. dry-run by default; existing files need overwrite:true OR a matching rev. */
export async function writeFull(env: RtEnv, opts: { path: string; bytes: Uint8Array; rev?: string; overwrite?: boolean; backup?: boolean; dryRun: boolean }): Promise<Record<string, unknown>> {
	const p = fenceFull(env, opts.path);
	const meta = await fullRpc(env, "/files/get_metadata", { path: p });
	if (meta.status >= 400 && meta.status !== 409) throw new Error(`Dropbox metadata error: ${meta.json?.error_summary ?? `HTTP ${meta.status}`} (${p})`);
	const existing = meta.status < 400 ? meta.json : null;
	if (existing?.[".tag"] === "folder") throw new Error(`'${p}' is a folder — refusing to overwrite it with a file.`);
	const exists = existing?.[".tag"] === "file";
	if (exists && !opts.overwrite && !opts.rev) throw new Error(`'${p}' already exists (rev ${existing?.rev}). Pass overwrite:true to replace it, or rev:'${existing?.rev}' for a conditional update.`);
	if (opts.rev && exists && opts.rev !== existing?.rev) throw new Error(`rev mismatch for '${p}': you have ${opts.rev}, current is ${existing?.rev}. Re-read and retry.`);
	const willBackup = exists && opts.backup !== false;
	if (opts.dryRun) {
		return { action: "write", scope: "full-dropbox", path: p, exists, will_overwrite: exists, bytes: opts.bytes.length, rev_condition: opts.rev ?? null, ...(willBackup ? { backup_to: TRASH_ROOT } : {}), note: "DRY RUN — nothing written. Re-call with dry_run:false to apply." };
	}
	const backup = willBackup ? await copyToTrash(env, p, stampNow()) : undefined;
	// `update` conditions on an existing revision — only valid when the file EXISTS. A rev supplied
	// for a missing path (e.g. a stale handle) must fall back to `add`, not build a doomed update.
	const mode = opts.rev && exists ? { ".tag": "update", update: opts.rev } : exists ? "overwrite" : "add";
	const resp = await fullFetch(env, `${CONTENT}/files/upload`, (t) => ({
		method: "POST",
		headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/octet-stream", "Dropbox-API-Arg": headerSafeJson({ path: p, mode, autorename: false, mute: true }) },
		body: opts.bytes,
		signal: AbortSignal.timeout(60_000),
	}));
	if (resp.status >= 400) throw new Error(`Dropbox upload error: ${(await resp.text().catch(() => "")).slice(0, 200) || `HTTP ${resp.status}`} (${p})`);
	const j: any = await resp.json().catch(() => null);
	return { ok: true, action: "write", scope: "full-dropbox", path: j?.path_display ?? p, size: j?.size ?? opts.bytes.length, rev: j?.rev, ...(backup ? { backup } : {}) };
}

/** Delete a file/folder anywhere in the account. dry-run by default; caller supplies confirm at the tool layer. Recoverable in Dropbox 'Deleted files'. */
export async function deleteFull(env: RtEnv, opts: { path: string; dryRun: boolean }): Promise<Record<string, unknown>> {
	const p = fenceFull(env, opts.path);
	const meta = await fullRpc(env, "/files/get_metadata", { path: p });
	if (meta.status >= 400) throw new Error(`Dropbox error: ${meta.json?.error_summary ?? `HTTP ${meta.status}`} (${p}) — nothing deleted.`);
	if (opts.dryRun) {
		return { action: "delete", scope: "full-dropbox", path: p, kind: meta.json?.[".tag"], note: "DRY RUN — nothing deleted. Re-call with dry_run:false + confirm:true to apply. Deletes are recoverable in Dropbox 'Deleted files'." };
	}
	const r = await fullRpc(env, "/files/delete_v2", { path: p });
	if (r.status >= 400) throw new Error(`Dropbox delete error: ${r.json?.error_summary ?? `HTTP ${r.status}`} (${p})`);
	return { ok: true, action: "delete", scope: "full-dropbox", deleted: r.json?.metadata?.path_display ?? p, note: "Recoverable in Dropbox 'Deleted files'." };
}

/** Move/rename anywhere in the account. dry-run by default; reversible by moving back. */
export async function moveFull(env: RtEnv, opts: { from: string; to: string; dryRun: boolean }): Promise<Record<string, unknown>> {
	const f = fenceFull(env, opts.from);
	const t = fenceFull(env, opts.to);
	if (f === t) throw new Error("move: `to` equals `from` — nothing to move.");
	if (opts.dryRun) {
		return { action: "move", scope: "full-dropbox", from: f, to: t, note: "DRY RUN — nothing moved. Re-call with dry_run:false to apply." };
	}
	const r = await fullRpc(env, "/files/move_v2", { from_path: f, to_path: t, autorename: false });
	if (r.status >= 400) throw new Error(`Dropbox move error: ${r.json?.error_summary ?? `HTTP ${r.status}`} (${f} → ${t})`);
	return { ok: true, action: "move", scope: "full-dropbox", from: f, to: r.json?.metadata?.path_display ?? t };
}

// files_operate — the find→plan→apply firewall (files.md §4-6). It gathers a target set
// (a whole-account search OR explicit handles), and either returns a dry PLAN (default) or
// APPLIES an action over the set by composing the ALREADY-GATED primitives (moveFull /
// deleteFull) — never raw mutation. Every per-item op keeps its own fence + rev-safety +
// recoverability; operate adds the plan/apply gate and a hard cap on blast radius. It does
// move (organize) + delete (cleanup); the content-transform leg (merge N→1, extract a slice)
// lives in transformFull below — same write firewall, different set-building.
export async function operateFull(
	env: RtEnv,
	opts: { find?: { query?: string; path_prefix?: string; ext?: string[] }; handles?: string[]; action: "move" | "delete"; dest?: string; apply: boolean; confirm?: boolean; max?: number; deadline?: number },
): Promise<Record<string, unknown>> {
	const max = Math.min(500, Math.max(1, Number(opts.max) || 100));
	let paths: string[] = [];
	let truncated = false;
	// Normalize every gathered path (normFull strips trailing/duplicate slashes) so a
	// handle like "/OldPhotos/" can't lose its basename at the move step below.
	if (opts.handles?.length) {
		paths = opts.handles.map((h) => normFull(h)).filter(Boolean);
	} else if (opts.find?.query) {
		const res = await searchFull(env, { query: opts.find.query, path_prefix: opts.find.path_prefix, ext: opts.find.ext, max_results: max });
		paths = res.matches.map((m) => normFull(m.path)).filter(Boolean);
		truncated = res.has_more;
	} else {
		throw new Error("operate needs a `find` query or an explicit `handles` list.");
	}
	if (paths.length > max) {
		paths = paths.slice(0, max);
		truncated = true;
	}
	// Normalize the dest FIRST — a raw '/' is truthy but normFull('/') === '', so guarding on
	// `!opts.dest` lets it slip through and every file lands at the account root. Guard on the
	// normalized value so an empty/root dest is refused.
	const dest = opts.dest ? normFull(opts.dest) : "";
	if (opts.action === "move" && !dest) throw new Error("operate move needs a `dest` folder.");

	if (!opts.apply) {
		return {
			plan: true,
			action: opts.action,
			matched: paths.length,
			...(truncated ? { truncated: true, cap: max } : {}),
			...(opts.action === "move" ? { dest } : {}),
			targets: paths,
			note: `Plan only — nothing changed. Pass apply:true${opts.action === "delete" ? " + confirm:true" : ""} to execute. Each op is fenced, rev-safe, and recoverable.`,
		};
	}
	if (opts.action === "delete" && opts.confirm !== true) throw new Error("operate delete apply requires confirm:true.");
	// Time budget: this loop mutates whole-Dropbox one path at a time; a wide set can
	// exceed index.ts's 60s FN_DEADLINE_MS, which would kill the run AFTER an unknown
	// subset already committed and report only a timeout. Stop claiming new paths at
	// the soft budget and return applied-so-far, flagged, so the caller knows the set
	// was NOT fully applied. Absolute-timestamp `deadline` is injectable for tests.
	const deadline = opts.deadline ?? Date.now() + FANOUT_BUDGET_MS;
	let timedOut = false;
	const results: Array<Record<string, unknown>> = [];
	for (const p of paths) {
		if (Date.now() >= deadline) {
			timedOut = true;
			break;
		}
		try {
			if (opts.action === "move") {
				const base = p.split("/").filter(Boolean).pop() ?? ""; // robust basename — never empty for a normalized path
				results.push(await moveFull(env, { from: p, to: `${dest}/${base}`, dryRun: false }));
			} else {
				results.push(await deleteFull(env, { path: p, dryRun: false }));
			}
		} catch (e) {
			results.push({ path: p, error: String((e as Error)?.message ?? e).slice(0, 150) });
		}
	}
	// Distinct truncation causes: `truncated` (input side — more matches than `max`
	// fetched) vs `timedOut` (output side — the time budget stopped the apply mid-set).
	const trunc: Record<string, unknown> = {};
	if (truncated) {
		trunc.truncated = true;
		trunc.cap = max;
	}
	if (timedOut) {
		trunc.truncated = true;
		trunc.reason = "time";
		trunc.skipped = paths.length - results.length;
	}
	return { applied: results.filter((r) => r.ok).length, of: paths.length, action: opts.action, ...trunc, results };
}

/** Build write bytes from either utf-8 text or base64 (for the tool layer). */
export const writeBytes = (text?: string, base64?: string): Uint8Array => {
	if (typeof base64 === "string" && base64) return fromB64(base64);
	return new TextEncoder().encode(typeof text === "string" ? text : "");
};

// ── Mode B content transforms (merge / extract) ──────────────────────────────
// The content-transform leg of files.md §4-6: build result BYTES from other files'
// bytes (read edge-side via readFull, so no payload transits context), then write
// them back through the SAME writeFull firewall (fence, rev-safety, dry-run default,
// /.sux-trash backup) — no new mutation path. Merge is the only op with an existing
// primitive to compose (the `pdf` fn, for the pdf mode); concat and slice are written
// here because no fn does raw byte/line slicing of an arbitrary file. Dry-run by default:
// the sources are still read (reads are free + safe) so the plan reports real sizes.

const MERGE_MAX_SOURCES = 20;
/** Hard cap on any transform's output, bounding Worker memory/cost. */
const TRANSFORM_MAX_BYTES = 25 * 1024 * 1024;

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
	let o = 0;
	for (const c of chunks) {
		out.set(c, o);
		o += c.length;
	}
	return out;
}

/** Read one transform source to raw bytes. Refuses an oversize (link-only) source: a transform
 *  composes bytes, and readFull returns a link (not bytes) above the inline cap — so silently
 *  merging/slicing would drop it. `isText` gates line-range (only text decodes to lines). */
async function readTransformSource(env: RtEnv, path: string): Promise<{ path: string; bytes: Uint8Array; isText: boolean }> {
	const p = normFull(path);
	if (!p) throw new Error("transform source path is empty.");
	const r = await readFull(env, p);
	if (r.too_large_to_inline) throw new Error(`source '${p}' is ${r.size} bytes — over the ${MAX_INLINE_BYTES}-byte inline cap, so it reads as a link, not bytes. A transform can't compose a link; narrow the set.`);
	if (typeof r.base64 === "string") return { path: p, bytes: fromB64(r.base64), isText: false };
	return { path: p, bytes: new TextEncoder().encode(String(r.text ?? "")), isText: true };
}

/** Merge N files→one (raw-byte concat, or render+merge into a PDF), or extract a byte/line slice —
 *  then write the result through writeFull's firewall. dry-run by default (reads run; the write is
 *  planned, not applied). Fail-closed: gate on hasDropboxFull one level up, like the other ops. */
export async function transformFull(
	env: RtEnv,
	opts: {
		op: "merge" | "extract";
		sources?: string[];
		mode?: "concat" | "pdf";
		source?: string;
		byte_range?: [number, number];
		line_range?: [number, number];
		dest: string;
		dryRun: boolean;
		overwrite?: boolean;
		backup?: boolean;
	},
): Promise<Record<string, unknown>> {
	// Fence dest up front so a protected/root target is refused before any source read.
	const dest = fenceFull(env, opts.dest);
	const write = (bytes: Uint8Array) => writeFull(env, { path: dest, bytes, overwrite: opts.overwrite, backup: opts.backup, dryRun: opts.dryRun });

	if (opts.op === "merge") {
		const sources = (opts.sources ?? []).map((s) => normFull(s)).filter(Boolean);
		if (sources.length < 2) throw new Error("merge needs at least 2 source paths.");
		if (sources.length > MERGE_MAX_SOURCES) throw new Error(`merge is capped at ${MERGE_MAX_SOURCES} sources (got ${sources.length}).`);
		if (sources.includes(dest) && opts.overwrite !== true) throw new Error(`dest '${dest}' is also a source — pass overwrite:true to replace it in place.`);
		// Independent source reads (each a metadata fetch + content download) — fan out
		// and let Promise.all preserve source order, rather than serializing the round trips.
		const read = await Promise.all(sources.map((s) => readTransformSource(env, s)));
		const mode = opts.mode ?? (sources.every((s) => /\.pdf$/i.test(s)) ? "pdf" : "concat");
		let bytes: Uint8Array;
		if (mode === "pdf") {
			// The one "compose via the pdf fn" case: render each source to PDF page(s) and merge in order.
			const res = await pdf.run(env, { sources: read.map((r) => ({ data: toB64(r.bytes), kind: "auto" })), as: "base64" });
			if (res.isError) throw new Error(`merge(pdf) failed: ${String(res.content?.[0]?.text ?? "").slice(0, 200)}`);
			bytes = fromB64(JSON.parse(res.content[0].text).base64);
		} else {
			bytes = concatBytes(read.map((r) => r.bytes));
		}
		if (bytes.length > TRANSFORM_MAX_BYTES) throw new Error(`merged output is ${bytes.length} bytes — over the ${TRANSFORM_MAX_BYTES}-byte transform cap.`);
		return { op: "merge", scope: "full-dropbox", mode, inputs: read.map((r) => ({ path: r.path, size: r.bytes.length })), output_bytes: bytes.length, ...(await write(bytes)) };
	}

	// extract — exactly one of byte_range / line_range, slicing one source.
	const source = normFull(opts.source ?? "");
	if (!source) throw new Error("extract needs a `source` path.");
	const hasByte = Array.isArray(opts.byte_range);
	const hasLine = Array.isArray(opts.line_range);
	if (hasByte === hasLine) throw new Error("extract needs exactly one of `byte_range` or `line_range`.");
	if (source === dest && opts.overwrite !== true) throw new Error(`dest '${dest}' is also the source — pass overwrite:true to replace it in place.`);
	const r = await readTransformSource(env, source);
	let bytes: Uint8Array;
	let range: Record<string, unknown>;
	if (hasByte) {
		const [start, rawEnd] = opts.byte_range!.map((n) => Math.floor(Number(n)));
		if (!Number.isFinite(start) || !Number.isFinite(rawEnd) || start < 0 || rawEnd <= start) throw new Error(`byte_range [${start},${rawEnd}] is invalid — need 0 <= start < end.`);
		if (start >= r.bytes.length) throw new Error(`byte_range start ${start} is past end-of-file (${r.bytes.length} bytes).`);
		const end = Math.min(rawEnd, r.bytes.length);
		bytes = r.bytes.slice(start, end);
		range = { byte_range: [start, end] };
	} else {
		// Lines are text-only: a binary/undecoded source has no meaningful \n structure.
		if (!r.isText) throw new Error("line_range needs text content — the source didn't decode as text (binary/undecoded).");
		const [start, rawEnd] = opts.line_range!.map((n) => Math.floor(Number(n)));
		if (!Number.isFinite(start) || !Number.isFinite(rawEnd) || start < 0 || rawEnd <= start) throw new Error(`line_range [${start},${rawEnd}] is invalid — need 0 <= start < end.`);
		const lines = new TextDecoder().decode(r.bytes).split("\n");
		if (start >= lines.length) throw new Error(`line_range start ${start} is past the last line (${lines.length} lines).`);
		const end = Math.min(rawEnd, lines.length);
		const slice = lines.slice(start, end);
		bytes = new TextEncoder().encode(slice.join("\n"));
		range = { line_range: [start, end], lines: slice.length };
	}
	if (!bytes.length) throw new Error("extract produced an empty slice — refusing to write nothing.");
	if (bytes.length > TRANSFORM_MAX_BYTES) throw new Error(`extracted slice is ${bytes.length} bytes — over the ${TRANSFORM_MAX_BYTES}-byte transform cap.`);
	return { op: "extract", scope: "full-dropbox", source, ...range, output_bytes: bytes.length, ...(await write(bytes)) };
}
