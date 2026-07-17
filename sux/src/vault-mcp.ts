import { fingerprint, ledger } from "./ledger";
import { fail, failWith, ok, type RtEnv, type ToolResult } from "./registry";
import { ingest } from "./fns/ingest";
import { obsidian, readGitContents, RETRY_ATTEMPTS, retryDelay, readVaultIndexBlob, type VaultCfg, vaultCfg, vaultHead, vaultPut, writeVaultIndexBlob } from "./fns/obsidian";
import { vaultToday } from "./fns/_util";
import {
	bodyExcerpt,
	bodyKeywords,
	evalFilter,
	extractTags,
	extractTasks,
	extractWikilinks,
	type Filter,
	frontmatterMatches,
	linkResolvesTo,
	parseFrontmatter,
	patchBlockRef,
	patchFrontmatter,
	patchHeadingSection,
	type PatchMode,
	type VaultTask,
} from "./vault-graph";

// The vault MCP server — our rolled-own obsidian-web-mcp (prior art:
// github.com/jimprosser/obsidian-web-mcp), kept on OUR Workers implementation.
// Reached through the `vault_` front verbs on the one /mcp connector (behind the
// same workers-oauth-provider flow claude.ai accepts for /mcp), with zero new
// public surface and zero new infra. The old /vault/mcp connector is retired —
// its route stays dormant for back-compat but ships no plugin; front verbs
// dispatch into these handlers now.
//
// The source of truth is in the cloud: tools read and write the git store
// (GitHub colinxs/vault — every write a revertible commit, KV-cached) and work
// with NO box awake. The live vault (remote/vpc backend) is used only where git
// cannot serve: full-text search (GitHub code search is dead on private repos).
//
// Stolen from the prior art: confirm-gated delete, daily-note verbs, tight
// per-tool schemas. Deliberately NOT ours to re-implement: its OAuth server
// (the provider does PKCE + dynamic client registration already), its atomic
// temp+rename writes (git commits are atomic; live-vault writes go through
// Obsidian's own adapter), its path guards (badVaultPath in fns/obsidian.ts).
const DAILY_DIR = "Daily";
const dailyPath = (env: RtEnv) => `${DAILY_DIR}/${vaultToday(env.VAULT_TZ)}.md`;

type VaultTool = {
	name: string;
	description: string;
	inputSchema: unknown;
	run: (env: RtEnv, args: any) => Promise<ToolResult>;
};

const git = (args: Record<string, unknown>) => ({ ...args, backend: "git" });

type VaultRecord = { path: string; fm: Record<string, unknown>; links: string[]; tags: string[]; tasks: VaultTask[]; excerpt: string; keywords: string[] };

const toRecord = (path: string, content: string, fm: Record<string, unknown>): VaultRecord => ({
	path,
	fm,
	links: extractWikilinks(content),
	tags: extractTags(content, fm),
	tasks: extractTasks(content),
	excerpt: bodyExcerpt(content),
	keywords: bodyKeywords(content),
});

// The whole-vault derived index: one KV blob of {path, fm, tags, links} for every
// note, stamped with the HEAD sha it was built at. backlinks/query/tags all read
// THIS instead of re-listing + re-reading ~500 notes (~500 KV round-trips → 1).
// Bounded-stale (NOT instantly consistent): keyed on the live HEAD (fns/obsidian's
// vaultHead), so a write THROUGH this Worker invalidates it in-line and the next
// scan rebuilds BEFORE returning. An OUT-OF-BAND change (GitHub UI edit, external
// git push, PR merge) only surfaces once vaultHead re-checks GitHub — within
// HEAD_RECHECK_MS (60s) in normal operation, up to HEAD_STALE_MAX_MS (10min) while
// GitHub's ref endpoint is erroring (see obsidian.ts). INDEX_MAX bounds a pathological
// vault; well above both the real ~500-note size and the 2000 per-call cap.
const INDEX_MAX = 5000;
// Bumped whenever VaultRecord's shape changes (e.g. #670 added tasks/excerpt/keywords).
// The vault's git HEAD is independent of Worker deploys, so a KV blob built by the
// PREVIOUS Worker version can still match the sha check post-deploy; version-stamping
// forces a rebuild instead of returning records missing the new fields (see #676).
const INDEX_VERSION = 2;
type VaultIndex = { sha: string; version: number; at: number; total: number; truncated: boolean; records: VaultRecord[] };

