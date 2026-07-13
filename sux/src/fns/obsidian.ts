import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";
import { extractRpcFromText } from "../mcp-util";
import { fromB64, toB64, oj } from "./_util";

// Work with Obsidian markdown notes across two backends:
//   git    (default) — a git-backed vault via the GitHub API (async, versioned).
//   remote          — Obsidian's official Local REST API exposed over a PUBLIC
//                     HTTPS URL (Tailscale Funnel), authed with the plugin's
//                     bearer key. The cloud Worker can reach a Funnel URL
//                     directly, so this is real-time to the LIVE vault with no
//                     SSRF issue (the funnel host is public, not LAN).
const GH = "https://api.github.com";
const ghHeaders = { Accept: "application/vnd.github+json", "User-Agent": "sux-obsidian" };

async function ghJson(env: any, url: string, init?: { method?: string; body?: string }): Promise<{ status: number; json: any }> {
	const resp = await smartFetch(env, url, { method: init?.method, headers: { ...ghHeaders, ...(init?.body ? { "Content-Type": "application/json" } : {}) }, body: init?.body });
	const json = await resp.json().catch(() => null);
	return { status: resp.status, json };
}

// --- vault config (shared with the ingest fn) ---
export type VaultCfg = { repo: string; branch: string; dir: string; inVault: (p: string) => string };

export function vaultCfg(env: any): VaultCfg | { error: string } {
	const repo = env.OBSIDIAN_VAULT_REPO;
	if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(String(repo))) return { error: "Obsidian git backend not configured. Set OBSIDIAN_VAULT_REPO to 'owner/repo'." };
	const branch = String(env.OBSIDIAN_VAULT_BRANCH ?? "main");
	const dir = String(env.OBSIDIAN_VAULT_DIR ?? "").replace(/^\/+|\/+$/g, "");
	return { repo: String(repo), branch, dir, inVault: (p: string) => (dir ? `${dir}/${p}`.replace(/\/+/g, "/") : p) };
}

// --- KV read-through cache (git = truth, KV = cache) ---
// Git-backend reads validate against the vault's HEAD commit sha (rechecked with
// GitHub at most once a minute; when the ref fetch fails, the cached sha is
// trusted for at most HEAD_STALE_MAX_MS, then the cache is bypassed). Git writes
// warm the cache in-line, since the contents API hands back the new commit sha —
// which IS the new HEAD. Git and remote entries live in SEPARATE namespaces so a
// lagging git mirror can never clobber the fresher live-vault copy; when the Mac
// is unreachable, remote `read` serves its last known copy instead of failing.
// The cache never feeds writes: edit/append always re-read their source.
// KV has no compare-and-swap, so concurrent writers can interleave head updates;
// accepted for a single-user vault (blast radius ≤ one recheck window).
const HEAD_RECHECK_MS = 60_000;
const HEAD_STALE_MAX_MS = 600_000;
const normPath = (p: string) => p.replace(/^\/+/, "");
const headKey = (cfg: VaultCfg) => `cache:vault:git:${cfg.repo}@${cfg.branch}:head`;
const gitNoteKey = (cfg: VaultCfg, p: string) => `cache:vault:git:${cfg.repo}@${cfg.branch}:note:${cfg.inVault(normPath(p))}`;
const gitListKey = (cfg: VaultCfg, filter: string) => `cache:vault:git:${cfg.repo}@${cfg.branch}:list:${filter || "/"}`;
const gitIndexKey = (cfg: VaultCfg) => `cache:vault:git:${cfg.repo}@${cfg.branch}:index`;
const remoteNoteKey = (p: string) => `cache:vault:remote:note:${normPath(p)}`;

