import { withRetry } from "../proxy";
import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { normalizeMoney, type RetailProduct } from "./_retail";
import { errMsg } from "./_util";

// Kroger Public API (api.kroger.com) — official, free, clean REST, no bot wall.
// One fn covers Kroger and every banner it owns (QFC, Fred Meyer, Ralphs, …) via
// the locations chain filter. Auth is OAuth2 client-credentials; the bearer token
// is minted once and cached in KV (env.OAUTH_KV) until just before it expires, so
// we never re-mint per call.

const API = "https://api.kroger.com/v1";
const TOKEN_URL = `${API}/connect/oauth2/token`;
const TOKEN_KEY = "sux:kroger:token";


/** Mint a fresh bearer token from the OAuth endpoint and cache it in KV. */
async function mintToken(env: RtEnv): Promise<string> {
	const basic = btoa(`${env.KROGER_CLIENT_ID}:${env.KROGER_CLIENT_SECRET}`);
	// A client-credentials mint has no side effect (it just issues a bearer), so it
	// is safe to retry a transient/rate-limit blip with backoff — same as an idempotent GET.
	const resp = await withRetry(() =>
		fetch(TOKEN_URL, {
			method: "POST",
			headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
			body: "grant_type=client_credentials&scope=product.compact",
		}),
	);
	if (!resp.ok) throw new Error(`OAuth token HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
	const j: any = await resp.json();
	const token = String(j?.access_token ?? "");
	if (!token) throw new Error("OAuth token response had no access_token.");
	// TTL = expires_in - 60 so the cached token is never used in its final minute;
	// clamp to Cloudflare KV's 60s floor.
	const ttl = Math.max(60, (Number(j?.expires_in) || 1800) - 60);
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
 * GET an authed Kroger endpoint, throwing a status-carrying error on failure.
 * Self-heals a revoked/rejected token: on a 401/403 it drops the cached token,
 * re-mints once, and retries — so a token invalidated before its TTL recovers
 * without waiting out the cache. The retry mints directly (not via getToken) so
 * KV read-after-delete eventual consistency can't hand back the rejected token.
 */
async function api(env: RtEnv, path: string): Promise<any> {
	// GETs are idempotent, so retry transient/rate-limit failures with backoff. A
	// 401/403 is NOT transient — withRetry passes it straight through, so the
	// re-mint self-heal below still fires on exactly the first rejected response.
	const get = (token: string) => withRetry(() => fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }));
	let resp = await get(await getToken(env));
	if (resp.status === 401 || resp.status === 403) {
		await env.OAUTH_KV.delete(TOKEN_KEY);
		resp = await get(await mintToken(env));
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
				return ok(JSON.stringify({ retailer: "kroger", action, count: locations.length, locations }, null, 2));
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
				return ok(JSON.stringify({ retailer: "kroger", action, count: 1, products: [normProduct(d)] }, null, 2));
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
			return ok(JSON.stringify({ retailer: "kroger", action, location_id: locationId || undefined, count: products.length, products }, null, 2));
		} catch (e) {
			return failWith("upstream_error", `kroger (${action}) failed: ${errMsg(e)}`);
		}
	},
};
