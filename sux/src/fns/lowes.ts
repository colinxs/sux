import { retailRender } from "../retail-render";
import { oj } from "./_util";
import { type Fn, fail, ok, type RtEnv } from "../registry";
import { normalizeMoney, type RetailProduct } from "./_retail";

// Lowe's has no public product API and serves its catalog from a client-side React
// app, so a plain fetch returns a shell with no products. This fn renders Lowe's
// search page through `retailRender` and lifts products out of the rendered HTML.
// Rendering defaults to Cloudflare Browser Rendering (residential + stealth); the mac
// render backend (a residential patched browser) is the dormant fallback for when cf
// can't clear a wall. Lowe's renders fine without a captcha; the backend
// auto-escalates its solver only if a wall appears, so we do NOT force-solve.
// Extraction is best-effort and two-tier: prefer an embedded state blob when present,
// else parse the `/pd/…` product anchors. Every step guards/try-catches — never
// throws.

const NO_PRODUCTS_MSG = "lowes: no products extracted (layout change).";
// Emitted instead of the layout-change message when the rendered page looks like a
// bot wall or an empty shell — signals the caller to retry or adjust the backend.
const BLOCKED_MSG = "lowes: no products — page looks blocked or empty (try again or a different render/backend).";

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

/**
 * Detect an obviously-unusable render: a bot wall ("Access Denied" / an Akamai
 * "Reference #" error / an "unusual traffic" interstitial) or a near-empty shell
 * (< 1000 bytes). Returns true so the caller can emit the blocked hint instead of
 * the generic layout-change message.
 */
function looksBlocked(body: string): boolean {
	return body.length < 1000 || /Access Denied|Reference #|unusual traffic/i.test(body);
}

/**
 * Try an embedded state blob first: Lowe's inlines product records inside `<script>`
 * state blobs. The field names drift across deploys, so rather than bind to one
 * global we scan for `"productId"` anchors and lift the description/brand/price/image
 * from a small window around each. Conservative — a match must yield at least a title
 * to count, so a weak/irrelevant blob returns [] and the caller falls back to the DOM
 * anchor parse (the reliable path). Fully guarded.
 */
function fromStateBlob(html: string): RetailProduct[] {
	const out: RetailProduct[] = [];
	const seen = new Set<string>();
	const re = /"productId"\s*:\s*"?(\d{6,})"?/g;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom.
	while ((m = re.exec(html)) !== null) {
		try {
			const id = m[1];
			if (seen.has(id)) continue;
			// A window around the productId occurrence holds the sibling fields; field
			// names vary, so accept the first of several likely keys for each.
			const start = Math.max(0, m.index - 700);
			const win = html.slice(start, m.index + 700);
			const title = win.match(/"(?:description|productLabel|title|name)"\s*:\s*"([^"]{3,})"/i);
			if (!title) continue; // too little signal — let the DOM parse handle this one.
			const brand = win.match(/"(?:brand|brandName)"\s*:\s*"([^"]{1,})"/i);
			// Price keys are ordered specific→generic. Prefer an unambiguous price key
			// (sellingPrice/finalPrice); only fall back to the bare "price" key when no
			// specific one sits in the window. The generic "value" key is intentionally
			// NOT accepted — it also names rating/review/aisle fields in the same ±700-char
			// window, so it would bind the price to an unrelated number (e.g. a star rating).
			const price =
				win.match(/"(?:sellingPrice|finalPrice)"\s*:\s*"?([0-9][0-9,]*(?:\.[0-9]{1,2})?)"?/i) ??
				win.match(/"price"\s*:\s*"?([0-9][0-9,]*(?:\.[0-9]{1,2})?)"?/i);
			const image = win.match(/"(https:\/\/(?:mobileimages|images)\.lowes\.com\/[^"]+)"/i);
			seen.add(id);
			out.push({
				id,
				title: decodeEntities(title[1]),
				brand: brand?.[1] ? decodeEntities(brand[1]) : undefined,
				price: normalizeMoney(price?.[1]),
				currency: "USD",
				image: image?.[1],
				url: `https://www.lowes.com/pd/-/${id}`,
			} as RetailProduct);
		} catch {
			// One malformed record never aborts the whole parse.
		}
	}
	return out;
}

/**
 * Fallback: parse product tiles from the rendered DOM. Lowe's links each result to
 * `/pd/<slug>/<productId>`, where productId is a long numeric id. We walk those
 * anchors and, from a window around each, pull the title (img alt / nearby heading),
 * a price, and an image. Best-effort and fully guarded — returns whatever parses.
 */
