import { type Fn, fail, ok } from "../registry";

type ShopHit = { title: string; price?: string; source?: string; url?: string; rating?: string };

// SerpAPI-backed stores: engine + the query-parameter name + how to read results.
const SERP: Record<string, { engine: string; param: string; pick: (j: any) => ShopHit[] }> = {
	gshop: {
		engine: "google_shopping",
		param: "q",
		pick: (j) => (j?.shopping_results ?? []).map((r: any) => ({ title: r.title, price: r.price, source: r.source, url: r.link, rating: r.rating ? `${r.rating}★ (${r.reviews ?? 0})` : undefined })),
	},
	amazon: {
		engine: "amazon",
		param: "k",
		pick: (j) => (j?.organic_results ?? []).map((r: any) => ({ title: r.title, price: r.price ?? r.price_upper, url: r.link, rating: r.rating ? `${r.rating}★ (${r.reviews ?? 0})` : undefined })),
	},
	walmart: {
		engine: "walmart",
		param: "query",
		pick: (j) => (j?.organic_results ?? []).map((r: any) => ({ title: r.title, price: r.primary_offer?.offer_price ? `$${r.primary_offer.offer_price}` : undefined, url: r.product_page_url ?? r.link, rating: r.rating ? `${r.rating}★` : undefined })),
	},
	home_depot: {
		engine: "home_depot",
		param: "q",
		pick: (j) => (j?.products ?? []).map((r: any) => ({ title: r.title, price: r.price ? `$${r.price}` : undefined, url: r.link, rating: r.rating ? `${r.rating}★` : undefined })),
	},
};

// Stores with no wired provider yet (SerpAPI doesn't cover them / no public API).
// Kept in the enum so the signature is stable; they report how to enable.
const UNWIRED: Record<string, string> = {
	costco: "Costco has no public product API and isn't on SerpAPI. Provide a scraper key or a third-party catalog API to enable.",
	kroger: "Kroger has an official Products API (needs OAuth client credentials). Wire KROGER_* secrets to enable.",
	fred_meyer: "Fred Meyer is a Kroger banner — same Kroger Products API path; wire KROGER_* secrets.",
	cvs: "CVS has no public product-search API. Provide a scraper/third-party key to enable.",
	lowes: "Lowe's isn't on SerpAPI and has no public API. Provide a scraper/third-party key to enable.",
	safeway: "Safeway (Albertsons) has no public API. Provide a scraper/third-party key to enable.",
	camelcamelcamel: "camelcamelcamel has no public API. For Amazon price history, provide a Keepa or Amazon PA-API key.",
};

const fmt = (hits: ShopHit[]): string =>
	hits.length
		? hits.map((h, i) => `${i + 1}. ${h.title}${h.price ? ` — ${h.price}` : ""}${h.rating ? ` — ${h.rating}` : ""}${h.source ? ` [${h.source}]` : ""}${h.url ? `\n   ${h.url}` : ""}`).join("\n\n")
		: "(no results)";

export const shop: Fn = {
	name: "shop",
	description:
		"Product search across retailers. `store`: gshop (Google Shopping), amazon, walmart, home_depot — all via SerpAPI (needs SERPAPI_KEY); " +
		"and costco, kroger, fred_meyer, cvs, lowes, safeway, camelcamelcamel — recognized but not yet wired (each reports how to enable, e.g. with a private/native API key). " +
		"Returns numbered products with price, rating, and link.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["query"],
		properties: {
			query: { type: "string", description: "Product query." },
			store: { type: "string", enum: ["gshop", "amazon", "walmart", "home_depot", "costco", "kroger", "fred_meyer", "cvs", "lowes", "safeway", "camelcamelcamel"], default: "gshop" },
			limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const q = String(args?.query ?? "").trim();
		if (!q) return fail("query is required.");
		const store = String(args?.store ?? "gshop");
		const limit = Math.min(25, Math.max(1, Number(args?.limit) || 10));

		if (UNWIRED[store]) return fail(`Store '${store}' isn't wired yet. ${UNWIRED[store]}`);
		const spec = SERP[store];
		if (!spec) return fail(`Unknown store '${store}'.`);
		if (!env.SERPAPI_KEY) return fail(`Store '${store}' needs the SERPAPI_KEY secret (SerpAPI ${spec.engine} engine), which isn't configured.`);

		try {
			const url = `https://serpapi.com/search.json?engine=${spec.engine}&${spec.param}=${encodeURIComponent(q)}&api_key=${env.SERPAPI_KEY}`;
			const resp = await fetch(url);
			if (!resp.ok) return fail(`SerpAPI ${spec.engine} HTTP ${resp.status}`);
			const j = await resp.json();
			return ok(fmt(spec.pick(j).slice(0, limit)));
		} catch (e) {
			return fail(`shop (${store}) failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
