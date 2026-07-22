import { type Fn, fail, failWith, ok, type RtEnv } from "../registry";
import { oj } from "./_util";
import { stripHtml } from "./_util/html";

// Zotero Web API v3 (api.zotero.org) — Colin's personal curated research library,
// NOT a public database like arxiv/pubmed/openalex. Read-only phase 1 (#1296):
// search, item detail (+children), collection tree, recently added/modified, and
// citation/bib export. Write ops (saveItem) and attachment-file download are
// explicitly out of scope — file follow-ups on demand.
//
// Auth: the `Zotero-API-Key` header (never a `?key=` URL param — a URL can leak
// into logs/referrers) + `Zotero-API-Version: 3`. Both ZOTERO_API_KEY and
// ZOTERO_USER_ID must be set, same fail-closed shape as monarch/dropbox/mychart.

const API = "https://api.zotero.org";

function hasZotero(env: RtEnv): boolean {
	return Boolean(env.ZOTERO_API_KEY && env.ZOTERO_USER_ID);
}

/** One authenticated GET against the user's library, returning the raw Response —
 * callers pick `.json()` (search/item/collections/recent) or `.text()` (bib, whose
 * `format=bib` response is HTML, not JSON). Respects Zotero's Backoff/Retry-After
 * by surfacing it in the thrown error rather than silently retrying (no retry
 * infra in this leaf — the caller decides whether to try again). */
async function zget(env: RtEnv, path: string, params?: Record<string, string | number | undefined>): Promise<Response> {
	const qs = new URLSearchParams();
	for (const [k, v] of Object.entries(params ?? {})) if (v != null && v !== "") qs.set(k, String(v));
	const url = `${API}/users/${env.ZOTERO_USER_ID}${path}${qs.toString() ? `?${qs}` : ""}`;
	const resp = await fetch(url, {
		headers: { "Zotero-API-Key": env.ZOTERO_API_KEY!, "Zotero-API-Version": "3", Accept: "application/json" },
		signal: AbortSignal.timeout(20_000),
	});
	if (!resp.ok) {
		const backoff = resp.headers.get("Backoff") ?? resp.headers.get("Retry-After");
		throw new Error(`Zotero API HTTP ${resp.status}${backoff ? ` (server asked to back off ${backoff}s)` : ""}.`);
	}
	return resp;
}

function normItem(it: any): Record<string, unknown> {
	const d = it?.data ?? {};
	const creators = Array.isArray(d.creators)
		? d.creators.map((c: any) => (c?.name ? String(c.name) : [c?.firstName, c?.lastName].filter(Boolean).join(" "))).filter(Boolean)
		: [];
	return {
		key: it?.key ?? d.key ?? null,
		itemType: d.itemType ?? null,
		title: d.title ?? null,
		creators,
		date: d.date ?? null,
		doi: d.DOI ?? null,
		url: d.url ?? null,
		tags: Array.isArray(d.tags) ? d.tags.map((t: any) => t?.tag).filter(Boolean) : [],
		dateAdded: d.dateAdded ?? null,
		dateModified: d.dateModified ?? null,
		numChildren: it?.meta?.numChildren ?? 0,
	};
}

function normChild(it: any): Record<string, unknown> {
	const d = it?.data ?? {};
	return {
		key: it?.key ?? d.key ?? null,
		itemType: d.itemType ?? null,
		title: d.title ?? (d.itemType === "note" ? stripHtml(String(d.note ?? "")).slice(0, 200) : null),
		filename: d.filename ?? null,
		contentType: d.contentType ?? null,
	};
}

/** Assemble the collection tree from ONE flat `/collections` call (which returns
 * every collection in the library with a `parentCollection` pointer) rather than
 * recursing per-node — a recursive per-collection fetch would burn a Worker
 * subrequest per node for no benefit, since the parent links already say enough
 * to build the tree client-side. */
function buildCollectionTree(list: any[]): Array<Record<string, unknown>> {
	const nodes = new Map<string, { key: string; name: string | null; numItems: number; children: Array<Record<string, unknown>> }>();
	for (const c of list) {
		const d = c?.data ?? {};
		nodes.set(c.key, { key: c.key, name: d.name ?? null, numItems: c?.meta?.numItems ?? 0, children: [] });
	}
	const roots: Array<Record<string, unknown>> = [];
	for (const c of list) {
		const d = c?.data ?? {};
		const node = nodes.get(c.key)!;
		const parentKey = typeof d.parentCollection === "string" ? d.parentCollection : null;
		if (parentKey && nodes.has(parentKey)) nodes.get(parentKey)!.children.push(node);
		else roots.push(node);
	}
	return roots;
}