async function buildVaultIndex(env: RtEnv, sha: string, cfg: VaultCfg): Promise<VaultIndex> {
	const listRes = await obsidian.run(env, git({ action: "list" }));
	if (listRes.isError) throw new Error(listRes.content?.[0]?.text ?? "vault list failed");
	const listing = JSON.parse(listRes.content[0].text) as { notes?: string[] };
	const all = Array.isArray(listing.notes) ? listing.notes : [];
	const notes = all.slice(0, INDEX_MAX);
	let failed = 0;
	const records = (
		await Promise.all(
			notes.map(async (path) => {
				// `list` returns dir-prefixed (OBSIDIAN_VAULT_DIR) paths, but `read` re-applies
				// inVault() itself — feeding the listed path straight back in would double-prefix
				// into a 404. Strip the dir prefix here, mirroring recall.ts's read-back fix.
				const readPath = cfg.dir && path.startsWith(`${cfg.dir}/`) ? path.slice(cfg.dir.length + 1) : path;
				const r = await obsidian.run(env, git({ action: "read", path: readPath }));
				if (r.isError) {
					failed++;
					return null;
				}
				const content = r.content[0].text;
				return toRecord(path, content, parseFrontmatter(content));
			}),
		)
	).filter((x): x is VaultRecord => x !== null);
	// `truncated` also flags an INCOMPLETE index: a per-note read that failed (a
	// GitHub secondary-rate-limit 403 on the read burst, a 5xx, a transient blip)
	// silently drops that note from `records`, so callers must know the answer may
	// have holes — not just when the whole vault exceeded INDEX_MAX. The blob is
	// cached until the next HEAD change, so one blip would otherwise poison every
	// backlinks/query/tags answer for that HEAD with no signal.
	return { sha, version: INDEX_VERSION, at: Date.now(), total: all.length, truncated: all.length > INDEX_MAX || failed > 0, records };
}

/** The whole-vault index for the current HEAD, rebuilt on HEAD mismatch (bounded-stale
 *  — see the index note above: a write through this Worker is reflected at once, an
 *  out-of-band edit within the vaultHead recheck window). Returns null when there's no
 *  KV or HEAD can't be resolved (offline) — the caller falls back to a direct per-note
 *  scan so the tools still work. */
async function vaultIndex(env: RtEnv, cfg: VaultCfg): Promise<VaultIndex | null> {
	const head = env.OAUTH_KV ? await vaultHead(env, cfg) : null;
	if (!head) return null;
	const cached = (await readVaultIndexBlob(env, cfg)) as VaultIndex | null;
	if (cached?.sha === head && cached?.version === INDEX_VERSION && Array.isArray(cached.records)) return cached;
	const fresh = await buildVaultIndex(env, head, cfg);
	await writeVaultIndexBlob(env, cfg, fresh);
	return fresh;
}

/** Direct per-note scan — the fallback when the index is unavailable (no KV / offline HEAD). */
async function scanVaultDirect(env: RtEnv, folder: string | undefined, cap: number): Promise<{ records: VaultRecord[]; total: number; truncated: boolean }> {
	const cfg = vaultCfg(env);
	const dir = "error" in cfg ? "" : cfg.dir;
	const listRes = await obsidian.run(env, git({ action: "list", ...(folder ? { path: folder } : {}) }));
	if (listRes.isError) throw new Error(listRes.content?.[0]?.text ?? "vault list failed");
	const listing = JSON.parse(listRes.content[0].text) as { notes?: string[] };
	const all = Array.isArray(listing.notes) ? listing.notes : [];
	const notes = all.slice(0, cap);
	const records = (
		await Promise.all(
			notes.map(async (path) => {
				// See buildVaultIndex: `list` returns dir-prefixed paths, but `read` re-applies
				// inVault() — strip the prefix back off before reading, or it double-prefixes.
				const readPath = dir && path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path;
				const r = await obsidian.run(env, git({ action: "read", path: readPath }));
				if (r.isError) return null;
				const content = r.content[0].text;
				return toRecord(path, content, parseFrontmatter(content));
			}),
		)
	).filter((x): x is VaultRecord => x !== null);
	return { records, total: all.length, truncated: all.length > cap };
}

