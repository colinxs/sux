import { type Fn, fail, ok, type RtEnv } from "../registry";
import { normalizeMoney, type RetailProduct } from "./_retail";

// Kroger Public API (api.kroger.com) — official, free, clean REST, no bot wall.
// One fn covers Kroger and every banner it owns (QFC, Fred Meyer, Ralphs, …) via
// the locations chain filter. Auth is OAuth2 client-credentials; the bearer token
// is minted once and cached in KV (env.OAUTH_KV) until just before it expires, so
// we never re-mint per call.

const API = "https://api.kroger.com/v1";
const TOKEN_URL = `${API}/connect/oauth2/token`;
const TOKEN_KEY = "sux:kroger:token";

const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

/** Get a valid bearer token — from KV if present, else mint one and cache it. */
async function getToken(env: RtEnv): Promise<string> {
	const cached = await env.OAUTH_KV.get(TOKEN_KEY);
	if (cached) return cached;
	const basic = btoa(`${env.KROGER_CLIENT_ID}:${env.KROGER_CLIENT_SECRET}`);
	const resp = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: "grant_type=client_credentials&scope=product.compact",
	});
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

/** GET an authed Kroger endpoint, throwing a status-carrying error on failure. */
async function api(token: string, path: string): Promise<any> {
	const resp = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
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

/** Resolve the first matching store's locationId for a zip (chain-filtered). */
async function resolveLocationId(token: string, zip: string, chain?: string): Promise<string | undefined> {
	const j = await api(token, locationsPath(zip, 1, chain));
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
			return fail("Kroger API not configured (KROGER_CLIENT_ID/KROGER_CLIENT_SECRET). Get a free key at developer.kroger.com.");

		const action = String(args?.action ?? "search");
		const limit = Math.min(50, Math.max(1, Number(args?.limit) || 15));
		const chain = args?.chain ? String(args.chain) : undefined;
		const zip = args?.zip ? String(args.zip).trim() : "";

		try {
			const token = await getToken(env);

			if (action === "locations") {
				if (!zip) return fail("action=locations requires a `zip`.");
				const j = await api(token, locationsPath(zip, limit, chain));
				const locations = (j?.data ?? []).map(normLocation);
				return ok(JSON.stringify({ retailer: "kroger", action, count: locations.length, locations }, null, 2));
			}

			if (action === "product") {
				const id = String(args?.product_id ?? "").trim();
				if (!id) return fail("action=product requires a `product_id`.");
				let locationId = args?.location_id ? String(args.location_id).trim() : "";
				if (!locationId && zip) locationId = (await resolveLocationId(token, zip, chain)) ?? "";
				const q = locationId ? `?filter.locationId=${encodeURIComponent(locationId)}` : "";
				const j = await api(token, `/products/${encodeURIComponent(id)}${q}`);
				const d = Array.isArray(j?.data) ? j.data[0] : j?.data;
				if (!d) return fail(`No Kroger product found for '${id}'.`);
				return ok(JSON.stringify({ retailer: "kroger", action, count: 1, products: [normProduct(d)] }, null, 2));
			}

			// action === "search"
			const term = String(args?.term ?? "").trim();
			if (!term) return fail("action=search requires a `term`.");
			let locationId = args?.location_id ? String(args.location_id).trim() : "";
			if (!locationId && zip) locationId = (await resolveLocationId(token, zip, chain)) ?? "";
			const p = new URLSearchParams({ "filter.term": term, "filter.limit": String(limit) });
			if (locationId) p.set("filter.locationId", locationId);
			const j = await api(token, `/products?${p}`);
			const products = (j?.data ?? []).map(normProduct);
			return ok(JSON.stringify({ retailer: "kroger", action, location_id: locationId || undefined, count: products.length, products }, null, 2));
		} catch (e) {
			return fail(`kroger (${action}) failed: ${errMsg(e)}`);
		}
	},
};
