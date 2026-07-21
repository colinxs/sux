import { type Fn, failWith, ok, type RtEnv, type ToolResult } from "../registry";
import { oj } from "./_util";
import type { RetailProduct } from "./_retail";
import { clientDeclaredUiSupport, escapeHtml, uiMeta, withUiResource } from "./_ui";

// Fan one `term` across the retailer fns concurrently and merge their products
// into one list. Each retailer is invoked through the FUNCTIONS registry (imported
// dynamically inside run() to avoid the static index.ts import cycle, exactly like
// batch/pipe), so product_search stays a thin orchestrator over the existing fns
// rather than duplicating any retailer's fetch/parse logic.
//
// Every retailer runs in its own Promise.allSettled slot: one retailer erroring
// (fail result), throwing, or returning unparseable JSON is isolated into `errors`
// and never aborts the others. Results are tagged with their retailer, concatenated,
// and capped by `limit`.

// The retailers we fan across, in a stable default order. kroger alone consumes a
// `zip` (to resolve a store for prices); the rest ignore it.
const RETAILERS = ["kroger", "walmart", "homedepot", "amazon", "lowes", "costco", "ace", "bestbuy", "ebay"] as const;

/** A merged product carries which retailer it came from alongside the shared shape. */
type TaggedProduct = RetailProduct & { retailer: string };

/** Build the per-retailer args for a search — kroger also gets the zip. */
function argsFor(retailer: string, term: string, zip: string, limit: number): Record<string, unknown> {
	const base: Record<string, unknown> = { action: "search", term, limit };
	if (retailer === "kroger" && zip) base.zip = zip;
	return base;
}

/**
 * Pull the products array out of a retailer fn's JSON text result. Each retailer
 * emits { retailer, action, count, products:[...] }; we tag each product with the
 * retailer and drop anything unparseable. Throws on non-JSON so the caller can
 * record it as that retailer's error.
 */
function parseProducts(retailer: string, text: string): TaggedProduct[] {
	const parsed = JSON.parse(text);
	const products = Array.isArray(parsed?.products) ? parsed.products : [];
	return products.map((p: RetailProduct) => ({ ...p, retailer }));
}

/**
 * Render a compact, self-contained HTML price-comparison dashboard (a sorted
 * bar chart + table) for the merged products — the MCP Apps UI resource
 * body for this fn (see `fns/_ui.ts`). No external assets (fonts/scripts/
 * images) — everything is inline so it renders in a sandboxed iframe with a
 * strict CSP. Every piece of upstream/third-party text (title, brand,
 * retailer) is HTML-escaped before interpolation.
 */
