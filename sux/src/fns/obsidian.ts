import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";
import { fromB64, toB64 } from "./_util";

// Work with Obsidian markdown notes. The cloud Worker can't reach a localhost
// Obsidian Local REST API (and the residential node's SSRF guard blocks LAN IPs),
// so the default backend is a GIT-BACKED vault via the GitHub API — list/read/
// search/append notes in a repo. A `local` backend (Obsidian's official Local
// REST API + built-in MCP, coddingtonbear/obsidian-local-rest-api) is stubbed:
// it needs the vault host exposed on the tailnet and allowlisted past the SSRF
// guard, a deliberate follow-up. GITHUB_TOKEN (already used by the proxy for
// GitHub) authorizes private repos and writes.
const GH = "https://api.github.com";
const ghHeaders = { Accept: "application/vnd.github+json", "User-Agent": "sux-obsidian" };

async function ghJson(env: any, url: string, init?: { method?: string; body?: string }): Promise<{ status: number; json: any }> {
	const resp = await smartFetch(env, url, { method: init?.method, headers: { ...ghHeaders, ...(init?.body ? { "Content-Type": "application/json" } : {}) }, body: init?.body });
	const json = await resp.json().catch(() => null);
	return { status: resp.status, json };
}

export const obsidian: Fn = {
	name: "obsidian",
	cost: 2,
	description:
		"Work with Obsidian markdown notes in a git-backed vault (GitHub). action: list (all .md notes, optionally under `path`) | read (a note by `path`) | search (`query` across notes via GitHub code search) | append (add `content` to a note at `path`, creating it if absent). Configure OBSIDIAN_VAULT_REPO ('owner/repo'), optional OBSIDIAN_VAULT_BRANCH (default main) and OBSIDIAN_VAULT_DIR (subfolder); GITHUB_TOKEN authorizes private repos + writes. (backend:'local' — Obsidian's Local REST API over the tailnet — is a stubbed follow-up.)",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["action"],
		properties: {
			action: { type: "string", enum: ["list", "read", "search", "append"] },
			path: { type: "string", description: "Note path within the vault (for read/append; a folder filter for list)." },
			query: { type: "string", description: "Search query (action=search)." },
			content: { type: "string", description: "Markdown to append (action=append)." },
			backend: { type: "string", enum: ["git", "local"], default: "git" },
		},
	},
	cacheable: false, // notes are mutable; reads should reflect the live vault
	run: async (env, args) => {
		if (String(args?.backend ?? "git") === "local") {
			return fail("backend:'local' (Obsidian Local REST API over the tailnet) isn't wired yet — it needs the vault host exposed on the tailnet and allowlisted past the node SSRF guard. Use the git backend (OBSIDIAN_VAULT_REPO).");
		}
		const repo = env.OBSIDIAN_VAULT_REPO;
		if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(String(repo))) return fail("Obsidian git backend not configured. Set OBSIDIAN_VAULT_REPO to 'owner/repo'.");
		const branch = String(env.OBSIDIAN_VAULT_BRANCH ?? "main");
		const dir = String(env.OBSIDIAN_VAULT_DIR ?? "").replace(/^\/+|\/+$/g, "");
		const action = String(args?.action ?? "");
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
