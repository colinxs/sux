import { type Fn, fail, ok } from "../registry";
import { normalizeMoney, type RetailProduct } from "./_retail";

// Best Buy Products API (api.bestbuy.com) — official, free, clean REST, no bot
// wall. A single apiKey rides the query string; no OAuth handshake. `search`
// hits the open-ended query endpoint; `product` fetches one SKU directly.

const API = "https://api.bestbuy.com/v1";
const SHOW = "sku,name,salePrice,regularPrice,onlineAvailability,image,url,manufacturer";

const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

async function api(url: string): Promise<any> {
	const resp = await fetch(url, { headers: { Accept: "application/json" } });
	if (!resp.ok) throw new Error(`Best Buy API HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
	return resp.json();
}

function normProduct(d: any): RetailProduct {
	const sale = normalizeMoney(d?.salePrice);
	const regular = normalizeMoney(d?.regularPrice);
	const promo = sale !== undefined && regular !== undefined && sale < regular ? sale : undefined;
	return {
		id: String(d?.sku ?? ""),
		title: d?.name,
		brand: d?.manufacturer,
		price: sale,
		promo_price: promo,
		currency: "USD",
		image: d?.image,
		url: d?.url,
		in_stock: typeof d?.onlineAvailability === "boolean" ? d.onlineAvailability : undefined,
	};
}

export const bestbuy: Fn = {
	name: "bestbuy",
	description:
		"Best Buy Products API (official, free) — product search and detail across Best Buy's catalog. " +
		"`action`: search (products matching `term`), product (detail by `sku`). " +
		"Needs BESTBUY_API_KEY (free at developer.bestbuy.com). Returns normalized JSON.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["search", "product"], default: "search" },
			term: { type: "string", description: "Search text (action=search)." },
			sku: { type: "string", description: "Best Buy SKU (action=product)." },
			limit: { type: "integer", minimum: 1, maximum: 50, default: 15 },
		},
	},
	cacheable: true,
	ttl: 300,
	run: async (env, args) => {
		if (!env.BESTBUY_API_KEY) return fail("Best Buy API not configured (BESTBUY_API_KEY). Free key at developer.bestbuy.com.");

		const action = String(args?.action ?? "search");
		const limit = Math.min(50, Math.max(1, Number(args?.limit) || 15));
		const key = env.BESTBUY_API_KEY;

		try {
			if (action === "product") {
				const sku = String(args?.sku ?? "").trim();
				if (!sku) return fail("action=product requires a `sku`.");
				const p = new URLSearchParams({ apiKey: key, format: "json", show: SHOW });
				const j = await api(`${API}/products/${encodeURIComponent(sku)}.json?${p}`);
				const d = Array.isArray(j?.products) ? j.products[0] : j;
				if (!d || d?.sku === undefined) return fail(`No Best Buy product found for SKU '${sku}'.`);
				return ok(JSON.stringify({ retailer: "bestbuy", action, count: 1, products: [normProduct(d)] }, null, 2));
			}

			// action === "search"
			const term = String(args?.term ?? "").trim();
			if (!term) return fail("action=search requires a `term`.");
			const p = new URLSearchParams({ apiKey: key, format: "json", show: SHOW, pageSize: String(limit) });
			const j = await api(`${API}/products((search=${encodeURIComponent(term)}))?${p}`);
			const products = (j?.products ?? []).map(normProduct);
			return ok(JSON.stringify({ retailer: "bestbuy", action, count: products.length, products }, null, 2));
		} catch (e) {
			return fail(`bestbuy (${action}) failed: ${errMsg(e)}`);
		}
	},
};