/** Scan the git vault (optionally under `folder`): the shared substrate for
 *  backlinks / frontmatter-query / tag-index. Serves the derived {path,fm,tags,links}
 *  from the HEAD-keyed KV index (one read) and slices to `folder`/`cap`; on a HEAD
 *  change the index rebuilds BEFORE returning, so a write through this Worker is
 *  reflected at once (an out-of-band edit within the vaultHead recheck window). Falls
 *  back to a direct per-note scan when the index is unavailable. `truncated` flags a
 *  result the caller's `cap` clipped, a vault beyond INDEX_MAX, OR an index with
 *  per-note read holes — the latter two propagate regardless of folder scoping. */
async function scanVault(env: RtEnv, folder: string | undefined, cap: number): Promise<{ records: VaultRecord[]; total: number; truncated: boolean }> {
	const cfg = vaultCfg(env);
	const idx = "error" in cfg ? null : await vaultIndex(env, cfg);
	if (idx && !("error" in cfg)) {
		const raw = String(folder ?? "").replace(/^\/+|\/+$/g, "");
		const prefix = raw ? cfg.inVault(raw) : "";
		// Compare against a slash-terminated prefix so folder:'Area' scopes to `Area/…`
		// only — a bare `startsWith('Area')` would also sweep in the sibling `Areas/…`.
		const p = prefix.replace(/\/?$/, "/");
		const base = prefix ? idx.records.filter((r) => r.path.startsWith(p)) : idx.records;
		const total = prefix ? base.length : idx.total;
		// idx.truncated (index capped at INDEX_MAX, or holes from failed reads) must
		// surface even under a `folder` scope: a folder can hold notes that never made
		// it into idx.records, so hiding the flag would return a confidently-wrong
		// undercount instead of a flagged partial one.
		return { records: base.slice(0, cap), total, truncated: base.length > cap || idx.truncated };
	}
	return scanVaultDirect(env, folder, cap);
}

