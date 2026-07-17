import { type Fn, failWith, type RtEnv } from "../registry";

// shop is a thin DISPATCHER over the dedicated retail fns — it does NOT scrape.
// The old SerpAPI / Google Shopping path is dead (SerpAPI's product engine went
// away and Google Shopping needs JS + anti-bot that isn't worth re-scraping when
// every major retailer already has a robust, structured sux fn). The `retailer`
// arg picks the retail fn; shop translates its {query, limit, optional zip} into
// that fn's args, invokes it through the FUNCTIONS registry, and returns its
// result verbatim (already normalized to the shared retail shape).

/**
 * How to route each `retailer` to a dedicated retail fn: the target fn's name and a
 * builder that shapes shop's {term, limit, zip} into that fn's own args. `deals`
 * routes to weekly_ad (Flipp) rather than a single retailer.
 */
type Route = { fn: string; args: (q: { term: string; limit: number; zip: string }) => Record<string, unknown> };

const withZip = (base: Record<string, unknown>, zip: string): Record<string, unknown> => (zip ? { ...base, zip } : base);

const ROUTES: Record<string, Route> = {
	amazon: { fn: "amazon", args: ({ term, limit }) => ({ action: "search", term, limit }) },
	walmart: { fn: "walmart", args: ({ term, limit }) => ({ action: "search", term, limit }) },
	home_depot: { fn: "homedepot", args: ({ term, limit, zip }) => withZip({ action: "search", term, limit }, zip) },
	lowes: { fn: "lowes", args: ({ term, limit }) => ({ action: "search", term, limit }) },
	ace: { fn: "ace", args: ({ term, limit }) => ({ action: "search", term, limit }) },
	costco: { fn: "costco", args: ({ term, limit }) => ({ action: "search", term, limit }) },
	bestbuy: { fn: "bestbuy", args: ({ term, limit }) => ({ action: "search", term, limit }) },
	ebay: { fn: "ebay", args: ({ term, limit }) => ({ action: "search", term, limit }) },
	kroger: { fn: "kroger", args: ({ term, limit, zip }) => withZip({ action: "search", term, limit }, zip) },
	// Fred Meyer is a Kroger banner — same API, selected via the chain filter.
	fred_meyer: { fn: "kroger", args: ({ term, limit, zip }) => withZip({ action: "search", term, limit, chain: "Fred Meyer" }, zip) },
	// Weekly-ad deals across every merchant Flipp indexes for the zip.
	deals: { fn: "weekly_ad", args: ({ term, limit, zip }) => ({ term, limit, zip }) },
};

const RETAILERS = Object.keys(ROUTES);

export const shop: Fn = {
	name: "shop",
	cost: 3,
	description:
		"Product search — a router over the dedicated retail fns (no Google Shopping / SerpAPI; that path is dead). Pick a retailer with `retailer` and pass `query`; shop dispatches to that fn and returns its normalized result. " +
		`\`retailer\`: ${RETAILERS.join(", ")} — amazon/walmart/lowes/ace (cf-residential render + optional unlocker), costco (residential proxy + optional unlocker, no render backend), home_depot→homedepot (cf-residential render + optional unlocker, honors \`zip\`), bestbuy (Best Buy Products API) and ebay (eBay Browse API), kroger and fred_meyer (Kroger API, \`zip\` auto-resolves a store for prices; fred_meyer via the Kroger chain filter), and deals→weekly_ad (Flipp grocery flyer, requires a 5-digit \`zip\`). ` +
		"`limit` caps results (1..25, default 10). For the full arg surface / product-detail lookups, call the retailer fn directly.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["query", "retailer"],
		properties: {
			query: { type: "string", description: "Product / deal search text." },
			retailer: { type: "string", enum: RETAILERS, description: "Which retailer to search (deals = weekly-ad flyer across merchants)." },
			zip: { type: "string", description: "5-digit ZIP — required for `deals`; localizes home_depot; auto-resolves a store (prices) for kroger/fred_meyer." },
			limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
		},
	},
	cacheable: true,
	ttl: 300, // prices/availability are live external state — keep fresh
	run: async (env: RtEnv, args) => {
		const query = String(args?.query ?? "").trim();
		if (!query) return failWith("bad_input", "query is required.");
		const retailer = String(args?.retailer ?? "").trim().toLowerCase();
		const route = ROUTES[retailer];
		if (!route) return failWith("bad_input", `retailer must be one of: ${RETAILERS.join(", ")}.`);
		const limit = Math.min(25, Math.max(1, Number(args?.limit) || 10));
		const zip = args?.zip ? String(args.zip).trim() : "";
		if (retailer === "deals" && !/^\d{5}$/.test(zip)) return failWith("bad_input", "retailer='deals' (weekly_ad) requires a 5-digit `zip`.");

		// Dispatch through the registry (dynamic import avoids the shop↔index cycle).
		const { FUNCTIONS } = (await import("./index")) as { FUNCTIONS: Fn[] };
		const target = FUNCTIONS.find((f) => f.name === route.fn);
		if (!target) return failWith("upstream_error", `shop: dispatch target '${route.fn}' is not registered.`);

		try {
			return await target.run(env, route.args({ term: query, limit, zip }));
		} catch (e) {
			return failWith("upstream_error", `shop → ${route.fn} failed: ${String((e as Error)?.message ?? e)}`);
		}
	},
};
