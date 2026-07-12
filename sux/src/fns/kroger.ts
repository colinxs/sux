import { withRetry } from "../proxy";
import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { getClientToken, mintClientToken, type OAuthClientCreds } from "./_oauth";
import { normalizeMoney, type RetailProduct } from "./_retail";
import { errMsg, oj } from "./_util";

// Kroger Public API (api.kroger.com) — official, free, clean REST, no bot wall.
// One fn covers Kroger and every banner it owns (QFC, Fred Meyer, Ralphs, …) via
// the locations chain filter. Auth is OAuth2 client-credentials; the bearer token
// is minted once and cached in KV (env.OAUTH_KV) until just before it expires, so
// we never re-mint per call. Token lifecycle lives in _oauth (shared with ebay/tailscale).

const API = "https://api.kroger.com/v1";
const TOKEN_KEY = "sux:kroger:token";
const oauth = (env: RtEnv): OAuthClientCreds => ({
	tokenUrl: `${API}/connect/oauth2/token`,
	clientId: String(env.KROGER_CLIENT_ID ?? ""),
	clientSecret: String(env.KROGER_CLIENT_SECRET ?? ""),
	cacheKey: TOKEN_KEY,
	scope: "product.compact",
	retry: true, // a client-credentials mint has no side effect — safe to retry a transient/rate-limit blip
	defaultTtl: 1800,
});

/**
 * GET an authed Kroger endpoint, throwing a status-carrying error on failure.
 * Self-heals a revoked/rejected token: on a 401/403 it drops the cached token,
 * re-mints once, and retries — so a token invalidated before its TTL recovers
 * without waiting out the cache. The retry mints directly (not via getClientToken)
 * so KV read-after-delete eventual consistency can't hand back the rejected token.
 */
async function api(env: RtEnv, path: string): Promise<any> {
	// GETs are idempotent, so retry transient/rate-limit failures with backoff. A
	// 401/403 is NOT transient — withRetry passes it straight through, so the
	// re-mint self-heal below still fires on exactly the first rejected response.
	const get = (token: string) => withRetry(() => fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }));
	let resp = await get(await getClientToken(env, oauth(env)));
	if (resp.status === 401 || resp.status === 403) {
		await env.OAUTH_KV.delete(TOKEN_KEY);
		resp = await get(await mintClientToken(env, oauth(env)));
	}
	if (!resp.ok) throw new Error(`Kroger API HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
	return resp.json();
}

function locationsPath(zip: string, limit: number, chain?: string): string {
	const p = new URLSearchParams({ "filter.zipCode.near": zip, "filter.limit": String(limit) });
	if (chain) p.set("filter.chain", chain);
	return `/locations?${p}`;
}

function normLocation(d: any): { locationId: string; chain?: string; name?: string; address?: string; phone?: string } {
	const a = d?.address ?? {};
	const address = [a.addressLine1, a.city, a.state, a.zipCode].filter(Boolean).join(", ") || undefined;
	return { locationId: d?.locationId, chain: d?.chain, name: d?.name, address, phone: d?.phone };
}

function normProduct(d: any): RetailProduct {
	const item = d?.items?.[0] ?? {};
	const price = item?.price ?? {};
	const ff = item?.fulfillment ?? {};
	const fulfillment = Object.keys(ff).filter((k) => ff[k]);
	const sizes = d?.images?.[0]?.sizes ?? [];
	const image = (sizes.find((s: any) => s?.size === "large") ?? sizes[0])?.url;
	return {
		id: d?.productId,
		title: d?.description,
		brand: d?.brand,
		price: normalizeMoney(price.regular),
		promo_price: normalizeMoney(price.promo),
		currency: "USD",
		fulfillment: fulfillment.length ? fulfillment : undefined,
		size: item?.size,
		image,
		url: `https://www.kroger.com/p/-/${d?.productId}`,
	};
}

/**
 * Normalize an API product array, guarding each record so one malformed entry
 * (unexpected shape that makes normProduct throw) is skipped rather than
 * discarding the whole result set — mirrors the per-tile guard in the HTML parsers.
 */
