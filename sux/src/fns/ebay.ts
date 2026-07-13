import { getClientToken, mintClientToken, type OAuthClientCreds } from "./_oauth";
import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { normalizeMoney, type RetailProduct } from "./_retail";
import { errMsg, oj } from "./_util";

// eBay Browse API (api.ebay.com) — official, clean REST, no bot wall. Auth is
// OAuth2 client-credentials (same shape as kroger): the app token is minted once
// and cached in KV (env.OAUTH_KV) until just before it expires, so we never
// re-mint per call. Token lifecycle lives in _oauth (shared with kroger/tailscale).

const API = "https://api.ebay.com/buy/browse/v1";
const TOKEN_KEY = "sux:ebay:token";
const oauth = (env: RtEnv): OAuthClientCreds => ({
	tokenUrl: "https://api.ebay.com/identity/v1/oauth2/token",
	clientId: String(env.EBAY_CLIENT_ID ?? ""),
	clientSecret: String(env.EBAY_CLIENT_SECRET ?? ""),
	cacheKey: TOKEN_KEY,
	scope: "https://api.ebay.com/oauth/api_scope",
	defaultTtl: 7200,
});

/** GET an authed eBay endpoint; self-heals a stale app token (401/403) by re-minting once — matching kroger/reddit/tailscale. */
async function api(env: RtEnv, url: string): Promise<any> {
	const get = (token: string) => fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
	let resp = await get(await getClientToken(env, oauth(env)));
	if (resp.status === 401 || resp.status === 403) {
		// eBay invalidated the token before its ~2h TTL → drop the cache and re-mint DIRECTLY (not via
		// getClientToken, so KV read-after-delete eventual consistency can't hand back the rejected token).
		await env.OAUTH_KV.delete(TOKEN_KEY).catch(() => {});
		resp = await get(await mintClientToken(env, oauth(env)));
	}
	if (!resp.ok) throw new Error(`eBay API HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
	return resp.json();
}

function normProduct(d: any): RetailProduct {
	const price = d?.price ?? {};
	return {
		id: String(d?.itemId ?? ""),
		title: d?.title,
		price: normalizeMoney(price.value),
		currency: String(price.currency ?? "USD"),
		image: d?.image?.imageUrl,
		url: d?.itemWebUrl,
		condition: d?.condition,
	};
}

export const ebay: Fn = {
	name: "ebay",
	description:
		"eBay Browse API (official) — search eBay's live marketplace listings by keyword. " +
		"`action`: search (item summaries matching `term`). " +
		"Needs EBAY_CLIENT_ID/EBAY_CLIENT_SECRET (free at developer.ebay.com). Returns normalized JSON.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["search"], default: "search" },
			term: { type: "string", description: "Search text (action=search)." },
			limit: { type: "integer", minimum: 1, maximum: 50, default: 15 },
		},
	},
	cacheable: true,
	ttl: 300,
	run: async (env, args) => {
		if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET)
			return failWith("not_configured", "eBay API not configured (EBAY_CLIENT_ID/EBAY_CLIENT_SECRET). Free at developer.ebay.com.");

		const action = String(args?.action ?? "search");
		const limit = Math.min(50, Math.max(1, Number(args?.limit) || 15));

		try {
			// action === "search"
			const term = String(args?.term ?? "").trim();
			if (!term) return failWith("bad_input", "action=search requires a `term`.");
			const p = new URLSearchParams({ q: term, limit: String(limit) });
			const j = await api(env, `${API}/item_summary/search?${p}`);
			const products = (j?.itemSummaries ?? []).map(normProduct);
			return ok(oj({ retailer: "ebay", action, count: products.length, products }));
		} catch (e) {
			return failWith("upstream_error", `ebay (${action}) failed: ${errMsg(e)}`);
		}
	},
};
