// portal.suxos.net as a served VIEW of the (single, private) git vault — not a
// separate repo. Design: docs/superpowers/specs/2026-07-18-single-vault-portal-view-design.md
//
// Decision recap: one vault repo (OBSIDIAN_VAULT_REPO) is the single source of
// truth; nothing splits by content type. A note opts into public serving via a
// `#portal` inline tag OR a `visibility: portal` frontmatter field (mirrors the
// vault's existing `#growth` tag convention) — default is PRIVATE. A portal note
// that [[wikilinks]] a private note renders that link as a "private stub" (the
// target exists but isn't public) rather than leaking content or 404ing silently.
//
// Served here — before the OAuth provider claims every path — for the same
// pre-gate reason /dashboard, /mychart, /apple-health are (see index.ts): this
// is a plain unauthenticated GET surface, not an MCP JSON-RPC call. UNLIKE
// /dashboard (Cloudflare-Access-gated), /portal's whole point is public,
// unauthenticated reads — so it's fail-closed on its OWN feature flag
// (PORTAL_ENABLED) instead, since flipping it on is what turns a private vault
// into a partially-public one.
//
// First slice only (#824): serves single notes + an index of portal-visible
// notes, and resolves wikilinks. Deferred (see design doc's "Open items"):
// folder-level tagging, and the SuxOS/vault migration/reconciliation pass
// (blocked on colinxs/vault's GitHub archive/read-only state being repaired).

import { obsidian, vaultCfg } from "./fns/obsidian";
import { obsRateLimited } from "./observability";
import type { RtEnv } from "./registry";
import { scanVault, type VaultRecord } from "./vault-mcp";
import { noteBasename } from "./vault-graph";

const PORTAL_TAG = "portal";
// Well above any real vault's note count (mirrors vault-mcp.ts's own INDEX_MAX) —
// this is a "give me the whole vault" scan, not a folder-scoped/paginated one.
const PORTAL_SCAN_CAP = 5000;

