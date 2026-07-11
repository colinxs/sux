import { checkArgs, FN_DEADLINE_MS, withDeadline } from "./index";
import { fingerprint, ledger } from "./ledger";
import { type JsonRpc, sseResponse } from "./mcp-util";
import { fail, ok, type RtEnv, type ToolResult } from "./registry";
import { ingest } from "./fns/ingest";
import { obsidian, vaultCfg } from "./fns/obsidian";
import { vaultToday } from "./fns/_util";
import { type Filter, evalFilter, frontmatterMatches, parseFrontmatter, patchBlockRef, patchFrontmatter, patchHeadingSection, type PatchMode } from "./vault-graph";

// The vault MCP server — our rolled-own obsidian-web-mcp (prior art:
// github.com/jimprosser/obsidian-web-mcp), kept on OUR Workers implementation.
// Served at /vault/mcp behind the same workers-oauth-provider flow claude.ai
// already accepts for /mcp, so it appears as its own "vault" connector in
// claude.ai / mobile / desktop with zero new public surface and zero new infra.
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

// Scan the git store's frontmatter server-side: list notes, then read each and
// parse its `---` block. Bodies transit the Worker only (never the model context),
// so a scan is handle-first — callers get {path, fm}, never note bodies. `list`
// returns repo-relative paths (dir-prefixed when OBSIDIAN_VAULT_DIR is set) but
// `vault_read`/obsidian read re-apply that prefix, so we strip it back to the
// vault-relative handle the read path expects.
async function scanVault(env: RtEnv, folder?: string): Promise<Array<{ path: string; fm: Record<string, unknown> }>> {
	const cfg = vaultCfg(env);
	const dir = "error" in cfg ? "" : cfg.dir;
	const listed = await obsidian.run(env, git({ action: "list", ...(folder ? { path: folder } : {}) }));
	if (listed.isError) throw new Error(listed.content?.[0]?.text ?? "vault list failed");
	const notes: string[] = JSON.parse(listed.content[0].text)?.notes ?? [];
	const rel = notes.map((p) => (dir && p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : p));
	const out: Array<{ path: string; fm: Record<string, unknown> }> = [];
	for (const path of rel) {
		const r = await obsidian.run(env, git({ action: "read", path }));
		if (r.isError) continue; // a note listed-then-unreadable (race/perm) is skipped, not fatal
		out.push({ path, fm: parseFrontmatter(r.content[0].text).fm });
	}
	return out;
}

