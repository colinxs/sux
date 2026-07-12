import { type Fn, fail, ok } from "../registry";
import { oj } from "./_util";
import { normalizeMoney, type RetailProduct } from "./_retail";

// Flipp (backflipp.wishabi.com) — keyless, free backend powering the Flipp
// grocery-flyer app. No residential proxy: a public items-search endpoint with no
// bot wall. One action: search a zip's live weekly-ad deals by term across every
// merchant Flipp indexes there. Flipp carries the big grocery banners — Safeway,
// Albertsons, Fred Meyer, Kroger, and their siblings — but NOT WinCo (WinCo runs
// no weekly-ad flyer, so it never appears). Deals rotate weekly, so a modest ttl.

const API = "https://backflipp.wishabi.com/flipp/items/search";

/** One normalized weekly-ad deal — a RetailProduct plus the flyer-specific fields. */
type WeeklyAdItem = RetailProduct & {
	original_price?: number;
	merchant?: string;
	merchant_logo?: string;
	valid_to?: string;
};

/**
 * Normalize a Flipp item into our common product shape. id is the flyer_item_id
 * (stringified), title is the item name, price is the (sale) current_price; the
 * pre-sale original_price, merchant, its logo, and the deal's valid_to ride along.
 */
function normItem(it: any): WeeklyAdItem {
	return {
		id: String(it?.flyer_item_id ?? ""),
		title: it?.name ?? "",
		price: normalizeMoney(it?.current_price),
		original_price: normalizeMoney(it?.original_price),
		currency: "USD",
		merchant: it?.merchant_name ?? undefined,
		merchant_logo: it?.merchant_logo ?? undefined,
		valid_to: it?.valid_to ?? undefined,
	};
}

export const weekly_ad: Fn = {
	name: "weekly_ad",
	description:
		"Grocery weekly-ad deals via Flipp (keyless, free) — searches a ZIP's live flyer items by `term` across every merchant Flipp indexes there. " +
		"Flipp carries the big grocery banners (Safeway, Albertsons, Fred Meyer, Kroger and siblings) but NOT WinCo (WinCo runs no flyer). " +
		"`term` and 5-digit `zip` required; `merchant` filters by case-insensitive substring on the merchant name; `limit` 1..50 (default 20). " +
		"Returns JSON { source:'flipp', term, zip, count, items:[{ id, title, price, original_price, currency, merchant, merchant_logo, valid_to }] }.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["term", "zip"],
		properties: {
			term: { type: "string", description: "Deal search text, e.g. 'chicken' or 'coca cola'." },
			zip: { type: "string", pattern: "^\\d{5}$", description: "5-digit US ZIP code." },
			merchant: { type: "string", description: "Case-insensitive substring filter on merchant_name, e.g. 'safeway'." },
			limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
		},
	},
	cacheable: true,
	ttl: 3600,
	run: async (_env, args) => {
		const term = String(args?.term ?? "").trim();
		if (!term) return fail("term is required.");
		const zip = String(args?.zip ?? "").trim();
		if (!/^\d{5}$/.test(zip)) return fail("zip is required (5 digits).");
		const merchant = args?.merchant ? String(args.merchant).trim().toLowerCase() : "";
		const limit = Math.min(50, Math.max(1, Number(args?.limit) || 20));

		const p = new URLSearchParams({ locale: "en-us", postal_code: zip, q: term });
		let resp: Response;
		try {
			resp = await fetch(`${API}?${p}`, { headers: { Accept: "application/json" } });
		} catch (e) {
			return fail(`Flipp fetch failed: ${String((e as Error)?.message ?? e)}`);
		}
		if (!resp.ok) return fail(`Flipp API HTTP ${resp.status}.`);
		const j: any = await resp.json();

		let items = (Array.isArray(j?.items) ? j.items : []).map(normItem);
		if (merchant) items = items.filter((it: WeeklyAdItem) => (it.merchant ?? "").toLowerCase().includes(merchant));
		items = items.slice(0, limit);

		return ok(oj({ source: "flipp", term, zip, count: items.length, items }));
	},
};
