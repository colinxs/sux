import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { oj } from "./_util";
import { retailRender } from "../retail-render";
import { normalizeMoney, type RetailProduct } from "./_retail";

// Walmart sits behind an ACTIVE PerimeterX JS challenge a plain fetch can't pass, so
// this fn renders Walmart's own search/product pages and lifts products out of the
// __NEXT_DATA__ JSON blob Next.js embeds (props.pageProps.initialData…). No Orchestra
// GraphQL — its persisted-query hashes rotate; __NEXT_DATA__ is stable.
//
// READS ONLY: both actions here (search, product) are reads, so they go through
// `retailRender` — cf-residential+stealth FIRST (it often clears PerimeterX for a
// plain page load from a home IP), with the paid residential unlocker as the fallback
// rung for the hard walls cf can't clear. The unlocker no-ops when UNLOCKER_API_* is
// unset, so the common path stays pure cf and a hard wall surfaces cf's error.

const BLOCKED_MSG = "walmart: blocked or no data — the render backend may be down or Walmart challenged the request.";

/**
 * Extract and parse the `<script id="__NEXT_DATA__" type="application/json">…
 * </script>` JSON from rendered HTML. Returns undefined if absent/unparseable —
 * every caller treats that as a challenge/layout-change failure rather than throwing.
 */
function extractNextData(html: string): any {
	const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
	if (!m) return undefined;
	try {
		return JSON.parse(m[1]);
	} catch {
		return undefined;
	}
}

/** Normalize one Walmart itemStacks item to the shared RetailProduct shape. */
function normSearchItem(it: any): RetailProduct {
	const id = String(it?.usItemId ?? it?.id ?? "");
	return {
		id,
		title: it?.name,
		price: normalizeMoney(it?.priceInfo?.currentPrice?.price),
		brand: it?.brand,
		currency: "USD",
		image: it?.imageInfo?.thumbnailUrl,
		url: id ? `https://www.walmart.com/ip/${id}` : undefined,
		in_stock: it?.availabilityStatus === "IN_STOCK",
	};
}

export const walmart: Fn = {
	name: "walmart",
	cost: 5,
	description:
		"Walmart product search and detail via a rendered browser (Walmart runs an active PerimeterX JS challenge a plain fetch can't pass). Renders through Cloudflare Browser Run (residential + stealth) first, falling back to the paid residential unlocker when cf can't clear the wall. " +
		"`action`: search (products for a `term`) or product (detail by `item_id`). Products come from Walmart's embedded __NEXT_DATA__ JSON, normalized to the shared retail shape (id/title/price/brand/image/url/in_stock). " +
		"`limit` caps search results (default 15, max 40). Slower than an API — it renders the real page.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["search", "product"], default: "search", description: "search (by term) or product (by item_id)." },
			term: { type: "string", description: "Search text (action=search)." },
			item_id: { type: "string", description: "Walmart item id (action=product)." },
			limit: { type: "integer", minimum: 1, maximum: 40, default: 15, description: "Max search results." },
		},
	},
	cacheable: true,
	ttl: 300,
	run: async (env: RtEnv, args) => {
		const action = args?.action === "product" ? "product" : "search";
		const limit = Math.min(40, Math.max(1, Number(args?.limit) || 15));

		if (action === "product") {
			const itemId = String(args?.item_id ?? "").trim();
			if (!itemId) return failWith("bad_input", "action=product requires an `item_id`.");
			const r = await retailRender(env, {
				url: `https://www.walmart.com/ip/${encodeURIComponent(itemId)}`,
				block_resources: true,
				wait_until: "domcontentloaded",
				wait_ms: 4000,
			});
			if (!r.ok) return failWith("blocked", `${BLOCKED_MSG} (${r.error})`);
			const data = extractNextData(r.body);
			const product = data?.props?.pageProps?.initialData?.data?.product;
			if (!product) return failWith("blocked", BLOCKED_MSG);
			const id = String(product?.usItemId ?? product?.id ?? itemId);
			const norm: RetailProduct = {
				id,
				title: product?.name,
				price: normalizeMoney(product?.priceInfo?.currentPrice?.price),
				brand: product?.brand,
				currency: "USD",
				image: product?.imageInfo?.thumbnailUrl,
				url: `https://www.walmart.com/ip/${id}`,
				in_stock: product?.availabilityStatus === "IN_STOCK",
			};
			return ok(oj({ retailer: "walmart", action, count: 1, products: [norm] }));
		}

		// action === "search"
		const term = String(args?.term ?? "").trim();
		if (!term) return failWith("bad_input", "action=search requires a `term`.");
		const r = await retailRender(env, {
			url: `https://www.walmart.com/search?q=${encodeURIComponent(term)}`,
			block_resources: true,
			wait_until: "domcontentloaded",
			wait_ms: 4000,
		});
		if (!r.ok) return failWith("blocked", `${BLOCKED_MSG} (${r.error})`);
		const data = extractNextData(r.body);
		if (!data) return failWith("blocked", BLOCKED_MSG);
		const items = data?.props?.pageProps?.initialData?.searchResult?.itemStacks?.[0]?.items;
		if (!Array.isArray(items)) return failWith("blocked", BLOCKED_MSG);
		// itemStacks can carry non-product tiles (ads/placeholders) with no id — keep
		// only real products, then cap to the requested limit.
		const products = items
			.filter((it: any) => it && (it.usItemId || it.id) && it.name)
			.slice(0, limit)
			.map(normSearchItem);
		return ok(oj({ retailer: "walmart", action, count: products.length, products }));
	},
};
