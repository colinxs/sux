import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { smartFetch } from "../proxy";
import { normalizeMoney, type RetailProduct, type RetailResult } from "./_retail";
import { errMsg } from "./_util";

// Costco sits behind Akamai, but the wall here is JA3/fingerprint-centric rather
// than IP-centric: the residential curl-impersonate path (smartFetch → proxy,
// coherent Chrome TLS/HTTP2) reaches its search HTML where a datacenter fetch is
// blocked. So we force the residential proxy, pull the CatalogSearch results
// page, and extract products out of the HTML — embedded JSON first, product
// tiles as the fallback. Best-effort throughout: parsing never throws, and a
// zero-product result is disambiguated (Akamai block vs. layout change).


/** Absolute costco.com URL from a possibly-relative href. */
function absUrl(href: string): string {
	if (/^https?:\/\//i.test(href)) return href;
	return `https://www.costco.com${href.startsWith("/") ? "" : "/"}${href}`;
}

/** Strip tags/entities to trimmed, whitespace-collapsed text. */
function stripText(html: string): string {
	return html
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
		.replace(/\s+/g, " ")
		.trim();
}

/** First <img src> inside a fragment, if any. */
function firstImgSrc(html: string): string | undefined {
	const m = /<img\b[^>]*\bsrc="([^"]+)"/i.exec(html);
	return m ? m[1] : undefined;
}

/** First <img alt> inside a fragment, if any. */
function firstImgAlt(html: string): string | undefined {
	const m = /<img\b[^>]*\balt="([^"]+)"/i.exec(html);
	return m ? stripText(m[1]) : undefined;
}

/** Pull a price out of a tile slice — prefer Costco's automation-id output. */
function extractPrice(slice: string): number | undefined {
	const m =
		/automation-id="itemPriceOutput[^"]*"[^>]*>\s*\$?\s*([\d.,]+)/i.exec(slice) ??
		/class="[^"]*\bprice\b[^"]*"[^>]*>\s*\$?\s*([\d.,]+)/i.exec(slice) ??
		/\$\s*([\d,]+\.\d{2})/.exec(slice);
	return m ? normalizeMoney(m[1]) : undefined;
}

/**
 * Slice a balanced `[…]` array out of `s` starting at the `[` at index `open`.
 * String- and escape-aware so brackets inside JSON string values don't count.
 * Returns undefined if the array never closes.
 */
function balancedArray(s: string, open: number): string | undefined {
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = open; i < s.length; i++) {
		const c = s[i];
		if (inStr) {
			if (esc) esc = false;
			else if (c === "\\") esc = true;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') inStr = true;
		else if (c === "[") depth++;
		else if (c === "]" && --depth === 0) return s.slice(open, i + 1);
	}
	return undefined;
}

/**
 * Attempt 1: embedded product JSON. Costco seeds the results into a script
 * (adobeProductList / dataLayer). Field names drift, so map defensively and only
 * return when we got at least one titled product; otherwise the caller falls
 * through to tile parsing. The array is captured by balancing brackets rather
 * than a non-greedy regex — real product entries carry nested arrays (images,
 * categories) whose inner `]` would otherwise truncate the match into invalid
 * JSON and silently drop the whole primary extraction path.
 */
function fromEmbeddedJson(html: string): RetailProduct[] {
	const m = /adobeProductList"?\s*[:=]\s*\[/i.exec(html);
	if (!m) return [];
	const open = m.index + m[0].length - 1;
	const raw = balancedArray(html, open);
	if (!raw) return [];
	let arr: any[];
	try {
		arr = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(arr)) return [];
	const products: RetailProduct[] = [];
	for (const p of arr) {
		const id = String(p?.productId ?? p?.id ?? p?.sku ?? "").trim();
		if (!id) continue;
		const title = stripText(String(p?.name ?? p?.productName ?? p?.title ?? ""));
		if (!title) continue;
		products.push({
			id,
			title,
			price: normalizeMoney(p?.salePrice ?? p?.price ?? p?.finalPrice ?? p?.listPrice),
			currency: "USD",
			image: p?.image ?? p?.imageUrl ?? p?.thumbnailUrl,
			url: p?.url ? absUrl(String(p.url)) : `https://www.costco.com/.product.${id}.html`,
		});
	}
	return products;
}

