import { type Fn, fail, ok } from "../registry";
import { normalizeMoney, type RetailProduct } from "./_retail";

// Etsy Open API v3 (openapi.etsy.com) — active-listing search across Etsy's
// handmade/vintage marketplace. The keystring rides the `x-api-key` header.
// Prices arrive as {amount, divisor, currency_code}; divide to a real number.

const API = "https://openapi.etsy.com/v3/application/listings/active";

const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

function normListing(d: any): RetailProduct {
	const price = d?.price ?? {};
	const amount = Number(price?.amount);
	const divisor = Number(price?.divisor);
	const value = Number.isFinite(amount) && Number.isFinite(divisor) && divisor > 0 ? amount / divisor : undefined;
	return {
		id: String(d?.listing_id ?? ""),
		title: d?.title,
		price: normalizeMoney(value),
		currency: price?.currency_code ?? "USD",
		url: d?.url ?? (d?.listing_id !== undefined ? `https://www.etsy.com/listing/${d.listing_id}` : undefined),
		tags: Array.isArray(d?.tags) ? d.tags : undefined,
	} as RetailProduct & { tags?: string[] };
}

export const etsy: Fn = {
	name: "etsy",
	description:
		"Etsy Open API v3 (official, free) — active-listing search across Etsy's handmade and vintage marketplace by `term`. " +
		"Needs ETSY_API_KEY keystring (free at etsy.com/developers). Returns normalized JSON.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["term"],
		properties: {
			term: { type: "string", description: "Search text." },
			limit: { type: "integer", minimum: 1, maximum: 50, default: 15 },
		},
	},
	cacheable: true,
	ttl: 600,
	run: async (env, args) => {
		if (!env.ETSY_API_KEY) return fail("Etsy API not configured (ETSY_API_KEY). Free key at etsy.com/developers.");

		const term = String(args?.term ?? "").trim();
		if (!term) return fail("`term` is required.");
		const limit = Math.min(50, Math.max(1, Number(args?.limit) || 15));

		try {
			const p = new URLSearchParams({ keywords: term, limit: String(limit) });
			const resp = await fetch(`${API}?${p}`, { headers: { "x-api-key": env.ETSY_API_KEY, Accept: "application/json" } });
			if (!resp.ok) throw new Error(`Etsy API HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
			const j: any = await resp.json();
			const products = (j?.results ?? []).map(normListing);
			return ok(JSON.stringify({ retailer: "etsy", action: "search", count: products.length, products }, null, 2));
		} catch (e) {
			return fail(`etsy failed: ${errMsg(e)}`);
		}
	},
};
