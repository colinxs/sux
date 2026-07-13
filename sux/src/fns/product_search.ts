import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { oj } from "./_util";
import type { RetailProduct } from "./_retail";

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
const RETAILERS = ["kroger", "walmart", "homedepot", "amazon", "lowes", "costco", "ace"] as const;

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

export const product_search: Fn = {
	name: "product_search",
	cost: 5,
	description:
		"Multi-retailer product search — fan one `term` across the retailer fns (kroger, walmart, homedepot, amazon, lowes, costco, ace) concurrently and merge their results into one normalized product list. " +
		"`retailers` (optional) narrows the fan-out to a subset; `zip` is passed through to kroger (for store prices); `limit` caps the merged list (default 30). " +
		"Per-retailer failure is isolated — a retailer that errors, is unconfigured, or is blocked lands in `errors` and never aborts the rest. " +
		"Returns JSON { term, count, by_retailer:{ retailer:n }, products:[{ …product, retailer }], errors:[{ retailer, error }] }.",
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
		const by_retailer: Record<string, number> = {};
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
				by_retailer[retailer] = s.value.products.length;
			} else {
				errors.push({ retailer, error: String(s.reason?.message ?? s.reason) });
			}
		}

		const capped = products.slice(0, limit);
		return ok(oj({ term, count: capped.length, by_retailer, products: capped, errors }));
	},
};
