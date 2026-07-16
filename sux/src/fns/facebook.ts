import { type Fn, fail, ok } from "../registry";
import { errMsg, oj } from "./_util";

// Facebook Graph API (official) wrapper. Key-gated on FACEBOOK_TOKEN — a Graph
// API access token with the scopes for whatever you're reading (pages, posts,
// public profile). graph.facebook.com is an authenticated API, so it egresses
// direct (like SerpAPI/Kroger); bounded with a timeout.
const GRAPH = "https://graph.facebook.com/v21.0";

export const facebook: Fn = {
	name: "facebook",
	cost: 2,
	description:
		"Facebook Graph API (official). Fetch a graph node or edge by `path`: a node id ('me', '{page-id}', '{user-id}') or an edge ('{page-id}/posts', '{page-id}/feed'). `fields` is a comma list (e.g. 'id,name,about,fan_count' or 'message,created_time,permalink_url'); `limit` caps edge results. Needs FACEBOOK_TOKEN (a Graph API access token with the right scopes — developers.facebook.com/tools/explorer). Returns the Graph JSON.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["path"],
		properties: {
			path: { type: "string", description: "Graph path: a node id ('me', '{id}') or an edge ('{id}/posts')." },
			fields: { type: "string", description: "Comma-separated fields to request (e.g. 'id,name,about,fan_count')." },
			limit: { type: "integer", minimum: 1, maximum: 100, description: "Cap edge (list) results." },
		},
	},
	cacheable: true,
	ttl: 300, // FB data is live external state — keep the cache short
	run: async (env, args) => {
		const token = env.FACEBOOK_TOKEN;
		if (!token) return fail("Facebook not configured (FACEBOOK_TOKEN). Provide a Graph API access token: https://developers.facebook.com/tools/explorer.");
		const path = String(args?.path ?? "").trim().replace(/^\/+/, "");
		if (!path) return fail("`path` is required (e.g. 'me' or '{page-id}/posts').");
		if (path.includes("://") || path.startsWith("..")) return fail("`path` must be a bare graph path, not a URL.");

		const qs = new URLSearchParams({ access_token: token });
		if (args?.fields) qs.set("fields", String(args.fields));
		if (args?.limit != null) qs.set("limit", String(Math.min(100, Math.max(1, Number(args.limit) || 25))));
		try {
			const resp = await fetch(`${GRAPH}/${path}?${qs}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
			const j = (await resp.json().catch(() => null)) as any;
			if (!resp.ok) return fail(`Facebook Graph error: ${j?.error?.message ?? `HTTP ${resp.status}`}`);
			return ok(oj(j));
		} catch (e) {
			return fail(`facebook failed: ${errMsg(e)}`);
		}
	},
};
