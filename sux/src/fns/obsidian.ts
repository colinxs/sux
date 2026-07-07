import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";
import { extractRpcFromText } from "../mcp-util";
import { fromB64, toB64 } from "./_util";

// Work with Obsidian markdown notes across three backends:
//   git    (default) — a git-backed vault via the GitHub API (async, versioned).
//   remote          — Obsidian's official Local REST API exposed over a PUBLIC
//                     HTTPS URL (Tailscale Funnel), authed with the plugin's
//                     bearer key. The cloud Worker can reach a Funnel URL
//                     directly, so this is real-time to the LIVE vault with no
//                     SSRF issue (the funnel host is public, not LAN).
//   local           — the same Local REST API on localhost/LAN; the Worker can't
//                     reach it and the node SSRF guard blocks LAN IPs, so it's a
//                     stub pointing at `remote`.
const GH = "https://api.github.com";
const ghHeaders = { Accept: "application/vnd.github+json", "User-Agent": "sux-obsidian" };

async function ghJson(env: any, url: string, init?: { method?: string; body?: string }): Promise<{ status: number; json: any }> {
	const resp = await smartFetch(env, url, { method: init?.method, headers: { ...ghHeaders, ...(init?.body ? { "Content-Type": "application/json" } : {}) }, body: init?.body });
	const json = await resp.json().catch(() => null);
	return { status: resp.status, json };
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
// HTTP, Bearer auth) exposing ~15 vault tools. Wrap it directly (F13, same shape
// as kagiTool): JSON-RPC over HTTP, SSE or JSON response. `tools`/`call` expose
// the full surface; the REST verbs below stay as convenience shortcuts.
async function obsidianMcp(env: any, method: string, params: unknown): Promise<{ result?: any; error?: any }> {
	const base = String(env.OBSIDIAN_REMOTE_URL).replace(/\/+$/, "");
	const resp = await fetch(`${base}/mcp/`, {
		method: "POST",
		headers: { Authorization: `Bearer ${env.OBSIDIAN_REMOTE_KEY}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		signal: AbortSignal.timeout(20_000),
	});
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
			return ok(JSON.stringify({ via: "mcp", count: tools.length, tools }, null, 2));
		}
		if (action === "call") {
			const tool = String(args?.tool ?? "").trim();
			if (!tool) return fail("action=call requires a `tool` (the MCP tool name — run action=tools to list them) and optional `tool_args`.");
			const { result, error } = await obsidianMcp(env, "tools/call", { name: tool, arguments: args?.tool_args ?? {} });
			if (error) return fail(`Obsidian MCP '${tool}' error: ${error.message ?? JSON.stringify(error)}`);
			const text = (result?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
			if (result?.isError) return fail(text || `Obsidian MCP '${tool}' returned an error.`);
			return ok(text || JSON.stringify(result, null, 2));
		}
		if (action === "list") {
			const dir = String(args?.path ?? "").replace(/^\/+|\/+$/g, "");
			const resp = await remoteFetch(env, `/vault/${dir ? `${encPath(dir)}/` : ""}`);
			if (resp.status >= 400) return fail(`Obsidian remote error listing: HTTP ${resp.status}`);
			const j = (await resp.json().catch(() => null)) as any;
			const files = j?.files ?? [];
			return ok(JSON.stringify({ dir: dir || "/", count: files.length, files }, null, 2));
		}
		if (action === "read") {
			const p = String(args?.path ?? "").trim();
			if (!p) return fail("action=read requires a `path`.");
			const resp = await remoteFetch(env, `/vault/${encPath(p)}`, { headers: { Accept: "text/markdown" } });
			if (resp.status === 404) return fail(`Note not found: ${p}`);
			if (resp.status >= 400) return fail(`Obsidian remote error reading: HTTP ${resp.status}`);
			return ok(await resp.text());
		}
		if (action === "search") {
			const q = String(args?.query ?? "").trim();
			if (!q) return fail("action=search requires a `query`.");
			const resp = await remoteFetch(env, `/search/simple/?query=${encodeURIComponent(q)}&contextLength=100`, { method: "POST" });
			if (resp.status >= 400) return fail(`Obsidian remote search error: HTTP ${resp.status}`);
			const j = (await resp.json().catch(() => null)) as any;
			const hits = (Array.isArray(j) ? j : []).slice(0, 20).map((h: any) => ({ path: h?.filename, score: h?.score }));
			return ok(JSON.stringify({ query: q, count: hits.length, hits }, null, 2));
		}
		if (action === "append") {
			const p = String(args?.path ?? "").trim();
			const content = String(args?.content ?? "");
			if (!p) return fail("action=append requires a `path`.");
			if (!content) return fail("action=append requires `content`.");
			const resp = await remoteFetch(env, `/vault/${encPath(p)}`, { method: "POST", headers: { "Content-Type": "text/markdown" }, body: content });
			if (resp.status >= 400) return fail(`Obsidian remote write error: HTTP ${resp.status}`);
			return ok(JSON.stringify({ ok: true, path: p, bytes: content.length }, null, 2));
		}
		return fail(`Unknown action '${action}'. Use list | read | search | append.`);
	} catch (e) {
		return fail(`obsidian remote (${action}) failed: ${String((e as Error).message ?? e)}`);
	}
}

export const obsidian: Fn = {
	name: "obsidian",
	cost: 2,
	description:
		"Work with Obsidian markdown notes. action: list (notes, optionally under `path`) | read (a note by `path`) | search (`query`) | append (add `content` to a note at `path`, creating it if absent). backend: git (default) — a GitHub-backed vault (async, versioned; OBSIDIAN_VAULT_REPO='owner/repo', optional OBSIDIAN_VAULT_BRANCH/OBSIDIAN_VAULT_DIR; GITHUB_TOKEN for private repos + writes); remote — the LIVE vault via Obsidian's Local REST API over a public HTTPS URL (Tailscale Funnel; OBSIDIAN_REMOTE_URL + OBSIDIAN_REMOTE_KEY). remote also wraps the vault's built-in MCP server: action=tools lists its ~15 vault tools and action=call runs one (tool + tool_args) — the full surface beyond list/read/search/append. local — same API on localhost, unreachable from the cloud Worker (use remote).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["action"],
		properties: {
			action: { type: "string", enum: ["list", "read", "search", "append", "tools", "call"] },
			path: { type: "string", description: "Note path within the vault (for read/append; a folder filter for list)." },
			query: { type: "string", description: "Search query (action=search)." },
			content: { type: "string", description: "Markdown to append (action=append)." },
			tool: { type: "string", description: "MCP tool name (remote, action=call). Run action=tools to list them." },
			tool_args: { type: "object", additionalProperties: true, description: "Arguments for the MCP tool (remote, action=call)." },
			backend: { type: "string", enum: ["git", "remote", "local"], default: "git" },
		},
	},
	cacheable: false, // notes are mutable; reads should reflect the live vault
	run: async (env, args) => {
		const action = String(args?.action ?? "");
		const backend = String(args?.backend ?? "git");
		if (backend === "remote") return runRemote(env, action, args);
		if (backend === "local") {
			return fail("backend:'local' (Obsidian Local REST API over the tailnet) isn't wired yet — expose the Local REST API over Tailscale Funnel and use backend:'remote' (OBSIDIAN_REMOTE_URL + OBSIDIAN_REMOTE_KEY), or use the git backend.");
		}
		const repo = env.OBSIDIAN_VAULT_REPO;
		if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(String(repo))) return fail("Obsidian git backend not configured. Set OBSIDIAN_VAULT_REPO to 'owner/repo'.");
		const branch = String(env.OBSIDIAN_VAULT_BRANCH ?? "main");
		const dir = String(env.OBSIDIAN_VAULT_DIR ?? "").replace(/^\/+|\/+$/g, "");
		const inVault = (p: string) => (dir ? `${dir}/${p}`.replace(/\/+/g, "/") : p);

		try {
			if (action === "list") {
				const { status, json } = await ghJson(env, `${GH}/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
				if (status >= 400) return fail(`GitHub error listing vault: ${json?.message ?? `HTTP ${status}`}`);
				const filter = args?.path ? inVault(String(args.path)) : dir;
				const notes = (json?.tree ?? [])
					.filter((n: any) => n?.type === "blob" && typeof n.path === "string" && n.path.endsWith(".md") && (!filter || n.path.startsWith(filter)))
					.map((n: any) => n.path);
				return ok(JSON.stringify({ repo, branch, count: notes.length, notes }, null, 2));
			}
			if (action === "read") {
				const p = String(args?.path ?? "").trim();
				if (!p) return fail("action=read requires a `path`.");
				const { status, json } = await ghJson(env, `${GH}/repos/${repo}/contents/${encodeURIComponent(inVault(p))}?ref=${encodeURIComponent(branch)}`);
				if (status === 404) return fail(`Note not found: ${p}`);
				if (status >= 400) return fail(`GitHub error reading note: ${json?.message ?? `HTTP ${status}`}`);
				const text = json?.content ? new TextDecoder().decode(fromB64(String(json.content).replace(/\n/g, ""))) : "";
				return ok(text);
			}
			if (action === "search") {
				const q = String(args?.query ?? "").trim();
				if (!q) return fail("action=search requires a `query`.");
				const { status, json } = await ghJson(env, `${GH}/search/code?q=${encodeURIComponent(`${q} repo:${repo} extension:md`)}&per_page=20`);
				if (status >= 400) return fail(`GitHub search error: ${json?.message ?? `HTTP ${status}`} (code search needs an authenticated GITHUB_TOKEN).`);
				const hits = (json?.items ?? []).map((it: any) => ({ path: it?.path, url: it?.html_url }));
				return ok(JSON.stringify({ query: q, count: hits.length, hits }, null, 2));
			}
			if (action === "append") {
				const p = String(args?.path ?? "").trim();
				const content = String(args?.content ?? "");
				if (!p) return fail("action=append requires a `path`.");
				if (!content) return fail("action=append requires `content`.");
				const full = inVault(p);
				// Read current (for the sha + existing body); 404 → create fresh.
				const cur = await ghJson(env, `${GH}/repos/${repo}/contents/${encodeURIComponent(full)}?ref=${encodeURIComponent(branch)}`);
				const existing = cur.status === 200 && cur.json?.content ? new TextDecoder().decode(fromB64(String(cur.json.content).replace(/\n/g, ""))) : "";
				const sha = cur.status === 200 ? cur.json?.sha : undefined;
				const merged = existing ? `${existing.replace(/\n+$/, "")}\n\n${content}\n` : `${content}\n`;
				const body = JSON.stringify({ message: `sux: append to ${p}`, content: toB64(new TextEncoder().encode(merged)), branch, ...(sha ? { sha } : {}) });
				const put = await ghJson(env, `${GH}/repos/${repo}/contents/${encodeURIComponent(full)}`, { method: "PUT", body });
				if (put.status >= 400) return fail(`GitHub write error: ${put.json?.message ?? `HTTP ${put.status}`} (append needs a GITHUB_TOKEN with write access).`);
				return ok(JSON.stringify({ ok: true, path: p, bytes: merged.length, commit: put.json?.commit?.sha }, null, 2));
			}
			return fail(`Unknown action '${action}'. Use list | read | search | append.`);
		} catch (e) {
			return fail(`obsidian (${action}) failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
