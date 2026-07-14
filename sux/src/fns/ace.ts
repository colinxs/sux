import { looksBlocked, retailRender } from "../retail-render";
import { oj } from "./_util";
import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { decodeEntities, normalizeMoney, type RetailProduct } from "./_retail";

// Ace Hardware runs on the Kibo/Mozu commerce platform and exposes no public
// product API, so this fn renders Ace's search page through `retailRender` and lifts
// products out of the rendered HTML. Ace runs an INVISIBLE reCAPTCHA v3 in the
// background that scores the session but does NOT wall the page, so we never force a
// solve — the render backend auto-escalates only if a real captcha wall ever appears.
// Rendering defaults to Cloudflare Browser Run (residential + stealth); the mac
// render backend (a residential patched browser) is the dormant fallback for when cf
// can't clear a wall. Extraction is best-effort from the rendered DOM: each result is
// a `mz-productlisting` tile with a `/p/<slug>/<sku>` anchor. Every step
// guards/try-catches — never throws.

const NO_PRODUCTS_MSG = "ace: no products extracted (layout change).";

/**
 * Parse product tiles from the rendered DOM. Ace renders each search result as a
 * listing tile whose class contains `mz-productlisting`, wrapping an anchor to
 * `/p/<slug>/<sku>`. Split on that tile marker so each chunk is roughly one tile;
 * the anchor + fields we want live within that chunk (resilient to attribute
 * reordering). Best-effort and fully guarded — pull the href, a title (img alt or
 * nearby anchor/heading text), a $-price, and the first CDN image. Returns whatever
 * parses, deduped by id.
 */
function fromTiles(html: string): RetailProduct[] {
	const out: RetailProduct[] = [];
	const seen = new Set<string>();
	// Split on the tile marker; the first chunk is everything before the first tile.
	const chunks = html.split(/mz-productlisting/i).slice(1);
	for (const chunk of chunks) {
		try {
			// The product detail link: /p/<slug>/<sku>. Take the first /p/ anchor in the
			// tile window.
			const href = chunk.match(/href="(\/p\/[^"]+)"/i);
			if (!href) continue;
			const path = href[1];
			// Derive an id from the href: prefer a numeric sku (the last digit-run in the
			// path, e.g. the trailing `/p/<slug>/<sku>` segment), else fall back to the
			// last path segment (the slug) so every tile still gets a stable id.
			const segments = path.split("/").filter(Boolean);
			const last = segments[segments.length - 1] ?? "";
			const skuMatch = path.match(/(\d{4,})(?:[^\d]*)?$/);
			const id = skuMatch?.[1] ?? last;
			if (!id || seen.has(id)) continue;
			seen.add(id);
			const url = new URL(path, "https://www.acehardware.com").href;
			// Title: prefer an img alt on the tile, else nearby anchor/heading text.
			const alt = chunk.match(/alt="([^"]{3,})"/i);
			const anchorText = chunk.match(/<a[^>]*href="\/p\/[^"]+"[^>]*>([\s\S]*?)<\/a>/i);
			const heading = chunk.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
			const rawTitle =
				alt?.[1] ??
				(anchorText?.[1] ? anchorText[1].replace(/<[^>]+>/g, " ") : undefined) ??
				(heading?.[1] ? heading[1].replace(/<[^>]+>/g, " ") : undefined);
			// Price: strip tags first (Ace may split markup around the amount), then grab
			// the first $-amount from the resulting text.
			const price = chunk.replace(/<[^>]+>/g, "").match(/\$\s*([0-9][0-9,]*(?:\.[0-9]{2})?)/);
			// Image: first https img src on the tile (Ace CDN / images).
			const img = chunk.match(/src="(https:\/\/[^"]+)"/i);
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

// Zero-products block/layout-change disambiguation delegates to retail-render's
// canonical looksBlocked (opted into its byte-length check — a tiny body at this
// point, after extraction already found nothing, is a strong wall/empty-shell
// signal). NOTE: "recaptcha" alone is NOT a block marker — Ace runs an invisible
// reCAPTCHA v3 in the background that scores but never walls the page.

export const ace: Fn = {
	name: "ace",
	cost: 5,
	description:
		"Ace Hardware product search via a rendered browser (Ace has no public product API, runs on Kibo/Mozu with an invisible reCAPTCHA v3, and a plain fetch returns no grid). Renders through Cloudflare Browser Run (residential + stealth) by default, falling back to the mac render backend (a residential patched browser) when cf can't clear a wall. " +
		"`action`: search (products for a `term`). Extraction is best-effort from the rendered `mz-productlisting` tiles, normalized to the shared retail shape (id/title/price/image/url). " +
		"`limit` caps results (default 15, max 40). Slower than an API.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["search"], default: "search", description: "search (by term)." },
			term: { type: "string", description: "Search text." },
			limit: { type: "integer", minimum: 1, maximum: 40, default: 15, description: "Max results." },
		},
	},
	cacheable: true,
	ttl: 300,
	run: async (env: RtEnv, args) => {
		const term = String(args?.term ?? "").trim();
		if (!term) return failWith("bad_input", "action=search requires a `term`.");
		const limit = Math.min(40, Math.max(1, Number(args?.limit) || 15));

		const r = await retailRender(env, {
			url: `https://www.acehardware.com/search?query=${encodeURIComponent(term)}`,
			block_resources: true,
			wait_until: "networkidle2",
			wait_ms: 6000,
			timeout_ms: 55000,
		});
		if (!r.ok) return failWith("blocked", `ace: blocked or render failed — ${r.error}`);

		let products = fromTiles(r.body);
		products = products.filter((p) => p.id && p.title).slice(0, limit);
		if (products.length === 0) {
			// No products: decide block vs. layout change so the caller gets a real hint.
			if (looksBlocked(r.body, 1000)) return failWith("blocked", "ace: blocked (challenge wall or access denied).");
			return failWith("layout_change", NO_PRODUCTS_MSG);
		}
		return ok(oj({ retailer: "ace", action: "search", count: products.length, products }));
	},
};
