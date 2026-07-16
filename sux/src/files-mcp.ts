import { fail, failWith, type RtEnv, type ToolResult } from "./registry";
import { dropbox } from "./fns/dropbox";
import { TEXT_EXT } from "./fns/_dropbox-core";
import { deleteFull, hasDropboxFull, hasDropboxFullWrite, listFull, moveFull, operateFull, readFull, searchFull, transformFull, writeBytes, writeFull } from "./fns/_dropbox-full";
import { fingerprint, ledger } from "./ledger";
import { staged } from "./stage";
import { errMsg, pool } from "./fns/_util";

// The files MCP server — the personal blob workspace, reached through the `files_`
// front verbs on the one /mcp connector, behind the same workers-oauth-provider flow
// (zero new infra). The old /files/mcp connector is retired — its route stays dormant
// for back-compat but ships no plugin; front verbs dispatch into these handlers now.
// Mirrors vault-mcp / mail-mcp: tight, handle-disciplined tools over the built `dropbox` fn
// (App-folder scoped — it can ONLY see /Apps/<app>/, so scope is the safety wall).
// The raw `dropbox` fn is exposed here as the escape hatch. Design: docs/proposals/files.md
// (Mode A — the bidirectional app workspace). Mode B (whole-Dropbox) rides a SEPARATE
// full-scope credential (_dropbox-full.ts): read/search (files_search + files_read/
// files_list `full:true`) light up on the credential (hasDropboxFull) alone. The WRITE
// verbs — files_write/files_upload/files_delete/files_move `full:true` — require a SECOND,
// separate arm (hasDropboxFullWrite / DROPBOX_FULL_WRITE_ENABLED, unset by default) so
// enabling Mode B read never arms the injection-reachable whole-account write/delete. Once
// armed they route through the write firewall (files.md §6): the default-on smart guard
// (stage.ts: stage a preview by default, then commit_token/force to apply), over rev-
// conditioning, a protected-prefix deny-list, and /.sux-trash recoverability.
// files_operate (set organize/cleanup) and files_transform (merge N→1 /
// extract a slice) compose those same write-gated primitives server-side, no bytes through
// context. Mode B read needs the second credential; Mode B write needs that AND the arm flag.
//
// The rule (files.md): markdown → vault, blobs → files. This is where PDFs, images,
// and exports live; the vault holds the *note* about them. list/read return references
// or one file; nothing here is unrecoverable without confirm.


/** Call the dropbox fn and return its parsed JSON, throwing its error text on failure. */
async function dbx(env: RtEnv, args: Record<string, unknown>): Promise<any> {
	const r = await dropbox.run(env, args);
	const body = r.content?.[0]?.text ?? "";
	if (r.isError) throw new Error(body);
	// op=get on a textual path returns the file's RAW TEXT (a bare string), not JSON — so
	// JSON.parsing it would reshape a .json/.md/.csv whose content is valid JSON into the parsed
	// value. Wrap it as {path,text} to mirror Mode B's readFull shape. The oversize branch still
	// returns JSON metadata (too_large_to_inline), so pass a parsed object with that flag through.
	if (String(args?.op) === "get" && TEXT_EXT.test(String(args?.path ?? ""))) {
		try {
			const parsed = JSON.parse(body);
			if (parsed && typeof parsed === "object" && parsed.too_large_to_inline) return parsed;
		} catch {
			/* not JSON — it's the raw text body, wrapped below */
		}
		return { path: String(args?.path ?? ""), text: body };
	}
	try {
		return JSON.parse(body);
	} catch {
		return { text: body };
	}
}

