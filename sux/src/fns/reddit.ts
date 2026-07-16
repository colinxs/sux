import { smartFetch } from "../proxy";
import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { errMsg, oj } from "./_util";

// Reddit read-only, KEYLESS-FIRST. Reddit now blocks self-serve OAuth app creation,
// so the default path needs no credentials at all: Reddit serves every public
// endpoint as JSON by appending `.json` to the path, and those `.json` responses
// have the SAME shape as the OAuth API (a Listing for posts, [post, comments] for
// the comments endpoint, {kind, data} for about) — so one set of normalizers covers
// both. The catch is that Reddit blocks datacenter IPs, so the keyless fetch MUST go
// through the residential proxy (smartFetch route "proxy") with a descriptive
// User-Agent — the residential exit is exactly why the keyless path works.
//
// If REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET are set we auto-upgrade to the app-only
// OAuth path (KV-cached bearer minted at www.reddit.com/api/v1/access_token, calls to
// oauth.reddit.com) for higher rate limits — kept intact as the optional upgrade.
//
// Reddit blocks the default/generic User-Agent outright, so a stable, descriptive
// User-Agent rides EVERY request on both paths — the token POST, every
// oauth.reddit.com call, and every keyless `.json` fetch.

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const API = "https://oauth.reddit.com";
const TOKEN_KEY = "sux:reddit:token";
const UA_OAUTH = "sux/1.0 (by /u/sux)";

// Keyless public-JSON base + its own descriptive User-Agent.
const PUBLIC = "https://www.reddit.com";
const UA_KEYLESS = "sux/1.0 (+https://github.com/SuxOS/sux)";


/** Sentinel for a Reddit block on the keyless proxy path (403 / empty / non-JSON
 * challenge page) — the run() catch maps it to failWith("blocked") rather than the
 * generic upstream_error, so the caller gets the actionable "try again or set creds". */
class RedditBlocked extends Error {}