function flagOn(v: string | undefined): boolean {
	const s = String(v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
}

/** The access-control mechanic (design doc §"Access control mechanic"): a
 * `#portal` tag OR a `visibility: portal` frontmatter field, checked
 * case-insensitively so `#Portal`/`Visibility: Portal` aren't silently private. */
function isPortalVisible(record: Pick<VaultRecord, "fm" | "tags">): boolean {
	if (record.tags.some((t) => t.toLowerCase() === PORTAL_TAG)) return true;
	const vis = record.fm.visibility;
	return typeof vis === "string" && vis.trim().toLowerCase() === PORTAL_TAG;
}

function esc(s: string): string {
	return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function stripFrontmatter(body: string): string {
	return body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

const noteHref = (link: string) => `/portal/${encodeURIComponent(noteBasename(link))}`;

/** Render a note body to a minimal, escaped HTML fragment: [[wikilinks]] (alias/
 * heading/block refs stripped, same as vault-graph's extractWikilinks) become
 * /portal/<basename> anchors — resolution of whether that target is public or a
 * private stub happens when that link is FOLLOWED, not here. Not a full markdown
 * renderer by design: the portal's job is the access filter, not a markdown engine. */
function renderBody(body: string): string {
	const escaped = esc(stripFrontmatter(body).trim());
	const linked = escaped.replace(/\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
		const [targetRaw, aliasRaw] = inner.split("|");
		const target = targetRaw.split("#")[0].split("^")[0].trim();
		const label = (aliasRaw ?? targetRaw).trim();
		return target ? `<a href="${noteHref(target)}">${label}</a>` : _m;
	});
	return `<pre class="note-body">${linked}</pre>`;
}

const PAGE_STYLE = `<style>
body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:720px;margin:40px auto;padding:0 20px;background:#0b0d10;color:#e6e6e6}
a{color:#93c5fd}
h1{font-size:20px;margin-bottom:4px}
.sub{color:#888;font-size:12px;margin-bottom:24px}
.note-body{white-space:pre-wrap;font-family:inherit;font-size:15px;line-height:1.6;margin:0}
ul{list-style:none;padding:0;margin:0}
li{padding:10px 0;border-bottom:1px solid #1f242b}
.excerpt{color:#aaa;font-size:13px;margin-top:2px}
.stub{color:#888;font-style:italic;border:1px dashed #333;padding:16px;border-radius:8px}
.back{display:inline-block;margin-top:24px;font-size:13px}
</style>`;

function page(title: string, body: string): Response {
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>${PAGE_STYLE}</head><body>${body}</body></html>`,
		{ status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'" } },
	);
}

const noteTitle = (r: Pick<VaultRecord, "path" | "fm">) => String(r.fm.title ?? noteBasename(r.path));

function renderIndex(records: VaultRecord[]): Response {
	const items = records
		.slice()
		.sort((a, b) => noteTitle(a).localeCompare(noteTitle(b)))
		.map((r) => `<li><a href="${noteHref(r.path)}">${esc(noteTitle(r))}</a><div class="excerpt">${esc(r.excerpt)}</div></li>`)
		.join("");
	return page("portal", `<h1>portal</h1><div class="sub">${records.length} public note${records.length === 1 ? "" : "s"}</div><ul>${items || "<li>Nothing published yet.</li>"}</ul>`);
}

/** The graph-integrity handling (design doc §"private ↔ portal links"): honest
 * that the target exists without leaking its content — reached both by a portal
 * note's own wikilink AND by directly requesting a private note's path. */
function renderStub(): Response {
	return page("private", `<div class="stub">This note exists but isn't public.</div><a class="back" href="/portal">&larr; portal</a>`);
}

function renderNote(record: VaultRecord, body: string): Response {
	const title = noteTitle(record);
	return page(title, `<h1>${esc(title)}</h1>${renderBody(body)}<a class="back" href="/portal">&larr; portal</a>`);
}

/** GET /portal (index of portal-visible notes) + GET /portal/<basename> (one
 * note, or a private stub when the basename resolves to a real but non-portal
 * note). Returns null for paths it doesn't own — the pre-gate handler contract
 * (see index.ts). Dormant (404) unless PORTAL_ENABLED and the vault is configured. */
export async function handlePortalRoutes(url: URL, request: Request, env: RtEnv): Promise<Response | null> {
	if (url.pathname !== "/portal" && !url.pathname.startsWith("/portal/")) return null;
	if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
	if (!flagOn(env.PORTAL_ENABLED)) return new Response("not found", { status: 404 });

	const cfg = vaultCfg(env);
	if ("error" in cfg) return new Response("not found", { status: 404 });

	// Same coarse per-IP backstop as /dashboard's notes route: an unauthenticated
	// route that fans out into GitHub API calls is worth rate-limiting regardless
	// of who's asking (see dashboard.ts's header).
	if (await obsRateLimited(request, env)) return new Response("rate limited", { status: 429 });

	let records: VaultRecord[];
	try {
		records = (await scanVault(env, undefined, PORTAL_SCAN_CAP)).records;
	} catch (e) {
		return new Response(`portal: vault scan failed: ${String((e as Error)?.message ?? e)}`, { status: 502 });
	}

	if (url.pathname === "/portal" || url.pathname === "/portal/") {
		return renderIndex(records.filter(isPortalVisible));
	}

	const reqBasename = noteBasename(decodeURIComponent(url.pathname.slice("/portal/".length)));
	const match = records.find((r) => noteBasename(r.path) === reqBasename);
	if (!match) return new Response("not found", { status: 404 });
	if (!isPortalVisible(match)) return renderStub();

	// `records` (from scanVault) only carries a bounded excerpt, not the full body —
	// re-read the note. `list`/the index return dir-prefixed paths, but `read`
	// re-applies OBSIDIAN_VAULT_DIR itself (mirrors dashboard.ts's recentNotes fix).
	const readPath = cfg.dir && match.path.startsWith(`${cfg.dir}/`) ? match.path.slice(cfg.dir.length + 1) : match.path;
	const r = await obsidian.run(env, { action: "read", path: readPath, backend: "git" });
	if (r.isError) return new Response("not found", { status: 404 });
	const body = Array.isArray(r.content) ? String(r.content[0]?.text ?? "") : "";
	return renderNote(match, body);
}