async function cacheGet(env: any, key: string): Promise<any | null> {
	try {
		const raw = await env.OAUTH_KV?.get(key);
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}
async function cachePut(env: any, key: string, value: unknown): Promise<void> {
	try {
		await env.OAUTH_KV?.put(key, JSON.stringify(value));
	} catch {}
}
async function cacheDel(env: any, key: string): Promise<void> {
	try {
		await env.OAUTH_KV?.delete(key);
	} catch {}
}

// The derived-scan index (fns/obsidian owns it because HEAD resolution + the KV
// keyspace live here). The blob shape is opaque to this module — vault-mcp owns
// it and stamps the HEAD sha it was built at, so a HEAD change invalidates it.
export async function readVaultIndexBlob(env: any, cfg: VaultCfg): Promise<any | null> {
	return cacheGet(env, gitIndexKey(cfg));
}
export async function writeVaultIndexBlob(env: any, cfg: VaultCfg, blob: unknown): Promise<void> {
	return cachePut(env, gitIndexKey(cfg), blob);
}

export async function vaultHead(env: any, cfg: VaultCfg): Promise<string | null> {
	const cached = await cacheGet(env, headKey(cfg));
	const now = Date.now();
	if (cached?.sha && now - cached.at < HEAD_RECHECK_MS) return cached.sha;
	const { status, json } = await ghJson(env, `${GH}/repos/${cfg.repo}/git/ref/heads/${encodeURIComponent(cfg.branch)}`);
	const sha = status === 200 ? (json?.object?.sha ?? null) : null;
	if (sha) {
		await cachePut(env, headKey(cfg), { sha, at: now });
		return sha;
	}
	return cached?.sha && now - cached.at < HEAD_STALE_MAX_MS ? cached.sha : null;
}

async function noteWritten(env: any, cfg: VaultCfg, path: string, body: string | null, commitSha: string | null | undefined): Promise<void> {
	if (body !== null && commitSha) await cachePut(env, gitNoteKey(cfg, path), { body, sha: commitSha, at: Date.now(), src: "git" });
	else await cacheDel(env, gitNoteKey(cfg, path));
	if (commitSha) await cachePut(env, headKey(cfg), { sha: commitSha, at: Date.now() });
	else await cacheDel(env, headKey(cfg));
}

// --- shared vault-write machinery (the write op here + the ingest fn) ---

/** Reject vault paths that escape the note tree: '..' or dot-prefixed segments
 * would let the write-scoped GITHUB_TOKEN touch repo infra (.github/workflows,
 * .obsidian config) — never the caller's intent for a note. */
export function badVaultPath(p: string): string | null {
	const segs = normPath(p).split("/");
	if (!segs.length || segs.some((s) => !s || s === ".." || s.startsWith("."))) {
		return `Refusing vault path '${p}': segments must be non-empty and not start with '.' — repo/vault infra (.github/, .obsidian/, dotfiles) is not reachable through this fn.`;
	}
	return null;
}

/** Commit one file (create/overwrite) into the vault repo; warms the KV cache for text bodies. */
export async function vaultPut(
	env: any,
	cfg: VaultCfg,
	path: string,
	content: string | Uint8Array,
	message: string,
	opts?: { failIfExists?: boolean; sha?: string },
): Promise<{ ok: true; commit?: string; created: boolean } | { ok: false; error: string; exists?: boolean; conflict?: boolean }> {
	const bad = badVaultPath(path);
	if (bad) return { ok: false, error: bad };
	const full = cfg.inVault(normPath(path));
	// A caller that threads a READ-TIME sha (edit/patch) wants THAT exact sha in the
	// PUT, so a concurrent write between read and write collides (409) instead of
	// being silently overwritten. Re-fetching HEAD-at-write here would fetch the
	// concurrent writer's sha and defeat GitHub's optimistic-concurrency check.
	let sha = opts?.sha;
	let created = false;
	if (sha === undefined) {
		const cur = await ghJson(env, `${GH}/repos/${cfg.repo}/contents/${encodeURIComponent(full)}?ref=${encodeURIComponent(cfg.branch)}`);
		if (opts?.failIfExists && cur.status === 200) return { ok: false, error: `already exists: ${path}`, exists: true };
		sha = cur.status === 200 ? cur.json?.sha : undefined;
		created = cur.status === 404;
	}
	const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
	const body = JSON.stringify({ message, content: toB64(bytes), branch: cfg.branch, ...(sha ? { sha } : {}) });
	const put = await ghJson(env, `${GH}/repos/${cfg.repo}/contents/${encodeURIComponent(full)}`, { method: "PUT", body });
	if (put.status === 409) return { ok: false, error: `note changed since read — re-read and retry: ${path}`, conflict: true };
	if (put.status >= 400) return { ok: false, error: `GitHub write error: ${put.json?.message ?? `HTTP ${put.status}`} (writes need a GITHUB_TOKEN with write access).` };
	await noteWritten(env, cfg, path, typeof content === "string" ? content : null, put.json?.commit?.sha);
	return { ok: true, commit: put.json?.commit?.sha, created };
}

/** Read a note's decoded body + sha from GitHub, refetching raw for >1MB files.
 * The Contents API omits inline content past 1MB (returns a positive `size` but
 * content:""), so every git reader — read, append, edit — must go through here;
 * decoding content directly would silently see an empty body and (on append)
 * destroy the note. Returns status 404 with an empty body for a missing note. */
export async function readGitContents(env: any, cfg: VaultCfg, full: string): Promise<{ status: number; sha?: string; body: string; error?: string }> {
	const cur = await ghJson(env, `${GH}/repos/${cfg.repo}/contents/${encodeURIComponent(full)}?ref=${encodeURIComponent(cfg.branch)}`);
	if (cur.status === 404) return { status: 404, body: "" };
	if (cur.status >= 400) return { status: cur.status, body: "", error: `GitHub error reading note: ${cur.json?.message ?? `HTTP ${cur.status}`}` };
	let body = cur.json?.content ? new TextDecoder().decode(fromB64(String(cur.json.content).replace(/\n/g, ""))) : "";
	if (!body && Number(cur.json?.size ?? 0) > 0) {
		const raw = await smartFetch(env, `${GH}/repos/${cfg.repo}/contents/${encodeURIComponent(full)}?ref=${encodeURIComponent(cfg.branch)}`, { headers: { ...ghHeaders, Accept: "application/vnd.github.raw+json" } });
		if (raw.status >= 400) return { status: raw.status, sha: cur.json?.sha, body: "", error: `GitHub error reading large note (${cur.json?.size} bytes): HTTP ${raw.status}` };
		body = await raw.text();
	}
	return { status: cur.status, sha: cur.json?.sha, body };
}

// Surgical find/replace: the match must be unique unless all=true, so an edit
// can never land somewhere unintended — task ops flip exactly the checkbox they
// mean to, and a note is never reprinted wholesale. The function replacer keeps
// `$&`/`$'`/`$$` in the replacement literal (String.replace substitution
// patterns would otherwise silently corrupt notes holding $-text).
function applyEdit(text: string, find: string, replace: string, all: boolean): { text: string; count: number } | { error: string } {
	const count = text.split(find).length - 1;
	if (count === 0) return { error: "`find` text not found" };
	if (count > 1 && !all) return { error: `\`find\` matches ${count} times — pass all:true to replace every occurrence, or make it unique` };
	return { text: all ? text.split(find).join(replace) : text.replace(find, () => replace), count };
}

// --- remote backend: Obsidian Local REST API over a public HTTPS (Funnel) URL ---
function remoteFetch(env: any, path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response> {
	const base = String(env.OBSIDIAN_REMOTE_URL).replace(/\/+$/, "");
	// Direct fetch: it's your own Funnel'd endpoint — no need to residentially proxy it.
	return fetch(`${base}${path}`, {
		method: init?.method ?? "GET",
		headers: { Authorization: `Bearer ${env.OBSIDIAN_REMOTE_KEY}`, ...(init?.headers ?? {}) },
		body: init?.body,
		signal: AbortSignal.timeout(20_000),
	});
}

const encPath = (p: string) => p.split("/").filter(Boolean).map(encodeURIComponent).join("/");

// The Local REST API plugin ALSO ships a built-in MCP server at /mcp/ (Streamable
// HTTP, Bearer auth) exposing ~15 vault tools. Wrap it (F13). Unlike Kagi's
// stateless MCP, this server is STATEFUL: it requires the MCP handshake —
// initialize (which returns an Mcp-Session-Id header), then notifications/
// initialized, then the real call — all carrying the session id. We run the
// handshake per call (sessions are cheap; keeps the wrapper stateless).
async function obsidianMcp(env: any, method: string, params: unknown): Promise<{ result?: any; error?: any }> {
	const endpoint = `${String(env.OBSIDIAN_REMOTE_URL).replace(/\/+$/, "")}/mcp/`;
	const base = { Authorization: `Bearer ${env.OBSIDIAN_REMOTE_KEY}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
	const post = (sid: string | undefined, payload: unknown) =>
		fetch(endpoint, { method: "POST", headers: { ...base, ...(sid ? { "Mcp-Session-Id": sid } : {}) }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });

	const init = await post(undefined, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sux", version: "1" } } });
	if (!init.ok) return { error: { message: `MCP initialize HTTP ${init.status}: ${(await init.text().catch(() => "")).slice(0, 160)}` } };
	const sid = init.headers.get("mcp-session-id") ?? undefined;
	if (sid) await post(sid, { jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});

	const resp = await post(sid, { jsonrpc: "2.0", id: 2, method, params });
	const obj = extractRpcFromText(await resp.text(), resp.headers.get("content-type"));
	return { result: obj?.result, error: obj?.error ?? (resp.status >= 400 ? { message: `HTTP ${resp.status}` } : undefined) };
}

async function runRemote(env: any, action: string, args: any) {
	if (!env.OBSIDIAN_REMOTE_URL || !env.OBSIDIAN_REMOTE_KEY) {
		return fail("Obsidian remote backend not configured. Set OBSIDIAN_REMOTE_URL (the Tailscale-Funnel'd Local REST API URL, e.g. https://vault.<tailnet>.ts.net) and OBSIDIAN_REMOTE_KEY (the plugin's API key from Obsidian → Local REST API settings).");
	}
	try {
		// Wrap the vault's built-in MCP server (full 15-tool surface).
		if (action === "tools") {
			const { result, error } = await obsidianMcp(env, "tools/list", {});
			if (error) return fail(`Obsidian MCP tools/list error: ${error.message ?? JSON.stringify(error)}`);
			const tools = (result?.tools ?? []).map((t: any) => ({ name: t?.name, description: t?.description }));
			return ok(oj({ via: "mcp", count: tools.length, tools }));
		}
		if (action === "call") {
			const tool = String(args?.tool ?? "").trim();
			if (!tool) return fail("action=call requires a `tool` (the MCP tool name — run action=tools to list them) and optional `tool_args`.");
			const { result, error } = await obsidianMcp(env, "tools/call", { name: tool, arguments: args?.tool_args ?? {} });
			if (error) return fail(`Obsidian MCP '${tool}' error: ${error.message ?? JSON.stringify(error)}`);
			const text = (result?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
			if (result?.isError) return fail(text || `Obsidian MCP '${tool}' returned an error.`);
			return ok(text || oj(result));
		}
		if (action === "list") {
			const dir = String(args?.path ?? "").replace(/^\/+|\/+$/g, "");
			const resp = await remoteFetch(env, `/vault/${dir ? `${encPath(dir)}/` : ""}`);
			if (resp.status >= 400) return fail(`Obsidian remote error listing: HTTP ${resp.status}`);
			const j = (await resp.json().catch(() => null)) as any;
			const files = j?.files ?? [];
			return ok(oj({ dir: dir || "/", count: files.length, files }));
		}
		if (action === "read") {
			const p = String(args?.path ?? "").trim();
			if (!p) return fail("action=read requires a `path`.");
			// Mac asleep surfaces as a thrown fetch error OR as a 5xx from the Funnel
			// edge (tailscaled up, Obsidian down) — both fall back to the KV copy.
			let resp: Response | null = null;
			let reason = "";
			try {
				resp = await remoteFetch(env, `/vault/${encPath(p)}`, { headers: { Accept: "text/markdown" } });
			} catch (e) {
				reason = String((e as Error).message ?? e);
			}
			if (!resp || resp.status >= 500) {
				const hit = await cacheGet(env, remoteNoteKey(p));
				if (typeof hit?.body === "string") return ok(hit.body);
				return fail(`obsidian remote unreachable (${reason || `HTTP ${resp?.status}`}) and no cached copy of ${p} — try backend:'git'.`);
			}
			if (resp.status === 404) return fail(`Note not found: ${p}`);
			if (resp.status >= 400) return fail(`Obsidian remote error reading: HTTP ${resp.status}`);
			const text = await resp.text();
			await cachePut(env, remoteNoteKey(p), { body: text, sha: null, at: Date.now(), src: "remote" });
			return ok(text);
		}
		if (action === "search") {
			const q = String(args?.query ?? "").trim();
			if (!q) return fail("action=search requires a `query`.");
			const resp = await remoteFetch(env, `/search/simple/?query=${encodeURIComponent(q)}&contextLength=100`, { method: "POST" });
			if (resp.status >= 400) return fail(`Obsidian remote search error: HTTP ${resp.status}`);
			const j = (await resp.json().catch(() => null)) as any;
			const hits = (Array.isArray(j) ? j : []).slice(0, 20).map((h: any) => ({ path: h?.filename, score: h?.score }));
			return ok(oj({ query: q, count: hits.length, hits }));
		}
		if (action === "append") {
			const p = String(args?.path ?? "").trim();
			const content = String(args?.content ?? "");
			if (!p) return fail("action=append requires a `path`.");
			if (!content) return fail("action=append requires `content`.");
			const resp = await remoteFetch(env, `/vault/${encPath(p)}`, { method: "POST", headers: { "Content-Type": "text/markdown" }, body: content });
			if (resp.status >= 400) return fail(`Obsidian remote write error: HTTP ${resp.status}`);
			await cacheDel(env, remoteNoteKey(p)); // merged body lives server-side; next read refills
			return ok(oj({ ok: true, path: p, bytes: content.length }));
		}
		if (action === "write") {
			const p = String(args?.path ?? "").trim();
			const content = String(args?.content ?? "");
			if (!p) return fail("action=write requires a `path`.");
			if (!content) return fail("action=write requires `content`.");
			const resp = await remoteFetch(env, `/vault/${encPath(p)}`, { method: "PUT", headers: { "Content-Type": "text/markdown" }, body: content });
			if (resp.status >= 400) return fail(`Obsidian remote write error: HTTP ${resp.status}`);
			await cachePut(env, remoteNoteKey(p), { body: content, sha: null, at: Date.now(), src: "remote" });
			return ok(oj({ ok: true, path: p, bytes: content.length }));
		}
		if (action === "edit") {
			const p = String(args?.path ?? "").trim();
			const find = String(args?.find ?? "");
			if (!p) return fail("action=edit requires a `path`.");
			if (!find) return fail("action=edit requires `find` (the exact text to replace).");
			const cur = await remoteFetch(env, `/vault/${encPath(p)}`, { headers: { Accept: "text/markdown" } });
			if (cur.status === 404) return fail(`Note not found: ${p}`);
			if (cur.status >= 400) return fail(`Obsidian remote error reading: HTTP ${cur.status}`);
			const edited = applyEdit(await cur.text(), find, String(args?.replace ?? ""), args?.all === true);
			if ("error" in edited) return fail(`${edited.error} in ${p}`);
			const resp = await remoteFetch(env, `/vault/${encPath(p)}`, { method: "PUT", headers: { "Content-Type": "text/markdown" }, body: edited.text });
			if (resp.status >= 400) return fail(`Obsidian remote write error: HTTP ${resp.status}`);
			await cachePut(env, remoteNoteKey(p), { body: edited.text, sha: null, at: Date.now(), src: "remote" });
			return ok(oj({ ok: true, path: p, replaced: edited.count }));
		}
		if (action === "delete") {
			const p = String(args?.path ?? "").trim();
			if (!p) return fail("action=delete requires a `path`.");
			const resp = await remoteFetch(env, `/vault/${encPath(p)}`, { method: "DELETE" });
			if (resp.status === 404) return fail(`Note not found: ${p}`);
			if (resp.status >= 400) return fail(`Obsidian remote delete error: HTTP ${resp.status}`);
			await cacheDel(env, remoteNoteKey(p));
			return ok(oj({ ok: true, deleted: p }));
		}
		return fail(`Unknown action '${action}'. Use list | read | search | append | write | edit | delete | tools | call.`);
	} catch (e) {
		return fail(`obsidian remote (${action}) failed: ${String((e as Error).message ?? e)}`);
	}
}

export const obsidian: Fn = {
	name: "obsidian",
	cost: 2,
	description:
		"Work with Obsidian markdown notes. action: list (notes, optionally under `path`) | read (a note by `path`) | search (`query`) | append (add `content` to a note at `path`, creating it if absent) | write (create/overwrite a note with `content`) | edit (surgical find/replace: `find` + `replace`, unique match unless `all`) | delete (remove a note). backend: git (default) — a GitHub-backed vault; every write is a commit, so git history is the undo (OBSIDIAN_VAULT_REPO='owner/repo', optional OBSIDIAN_VAULT_BRANCH/OBSIDIAN_VAULT_DIR; GITHUB_TOKEN for private repos + writes); remote — the LIVE vault via Obsidian's Local REST API over a public HTTPS URL (Tailscale Funnel; OBSIDIAN_REMOTE_URL + OBSIDIAN_REMOTE_KEY). remote also wraps the vault's built-in MCP server: action=tools lists its ~15 vault tools and action=call runs one (tool + tool_args). Reads are KV-cached: git reads validate against the vault HEAD sha; remote `read` writes through and falls back to the cached copy when the Mac is unreachable (fetch failure or 5xx — remote list/search are uncached). Mutating actions refuse dot-prefixed path segments (.github/, .obsidian/, dotfiles): repo/vault infra is not reachable through this fn.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["action"],
		properties: {
			action: { type: "string", enum: ["list", "read", "search", "append", "write", "edit", "delete", "tools", "call"] },
			path: { type: "string", description: "Note path within the vault (read/append/write/edit/delete; a folder filter for list)." },
			query: { type: "string", description: "Search query (action=search)." },
			content: { type: "string", description: "Markdown content (action=append/write)." },
			find: { type: "string", description: "Exact text to replace (action=edit); must match exactly once unless `all` is set." },
			replace: { type: "string", description: "Replacement text (action=edit; empty string deletes the match)." },
			all: { type: "boolean", description: "Replace every occurrence of `find` (action=edit)." },
			tool: { type: "string", description: "MCP tool name (remote, action=call). Run action=tools to list them." },
			tool_args: { type: "object", additionalProperties: true, description: "Arguments for the MCP tool (remote, action=call)." },
			backend: { type: "string", enum: ["git", "remote"], default: "git" },
		},
	},
	cacheable: false, // notes are mutable; reads should reflect the live vault
	run: async (env, args) => {
		// Normalize so 'Tools' / 'CALL' / 'read ' don't dead-end at "Unknown action"
		// (dispatch does no server-side enum enforcement).
		const action = String(args?.action ?? "").trim().toLowerCase();
		const backend = String(args?.backend ?? "git").trim().toLowerCase();
		if (["append", "write", "edit", "delete"].includes(action)) {
			const p0 = String(args?.path ?? "").trim();
			const bad = p0 ? badVaultPath(p0) : null;
			if (bad) return fail(bad);
		}
		if (backend === "remote") return runRemote(env, action, args);
		// tools/call are remote-only (they wrap the live vault's MCP server); check
		// this BEFORE vaultCfg so a remote-only config isn't misdirected to "set
		// OBSIDIAN_VAULT_REPO".
		if (action === "tools" || action === "call") return fail("actions 'tools' and 'call' wrap the live vault's MCP server — pass backend:'remote'.");
		const cfg = vaultCfg(env);
		if ("error" in cfg) return fail(cfg.error);
		const { repo, branch, dir, inVault } = cfg;

		try {
			if (action === "list") {
				const rawFilter = String(args?.path ?? "").replace(/^\/+|\/+$/g, "");
				const filter = rawFilter ? inVault(rawFilter) : dir;
				const head = env.OAUTH_KV ? await vaultHead(env, cfg) : null;
				if (head) {
					const hit = await cacheGet(env, gitListKey(cfg, filter));
					if (hit?.sha === head && typeof hit.payload === "string") return ok(hit.payload);
				}
				const { status, json } = await ghJson(env, `${GH}/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
				if (status >= 400) return fail(`GitHub error listing vault: ${json?.message ?? `HTTP ${status}`}`);
				const notes = (json?.tree ?? [])
					.filter((n: any) => n?.type === "blob" && typeof n.path === "string" && n.path.endsWith(".md") && (!filter || n.path.startsWith(filter)))
					.map((n: any) => n.path);
				const payload = oj({ repo, branch, count: notes.length, notes });
				if (head) await cachePut(env, gitListKey(cfg, filter), { payload, sha: head, at: Date.now() });
				return ok(payload);
			}
			if (action === "read") {
				const p = String(args?.path ?? "").trim();
				if (!p) return fail("action=read requires a `path`.");
				const head = env.OAUTH_KV ? await vaultHead(env, cfg) : null;
				if (head) {
					const hit = await cacheGet(env, gitNoteKey(cfg, p));
					if (hit?.sha === head && typeof hit.body === "string") return ok(hit.body);
				}
				const r = await readGitContents(env, cfg, inVault(p));
				if (r.status === 404) return fail(`Note not found: ${p}`);
				if (r.error) return fail(r.error);
				if (head) await cachePut(env, gitNoteKey(cfg, p), { body: r.body, sha: head, at: Date.now(), src: "git" });
				return ok(r.body);
			}
			if (action === "search") {
				const q = String(args?.query ?? "").trim();
				if (!q) return fail("action=search requires a `query`.");
				const { status, json } = await ghJson(env, `${GH}/search/code?q=${encodeURIComponent(`${q} repo:${repo} extension:md`)}&per_page=20`);
				if (status >= 400) return fail(`GitHub search error: ${json?.message ?? `HTTP ${status}`} (code search needs an authenticated GITHUB_TOKEN).`);
				const hits = (json?.items ?? []).map((it: any) => ({ path: it?.path, url: it?.html_url }));
				return ok(oj({ query: q, count: hits.length, hits }));
			}
			if (action === "append") {
				const p = String(args?.path ?? "").trim();
				const content = String(args?.content ?? "");
				if (!p) return fail("action=append requires a `path`.");
				if (!content) return fail("action=append requires `content`.");
				const full = inVault(p);
				// Read current (for the sha + existing body); 404 → create fresh. Goes
				// through readGitContents so a >1MB note's body isn't seen as empty and
				// destroyed by the merge.
				const cur = await readGitContents(env, cfg, full);
				if (cur.error) return fail(cur.error);
				const existing = cur.body;
				const sha = cur.status === 200 ? cur.sha : undefined;
				const merged = existing ? `${existing.replace(/\n+$/, "")}\n\n${content}\n` : `${content}\n`;
				const body = JSON.stringify({ message: `sux: append to ${p}`, content: toB64(new TextEncoder().encode(merged)), branch, ...(sha ? { sha } : {}) });
				const put = await ghJson(env, `${GH}/repos/${repo}/contents/${encodeURIComponent(full)}`, { method: "PUT", body });
				if (put.status >= 400) return fail(`GitHub write error: ${put.json?.message ?? `HTTP ${put.status}`} (append needs a GITHUB_TOKEN with write access).`);
				await noteWritten(env, cfg, p, merged, put.json?.commit?.sha);
				return ok(oj({ ok: true, path: p, bytes: merged.length, commit: put.json?.commit?.sha }));
			}
			if (action === "write") {
				const p = String(args?.path ?? "").trim();
				const content = String(args?.content ?? "");
				if (!p) return fail("action=write requires a `path`.");
				if (!content) return fail("action=write requires `content`.");
				const r = await vaultPut(env, cfg, p, content, `sux: write ${p}`);
				if (!r.ok) return fail(r.error);
				return ok(oj({ ok: true, path: p, bytes: content.length, created: r.created, commit: r.commit }));
			}
			if (action === "edit") {
				const p = String(args?.path ?? "").trim();
				const find = String(args?.find ?? "");
				if (!p) return fail("action=edit requires a `path`.");
				if (!find) return fail("action=edit requires `find` (the exact text to replace).");
				const full = inVault(p);
				const cur = await readGitContents(env, cfg, full);
				if (cur.status === 404) return fail(`Note not found: ${p}`);
				if (cur.error) return fail(cur.error);
				const edited = applyEdit(cur.body, find, String(args?.replace ?? ""), args?.all === true);
				if ("error" in edited) return fail(`${edited.error} in ${p}`);
				// PUT with the READ-TIME sha (optimistic concurrency): a concurrent write
				// since this read yields a 409 "note changed" instead of a silent clobber.
				const w = await vaultPut(env, cfg, p, edited.text, `sux: edit ${p}`, { sha: cur.sha });
				if (!w.ok) return fail(w.error);
				return ok(oj({ ok: true, path: p, replaced: edited.count, commit: w.commit }));
			}
			if (action === "delete") {
				const p = String(args?.path ?? "").trim();
				if (!p) return fail("action=delete requires a `path`.");
				const full = inVault(p);
				const cur = await ghJson(env, `${GH}/repos/${repo}/contents/${encodeURIComponent(full)}?ref=${encodeURIComponent(branch)}`);
				if (cur.status === 404) return fail(`Note not found: ${p}`);
				if (cur.status >= 400) return fail(`GitHub error reading note: ${cur.json?.message ?? `HTTP ${cur.status}`}`);
				const body = JSON.stringify({ message: `sux: delete ${p}`, sha: cur.json?.sha, branch });
				const del = await ghJson(env, `${GH}/repos/${repo}/contents/${encodeURIComponent(full)}`, { method: "DELETE", body });
				if (del.status >= 400) return fail(`GitHub delete error: ${del.json?.message ?? `HTTP ${del.status}`} (delete needs a GITHUB_TOKEN with write access).`);
				await noteWritten(env, cfg, p, null, del.json?.commit?.sha);
				return ok(oj({ ok: true, deleted: p, commit: del.json?.commit?.sha }));
			}
			return fail(`Unknown action '${action}'. Use list | read | search | append | write | edit | delete.`);
		} catch (e) {
			return fail(`obsidian (${action}) failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
