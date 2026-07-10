import { type RtEnv } from "../registry";
import { fromB64, toB64 } from "./_util";

// Full-Dropbox (Mode B) client — READ + SEARCH over the WHOLE Dropbox, behind a
// SEPARATE full-scope credential (DROPBOX_FULL_*) at a DISTINCT KV key. This never
// touches the App-folder credential (Mode A stays the /Apps/<app>/ safety wall), and
// it is dormant unless hasDropboxFull(env). Read-only by construction: no upload/move/
// delete lives here — whole-account MUTATION is a deliberate, separately-gated build
// (see docs/proposals/files.md Mode B: the injection-reachable delete/overwrite surface
// needs the vault-mirror guard configured fail-closed first). Design + adversarial
// review: the design-full-dropbox-mode-b workflow.
//
// Auth mirrors dropbox.ts's public-client (PKCE, secretless) refresh: mint a short-lived
// access token from the full refresh token, cache it in KV under a full-only key, and
// self-heal a 401 by re-minting once.

const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";
const OAUTH_TOKEN_URL = "https://api.dropbox.com/oauth2/token";
const FULL_TOKEN_KEY = "sux:dropbox:full:token";

/** Oversize gate: above this, read returns a TEMPORARY (expiring, non-public) link, never bytes. */
const MAX_INLINE_BYTES = 4 * 1024 * 1024;
const TEXT_EXT = /\.(md|txt|json|csv|tsv|ya?ml|xml|html?|js|ts|css)$/i;

/** True when the full-Dropbox (Mode B) credential is configured. */
export const hasDropboxFull = (env: RtEnv): boolean =>
	Boolean((env.DROPBOX_FULL_REFRESH_TOKEN && env.DROPBOX_FULL_APP_KEY) || env.DROPBOX_FULL_TOKEN);

const headerSafeJson = (v: unknown): string => JSON.stringify(v).replace(/[-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** Absolute Dropbox path: "" = account root; a file/folder is "/Foo/bar". */
export const normFull = (p: unknown): string => {
	const s = String(p ?? "").trim().replace(/\/+$/g, "").replace(/^\/+/, "");
	return s ? `/${s}` : "";
};

async function mintFull(env: RtEnv): Promise<string> {
	const hasSecret = Boolean(env.DROPBOX_FULL_APP_SECRET);
	const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
	if (hasSecret) headers.Authorization = `Basic ${btoa(`${env.DROPBOX_FULL_APP_KEY}:${env.DROPBOX_FULL_APP_SECRET}`)}`;
	const resp = await fetch(OAUTH_TOKEN_URL, {
		method: "POST",
		headers,
		body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(String(env.DROPBOX_FULL_REFRESH_TOKEN))}${hasSecret ? "" : `&client_id=${encodeURIComponent(String(env.DROPBOX_FULL_APP_KEY))}`}`,
		signal: AbortSignal.timeout(20_000),
	});
	const j: any = await resp.json().catch(() => null);
	if (!resp.ok || !j?.access_token) throw new Error(`Dropbox-full token refresh HTTP ${resp.status}: ${j?.error_description ?? j?.error ?? "no access_token"}`);
	const ttl = Math.max(60, (Number(j?.expires_in) || 14_400) - 60);
	await env.OAUTH_KV?.put(FULL_TOKEN_KEY, String(j.access_token), { expirationTtl: ttl });
	return String(j.access_token);
}

async function fullToken(env: RtEnv): Promise<string> {
	if (env.DROPBOX_FULL_REFRESH_TOKEN && env.DROPBOX_FULL_APP_KEY) {
		const cached = await env.OAUTH_KV?.get(FULL_TOKEN_KEY);
		if (cached) return cached;
		return mintFull(env);
	}
	if (env.DROPBOX_FULL_TOKEN) return String(env.DROPBOX_FULL_TOKEN);
	throw new Error("Full-Dropbox not configured. Set DROPBOX_FULL_REFRESH_TOKEN + DROPBOX_FULL_APP_KEY (+ optional DROPBOX_FULL_APP_SECRET).");
}

/** Fetch with per-credential 401 self-heal (re-mint ONLY the full token, never Mode A's). */
async function fullFetch(env: RtEnv, url: string, build: (t: string) => RequestInit): Promise<Response> {
	const first = await fetch(url, build(await fullToken(env)));
	if (first.status !== 401 || !(env.DROPBOX_FULL_REFRESH_TOKEN && env.DROPBOX_FULL_APP_KEY)) return first;
	await env.OAUTH_KV?.delete(FULL_TOKEN_KEY).catch(() => {});
	return fetch(url, build(await fullToken(env)));
}

async function fullRpc(env: RtEnv, path: string, body: unknown): Promise<{ status: number; json: any }> {
	const resp = await fullFetch(env, `${API}${path}`, (t) => ({
		method: "POST",
		headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(20_000),
	}));
	return { status: resp.status, json: await resp.json().catch(() => null) };
}

const fileEntry = (m: any) => ({ kind: m?.[".tag"], name: m?.name, path: m?.path_display ?? m?.path_lower, size: m?.size, rev: m?.rev, modified: m?.server_modified });

/** Whole-Dropbox search (files/search_v2). Read-only, handles only (never bytes). */
export async function searchFull(env: RtEnv, opts: { query: string; path_prefix?: string; ext?: string[]; max_results?: number; cursor?: string }): Promise<{ matches: any[]; has_more: boolean; cursor?: string }> {
	let r: { status: number; json: any };
	if (opts.cursor) {
		r = await fullRpc(env, "/files/search/continue_v2", { cursor: opts.cursor });
	} else {
		const options: Record<string, unknown> = { max_results: Math.min(1000, Math.max(1, opts.max_results ?? 100)), file_status: "active", filename_only: false };
		if (opts.path_prefix) options.path = normFull(opts.path_prefix); // omit → whole account
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
	const mode = opts.rev ? { ".tag": "update", update: opts.rev } : exists ? "overwrite" : "add";
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
// recoverability; operate adds the plan/apply gate and a hard cap on blast radius. v1 does
// move (organize) + delete (cleanup); the content-transform leg (merge/extract/etc.) composes
// via the raw pdf/extract fns and is a documented next step, not raw mutation invented here.
export async function operateFull(
	env: RtEnv,
	opts: { find?: { query?: string; path_prefix?: string; ext?: string[] }; handles?: string[]; action: "move" | "delete"; dest?: string; apply: boolean; confirm?: boolean; max?: number },
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
	if (opts.action === "move" && !opts.dest) throw new Error("operate move needs a `dest` folder.");
	const dest = opts.dest ? normFull(opts.dest) : "";

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
	const results: Array<Record<string, unknown>> = [];
	for (const p of paths) {
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
	return { applied: results.filter((r) => r.ok).length, of: paths.length, action: opts.action, ...(truncated ? { truncated: true, cap: max } : {}), results };
}

/** Build write bytes from either utf-8 text or base64 (for the tool layer). */
export const writeBytes = (text?: string, base64?: string): Uint8Array => {
	if (typeof base64 === "string" && base64) return fromB64(base64);
	return new TextEncoder().encode(typeof text === "string" ? text : "");
};