/** Split Zotero's `format=bib` HTML (`<div class="csl-bib-body">` wrapping one
 * `<div class="csl-entry">` per citation) into plain-text citation lines. */
function parseBibHtml(html: string): string[] {
	return html
		.split(/<div class="csl-entry"[^>]*>/)
		.slice(1)
		.map((part) => stripHtml(part))
		.filter(Boolean);
}

export const zotero: Fn = {
	name: "zotero",
	description:
		"Your personal Zotero research library (Web API v3) — NOT a public database (use arxiv/pubmed/openalex/crossref/semantic_scholar for those). `action`: search {q, qmode?:'titleCreatorYear'|'everything' (everything = server-side fulltext across attachments too), itemType?, tag?, collection? (scope to a collection key), limit?} — item {key} (detail + children: notes/attachments) — collections (the full collection tree, built from one flat request) — recent {limit?} (most recently added/modified top-level items) — bib {keys:[...], style?:'apa'} (citation/bibliography text for the given item keys, any CSL style id e.g. apa, chicago-author-date, mla). Read-only; write ops and attachment-file download are separate follow-ups.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["action"],
		properties: {
			action: { type: "string", enum: ["search", "item", "collections", "recent", "bib"] },
			q: { type: "string", description: "Search text (action=search)." },
			qmode: { type: "string", enum: ["titleCreatorYear", "everything"], default: "titleCreatorYear", description: "action=search." },
			itemType: { type: "string", description: "Filter by Zotero item type, e.g. journalArticle, book (action=search)." },
			tag: { type: "string", description: "Filter by tag (action=search)." },
			collection: { type: "string", description: "Scope to a collection key, from action=collections (action=search)." },
			limit: { type: "integer", minimum: 1, maximum: 100, default: 25, description: "action=search/recent." },
			key: { type: "string", description: "Item key, from action=search/recent (action=item)." },
			keys: { type: "array", items: { type: "string" }, description: "Item keys to cite (action=bib)." },
			style: { type: "string", default: "apa", description: "CSL style id, e.g. apa, chicago-author-date, modern-language-association (action=bib)." },
		},
	},
	cacheable: true,
	ttl: 300, // a personal library mutates slowly, but not so slowly a fresh add should hide for long
	run: async (env: RtEnv, args) => {
		if (!hasZotero(env)) return failWith("not_configured", "Zotero isn't configured — set ZOTERO_API_KEY and ZOTERO_USER_ID (both required).");
		const action = String(args?.action ?? "");

		try {
			if (action === "search") {
				const q = String(args?.q ?? "").trim();
				if (!q) return fail("action=search requires `q`.");
				const limit = Math.min(100, Math.max(1, Number(args?.limit) || 25));
				const path = args?.collection ? `/collections/${encodeURIComponent(String(args.collection))}/items` : "/items";
				const resp = await zget(env, path, { q, qmode: args?.qmode ?? "titleCreatorYear", itemType: args?.itemType, tag: args?.tag, limit });
				const list = (await resp.json()) as any[];
				return ok(oj({ action, count: list.length, items: list.map(normItem) }));
			}

			if (action === "item") {
				const key = String(args?.key ?? "").trim();
				if (!key) return fail("action=item requires `key`.");
				const [itemResp, childResp] = await Promise.all([zget(env, `/items/${encodeURIComponent(key)}`), zget(env, `/items/${encodeURIComponent(key)}/children`)]);
				const item = await itemResp.json();
				const children = (await childResp.json()) as any[];
				return ok(oj({ action, item: normItem(item), children: children.map(normChild) }));
			}

			if (action === "collections") {
				const resp = await zget(env, "/collections", { limit: 100 });
				const list = (await resp.json()) as any[];
				return ok(oj({ action, collections: buildCollectionTree(list) }));
			}

			if (action === "recent") {
				const limit = Math.min(100, Math.max(1, Number(args?.limit) || 25));
				const resp = await zget(env, "/items/top", { sort: "dateModified", direction: "desc", limit });
				const list = (await resp.json()) as any[];
				return ok(oj({ action, count: list.length, items: list.map(normItem) }));
			}

			if (action === "bib") {
				const keys = Array.isArray(args?.keys) ? args.keys.map(String).filter(Boolean) : [];
				if (!keys.length) return fail("action=bib requires a non-empty `keys` array.");
				const style = String(args?.style ?? "apa").trim() || "apa";
				const resp = await zget(env, "/items", { itemKey: keys.join(","), format: "bib", style });
				const html = await resp.text();
				return ok(oj({ action, style, entries: parseBibHtml(html) }));
			}

			return fail(`Unknown action '${action}'. Options: search, item, collections, recent, bib.`);
		} catch (e) {
			return fail(`Zotero request failed: ${String((e as Error)?.message ?? e)}`);
		}
	},
};