// Mode B WRITE gate — the security boundary for whole-account mutation. Read/search gate on
// hasDropboxFull (the credential); every WRITE verb gates on this instead, which ALSO requires
// the separate DROPBOX_FULL_WRITE_ENABLED arm. So enabling Mode B read (recall's files source)
// leaves the injection-reachable write/delete surface dormant. Two-tier message: credential-
// missing vs armed-off are distinct fixes. Returns the failure ToolResult, or null when armed.
const gateModeBWrite = (env: RtEnv): ToolResult | null => {
	if (!hasDropboxFull(env)) return failWith("not_configured", "full-Dropbox (Mode B) not configured — set DROPBOX_FULL_*. Without it, files_* covers the app-folder workspace only.");
	if (!hasDropboxFullWrite(env)) return failWith("not_configured", "full-Dropbox (Mode B) WRITE is not armed — set DROPBOX_FULL_WRITE_ENABLED (a separate toggle, unset by default). Read/search light up on DROPBOX_FULL_* alone; whole-account write/delete/move stays dormant until you explicitly arm it.");
	return null;
};

// The write firewall flags only mean something for whole-Dropbox (Mode B) writes. In the
// app-folder (Mode A) — where the /Apps scope IS the wall and writes are unblocked — the
// dropbox fn always overwrites, so a supplied dry_run/overwrite/rev/backup OR a stage-guard
// flag (stage/commit_token/force) would be silently dropped and a requested guardrail (e.g.
// stage:true to preview) would become a real clobber. Reject them instead.
const rejectModeBFlags = (a: any): ToolResult | null =>
	["dry_run", "overwrite", "rev", "backup", "stage", "commit_token", "force"].some((k) => a?.[k] !== undefined)
		? failWith("bad_input", "dry_run/overwrite/rev/backup and the stage guard (stage/commit_token/force) apply only to whole-Dropbox writes (full:true). App-folder writes are unblocked — the /Apps scope is the wall.")
		: null;

type FileTool = { name: string; description: string; inputSchema: unknown; run: (env: RtEnv, args: any) => Promise<ToolResult> };
const ok = (v: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(v, null, 2) }] });

// Bounded fan-out for files_batch_put's independent Dropbox uploads — a modest cap keeps a large
// batch from opening one round trip per item serially without hammering Dropbox all at once.
const FILES_PUT_CONCURRENCY = 8;

/** The stage-guard arg triplet (mirrors mail-mcp). Threads stage/commit_token/force uniformly
 *  at every Mode-B staged() call site so the guard — not an ad-hoc dry_run/confirm pair — gates. */
const gateArgs = (a: any) => ({ stage: a?.stage === true, commit_token: a?.commit_token ? String(a.commit_token) : undefined, force: a?.force === true });

/** Run a Mode-B mutation through the smart guard. `preview` is the primitive's dry-run plan (the
 *  stage preview supersedes the old dry_run default); `mutate` applies it (supersedes dry_run:false).
 *  The primitive's own firewall — fenceFull, rev-safety, /.sux-trash backup, protected-prefix deny —
 *  stays inside `mutate`, fully intact; only the outer plan/apply gate becomes the stage guard. */
async function guard(env: RtEnv, a: any, kind: string, payload: unknown, preview: unknown, mutate: () => Promise<unknown>): Promise<ToolResult> {
	const out = await staged(env, kind, gateArgs(a), payload, preview, mutate);
	return ok("stageResult" in out ? out.stageResult : out.result);
}

