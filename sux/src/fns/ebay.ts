import { type Fn, fail, ok, type RtEnv } from "../registry";
import { normalizeMoney, type RetailProduct } from "./_retail";

// eBay Browse API (api.ebay.com) — official, clean REST, no bot wall. Auth is
// OAuth2 client-credentials (same shape as kroger): the app token is minted once
// and cached in KV (env.OAUTH_KV) until just before it expires, so we never
// re-mint per call.

const API = "https://api.ebay.com/buy/browse/v1";
const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const TOKEN_KEY = "sux:ebay:token";
const SCOPE = "https://api.ebay.com/oauth/api_scope";

const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

/** Mint a fresh app token and cache it in KV. */
async function mintToken(env: RtEnv): Promise<string> {
	const basic = btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`);
	const resp = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: `grant_type=client_credentials&scope=${encodeURIComponent(SCOPE)}`,
	});
	if (!resp.ok) throw new Error(`OAuth token HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
	const j: any = await resp.json();
	const token = String(j?.access_token ?? "");
	if (!token) throw new Error("OAuth token response had no access_token.");
	const ttl = Math.max(60, (Number(j?.expires_in) || 7200) - 60);
	await env.OAUTH_KV.put(TOKEN_KEY, token, { expirationTtl: ttl });
	return token;
}

/** Get a valid app token — from KV if present, else mint one and cache it. */
async function getToken(env: RtEnv): Promise<string> {
	const cached = await env.OAUTH_KV.get(TOKEN_KEY);
	return cached || mintToken(env);
}

/** GET an authed eBay endpoint; self-heals a stale app token (401/403) by re-minting once — matching kroger/reddit/tailscale. */
async function api(env: RtEnv, url: string): Promise<any> {
	const get = (token: string) => fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
	let resp = await get(await getToken(env));
	if (resp.status === 401 || resp.status === 403) {
		// eBay invalidated the token before its ~2h TTL → drop the cache and re-mint DIRECTLY (not via
		// getToken, so KV read-after-delete eventual consistency can't hand back the rejected token).
		await env.OAUTH_KV.delete(TOKEN_KEY).catch(() => {});
		resp = await get(await mintToken(env));
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
			return fail("eBay API not configured (EBAY_CLIENT_ID/EBAY_CLIENT_SECRET). Free at developer.ebay.com.");

		const action = String(args?.action ?? "search");
		const limit = Math.min(50, Math.max(1, Number(args?.limit) || 15));

		try {
			// action === "search"
			const term = String(args?.term ?? "").trim();
			if (!term) return fail("action=search requires a `term`.");
			const p = new URLSearchParams({ q: term, limit: String(limit) });
			const j = await api(env, `${API}/item_summary/search?${p}`);
			const products = (j?.itemSummaries ?? []).map(normProduct);
			return ok(JSON.stringify({ retailer: "ebay", action, count: products.length, products }, null, 2));
		} catch (e) {
			return fail(`ebay (${action}) failed: ${errMsg(e)}`);
		}
	},
};
