import { macRender } from "../mac-render";
import { type Fn, fail, ok, type RtEnv } from "../registry";
import { normalizeMoney, type RetailProduct } from "./_retail";

// Amazon has NO usable free API (the Product Advertising API needs affiliate
// approval), so this fn is render-based exactly like homedepot: the mac render
// backend (a residential patched browser) fetches Amazon's search or product
// page — passing the active bot wall a plain fetch can't — and we lift products
// out of the rendered HTML. The service auto-escalates to the headed CapSolver
// solver when it sees a captcha, so we never force `solve`. Extraction is
// best-effort and every tile is parsed in its own try/catch — one bad tile never
// aborts the whole parse.

const NO_PRODUCTS_MSG = "amazon: no products extracted (layout change).";
// Markers Amazon serves on its bot wall / captcha interstitial. If the render
// came back with zero products AND any of these are present, the request was
// challenged rather than merely mis-parsed — report that distinctly.
const CHALLENGE_MARKERS = ["Robot Check", "Enter the characters you see", "api-services-support"];

/** Decode HTML entities that show up in extracted title text (best-effort). */
function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&#38;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#34;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.trim();
}

/** A valid ASIN is exactly 10 uppercase-alphanumeric chars (Amazon's product id). */
function isAsin(s: string | undefined): s is string {
	return !!s && /^[A-Z0-9]{10}$/.test(s);
}

/**
 * Parse the search-results grid. Amazon renders each result as a container
 * `<div data-component-type="s-search-result" data-asin="B0XXXXXXXX" ...>`, so we
 * split the HTML on that marker (like homedepot's split on product-pod) — each
 * chunk is roughly one tile and the fields we want live within it. Resilient to
 * attribute reordering; dedups by asin. Returns whatever parses.
 */
function fromSearch(html: string): RetailProduct[] {
	const out: RetailProduct[] = [];
	const seen = new Set<string>();
	const chunks = html.split(/data-component-type="s-search-result"/i).slice(1);
	for (const chunk of chunks) {
		try {
			// The `data-asin` attribute may sit before or after the split marker on the
			// same tag; grab the first ASIN-shaped value in this chunk's opening region.
			const asinMatch = chunk.match(/data-asin="([A-Z0-9]{10})"/i);
			const asin = asinMatch?.[1]?.toUpperCase();
			if (!isAsin(asin)) continue; // Skip empty/placeholder data-asin tiles.
			if (seen.has(asin)) continue;
			seen.add(asin);
			// Title: first `<h2 ...>...</h2>` inner text on the tile, tags stripped
			// (an <a> often wraps or nests inside the h2).
			const h2 = chunk.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
			const rawTitle = h2?.[1] ? h2[1].replace(/<[^>]+>/g, " ") : undefined;
			// Price: the first `a-offscreen` $-amount in the tile (Amazon mirrors the
			// visible split-span price into a screen-reader `a-offscreen` span).
			const price = chunk.match(/class="a-offscreen"[^>]*>\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]{2})?)/i);
			// Image: the `s-image` product thumbnail src.
			const img = chunk.match(/class="s-image"[^>]*\ssrc="([^"]+)"/i);
			out.push({
				id: asin,
				title: rawTitle ? decodeEntities(rawTitle.replace(/\s+/g, " ")) : undefined,
				price: normalizeMoney(price?.[1]),
				currency: "USD",
				image: img?.[1],
				url: `https://www.amazon.com/dp/${asin}`,
			} as RetailProduct);
		} catch {
			// One malformed tile never aborts the whole parse.
		}
	}
	return out;
}

/**
 * Parse a single product-detail page (action=product). Amazon exposes the fields
 * at stable ids: `#productTitle`, the first `.a-offscreen` $-amount, the
 * `#landingImage`/`#imgBlkFront` src, and the `#bylineInfo` brand link. Fully
 * guarded — returns [] if nothing recognizable parses.
 */