const TOOLS: FileTool[] = [
	{
		name: "files_list",
		description: "List a folder. Default: the app-folder workspace (root). `full:true` lists an absolute folder in your WHOLE Dropbox ('' = account root) — needs the full-Dropbox credential (DROPBOX_FULL_*). Returns entries (name, path, kind, size, rev); paginate with `cursor` when has_more.",
		inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string", description: "Folder path (app-folder-relative, or absolute when full:true)." }, cursor: { type: "string", description: "Continue a paginated listing." }, full: { type: "boolean", description: "List the whole Dropbox (Mode B) instead of the app folder." } } },
		run: async (env, a) => {
			try {
				if (a?.full === true) {
					if (!hasDropboxFull(env)) return failWith("not_configured", "full-Dropbox (Mode B) not configured — set DROPBOX_FULL_*. Without it, files_* covers the app-folder workspace only.");
					const r = await listFull(env, String(a?.path ?? ""), a?.cursor ? String(a.cursor) : undefined);
					return ok({ scope: "full-dropbox", dir: a?.path || "/", count: r.entries.length, has_more: r.has_more, ...(r.cursor ? { cursor: r.cursor } : {}), entries: r.entries });
				}
				return ok(await dbx(env, { op: "list", ...(a?.path ? { path: a.path } : {}), ...(a?.cursor ? { cursor: a.cursor } : {}) }));
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "files_search",
		description: "Search your WHOLE Dropbox by filename + content (Mode B). Returns file REFERENCES only (path, name, size, rev, modified) — never bytes; read one with files_read full:true. Filter by ext / path_prefix (omit = whole account). Needs the separate full-Dropbox credential (DROPBOX_FULL_*) — the app-folder files_* tools don't need it.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				query: { type: "string", description: "Search text (matches filename and content)." },
				path_prefix: { type: "string", description: "Scope to a folder, e.g. '/Documents' (omit = whole account)." },
				ext: { type: "array", items: { type: "string" }, description: "Filter by extensions, e.g. ['pdf','docx']." },
				max_results: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
				cursor: { type: "string", description: "Continue a paginated search." },
			},
		},
		run: async (env, a) => {
			if (!a?.query && !a?.cursor) return failWith("bad_input", "files_search requires a `query`.");
			if (!hasDropboxFull(env)) return failWith("not_configured", "full-Dropbox search (Mode B) not configured — set DROPBOX_FULL_* (a separate full-scope Dropbox app). The app-folder files_* tools don't need it.");
			try {
				const r = await searchFull(env, { query: String(a?.query ?? ""), path_prefix: a?.path_prefix ? String(a.path_prefix) : undefined, ext: Array.isArray(a?.ext) ? a.ext.map(String) : undefined, max_results: Number(a?.max_results) || 100, cursor: a?.cursor ? String(a.cursor) : undefined });
				return ok({ scope: "full-dropbox", count: r.matches.length, has_more: r.has_more, ...(r.cursor ? { cursor: r.cursor } : {}), matches: r.matches });
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "files_read",
		description: "Read a file — text for textual formats, else base64 bytes. Large files return metadata + a link instead of inlining. Default: the app-folder workspace. `full:true` reads an ABSOLUTE path in your whole Dropbox (Mode B, read-only) — oversize there returns a TEMPORARY expiring link, never a public share. The one deliberate 'return the bytes' verb.",
		inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string", description: "File path (app-folder-relative, or absolute when full:true)." }, full: { type: "boolean", description: "Read from the whole Dropbox (Mode B) instead of the app folder." } } },
		run: async (env, a) => {
			if (!a?.path) return failWith("bad_input", "files_read requires a `path`.");
			try {
				if (a?.full === true) {
					if (!hasDropboxFull(env)) return failWith("not_configured", "full-Dropbox (Mode B) not configured — set DROPBOX_FULL_*. Without it, files_read covers the app-folder workspace only.");
					return ok({ scope: "full-dropbox", ...(await readFull(env, String(a.path))) });
				}
				return ok(await dbx(env, { op: "get", path: String(a.path) }));
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "files_write",
		description: "Write a text file. Default: create/overwrite in the app-folder workspace (returns path + shareable link). `full:true` writes an ABSOLUTE path in your whole Dropbox (Mode B) behind the write firewall: STAGES A PREVIEW BY DEFAULT (returns the plan + commit_token, writes nothing) — re-call with the commit_token, or pass force:true, to apply. Existing files need overwrite:true OR a matching rev; an overwrite is backed up to /.sux-trash first. For binary, use files_upload.",
		inputSchema: { type: "object", additionalProperties: false, required: ["path", "text"], properties: { path: { type: "string" }, text: { type: "string", description: "UTF-8 text to write." }, full: { type: "boolean", description: "Write into the whole Dropbox (Mode B) instead of the app folder." }, overwrite: { type: "boolean", description: "full mode: allow replacing an existing file." }, rev: { type: "string", description: "full mode: conditional update — write only if the file still has this rev." }, backup: { type: "boolean", description: "full mode: pre-op copy an overwritten file to /.sux-trash (default true)." }, stage: { type: "boolean", description: "Preview only: returns {preview, commit_token}, writes nothing." }, commit_token: { type: "string", description: "Apply a previously staged plan (payload must match)." }, force: { type: "boolean", description: "Apply in one shot, skipping the default stage (the ! override)." } } },
		run: async (env, a) => {
			if (!a?.path || a?.text === undefined) return failWith("bad_input", "files_write requires `path` and `text`.");
			try {
				if (a?.full === true) {
					const g = gateModeBWrite(env);
					if (g) return g;
					const path = String(a.path), text = String(a.text);
					const rev = a?.rev ? String(a.rev) : undefined, overwrite = a?.overwrite === true, backup = a?.backup !== false;
					const opts = { path, bytes: writeBytes(text, undefined), rev, overwrite, backup };
					const payload = { path, text, rev: rev ?? null, overwrite, backup };
					const preview = await writeFull(env, { ...opts, dryRun: true });
					return guard(env, a, "files_write_full", payload, preview, () => writeFull(env, { ...opts, dryRun: false }));
				}
				const g = rejectModeBFlags(a);
				if (g) return g;
				return ok(await dbx(env, { op: "put", path: String(a.path), data: String(a.text) }));
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "files_upload",
		description: "Upload binary content (base64) — an image, PDF, or export. Default: the app-folder workspace (returns path + shareable link). `full:true` uploads to an ABSOLUTE whole-Dropbox path (Mode B) under the same write firewall as files_write (stages a preview by default — commit_token/force to apply; overwrite/rev gated, /.sux-trash backup).",
		inputSchema: { type: "object", additionalProperties: false, required: ["path", "base64"], properties: { path: { type: "string" }, base64: { type: "string", description: "Base64-encoded bytes." }, full: { type: "boolean", description: "Upload into the whole Dropbox (Mode B) instead of the app folder." }, overwrite: { type: "boolean", description: "full mode: allow replacing an existing file." }, rev: { type: "string", description: "full mode: conditional update — write only if the file still has this rev." }, backup: { type: "boolean", description: "full mode: pre-op copy an overwritten file to /.sux-trash (default true)." }, stage: { type: "boolean", description: "Preview only: returns {preview, commit_token}, writes nothing." }, commit_token: { type: "string", description: "Apply a previously staged plan (payload must match)." }, force: { type: "boolean", description: "Apply in one shot, skipping the default stage (the ! override)." } } },
		run: async (env, a) => {
			if (!a?.path || !a?.base64) return failWith("bad_input", "files_upload requires `path` and `base64`.");
			try {
				if (a?.full === true) {
					const g = gateModeBWrite(env);
					if (g) return g;
					const path = String(a.path), base64 = String(a.base64);
					const rev = a?.rev ? String(a.rev) : undefined, overwrite = a?.overwrite === true, backup = a?.backup !== false;
					const opts = { path, bytes: writeBytes(undefined, base64), rev, overwrite, backup };
					const payload = { path, base64, rev: rev ?? null, overwrite, backup };
					const preview = await writeFull(env, { ...opts, dryRun: true });
					return guard(env, a, "files_upload_full", payload, preview, () => writeFull(env, { ...opts, dryRun: false }));
				}
				const g = rejectModeBFlags(a);
				if (g) return g;
				return ok(await dbx(env, { op: "put", path: String(a.path), base64: String(a.base64) }));
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "files_batch_put",
		description:
			"Write MANY files to the app-folder workspace in one call: `items` [{path, text?|base64?}] fanned out server-side, each returning its path + shareable link. IDEMPOTENT — an item already written (same path + content) is skipped, so a re-run converges. `dry_run:true` previews. App-folder scoped (scope is the wall). For whole-Dropbox batch writes, use files_operate.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["items"],
			properties: {
				items: { type: "array", items: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" }, text: { type: "string", description: "UTF-8 text." }, base64: { type: "string", description: "Base64 bytes (binary)." } } }, description: "The files to write." },
				dry_run: { type: "boolean", description: "Preview the intended writes without writing." },
			},
		},
		run: async (env, a) => {
			const items = Array.isArray(a?.items) ? a.items : [];
			if (!items.length) return failWith("bad_input", "files_batch_put requires a non-empty `items` [{path, text?|base64?}].");
			const dryRun = a?.dry_run === true;
			const led = ledger(env, "files_put");
			// Each item writes an independent Dropbox path with no ordering dependency, so fan the
			// network round trips out through the shared pool() (as batch_fetch/crawl do) instead of
			// awaiting one at a time. pool preserves input order; per-item try/catch keeps one
			// failure from sinking the batch.
			const results = await pool(items, FILES_PUT_CONCURRENCY, async (it: any): Promise<Record<string, unknown>> => {
				const path = String(it?.path ?? "");
				const hasBin = typeof it?.base64 === "string" && it.base64;
				const hasText = typeof it?.text === "string";
				if (!path || (!hasBin && !hasText)) return { path, skipped: "missing path or content (text|base64)" };
				const id = `${path}::${await fingerprint(hasBin ? `b:${it.base64}` : `t:${String(it.text)}`)}`;
				if (await led.seen(id)) return { path, skipped: "already written (idempotent)" };
				if (dryRun) return { path, would_write: hasBin ? "binary" : "text" };
				try {
					const r = await dbx(env, { op: "put", path, ...(hasBin ? { base64: it.base64 } : { data: String(it.text) }) });
					await led.mark(id);
					return { path: r?.path ?? path, url: r?.url };
				} catch (e) {
					return { path, error: errMsg(e).slice(0, 120) };
				}
			});
			return ok({ count: items.length, dry_run: dryRun, results });
		},
	},
	{
		name: "files_share",
		description: "Get a public 'anyone with the link' shareable URL for a file (created or reused).",
		inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" } } },
		run: async (env, a) => {
			if (!a?.path) return failWith("bad_input", "files_share requires a `path`.");
			try {
				return ok(await dbx(env, { op: "share", path: String(a.path) }));
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "files_move",
		description: "Move or rename a file/folder. App-folder mode (`from`→`to`) is scope-fenced, no confirm. `full:true` moves within your whole Dropbox (Mode B): stages a preview by default — commit_token/force to apply; reversible by moving back.",
		inputSchema: { type: "object", additionalProperties: false, required: ["from", "to"], properties: { from: { type: "string", description: "Source path." }, to: { type: "string", description: "Destination path (rename or relocate)." }, full: { type: "boolean", description: "Move within the whole Dropbox (Mode B) instead of the app folder." }, stage: { type: "boolean", description: "Preview only: returns {preview, commit_token}, writes nothing." }, commit_token: { type: "string", description: "Apply a previously staged plan (payload must match)." }, force: { type: "boolean", description: "Apply in one shot, skipping the default stage (the ! override)." } } },
		run: async (env, a) => {
			if (!a?.from || !a?.to) return failWith("bad_input", "files_move requires `from` and `to`.");
			if (a?.full === true) {
				const g = gateModeBWrite(env);
				if (g) return g;
				try {
					const from = String(a.from), to = String(a.to);
						const preview = await moveFull(env, { from, to, dryRun: true });
						return await guard(env, a, "files_move_full", { from, to }, preview, () => moveFull(env, { from, to, dryRun: false }));
				} catch (e) {
					return fail(errMsg(e));
				}
			}
			try {
				return ok(await dbx(env, { op: "move", path: String(a.from), to: String(a.to) }));
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "files_delete",
		description: "Delete a file (moves it to your Dropbox 'Deleted files' — recoverable there). App-folder mode requires confirm:true. `full:true` deletes an ABSOLUTE whole-Dropbox path (Mode B): stages a preview by default (the plan + commit_token) — re-call with the commit_token, or pass force:true, to apply. Recoverable in Dropbox 'Deleted files'.",
		inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" }, confirm: { type: "boolean", description: "Must be true to actually delete — a deliberate two-step." }, full: { type: "boolean", description: "Delete from the whole Dropbox (Mode B) instead of the app folder." }, stage: { type: "boolean", description: "Preview only: returns {preview, commit_token}, writes nothing." }, commit_token: { type: "string", description: "Apply a previously staged plan (payload must match)." }, force: { type: "boolean", description: "Apply in one shot, skipping the default stage (the ! override)." } } },
		run: async (env, a) => {
			if (!a?.path) return failWith("bad_input", "files_delete requires a `path`.");
			if (a?.full === true) {
				const g = gateModeBWrite(env);
				if (g) return g;
								try {
						const path = String(a.path);
						const preview = await deleteFull(env, { path, dryRun: true });
						return await guard(env, a, "files_delete_full", { path }, preview, () => deleteFull(env, { path, dryRun: false }));
				} catch (e) {
					return fail(errMsg(e));
				}
			}
			if (a?.confirm !== true) return failWith("bad_input", "files_delete requires confirm:true.");
			try {
				return ok(await dbx(env, { op: "delete", path: String(a.path), confirm: true }));
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "files_operate",
		description:
			"Operate over a SEARCHED set of whole-Dropbox files in ONE call (Mode B), zero bytes through context. `find` (a files_search spec: {query, path_prefix?, ext?}) OR explicit `handles` [path] select the set; `action` is move (relocate the set into `dest`) or delete. STAGES A PLAN by default — returns the matched files + what would happen, changing nothing, with a commit_token. Re-call with the commit_token, or pass force:true, to execute. Each op rides the same firewall as files_move/files_delete — path-fence, rev-safety, Dropbox-trash recoverability — and the set is capped at `max` (default 100). For content transforms (merge N files→one, extract a byte/line slice) use files_transform. Needs DROPBOX_FULL_*.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["action"],
			properties: {
				action: { type: "string", enum: ["move", "delete"] },
				find: { type: "object", additionalProperties: false, properties: { query: { type: "string" }, path_prefix: { type: "string" }, ext: { type: "array", items: { type: "string" } } }, description: "A whole-Dropbox search spec selecting the set." },
				handles: { type: "array", items: { type: "string" }, description: "Explicit absolute paths (instead of a find)." },
				dest: { type: "string", description: "move: destination folder for the set." },
				stage: { type: "boolean", description: "Preview only: returns {plan, commit_token}, changes nothing." },
				commit_token: { type: "string", description: "Apply a previously staged plan (payload must match)." },
				force: { type: "boolean", description: "Apply in one shot, skipping the default stage (the ! override)." },
				max: { type: "integer", minimum: 1, maximum: 500, description: "Cap the set size (default 100)." },
			},
		},
		run: async (env, a) => {
			const g = gateModeBWrite(env);
			if (g) return g;
			const action = String(a?.action ?? "");
			if (action !== "move" && action !== "delete") return failWith("bad_input", "files_operate action must be 'move' or 'delete'.");
			try {
				const base = { find: a?.find, handles: Array.isArray(a?.handles) ? a.handles : undefined, action: action as "move" | "delete", dest: a?.dest ? String(a.dest) : undefined, max: a?.max };
				const payload = { action, find: a?.find ?? null, handles: Array.isArray(a?.handles) ? a.handles : null, dest: a?.dest ?? null, max: a?.max ?? null };
				const preview = await operateFull(env, { ...base, apply: false });
				return await guard(env, a, "files_operate", payload, preview, () => operateFull(env, { ...base, apply: true, confirm: true }));
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "files_transform",
		description:
			"Compose whole-Dropbox files into a NEW file, server-side (Mode B) — zero bytes through context. `op:'merge'` joins `sources` (2..20 absolute paths) into `dest`: mode 'concat' (default) is a raw-byte join in listed order; mode 'pdf' (default when every source is .pdf) renders each source to PDF page(s) and merges them (via the pdf fn). `op:'extract'` slices ONE `source` into `dest` by `byte_range` OR `line_range` ([start,end), 0-indexed half-open; line ranges need a text source). Sources are read edge-side (oversize link-only files are refused, never silently skipped); the result is written through the SAME firewall as files_write full:true — STAGES A PREVIEW BY DEFAULT (the plan: resolved sources, sizes, would-overwrite, + a commit_token; re-call with it or pass force:true to apply), existing/overlapping dest needs overwrite:true, an overwrite is backed up to /.sux-trash, and output is capped. Needs DROPBOX_FULL_*.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["op", "dest"],
			properties: {
				op: { type: "string", enum: ["merge", "extract"] },
				sources: { type: "array", items: { type: "string" }, description: "merge: 2..20 absolute source paths, joined in listed order." },
				mode: { type: "string", enum: ["concat", "pdf"], description: "merge: 'concat' raw-byte join (default), or 'pdf' render+merge into one PDF (default when every source is .pdf)." },
				source: { type: "string", description: "extract: the single absolute source path to slice." },
				byte_range: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2, description: "extract: [start,end) byte offsets (0-indexed, half-open)." },
				line_range: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2, description: "extract: [start,end) line indices (0-indexed, half-open); text sources only." },
				dest: { type: "string", description: "Absolute destination path for the result." },
				stage: { type: "boolean", description: "Preview only: returns {preview, commit_token}, writes nothing." },
				commit_token: { type: "string", description: "Apply a previously staged plan (payload must match)." },
				force: { type: "boolean", description: "Apply in one shot, skipping the default stage (the ! override)." },
				overwrite: { type: "boolean", description: "Allow replacing an existing dest (required when dest is also a source)." },
				backup: { type: "boolean", description: "Pre-op copy an overwritten dest to /.sux-trash (default true)." },
			},
		},
		run: async (env, a) => {
			const g = gateModeBWrite(env);
			if (g) return g;
			const op = String(a?.op ?? "");
			if (op !== "merge" && op !== "extract") return failWith("bad_input", "files_transform op must be 'merge' or 'extract'.");
			if (!a?.dest) return failWith("bad_input", "files_transform requires a `dest`.");
			try {
				const base = {
					op: op as "merge" | "extract",
					sources: Array.isArray(a?.sources) ? a.sources.map(String) : undefined,
					mode: (a?.mode === "pdf" || a?.mode === "concat" ? a.mode : undefined) as "pdf" | "concat" | undefined,
					source: a?.source ? String(a.source) : undefined,
					byte_range: Array.isArray(a?.byte_range) ? (a.byte_range.map(Number) as [number, number]) : undefined,
					line_range: Array.isArray(a?.line_range) ? (a.line_range.map(Number) as [number, number]) : undefined,
					dest: String(a.dest),
					overwrite: a?.overwrite === true,
					backup: a?.backup !== false,
				};
				const payload = { op, sources: base.sources ?? null, mode: base.mode ?? null, source: base.source ?? null, byte_range: base.byte_range ?? null, line_range: base.line_range ?? null, dest: base.dest, overwrite: base.overwrite, backup: base.backup };
				const preview = await transformFull(env, { ...base, dryRun: true });
				return await guard(env, a, "files_transform", payload, preview, () => transformFull(env, { ...base, dryRun: false }));
			} catch (e) {
				return fail(errMsg(e));
			}
		},
	},
	{
		name: "dropbox",
		description: "Raw dropbox escape hatch — the underlying app-folder blob store (op: put/get/list/delete/share). Same contract as the universal `dropbox` fn; use when the ergonomic files_* tools don't cover it.",
		inputSchema: dropbox.inputSchema,
		run: (env, a) => dropbox.run(env, a),
	},
];

export const FILES_TOOLS = TOOLS;