function fromAnchors(html: string): RetailProduct[] {
	const out: RetailProduct[] = [];
	const seen = new Set<string>();
	const re = /href="(\/pd\/[^"]*?\/(\d{6,})[^"]*)"/gi;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom.
	while ((m = re.exec(html)) !== null) {
		try {
			const href = m[1];
			const id = m[2];
			if (seen.has(id)) continue;
			seen.add(id);
			const url = new URL(href, "https://www.lowes.com").href;
			// The title/price/image all follow the anchor, so the window starts AT the
			// anchor (a lead-in would bleed into the previous tile) and runs forward far
			// enough to cover one tile. First-match wins, so we get this tile's own fields.
			const win = html.slice(m.index, m.index + 1200);
			// Title: prefer the img alt (Lowe's sets it to the product name), else a
			// nearby heading's text.
			const alt = win.match(/alt="([^"]{3,})"/i);
			const header = win.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
			const rawTitle = alt?.[1] ?? (header?.[1] ? header[1].replace(/<[^>]+>/g, " ") : undefined);
			// Price: Lowe's splits dollars/cents across sibling spans like Home Depot
			// (e.g. `$<span>79</span><span>.00</span>`), so strip tags first, then grab the
			// first $-amount from the resulting text.
			const price = win.replace(/<[^>]+>/g, "").match(/\$\s*([0-9][0-9,]*(?:\.[0-9]{2})?)/);
			// Image: first Lowe's product image src in the window.
			const img = win.match(/src="(https:\/\/(?:mobileimages|images)\.lowes\.com\/[^"]+)"/i);
			out.push({
				id,
				title: rawTitle ? decodeEntities(rawTitle.replace(/\s+/g, " ")) : undefined,
				price: normalizeMoney(price?.[1]),
				currency: "USD",
				image: img?.[1],
				url,
			} as RetailProduct);
		} catch {
			// One malformed tile never aborts the whole parse.
		}
	}
	return out;
}

/**
 * action=product: extract a single product from a rendered `/pd/-/<item_id>` page.
 * Product detail markup is less predictable than a search tile, so this is
 * deliberately shallow and guarded: title from og:title / `<title>`, price from the
 * first $-amount, image from a Lowe's image url. Returns [] when nothing usable
 * parses so the caller can distinguish "blocked" from "layout change".
 */
function fromProductPage(html: string, itemId: string): RetailProduct[] {
	try {
		const og = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
		const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);
		const rawTitle = og?.[1] ?? titleTag?.[1];
		const price = html.replace(/<[^>]+>/g, " ").match(/\$\s*([0-9][0-9,]*(?:\.[0-9]{2})?)/);
		const img = html.match(/"(https:\/\/(?:mobileimages|images)\.lowes\.com\/[^"]+)"/i);
		if (!rawTitle && !price) return [];
		return [
			{
				id: itemId,
				title: rawTitle ? decodeEntities(rawTitle.replace(/\s+/g, " ")) : undefined,
				price: normalizeMoney(price?.[1]),
				currency: "USD",
				image: img?.[1],
				url: `https://www.lowes.com/pd/-/${itemId}`,
			} as RetailProduct,
		];
	} catch {
		return [];
	}
}

export const lowes: Fn = {
	name: "lowes",
	cost: 5,
	description:
		"Lowe's product lookup via a rendered browser (Lowe's has no public product API and serves a client-side React catalog a plain fetch returns empty). Renders through Cloudflare Browser Rendering (residential + stealth) by default, falling back to the mac render backend (a residential patched browser) when cf can't clear a wall. " +
		"`action`: search (products for a `term`) or product (a single item by `item_id`). Extraction is best-effort from the rendered page (embedded state blob when present, else `/pd/…` product tiles), normalized to the shared retail shape (id/title/price/image/url). " +
		"`limit` caps results (default 15, max 40). Slower than an API.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["search", "product"], default: "search", description: "search (by term) or product (by item_id)." },
			term: { type: "string", description: "Search text (action=search)." },
			item_id: { type: "string", description: "Lowe's product/item id (action=product)." },
			limit: { type: "integer", minimum: 1, maximum: 40, default: 15, description: "Max results." },
		},
	},
	cacheable: true,
	ttl: 300,
	run: async (env: RtEnv, args) => {
		const action = String(args?.action ?? "search");
		const limit = Math.min(40, Math.max(1, Number(args?.limit) || 15));

		if (action === "product") {
			const itemId = String(args?.item_id ?? "").trim();
			if (!itemId) return fail("action=product requires an `item_id`.");
			const r = await retailRender(env, {
				url: `https://www.lowes.com/pd/-/${encodeURIComponent(itemId)}`,
				block_resources: true,
				wait_until: "networkidle2",
				wait_ms: 6000,
				timeout_ms: 55000,
			});
			if (!r.ok) return fail(`lowes: blocked or render failed — ${r.error}`);
			// A product must at least carry a title or a price to be worth returning.
			const products = fromProductPage(r.body, itemId).filter((p) => p.id && (p.title || p.price)).slice(0, limit);
			if (products.length === 0) return fail(looksBlocked(r.body) ? BLOCKED_MSG : NO_PRODUCTS_MSG);
			return ok(oj({ retailer: "lowes", action, count: products.length, products }));
		}

		// Default: search.
		const term = String(args?.term ?? "").trim();
		if (!term) return fail("action=search requires a `term`.");

		const r = await retailRender(env, {
			url: `https://www.lowes.com/search?searchTerm=${encodeURIComponent(term)}`,
			block_resources: true,
			wait_until: "networkidle2",
			wait_ms: 6000,
			timeout_ms: 55000,
		});
		if (!r.ok) return fail(`lowes: blocked or render failed — ${r.error}`);

		// Prefer an embedded state blob (richer), fall back to DOM anchor parsing.
		let products = fromStateBlob(r.body);
		if (products.length === 0) products = fromAnchors(r.body);
		products = products.filter((p) => p.id && p.title).slice(0, limit);
		if (products.length === 0) return fail(looksBlocked(r.body) ? BLOCKED_MSG : NO_PRODUCTS_MSG);
		return ok(oj({ retailer: "lowes", action: "search", count: products.length, products }));
	},
};