function normProducts(data: any): RetailProduct[] {
	return (Array.isArray(data) ? data : [])
		.map((d) => {
			try {
				return normProduct(d);
			} catch {
				return null;
			}
		})
		.filter((p): p is RetailProduct => p !== null);
}

/** Resolve the first matching store's locationId for a zip (chain-filtered). */
async function resolveLocationId(env: RtEnv, zip: string, chain?: string): Promise<string | undefined> {
	const j = await api(env, locationsPath(zip, 1, chain));
	return (j?.data ?? [])[0]?.locationId;
}

export const kroger: Fn = {
	name: "kroger",
	description:
		"Kroger Public API (official, free) — product search, prices, and store locations for Kroger and its banners (QFC, Fred Meyer, Ralphs, Fry's, King Soopers, Smith's) via the `chain` filter. " +
		"`action`: search (products; needs a location_id, or a zip to auto-resolve one), locations (stores near a zip), product (detail by product_id). " +
		"Prices/availability require a store, so pass location_id or zip. Needs KROGER_CLIENT_ID/KROGER_CLIENT_SECRET (free at developer.kroger.com). Returns normalized JSON.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["search", "locations", "product"], default: "search" },
			term: { type: "string", description: "Search text (action=search)." },
			location_id: { type: "string", description: "Store id for prices/availability." },
			zip: { type: "string", description: "ZIP code — for action=locations, or to auto-resolve a store when location_id is absent." },
			chain: { type: "string", enum: ["Kroger", "QFC", "Fred Meyer", "Ralphs", "Frys", "King Soopers", "Smiths"], description: "Banner filter for locations / auto-resolution." },
			product_id: { type: "string", description: "Product id (action=product)." },
			limit: { type: "integer", minimum: 1, maximum: 50, default: 15 },
		},
	},
	cacheable: true,
	ttl: 300,
	run: async (env, args) => {
		if (!env.KROGER_CLIENT_ID || !env.KROGER_CLIENT_SECRET)
			return failWith("not_configured", "Kroger API not configured (KROGER_CLIENT_ID/KROGER_CLIENT_SECRET). Get a free key at developer.kroger.com.");

		const action = String(args?.action ?? "search");
		const limit = Math.min(50, Math.max(1, Number(args?.limit) || 15));
		const chain = args?.chain ? String(args.chain) : undefined;
		const zip = args?.zip ? String(args.zip).trim() : "";

		try {
			if (action === "locations") {
				if (!zip) return failWith("bad_input", "action=locations requires a `zip`.");
				const j = await api(env, locationsPath(zip, limit, chain));
				const locations = (j?.data ?? []).map(normLocation);
				return ok(oj({ retailer: "kroger", action, count: locations.length, locations }));
			}

			if (action === "product") {
				const id = String(args?.product_id ?? "").trim();
				if (!id) return failWith("bad_input", "action=product requires a `product_id`.");
				let locationId = args?.location_id ? String(args.location_id).trim() : "";
				if (!locationId && zip) locationId = (await resolveLocationId(env, zip, chain)) ?? "";
				const q = locationId ? `?filter.locationId=${encodeURIComponent(locationId)}` : "";
				const j = await api(env, `/products/${encodeURIComponent(id)}${q}`);
				const d = Array.isArray(j?.data) ? j.data[0] : j?.data;
				if (!d) return failWith("not_found", `No Kroger product found for '${id}'.`);
				return ok(oj({ retailer: "kroger", action, count: 1, products: [normProduct(d)] }));
			}

			// action === "search"
			const term = String(args?.term ?? "").trim();
			if (!term) return failWith("bad_input", "action=search requires a `term`.");
			let locationId = args?.location_id ? String(args.location_id).trim() : "";
			if (!locationId && zip) locationId = (await resolveLocationId(env, zip, chain)) ?? "";
			const p = new URLSearchParams({ "filter.term": term, "filter.limit": String(limit) });
			if (locationId) p.set("filter.locationId", locationId);
			const j = await api(env, `/products?${p}`);
			const products = normProducts(j?.data);
			return ok(oj({ retailer: "kroger", action, location_id: locationId || undefined, count: products.length, products }));
		} catch (e) {
			return failWith("upstream_error", `kroger (${action}) failed: ${errMsg(e)}`);
		}
	},
};