/** Mint a fresh app-only bearer token from the OAuth endpoint and cache it in KV. */
async function mintToken(env: RtEnv): Promise<string> {
	const basic = btoa(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`);
	const resp = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": UA_OAUTH },
		body: "grant_type=client_credentials",
		signal: AbortSignal.timeout(20_000),
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
 * OAuth path: GET an authed Reddit endpoint, throwing a status-carrying error on
 * failure. Self-heals a revoked/rejected token: on a 401/403 it drops the cached
 * token, re-mints once, and retries. The retry mints directly (not via getToken) so
 * KV read-after-delete eventual consistency can't hand back the rejected token. The
 * descriptive User-Agent rides EVERY request — Reddit blocks default UAs.
 */
async function api(env: RtEnv, path: string): Promise<any> {
	const get = (token: string) => fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": UA_OAUTH }, signal: AbortSignal.timeout(20_000) });
	let resp = await get(await getToken(env));
	if (resp.status === 401 || resp.status === 403) {
		await env.OAUTH_KV.delete(TOKEN_KEY);
		resp = await get(await mintToken(env));
	}
	if (!resp.ok) throw new Error(`Reddit API HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
	return resp.json();
}

/** Rewrite an OAuth-style path (`/r/x/hot?limit=25`) into its keyless public-JSON
 * URL by inserting `.json` before any query string — the `.json` suffix is what
 * makes Reddit serve public data with no auth. */
function publicUrl(path: string): string {
	const qi = path.indexOf("?");
	const base = qi === -1 ? path : path.slice(0, qi);
	const query = qi === -1 ? "" : path.slice(qi);
	return `${PUBLIC}${base}.json${query}`;
}

/**
 * Keyless path: fetch a public `.json` endpoint through the RESIDENTIAL proxy
 * (Reddit blocks datacenter IPs; the residential exit is why this works) with the
 * descriptive User-Agent. A Reddit block surfaces as a 403, an empty body, or a
 * non-JSON HTML challenge page — all three throw RedditBlocked so run() can map them
 * to failWith("blocked"). A non-block non-2xx throws a plain status error.
 */
async function fetchPublicJson(env: RtEnv, path: string): Promise<any> {
	const resp = await smartFetch(env, publicUrl(path), { headers: { "User-Agent": UA_KEYLESS } }, "proxy");
	const text = (await resp.text().catch(() => "")).trim();
	if (resp.status === 403 || !text) throw new RedditBlocked();
	let j: any;
	try {
		j = JSON.parse(text);
	} catch {
		throw new RedditBlocked(); // HTML block/challenge page, not JSON
	}
	if (!resp.ok) throw new Error(`Reddit public JSON HTTP ${resp.status}`);
	return j;
}

/** Dispatch a read to the OAuth API (creds set) or the keyless public-JSON proxy
 * path. Both return the same-shaped JSON, so callers/normalizers don't branch. */
async function fetchJson(env: RtEnv, path: string, useOAuth: boolean): Promise<any> {
	return useOAuth ? api(env, path) : fetchPublicJson(env, path);
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

type RedditComment = {
	id: string;
	author: string;
	body: string;
	score: number;
	created_utc: number;
	replies?: RedditComment[];
};

function normComment(d: any): RedditComment {
	const c: RedditComment = {
		id: d?.id,
		author: d?.author,
		body: d?.body,
		score: Number(d?.score) || 0,
		created_utc: Number(d?.created_utc) || 0,
	};
	const replies = normComments(d?.replies);
	if (replies.length) c.replies = replies;
	return c;
}

/**
 * Normalize a comments listing's `t1` children into a comment tree, recursing into
 * `replies` (itself a Listing, or `""` for a leaf comment). Guards each record like
 * normListing does, so one malformed comment is skipped rather than discarding the
 * whole thread.
 */
function normComments(j: any): RedditComment[] {
	const children = j?.data?.children;
	return (Array.isArray(children) ? children : [])
		.filter((c: any) => c?.kind === "t1")
		.map((c: any) => {
			try {
				return normComment(c?.data ?? {});
			} catch {
				return null;
			}
		})
		.filter((c): c is RedditComment => c !== null);
}

export const reddit: Fn = {
	name: "reddit",
	description:
		"Reddit read-only API — search posts, browse a subreddit, read a post's comments, or look up a user. " +
		"Works KEYLESS by default: fetches Reddit's public `.json` endpoints through the residential proxy (Reddit blocks datacenter IPs, so the residential exit is what makes this work) — no credentials needed. " +
		"Auto-upgrades to app-only OAuth (higher rate limits) when REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET are set. " +
		"`action`: search (posts matching `q`, optionally scoped to `subreddit`), subreddit (listing for `subreddit` by `sort`), comments (post in `items` + its comment tree in `comments`, for `article_id`), user (about for `username`). Returns normalized JSON.",
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
		// Keyless is the default; OAuth is the optional upgrade when both creds are set.
		const useOAuth = Boolean(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET);

		const action = String(args?.action ?? "search");
		const limit = Math.min(100, Math.max(1, Number(args?.limit) || 25));
		const sort = String(args?.sort ?? "hot");
		const subreddit = args?.subreddit ? String(args.subreddit).trim().replace(/^\/?r\//i, "") : "";

		try {
			if (action === "subreddit") {
				if (!subreddit) return failWith("bad_input", "action=subreddit requires a `subreddit`.");
				const j = await fetchJson(env, `/r/${encodeURIComponent(subreddit)}/${encodeURIComponent(sort)}?limit=${limit}`, useOAuth);
				const items = normListing(j);
				return ok(oj({ service: "reddit", action, count: items.length, items }));
			}

			if (action === "comments") {
				const id = String(args?.article_id ?? "").trim();
				if (!id) return failWith("bad_input", "action=comments requires an `article_id`.");
				const j = await fetchJson(env, `/comments/${encodeURIComponent(id)}?limit=${limit}`, useOAuth);
				// /comments returns [postListing, commentsListing]; normalize both.
				const postListing = Array.isArray(j) ? j[0] : j;
				const commentsListing = Array.isArray(j) ? j[1] : undefined;
				const items = normListing(postListing);
				const comments = normComments(commentsListing);
				return ok(oj({ service: "reddit", action, count: items.length, items, comments }));
			}

			if (action === "user") {
				const username = String(args?.username ?? "").trim().replace(/^\/?u\//i, "");
				if (!username) return failWith("bad_input", "action=user requires a `username`.");
				const j = await fetchJson(env, `/user/${encodeURIComponent(username)}/about`, useOAuth);
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
				return ok(oj({ service: "reddit", action, count: 1, items: [item] }));
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
			const j = await fetchJson(env, path, useOAuth);
			const items = normListing(j);
			return ok(oj({ service: "reddit", action, count: items.length, items }));
		} catch (e) {
			// A keyless proxy block is retryable and hints the OAuth upgrade; everything
			// else (OAuth HTTP errors, parse failures) is a generic upstream error.
			if (e instanceof RedditBlocked) return failWith("blocked", "reddit: blocked — try again or set REDDIT_CLIENT_ID/SECRET");
			return failWith("upstream_error", `reddit (${action}) failed: ${errMsg(e)}`);
		}
	},
};