function renderProductDashboard(term: string, products: TaggedProduct[]): string {
	const priced = products
		.map((p) => ({ ...p, effectivePrice: p.promo_price ?? p.price }))
		.filter((p): p is TaggedProduct & { effectivePrice: number } => typeof p.effectivePrice === "number")
		.sort((a, b) => a.effectivePrice - b.effectivePrice);
	const max = priced.reduce((m, p) => Math.max(m, p.effectivePrice), 0) || 1;
	const rows = priced
		.map((p) => {
			const pct = Math.max(2, Math.round((p.effectivePrice / max) * 100));
			const label = `${escapeHtml(p.retailer)} — ${escapeHtml(p.title)}`;
			const price = `$${p.effectivePrice.toFixed(2)}`;
			return `<div class="row"><div class="label" title="${label}">${label}</div><div class="bar-track"><div class="bar" style="width:${pct}%"></div><span class="price">${price}</span></div></div>`;
		})
		.join("\n");
	return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.4 -apple-system, system-ui, sans-serif; margin: 0; padding: 12px; }
  h1 { font-size: 15px; margin: 0 0 10px; }
  .row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
  .label { width: 40%; flex: 0 0 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { flex: 1; display: flex; align-items: center; gap: 6px; }
  .bar { height: 16px; background: #3b82f6; border-radius: 3px; min-width: 4px; }
  .price { font-variant-numeric: tabular-nums; opacity: 0.85; }
  .empty { opacity: 0.7; }
</style></head>
<body>
<h1>Price comparison — ${escapeHtml(term)} (${priced.length} of ${products.length} priced)</h1>
${priced.length ? rows : '<p class="empty">No priced results to chart.</p>'}
</body></html>`;
}

export const product_search: Fn = {
	name: "product_search",
	cost: 5,
	description:
		"Multi-retailer product search — fan one `term` across the retailer fns (kroger, walmart, homedepot, amazon, lowes, costco, ace, bestbuy, ebay) concurrently and merge their results into one normalized product list. " +
		"`retailers` (optional) narrows the fan-out to a subset; `zip` is passed through to kroger (for store prices); `limit` caps the merged list (default 30). " +
		"`ui:true` additionally attaches an MCP Apps (SEP-1865) inline HTML price-comparison dashboard alongside the JSON — an MCP-Apps-aware host renders it, others ignore the extra content part. " +
		"Per-retailer failure is isolated — a retailer that errors, is unconfigured, or is blocked lands in `errors` and never aborts the rest. " +
		"Returns JSON { term, count, by_retailer:{ retailer:n }, products:[{ …product, retailer }], errors:[{ retailer, error }] }.",
	// _meta.ui.resourceUri names the ui:// template this fn's result MAY embed
	// when called with ui:true — advertised on the tool definition per the MCP
	// Apps spec's nested _meta.ui form (fns/_ui.ts's uiMeta).
	meta: uiMeta("product-search-dashboard"),
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["term"],
		properties: {
			term: { type: "string", description: "Product search text, e.g. 'cordless drill' or 'oat milk'." },
			retailers: {
				type: "array",
				items: { type: "string", enum: [...RETAILERS] },
				description: "Subset of retailers to fan across (default: all). Unknown names are ignored.",
			},
			zip: { type: "string", description: "5-digit US ZIP — passed to kroger to resolve a store for prices; ignored by the other retailers." },
			limit: { type: "integer", minimum: 1, maximum: 100, default: 30, description: "Cap on the merged product list." },
			ui: { type: "boolean", default: false, description: "Attach an inline MCP Apps HTML price-comparison dashboard alongside the JSON result." },
		},
	},
	cacheable: true,
	ttl: 300,
	run: async (env: RtEnv, args) => {
		const term = String(args?.term ?? "").trim();
		if (!term) return failWith("bad_input", "term is required.");
		const zip = args?.zip ? String(args.zip).trim() : "";
		const limit = Math.min(100, Math.max(1, Number(args?.limit) || 30));

		// Resolve the retailer subset: an explicit `retailers` list narrows to the known
		// retailers it names (unknowns silently dropped); absent → all of them.
		const requested = Array.isArray(args?.retailers) ? args.retailers.map((r: unknown) => String(r).trim().toLowerCase()) : null;
		const retailers = requested ? RETAILERS.filter((r) => requested.includes(r)) : [...RETAILERS];
		if (retailers.length === 0) return failWith("bad_input", `No known retailers selected. Options: ${RETAILERS.join(", ")}.`);

		// Dynamic import breaks the static cycle (index.ts -> product_search.ts -> index.ts).
		const { FUNCTIONS } = (await import("./index")) as { FUNCTIONS: Fn[] };

		const products: TaggedProduct[] = [];
		const errors: Array<{ retailer: string; error: string }> = [];

		// Each retailer runs in its own settled slot — a rejection or fail result is
		// caught into `errors`, never propagated, so one retailer never sinks the fan-out.
		const settled = await Promise.allSettled(
			retailers.map(async (retailer) => {
				const fn = FUNCTIONS.find((f) => f.name === retailer);
				if (!fn) throw new Error(`retailer fn '${retailer}' not found in registry.`);
				const r = await fn.run(env, argsFor(retailer, term, zip, limit));
				const text = r.content?.[0]?.text ?? "";
				if (r.isError) throw new Error(text || `${retailer} failed.`);
				return { retailer, products: parseProducts(retailer, text) };
			}),
		);

		for (let i = 0; i < settled.length; i++) {
			const retailer = retailers[i];
			const s = settled[i];
			if (s.status === "fulfilled") {
				products.push(...s.value.products);
			} else {
				errors.push({ retailer, error: String(s.reason?.message ?? s.reason) });
			}
		}

		// Tally by_retailer from the post-slice capped list, not the raw per-retailer
		// counts — otherwise a retailer whose products got sliced off still reports
		// its full uncapped count, and by_retailer sums to more than products.length.
		const capped = products.slice(0, limit);
		const by_retailer: Record<string, number> = {};
		for (const p of capped) by_retailer[p.retailer] = (by_retailer[p.retailer] ?? 0) + 1;
		const result: ToolResult = ok(oj({ term, count: capped.length, by_retailer, products: capped, errors }));
		if (args?.ui && (await clientDeclaredUiSupport(env))) return withUiResource(result, "product-search-dashboard", renderProductDashboard(term, capped));
		return result;
	},
};