const TOOLS: VaultTool[] = [
	{
		name: "vault_read",
		description: "Read a note from the vault (cloud git store, KV-cached — always available).",
		inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string", description: "Note path, e.g. Inbox/idea.md" } } },
		run: (env, a) => obsidian.run(env, git({ action: "read", path: a?.path })),
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
		description: "Create or overwrite a note. Every write is a git commit — history is the undo.",
		inputSchema: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string", description: "Full markdown body." } } },
		run: (env, a) => obsidian.run(env, git({ action: "write", path: a?.path, content: a?.content })),
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
		run: (env, a) => (a?.confirm === true ? obsidian.run(env, git({ action: "delete", path: a?.path })) : Promise.resolve(fail("vault_delete requires confirm:true."))),
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
			if (!items.length) return fail("vault_batch_append requires a non-empty `items` [{path, content}].");
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
		name: "vault_query",
		description:
			"Find notes by FRONTMATTER (structured, git-backed — always available; this is not full-text search). Two forms: the simple `field` (+ optional `value`: omitted = presence, array field = membership, else equality), or a `filter` JsonLogic object for boolean/comparison composition — {and:[…]} {or:[…]} {not:…}, {\"==\":[field,val]} {\"!=\":…} {\">\"/\"<\"/\">=\"/\"<=\":[field,val]} (numeric else ISO-date lexical), {\"in\":[field,val]} (array membership). Scans server-side and returns matching PATHS only (never bodies). Optional `folder` scopes the scan. Free-text/Dataview search needs the live backend and is out of scope here.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				field: { type: "string", description: "Frontmatter key for the simple form, e.g. 'type'." },
				value: { description: "Match value for the simple form; omit to test presence of `field`." },
				filter: { type: "object", description: "JsonLogic-lite filter (and/or/not, ==,!=,>,<,>=,<=, in). Use instead of field/value for boolean composition." },
				folder: { type: "string", description: "Scope the scan to a folder, e.g. 'Projects'." },
			},
		},
		run: async (env, a) => {
			const filter = a?.filter as Filter | undefined;
			const field = typeof a?.field === "string" ? a.field : undefined;
			if (!filter && !field) return fail("vault_query needs either `field` (simple form) or `filter` (JsonLogic).");
			let matches: (fm: Record<string, unknown>) => boolean;
			try {
				matches = filter ? (fm) => evalFilter(fm, filter) : (fm) => frontmatterMatches(fm, field!, a?.value);
			} catch (e) {
				return fail(`invalid filter: ${String((e as Error).message ?? e)}`);
			}
			let scanned: Array<{ path: string; fm: Record<string, unknown> }>;
			try {
				scanned = await scanVault(env, typeof a?.folder === "string" ? a.folder : undefined);
			} catch (e) {
				return fail(`vault_query scan failed: ${String((e as Error).message ?? e)}`);
			}
			const hits: Array<{ path: string }> = [];
			for (const n of scanned) {
				// A malformed filter throws only on the first note; surface it once.
				try {
					if (matches(n.fm)) hits.push({ path: n.path });
				} catch (e) {
					return fail(`invalid filter: ${String((e as Error).message ?? e)}`);
				}
			}
			return ok(JSON.stringify({ scanned: scanned.length, count: hits.length, matches: hits.map((h) => h.path) }, null, 2));
		},
	},
	{
		name: "vault_patch",
		description:
			"Structural edit of a note: target exactly ONE of `heading` (the `# Heading` section), `block` (an `^block-id` anchor), or `frontmatter_field` (a top-level frontmatter key). `mode` (replace|append|prepend) applies to heading/block; frontmatter_field always sets/replaces the key to `content`. Read → transform → commit on the git store, so history is the undo — no confirm gate (same rationale as vault_batch_append). A missing or ambiguous target fails cleanly (mirrors vault_edit's unique-match discipline).",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["path", "content"],
			properties: {
				path: { type: "string" },
				heading: { type: "string", description: "Target the section under this heading (by its text)." },
				block: { type: "string", description: "Target the block anchored by this id (`^id`, with or without the caret)." },
				frontmatter_field: { type: "string", description: "Target this top-level frontmatter key; `content` is the value to set." },
				mode: { type: "string", enum: ["replace", "append", "prepend"], default: "replace", description: "For heading/block targets." },
				content: { type: "string", description: "Text to write (the section/block text, or the frontmatter value)." },
			},
		},
		run: async (env, a) => {
			const path = typeof a?.path === "string" ? a.path.trim() : "";
			if (!path) return fail("vault_patch requires a `path`.");
			if (typeof a?.content !== "string") return fail("vault_patch requires `content`.");
			const targets = ["heading", "block", "frontmatter_field"].filter((k) => typeof a?.[k] === "string" && a[k]);
			if (targets.length !== 1) return fail("vault_patch needs exactly one target: `heading`, `block`, or `frontmatter_field`.");
			const mode = (["replace", "append", "prepend"].includes(a?.mode) ? a.mode : "replace") as PatchMode;
			const read = await obsidian.run(env, git({ action: "read", path }));
			if (read.isError) return read;
			const cur = read.content[0].text;
			let patched: { content: string; changed: boolean };
			try {
				if (targets[0] === "frontmatter_field") patched = patchFrontmatter(cur, a.frontmatter_field, a.content);
				else if (targets[0] === "heading") patched = patchHeadingSection(cur, a.heading, mode, a.content);
				else patched = patchBlockRef(cur, a.block, mode, a.content);
			} catch (e) {
				return fail(`vault_patch: ${String((e as Error).message ?? e)}`);
			}
			if (!patched.changed) return ok(JSON.stringify({ ok: true, path, changed: false, note: "target already holds this value" }, null, 2));
			const wrote = await obsidian.run(env, git({ action: "write", path, content: patched.content }));
			if (wrote.isError) return wrote;
			return ok(JSON.stringify({ ok: true, path, changed: true, target: targets[0], mode: targets[0] === "frontmatter_field" ? undefined : mode }, null, 2));
		},
	},
];

export const VAULT_TOOLS = TOOLS;

// Mirrors handleRpc's protocol shell (initialize / notifications / tools) with
// the vault registry instead of FUNCTIONS. Stateless per request, like the main
// server: the MCP session is a per-call formality, all state lives in the store.
// Above this, refuse a tools/call body outright. The vault handler dispatches
// tools directly (not through the main /mcp checkArgs), so it enforces its own
// coarse ceiling — a note body can be large, but not unbounded.
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function handleVaultRpc(env: RtEnv, _ctx: ExecutionContext, rpc: JsonRpc | undefined, bodyBytes = 0): Promise<Response> {
	const method = rpc?.method;
	const id = rpc?.id ?? null;

	if (!method) return new Response(null, { status: 202 });
	if (method === "tools/call" && bodyBytes > MAX_BODY_BYTES) {
		return sseResponse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Request too large (${bodyBytes} bytes > ${MAX_BODY_BYTES}).` }], isError: true } });
	}
	if (method === "initialize") {
		return sseResponse({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: "2025-06-18",
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "vault", version: "0.1.0" },
			},
		});
	}
	if (method.startsWith("notifications/")) return new Response(null, { status: 202 });
	if (method === "tools/list") {
		return sseResponse({ jsonrpc: "2.0", id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
	}
	if (method === "tools/call") {
		const name = String(rpc?.params?.name ?? "");
		const tool = TOOLS.find((t) => t.name === name);
		if (!tool) return sseResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool: ${name}` } });
		const args = rpc?.params?.arguments ?? {};
		// The same dispatch rails the main /mcp path enforces (this handler doesn't
		// go through handleRpc): reject a pathological args blob, and never let one
		// tool hang the isolate.
		const argErr = checkArgs(args, MAX_BODY_BYTES, 64);
		if (argErr) return sseResponse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `${name} rejected: ${argErr}` }], isError: true } });
		try {
			const result = await withDeadline(name, FN_DEADLINE_MS, tool.run(env, args));
			return sseResponse({ jsonrpc: "2.0", id, result });
		} catch (e) {
			return sseResponse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `${name} failed: ${String((e as Error).message ?? e)}` }], isError: true } });
		}
	}
	return sseResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } });
}