const TOOLS: VaultTool[] = [
	{
		name: "vault_read",
		description: "Read a note from the vault (cloud git store, KV-cached — always available). Pass with_sha:true to get the note's content sha (JSON `{path, body, sha}`) for use as vault_write's base_sha.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["path"],
			properties: { path: { type: "string", description: "Note path, e.g. Inbox/idea.md" }, with_sha: { type: "boolean", description: "Return JSON `{path, body, sha}` instead of the bare body string." } },
		},
		run: (env, a) => obsidian.run(env, git({ action: "read", path: a?.path, ...(a?.with_sha === true ? { with_sha: true } : {}) })),
	},
	{
		name: "vault_list",
		description: "List notes in the vault, optionally under a folder.",
		inputSchema: { type: "object", additionalProperties: false, properties: { folder: { type: "string", description: "Folder filter, e.g. Projects" } } },
		run: (env, a) => obsidian.run(env, git({ action: "list", ...(a?.folder ? { path: a.folder } : {}) })),
	},
	// Cloud tools only in v1 (Colin, 2026-07-08): no live-vault dependencies here.
	// Full-text search needs the live host (GitHub code search is dead on private
	// repos) — it lands with the tier-2 vpc backend. Desktop keeps live-vault MCP
	// through the local mcp-gate wrapper meanwhile.
	{
		name: "vault_write",
		description: "Create or overwrite a note. Every write is a git commit — history is the undo. Optional `base_sha` (the note's content sha, from vault_read with_sha:true or a prior write's returned `sha`) makes a concurrent change since then 409 instead of silently clobbering it.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["path", "content"],
			properties: { path: { type: "string" }, content: { type: "string", description: "Full markdown body." }, base_sha: { type: "string", description: "Expected current content sha; a mismatch fails with a 409 instead of overwriting." } },
		},
		run: (env, a) => obsidian.run(env, git({ action: "write", path: a?.path, content: a?.content, ...(typeof a?.base_sha === "string" && a.base_sha ? { base_sha: a.base_sha } : {}) })),
	},
	{
		name: "vault_append",
		description: "Append markdown to a note, creating it if absent.",
		inputSchema: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } },
		run: (env, a) => obsidian.run(env, git({ action: "append", path: a?.path, content: a?.content })),
	},
	{
		name: "vault_edit",
		description: "Surgical find/replace in a note. `find` must match exactly once unless `all` is set — an edit never lands somewhere unintended.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["path", "find", "replace"],
			properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" }, all: { type: "boolean", default: false } },
		},
		run: (env, a) => obsidian.run(env, git({ action: "edit", path: a?.path, find: a?.find, replace: a?.replace, ...(a?.all === true ? { all: true } : {}) })),
	},
	{
		name: "vault_delete",
		description: "Delete a note (git history keeps it recoverable). Requires confirm:true.",
		inputSchema: { type: "object", additionalProperties: false, required: ["path", "confirm"], properties: { path: { type: "string" }, confirm: { type: "boolean", description: "Must be true — a deliberate two-step, stolen from obsidian-web-mcp." } } },
		run: (env, a) => (a?.confirm === true ? obsidian.run(env, git({ action: "delete", path: a?.path })) : Promise.resolve(failWith("bad_input", "vault_delete requires confirm:true."))),
	},
	{
		name: "vault_capture",
		description:
			"Capture into the vault Inbox with provenance frontmatter: exactly one of url (page → markdown; files become attachments), text, or query (web-search results). Optional summarize/compress passes. Never overwrites — collisions disambiguate.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				url: { type: "string" },
				text: { type: "string" },
				query: { type: "string" },
				title: { type: "string" },
				tags: { type: "array", items: { type: "string" } },
				summarize: { type: "boolean", default: false },
				compress: { type: "boolean", default: false },
			},
		},
		// Allowlist the fields we forward — NEVER the raw args. A stray `path` key
		// (models emit extras despite additionalProperties:false, which nothing
		// enforces server-side) would hit ingest's explicit-path overwrite branch
		// and clobber a named note, breaking this tool's never-overwrite promise.
		run: (env, a) => {
			const pick: Record<string, unknown> = {};
			for (const k of ["url", "text", "query", "title", "tags", "summarize", "compress"]) if (a?.[k] !== undefined) pick[k] = a[k];
			return ingest.run(env, pick);
		},
	},
	{
		name: "vault_batch_append",
		description:
			"Append to MANY notes in one call: `items` [{path, content}] fanned out server-side. IDEMPOTENT — an item already appended in a prior run (same path + content) is skipped, so a re-run converges instead of duplicating. `dry_run:true` previews the intended appends without writing. Git history is the undo, so no confirm gate.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["items"],
			properties: {
				items: { type: "array", items: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } }, description: "The appends to make." },
				dry_run: { type: "boolean", description: "Preview the intended appends without writing." },
			},
		},
		run: async (env, a) => {
			const items = Array.isArray(a?.items) ? a.items : [];
			if (!items.length) return failWith("bad_input", "vault_batch_append requires a non-empty `items` [{path, content}].");
			const dryRun = a?.dry_run === true;
			const led = ledger(env, "vault_append");
			const results: Array<Record<string, unknown>> = [];
			for (const it of items) {
				const path = String(it?.path ?? "");
				const content = String(it?.content ?? "");
				if (!path || !content) {
					results.push({ path, skipped: "missing path or content" });
					continue;
				}
				const id = `${path}::${await fingerprint(content)}`;
				if (await led.seen(id)) {
					results.push({ path, skipped: "already appended (idempotent)" });
					continue;
				}
				if (dryRun) {
					results.push({ path, would_append_chars: content.length });
					continue;
				}
				const r = await obsidian.run(env, git({ action: "append", path, content }));
				if (r.isError) {
					results.push({ path, error: (r.content?.[0]?.text ?? "append failed").slice(0, 120) });
					continue;
				}
				await led.mark(id);
				results.push({ path, appended: true });
			}
			return ok(JSON.stringify({ count: items.length, dry_run: dryRun, results }, null, 2));
		},
	},
	{
		name: "vault_daily_read",
		description: "Read today's daily note (the vault owner's local day).",
		inputSchema: { type: "object", additionalProperties: false, properties: {} },
		run: (env) => obsidian.run(env, git({ action: "read", path: dailyPath(env) })),
	},
	{
		name: "vault_daily_append",
		description: "Append to today's daily note (created if absent) — the quick-capture surface for tasks and jots.",
		inputSchema: { type: "object", additionalProperties: false, required: ["content"], properties: { content: { type: "string", description: "Markdown to add, e.g. '- [ ] call the plumber'." } } },
		run: (env, a) => obsidian.run(env, git({ action: "append", path: dailyPath(env), content: a?.content })),
	},
	{
		name: "vault_backlinks",
		description: "List notes that [[link]] to a target note — the backlinks Obsidian shows in its side panel. Resolves wikilinks by basename. Scans the vault (KV-cached); `cap` bounds how many notes are read.",
		inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string", description: "Target note path, e.g. Projects/sux.md" }, cap: { type: "integer", minimum: 1, maximum: 2000, description: "Max notes to scan (default 500)." } } },
		run: async (env, a) => {
			if (!a?.path) return failWith("bad_input", "vault_backlinks requires a `path`.");
			try {
				const { records, total, truncated } = await scanVault(env, undefined, clampCap(a?.cap));
				const target = String(a.path);
				const backlinks = records.filter((r) => r.path !== target && r.links.some((l) => linkResolvesTo(l, target))).map((r) => ({ path: r.path, links: r.links.filter((l) => linkResolvesTo(l, target)) }));
				return ok(JSON.stringify({ target, count: backlinks.length, backlinks, scanned: records.length, total, truncated }, null, 2));
			} catch (e) {
				return fail(String((e as Error)?.message ?? e));
			}
		},
	},
	{
		name: "vault_query",
		description:
			"Find notes by FRONTMATTER — the note-database query folders can't do (structured, git-backed; NOT full-text search). Two forms: simple `field` (+ optional `value`: omit=presence, array field=membership, else equality), or a `filter` JsonLogic object for boolean/comparison composition — {and:[…]} {or:[…]} {not:…}, {\"==\":[field,val]}, {\"!=\"/\">\"/\"<\"/\">=\"/\"<=\":[field,val]} (numeric else string), {\"in\":[field,val]}. Optional `folder` scopes the scan. Returns matching {path, frontmatter}.",
		inputSchema: { type: "object", additionalProperties: false, properties: { field: { type: "string", description: "Frontmatter key for the simple form, e.g. status or type." }, value: { description: "Match value for the simple form; omit to test presence of `field`." }, filter: { type: "object", description: "JsonLogic-lite filter (and/or/not, ==,!=,>,<,>=,<=, in) — use instead of field/value for boolean composition." }, folder: { type: "string", description: "Restrict to a folder." }, cap: { type: "integer", minimum: 1, maximum: 2000 } } },
		run: async (env, a) => {
			const filter = a?.filter as Filter | undefined;
			const field = typeof a?.field === "string" ? a.field : undefined;
			if (!filter && !field) return failWith("bad_input", "vault_query needs either `field` (simple form) or `filter` (JsonLogic).");
			let matches: (fm: Record<string, unknown>) => boolean;
			try {
				matches = filter ? (fm) => evalFilter(fm, filter) : (fm) => frontmatterMatches(fm, field!, a?.value);
			} catch (e) {
				return failWith("bad_input", `invalid filter: ${String((e as Error)?.message ?? e)}`);
			}
			try {
				const { records, total, truncated } = await scanVault(env, a?.folder ? String(a.folder) : undefined, clampCap(a?.cap));
				const notes: Array<{ path: string; frontmatter: Record<string, unknown> }> = [];
				for (const r of records) {
					try {
						if (matches(r.fm)) notes.push({ path: r.path, frontmatter: r.fm });
					} catch (e) {
						return failWith("bad_input", `invalid filter: ${String((e as Error)?.message ?? e)}`); // a bad filter throws on the first note
					}
				}
				return ok(JSON.stringify({ ...(field ? { field } : {}), ...(a?.value !== undefined ? { value: a.value } : {}), ...(filter ? { filter } : {}), count: notes.length, notes, scanned: records.length, total, truncated }, null, 2));
			} catch (e) {
				return fail(String((e as Error)?.message ?? e));
			}
		},
	},
	{
		name: "vault_patch",
		description:
			"Structural edit of a note: target exactly ONE of `heading` (the `# Heading` section), `block` (an `^block-id` anchor), or `frontmatter_field` (a top-level frontmatter key). `mode` (replace|append|prepend) applies to heading/block; frontmatter_field always sets/replaces the key to `content`. Read→transform→commit on the git store — history is the undo, no confirm gate. A missing or ambiguous target fails cleanly (mirrors vault_edit's unique-match discipline).",
		inputSchema: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string" }, heading: { type: "string", description: "Target the section under this heading (by its text)." }, block: { type: "string", description: "Target the block anchored by this id (`^id`, caret optional)." }, frontmatter_field: { type: "string", description: "Target this top-level frontmatter key; `content` is the value to set." }, mode: { type: "string", enum: ["replace", "append", "prepend"], default: "replace", description: "For heading/block targets." }, content: { type: "string", description: "Text to write (section/block text, or the frontmatter value)." } } },
		run: async (env, a) => {
			const path = typeof a?.path === "string" ? a.path.trim() : "";
			if (!path) return failWith("bad_input", "vault_patch requires a `path`.");
			if (typeof a?.content !== "string") return failWith("bad_input", "vault_patch requires `content`.");
			const targets = ["heading", "block", "frontmatter_field"].filter((k) => typeof a?.[k] === "string" && a[k]);
			if (targets.length !== 1) return failWith("bad_input", "vault_patch needs exactly one target: `heading`, `block`, or `frontmatter_field`.");
			const mode = (["replace", "append", "prepend"].includes(a?.mode) ? a.mode : "replace") as PatchMode;
			const cfg = vaultCfg(env);
			if ("error" in cfg) return failWith("not_configured", cfg.error);
			// Read note + its sha, transform, then write PUTting THAT read-time sha:
			// a concurrent modification collides (409) instead of a silent lost update.
			// Retried like obsidian.ts's append/edit (RETRY_ATTEMPTS): re-read and
			// reapply the patch against the fresh body each attempt, so it self-heals.
			for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
				if (attempt > 0) await new Promise((r) => setTimeout(r, retryDelay(attempt - 1)));
				const cur = await readGitContents(env, cfg, cfg.inVault(path));
				if (cur.status === 404) return failWith("not_found", `Note not found: ${path}`);
				if (cur.error) return fail(cur.error);
				let patched: { content: string; changed: boolean };
				try {
					if (targets[0] === "frontmatter_field") patched = patchFrontmatter(cur.body, a.frontmatter_field, a.content);
					else if (targets[0] === "heading") patched = patchHeadingSection(cur.body, a.heading, mode, a.content);
					else patched = patchBlockRef(cur.body, a.block, mode, a.content);
				} catch (e) {
					return failWith("bad_input", `vault_patch: ${String((e as Error)?.message ?? e)}`);
				}
				if (!patched.changed) return ok(JSON.stringify({ ok: true, path, changed: false, note: "target already holds this value" }, null, 2));
				const wrote = await vaultPut(env, cfg, path, patched.content, `sux: patch ${path}`, { sha: cur.sha });
				if (wrote.ok) return ok(JSON.stringify({ ok: true, path, changed: true, target: targets[0], ...(targets[0] === "frontmatter_field" ? {} : { mode }) }, null, 2));
				if (!wrote.conflict) return fail(wrote.error);
			}
			return fail(`patch of ${path} lost the race to a concurrent writer ${RETRY_ATTEMPTS} times in a row — retry once more.`);
		},
	},
	{
		name: "vault_tags",
		description: "Tag index over the vault: pass a `tag` to list notes carrying it (frontmatter tags ∪ inline #tags), or omit to enumerate every tag with its note count. Optional `folder`.",
		inputSchema: { type: "object", additionalProperties: false, properties: { tag: { type: "string", description: "A tag (with or without #) to list notes for; omit to enumerate all tags." }, folder: { type: "string" }, cap: { type: "integer", minimum: 1, maximum: 2000 } } },
		run: async (env, a) => {
			try {
				const { records, total, truncated } = await scanVault(env, a?.folder ? String(a.folder) : undefined, clampCap(a?.cap));
				if (a?.tag) {
					const want = String(a.tag).replace(/^#/, "").toLowerCase();
					const notes = records.filter((r) => r.tags.some((t) => t.toLowerCase() === want)).map((r) => r.path);
					return ok(JSON.stringify({ tag: want, count: notes.length, notes, scanned: records.length, total, truncated }, null, 2));
				}
				const counts: Record<string, number> = {};
				for (const r of records) for (const t of r.tags) counts[t] = (counts[t] ?? 0) + 1;
				const tags = Object.entries(counts).sort((a2, b2) => b2[1] - a2[1]).map(([tag, count]) => ({ tag, count }));
				return ok(JSON.stringify({ count: tags.length, tags, scanned: records.length, total, truncated }, null, 2));
			} catch (e) {
				return fail(String((e as Error)?.message ?? e));
			}
		},
	},
	{
		name: "vault_tasks",
		description:
			"Checkbox tasks (`- [ ]`/`- [x]`) across the vault, from the KV-cached index — no live Obsidian. Filter by `done`, `overdue` (undone + a 📅 due date before today, vault-local day), or `tag`/`folder` scope. Recognizes the Tasks-plugin shorthand: 📅 due date, 🔁 recurrence, trailing `^t-id`.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				done: { type: "boolean", description: "Filter to done (true) or undone (false) tasks; omit for both." },
				overdue: { type: "boolean", description: "Only undone tasks whose 📅 due date is before today." },
				tag: { type: "string", description: "Only notes carrying this tag." },
				folder: { type: "string" },
				cap: { type: "integer", minimum: 1, maximum: 2000 },
			},
		},
		run: async (env, a) => {
			try {
				const { records, total, truncated } = await scanVault(env, a?.folder ? String(a.folder) : undefined, clampCap(a?.cap));
				const today = vaultToday(env.VAULT_TZ);
				const wantDone = typeof a?.done === "boolean" ? a.done : undefined;
				const wantOverdue = a?.overdue === true;
				const wantTag = a?.tag ? String(a.tag).replace(/^#/, "").toLowerCase() : undefined;
				const tasks: Array<{ path: string } & VaultTask> = [];
				for (const r of records) {
					if (wantTag && !r.tags.some((t) => t.toLowerCase() === wantTag)) continue;
					for (const t of r.tasks ?? []) {
						if (wantDone !== undefined && t.done !== wantDone) continue;
						if (wantOverdue && (t.done || !t.due || t.due >= today)) continue;
						tasks.push({ path: r.path, ...t });
					}
				}
				return ok(JSON.stringify({ count: tasks.length, tasks, scanned: records.length, total, truncated }, null, 2));
			} catch (e) {
				return fail(String((e as Error)?.message ?? e));
			}
		},
	},
	{
		name: "vault_search_body",
		description:
			"Grep-quality body search over the vault, from the KV-cached index — case-insensitive substring match against each note's excerpt/keywords (GitHub code search is dead on private repos). NOT full-text: only the first ~300 chars of each note's body are indexed, so a hit deep in a long note can be missed — read the note to confirm.",
		inputSchema: { type: "object", additionalProperties: false, required: ["q"], properties: { q: { type: "string", description: "Substring/word to search for." }, folder: { type: "string" }, cap: { type: "integer", minimum: 1, maximum: 2000 } } },
		run: async (env, a) => {
			const q = typeof a?.q === "string" ? a.q.trim().toLowerCase() : "";
			if (!q) return failWith("bad_input", "vault_search_body requires a non-empty `q`.");
			try {
				const { records, total, truncated } = await scanVault(env, a?.folder ? String(a.folder) : undefined, clampCap(a?.cap));
				const hits = records.filter((r) => (r.excerpt ?? "").toLowerCase().includes(q) || (r.keywords ?? []).includes(q)).map((r) => ({ path: r.path, excerpt: r.excerpt ?? "" }));
				return ok(JSON.stringify({ q, count: hits.length, hits, scanned: records.length, total, truncated }, null, 2));
			} catch (e) {
				return fail(String((e as Error)?.message ?? e));
			}
		},
	},
];

const clampCap = (v: unknown): number => Math.min(2000, Math.max(1, Number(v) || 500));

export const VAULT_TOOLS = TOOLS;
