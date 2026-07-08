import { type Fn, failWith, ok, type RtEnv } from "../registry";

// Reddit read-only API via APP-ONLY OAuth (client_credentials). No user context —
// just a machine bearer minted from REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET and cached
// in KV (env.OAUTH_KV) until just before it expires (mirrors kroger.ts getToken).
//
// Reddit blocks the default/generic User-Agent AND repeat "again" UAs outright, so a
// stable, descriptive User-Agent rides EVERY request — the token POST and every
// oauth.reddit.com call. This is essential; without it Reddit 429s/403s us.

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const API = "https://oauth.reddit.com";
const TOKEN_KEY = "sux:reddit:token";
const UA = "sux/1.0 (by /u/sux)";

const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

/** Mint a fresh app-only bearer token from the OAuth endpoint and cache it in KV. */
async function mintToken(env: RtEnv): Promise<string> {
	const basic = btoa(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`);
	const resp = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": UA },
		body: "grant_type=client_credentials",
	});
	if (!resp.ok) throw new Error(`OAuth token HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
	const j: any = await resp.json();
	const token = String(j?.access_token ?? "");
	if (!token) throw new Error("OAuth token response had no access_token.");
	// TTL = expires_in - 60 so the cached token is never used in its final minute;
	// clamp to Cloudflare KV's 60s floor.
	const ttl = Math.max(60, (Number(j?.expires_in) || 3600) - 60);
	await env.OAUTH_KV.put(TOKEN_KEY, token, { expirationTtl: ttl });
	return token;
}

/** Get a valid bearer token — from KV if present, else mint one and cache it. */
async function getToken(env: RtEnv): Promise<string> {
	const cached = await env.OAUTH_KV.get(TOKEN_KEY);
	if (cached) return cached;
	return mintToken(env);
}

/**
 * GET an authed Reddit endpoint, throwing a status-carrying error on failure.
 * Self-heals a revoked/rejected token: on a 401/403 it drops the cached token,
 * re-mints once, and retries. The retry mints directly (not via getToken) so KV
 * read-after-delete eventual consistency can't hand back the rejected token.
 * The descriptive User-Agent rides EVERY request — Reddit blocks default UAs.
 */
async function api(env: RtEnv, path: string): Promise<any> {
	const get = (token: string) => fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": UA } });
	let resp = await get(await getToken(env));
	if (resp.status === 401 || resp.status === 403) {
		await env.OAUTH_KV.delete(TOKEN_KEY);
		resp = await get(await mintToken(env));
	}
	if (!resp.ok) throw new Error(`Reddit API HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
	return resp.json();
}

type RedditPost = {
	id: string;
	title: string;
	subreddit: string;
	author: string;
	score: number;
	num_comments: number;
	created_utc: number;
	permalink: string;
	url: string;
	selftext?: string;
};

function normPost(d: any): RedditPost {
	const p: RedditPost = {
		id: d?.id,
		title: d?.title,
		subreddit: d?.subreddit,
		author: d?.author,
		score: Number(d?.score) || 0,
		num_comments: Number(d?.num_comments) || 0,
		created_utc: Number(d?.created_utc) || 0,
		permalink: `https://reddit.com${d?.permalink ?? ""}`,
		url: d?.url,
	};
	if (d?.selftext) p.selftext = d.selftext;
	return p;
}

/**
 * Normalize a listing's children to posts, guarding each record so one malformed
 * entry (unexpected shape that makes normPost throw) is skipped rather than
 * discarding the whole result set.
 */
function normListing(j: any): RedditPost[] {
	const children = j?.data?.children;
	return (Array.isArray(children) ? children : [])
		.map((c: any) => {
			try {
				return normPost(c?.data ?? {});
			} catch {
				return null;
			}
		})
		.filter((p): p is RedditPost => p !== null);
}

export const reddit: Fn = {
	name: "reddit",
	description:
		"Reddit read-only API (app-only OAuth) — search posts, browse a subreddit, read a post's comments, or look up a user. " +
		"`action`: search (posts matching `q`, optionally scoped to `subreddit`), subreddit (listing for `subreddit` by `sort`), comments (post + comments for `article_id`), user (about for `username`). " +
		"Needs REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET (free 'script'/app-only app at reddit.com/prefs/apps). Returns normalized JSON.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["search", "subreddit", "comments", "user"], default: "search" },
			q: { type: "string", description: "Search text (action=search)." },
			subreddit: { type: "string", description: "Subreddit name — scopes search, or the listing target (action=subreddit)." },
			sort: { type: "string", enum: ["hot", "new", "top", "rising"], default: "hot", description: "Listing/search sort." },
			article_id: { type: "string", description: "Post id (action=comments)." },
			username: { type: "string", description: "Reddit username (action=user)." },
			limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
		},
	},
	cacheable: true,
	ttl: 300,
	run: async (env, args) => {
		if (!env.REDDIT_CLIENT_ID || !env.REDDIT_CLIENT_SECRET)
			return failWith("not_configured", "Reddit API not configured (REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET). Create a free app-only app at reddit.com/prefs/apps.");

		const action = String(args?.action ?? "search");
		const limit = Math.min(100, Math.max(1, Number(args?.limit) || 25));
		const sort = String(args?.sort ?? "hot");
		const subreddit = args?.subreddit ? String(args.subreddit).trim().replace(/^\/?r\//i, "") : "";

		try {
			if (action === "subreddit") {
				if (!subreddit) return failWith("bad_input", "action=subreddit requires a `subreddit`.");
				const j = await api(env, `/r/${encodeURIComponent(subreddit)}/${encodeURIComponent(sort)}?limit=${limit}`);
				const items = normListing(j);
				return ok(JSON.stringify({ service: "reddit", action, count: items.length, items }, null, 2));
			}

			if (action === "comments") {
				const id = String(args?.article_id ?? "").trim();
				if (!id) return failWith("bad_input", "action=comments requires an `article_id`.");
				const j = await api(env, `/comments/${encodeURIComponent(id)}?limit=${limit}`);
				// /comments returns [postListing, commentsListing]; normalize the post listing.
				const postListing = Array.isArray(j) ? j[0] : j;
				const items = normListing(postListing);
				return ok(JSON.stringify({ service: "reddit", action, count: items.length, items }, null, 2));
			}

			if (action === "user") {
				const username = String(args?.username ?? "").trim().replace(/^\/?u\//i, "");
				if (!username) return failWith("bad_input", "action=user requires a `username`.");
				const j = await api(env, `/user/${encodeURIComponent(username)}/about`);
				const d = j?.data;
				if (!d) return failWith("not_found", `No Reddit user found for '${username}'.`);
				const item = {
					id: d?.id,
					name: d?.name,
					created_utc: Number(d?.created_utc) || 0,
					link_karma: Number(d?.link_karma) || 0,
					comment_karma: Number(d?.comment_karma) || 0,
					is_mod: Boolean(d?.is_mod),
					url: `https://reddit.com/user/${d?.name ?? username}`,
				};
				return ok(JSON.stringify({ service: "reddit", action, count: 1, items: [item] }, null, 2));
			}

			// action === "search"
			const q = String(args?.q ?? "").trim();
			if (!q) return failWith("bad_input", "action=search requires a `q`.");
			const p = new URLSearchParams({ q, limit: String(limit), sort });
			let path: string;
			if (subreddit) {
				p.set("restrict_sr", "1");
				path = `/r/${encodeURIComponent(subreddit)}/search?${p}`;
			} else {
				path = `/search?${p}`;
			}
			const j = await api(env, path);
			const items = normListing(j);
			return ok(JSON.stringify({ service: "reddit", action, count: items.length, items }, null, 2));
		} catch (e) {
			return failWith("upstream_error", `reddit (${action}) failed: ${errMsg(e)}`);
		}
	},
};