/**
 * Attempt 2: parse product tiles. Costco tiles link out to
 * `<slug>.product.<id>.html` — that anchor (image thumb and/or description link)
 * is the reliable anchor. We collect one entry per product id (page order), then
 * bound a window from each tile's first anchor to the next tile's to scavenge a
 * price and image.
 */
function fromTiles(html: string): RetailProduct[] {
	const anchorRe = /<a\b[^>]*href="([^"]*\.product\.(\d+)\.html[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
	type Entry = { url: string; start: number; title?: string; alt?: string; image?: string };
	const byId = new Map<string, Entry>();
	for (let m = anchorRe.exec(html); m; m = anchorRe.exec(html)) {
		const [, href, id, inner] = m;
		let e = byId.get(id);
		if (!e) {
			e = { url: absUrl(href), start: m.index };
			byId.set(id, e);
		}
		if (!e.title) {
			const t = stripText(inner);
			if (t) e.title = t;
		}
		if (!e.alt) e.alt = firstImgAlt(inner);
		if (!e.image) e.image = firstImgSrc(inner);
	}
	if (!byId.size) return [];
	const starts = [...byId.values()].map((e) => e.start).sort((a, b) => a - b);
	const products: RetailProduct[] = [];
	for (const [id, e] of byId) {
		const nextStart = starts.find((s) => s > e.start) ?? html.length;
		const window = html.slice(e.start, Math.min(nextStart, e.start + 3000));
		const title = e.title ?? e.alt ?? "";
		if (!title) continue;
		products.push({
			id,
			title,
			price: extractPrice(window),
			currency: "USD",
			image: e.image ?? firstImgSrc(window),
			url: e.url,
		});
	}
	return products;
}

/** Extract products from a Costco search page — never throws. */
function extractProducts(html: string): RetailProduct[] {
	try {
		const json = fromEmbeddedJson(html);
		if (json.length) return json;
		return fromTiles(html);
	} catch {
		return [];
	}
}

export const costco: Fn = {
	name: "costco",
	description:
		"Costco product search. Costco is behind Akamai but its wall is JA3/fingerprint-centric, so this fetches the CatalogSearch results HTML through the residential curl-impersonate proxy and extracts normalized products. " +
		"`action`: search (only). Best-effort HTML extraction; if Akamai blocks the page it fails with a hint to try render backend:mac. Returns normalized JSON.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["search"], default: "search" },
			term: { type: "string", description: "Search text." },
			limit: { type: "integer", minimum: 1, maximum: 40, default: 15 },
		},
	},
	cacheable: true,
	ttl: 300,
	run: async (env, args) => {
		const action = String(args?.action ?? "search");
		if (action !== "search") return failWith("bad_input", `costco: unsupported action '${action}'.`);
		const term = String(args?.term ?? "").trim();
		if (!term) return failWith("bad_input", "costco: action=search requires a `term`.");
		const limit = Math.min(40, Math.max(1, Number(args?.limit) || 15));

		const url = `https://www.costco.com/CatalogSearch?keyword=${encodeURIComponent(term)}`;
		let html: string;
		try {
			const resp = await smartFetch(env, url, {}, "proxy");
			html = await resp.text();
		} catch (e) {
			return failWith("upstream_error", `costco: fetch failed — ${errMsg(e)}`);
		}

		const products = extractProducts(html).slice(0, limit);
		if (!products.length) {
			const blocked = /Access Denied|sec-cpt/i.test(html) || html.trim().length < 1000;
			return blocked
				? failWith("blocked", "costco: blocked by Akamai (try render:mac) — no products")
				: failWith("layout_change", "costco: no products extracted (layout change)");
		}

		const result: RetailResult = { retailer: "costco", action: "search", count: products.length, products };
		return ok(JSON.stringify(result, null, 2));
	},
};
