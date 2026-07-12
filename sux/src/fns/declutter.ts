import { type Fn, fail, ok } from "../registry";
import { loadHtml, stripHtml } from "./_util";

// uBlock-style HTML cleaning: strip scripts/styles/iframes/ads/tracking pixels
// and inline event handlers so downstream tools (summarize, readability, markdown)
// see content, not clutter. Regex-based and dependency-free — best-effort: full
// CSS-selector element hiding would need a DOM parser (see PLAN). Composes:
// declutter -> summarize.

// Known ad/tracker/consent markers in class/id — used to drop simple wrapper blocks.
const CLUTTER = "ad|ads|advert|adslot|banner|sponsor|promo|popup|modal|overlay|interstitial|cookie|consent|gdpr|newsletter|subscribe|signup|paywall|social-share|sharethis|addthis|share-bar|related-posts|recommended|taboola|outbrain|disqus|comments?";

function clean(html: string): string {
	let s = html
		// Comments + conditional comments.
		.replace(/<!--[\s\S]*?-->/g, "")
		// Whole clutter/inactive elements.
		.replace(/<(script|style|noscript|template|svg|iframe|form|object|embed|link|meta)\b[\s\S]*?<\/\1>/gi, "")
		// Self-closing / void variants of the above that have no closing tag.
		.replace(/<(?:link|meta|input|source)\b[^>]*>/gi, "")
		// Google/Amazon ad containers.
		.replace(/<ins\b[^>]*adsbygoogle[\s\S]*?<\/ins>/gi, "")
		// 1x1 / tracking pixels — isolate each tag first (single bounded scan) then
		// test its attrs, so adversarial input can't trigger regex backtracking.
		.replace(/<img\b[^>]*>/gi, (tag) => ((tag.match(/\b(?:width|height)=["']?1["']?/gi)?.length ?? 0) >= 2 ? "" : tag))
		.replace(/<img\b[^>]*\bsrc=["'][^"']*(?:doubleclick|googlesyndication|google-analytics|googletagmanager|scorecardresearch|quantserve|facebook\.com\/tr|pixel)[^"']*["'][^>]*>/gi, "");
	// Simple, non-nested wrapper blocks whose class/id looks like clutter.
	const wrapper = new RegExp(`<(div|section|aside|ul|ins|span)\\b[^>]*\\b(?:class|id)=["'][^"']*\\b(?:${CLUTTER})\\b[^"']*["'][^>]*>(?:(?!<\\1\\b)[\\s\\S])*?<\\/\\1>`, "gi");
	for (let i = 0; i < 3; i++) s = s.replace(wrapper, ""); // a few passes for adjacent blocks
	// Strip inline event handlers + common tracking attributes.
	s = s
		.replace(/\son\w+=("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
		.replace(/\s(?:data-(?:track|ga|gtm|analytics|ad)[\w-]*)=("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
	// Collapse the whitespace left behind.
	return s.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

export const declutter: Fn = {
	name: "declutter",
	description:
		"Clean HTML uBlock-style before further processing: removes scripts, styles, iframes, ad/consent/newsletter/social/comment blocks, tracking pixels, and inline event handlers. Pass `url` or `html`; `to`: html (default) | text. Set `adblock:true` (requires `url`) to additionally delete ad/tracker/annoyance DOM via the EasyList+EasyPrivacy cosmetic engine (never touches Claude/Anthropic/sux domains). Best-effort regex cleaning (no DOM). Compose before summarize/readability/markdown for cleaner output.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			url: { type: "string", description: "URL to fetch (via proxy) and clean." },
			html: { type: "string", description: "Raw HTML to clean." },
			to: { type: "string", enum: ["html", "text"], default: "html", description: "Return cleaned HTML or stripped plain text." },
			adblock: { type: "boolean", default: false, description: "Opt-in: also strip ad/tracker/annoyance DOM using the cosmetic filter engine (needs `url` for the hostname; whitelists first-party domains)." },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const loaded = await loadHtml(env, args);
		if ("error" in loaded) return fail(loaded.error);
		try {
			let html = loaded.html;
			// Adblock is opt-in and URL-scoped: the cosmetic engine keys on the page's
			// hostname, so an inline-`html` call (no url) has nothing to key on and skips.
			if (args?.adblock && typeof args?.url === "string" && args.url) {
				const { stripCosmetic } = await import("./_adblock");
				html = await stripCosmetic(env, html, args.url);
			}
			const cleaned = clean(html);
			return ok(args?.to === "text" ? stripHtml(cleaned) : cleaned);
		} catch (e) {
			return fail(`declutter failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