function fromProduct(html: string, asin: string): RetailProduct[] {
	try {
		const title = html.match(/id="productTitle"[^>]*>([\s\S]*?)<\//i);
		const price = html.match(/class="a-offscreen"[^>]*>\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]{2})?)/i);
		// Image: prefer the main landing image, fall back to the book-style front image.
		const img =
			html.match(/id="landingImage"[^>]*\ssrc="([^"]+)"/i) ?? html.match(/id="imgBlkFront"[^>]*\ssrc="([^"]+)"/i);
		// Brand: the `#bylineInfo` byline link text ("Visit the ACME Store" / "Brand: ACME").
		const byline = html.match(/id="bylineInfo"[^>]*>([\s\S]*?)<\//i);
		const rawBrand = byline?.[1]
			? byline[1]
					.replace(/<[^>]+>/g, " ")
					.replace(/\b(Visit the|Store|Brand:)\b/gi, " ")
					.replace(/\s+/g, " ")
					.trim()
			: undefined;
		const rawTitle = title?.[1] ? title[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") : undefined;
		if (!rawTitle && !price && !img) return []; // Nothing recognizable — treat as no product.
		return [
			{
				id: asin,
				title: rawTitle ? decodeEntities(rawTitle) : undefined,
				brand: rawBrand ? decodeEntities(rawBrand) : undefined,
				price: normalizeMoney(price?.[1]),
				currency: "USD",
				image: img?.[1],
				url: `https://www.amazon.com/dp/${asin}`,
			} as RetailProduct,
		];
	} catch {
		return [];
	}
}

export const amazon: Fn = {
	name: "amazon",
	cost: 5,
	description:
		"Amazon product search / product-detail via the mac render backend (a residential patched browser that renders Amazon's page — Amazon has no usable free API and walls plain fetches; the backend auto-escalates to a captcha solver when challenged). " +
		"`action`: search (products for a `term`) or product (one product by `asin`). Extraction is best-effort from the rendered page, normalized to the shared retail shape (id=ASIN/title/price/image/url; brand for product). " +
		"`limit` caps search results (default 15, max 40). Slower than an API and dependent on the mac render backend being up.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["search", "product"], default: "search", description: "search (by term) or product (by asin)." },
			term: { type: "string", description: "Search text (action=search)." },
			asin: { type: "string", description: "10-char Amazon ASIN (action=product)." },
			limit: { type: "integer", minimum: 1, maximum: 40, default: 15, description: "Max search results." },
		},
	},
	cacheable: true,
	ttl: 300,
	run: async (env: RtEnv, args) => {
		const action = String(args?.action ?? "search").trim() || "search";

		// Resolve the target URL and (for product) validate the ASIN up front.
		let url: string;
		let asin = "";
		if (action === "product") {
			asin = String(args?.asin ?? "").trim().toUpperCase();
			if (!isAsin(asin)) return fail("action=product requires a valid 10-char `asin`.");
			url = `https://www.amazon.com/dp/${asin}`;
		} else {
			const term = String(args?.term ?? "").trim();
			if (!term) return fail("action=search requires a `term`.");
			url = `https://www.amazon.com/s?k=${encodeURIComponent(term)}`;
		}
		const limit = Math.min(40, Math.max(1, Number(args?.limit) || 15));

		const r = await macRender(env, {
			url,
			as: "html",
			block_resources: true,
			wait_until: "networkidle2",
			wait_ms: 6000,
			timeout_ms: 55000,
		});
		if (!r.ok) return fail(`amazon: blocked or render failed — ${r.error}`);

		let products = action === "product" ? fromProduct(r.body, asin) : fromSearch(r.body);
		products = products.filter((p) => p.id && p.title).slice(0, limit);

		if (products.length === 0) {
			// Distinguish an active bot challenge from a plain layout change: if Amazon
			// served its captcha/robot interstitial, say so — otherwise it parsed clean
			// but the layout changed.
			if (CHALLENGE_MARKERS.some((m) => r.body.includes(m))) {
				return fail("amazon: Amazon challenged the request (Robot Check / captcha) — try again or narrow the query.");
			}
			return fail(NO_PRODUCTS_MSG);
		}
		return ok(JSON.stringify({ retailer: "amazon", action, count: products.length, products }, null, 2));
	},
};
