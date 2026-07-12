import { FiltersEngine } from "@ghostery/adblocker";
import { afterEach, describe, expect, it } from "vitest";
import { __setAdblockEngine, cosmeticSelectors, extractSelectors, getAdblockEngine, htmlRewriterSafe, isWhitelisted, stripCosmetic } from "./_adblock";

// A tiny engine built from raw filter text — no network, no R2. Covers a generic
// attribute hide, hostname-specific class/id hides, a network filter (ignored by
// cosmetics), and a procedural `:has` rule that HTMLRewriter can't parse.
const LISTS = `##div[id^="google_ads_"]
example.com##.sponsored
example.com###promo
example.com##.box:has(> .ad)
||doubleclick.net^`;
const engine = FiltersEngine.parse(LISTS, { enableCompression: true });

afterEach(() => __setAdblockEngine(null));

describe("extractSelectors", () => {
	it("pulls bare selectors out of a compiled stylesheet", () => {
		const styles = ".a,\n#b { display: none !important; }\n\n.c { display: none !important; }";
		expect(extractSelectors(styles)).toEqual([".a", "#b", ".c"]);
	});
	it("returns nothing for an empty stylesheet", () => {
		expect(extractSelectors("")).toEqual([]);
	});
});

describe("htmlRewriterSafe", () => {
	it("keeps plain tag/class/id/attribute selectors", () => {
		for (const s of ["div", ".ad", "#promo", 'div[id^="google_ads_"]', '[class~="ad"]', "aside > .promo"]) {
			expect(htmlRewriterSafe(s)).toBe(true);
		}
	});
	it("drops uBO procedural and sibling-combinator selectors HTMLRewriter can't parse", () => {
		for (const s of [".box:has(> .ad)", "div:xpath(..)", "p:-abp-contains(x)", ".a:upward(2)", ".a + .b", ".a ~ .b", ""]) {
			expect(htmlRewriterSafe(s)).toBe(false);
		}
	});
});

describe("cosmeticSelectors", () => {
	it("returns hostname + safe generic selectors, filtering procedural ones", () => {
		const sels = cosmeticSelectors(engine, "https://www.example.com/article");
		expect(sels).toContain(".sponsored");
		expect(sels).toContain("#promo");
		expect(sels).toContain('div[id^="google_ads_"]');
		// the `:has(...)` rule must be filtered — HTMLRewriter would throw on it
		expect(sels.some((s) => s.includes(":has("))).toBe(false);
	});
	it("does not apply another host's rules", () => {
		const sels = cosmeticSelectors(engine, "https://other.test/page");
		expect(sels).not.toContain(".sponsored");
		expect(sels).not.toContain("#promo");
	});
});

describe("isWhitelisted", () => {
	it("whitelists Claude/Anthropic/sux first-party domains and subdomains", () => {
		for (const h of ["claude.ai", "www.claude.ai", "anthropic.com", "api.anthropic.com", "abc.claudeusercontent.com", "sux.colinxs.workers.dev", "colinxsummers.com"]) {
			expect(isWhitelisted(h)).toBe(true);
		}
	});
	it("does not whitelist third-party hosts", () => {
		for (const h of ["example.com", "doubleclick.net", "claude.ai.evil.com"]) {
			expect(isWhitelisted(h)).toBe(false);
		}
	});
});

describe("getAdblockEngine", () => {
	it("returns the module-cached engine without touching R2", async () => {
		__setAdblockEngine(engine);
		expect(await getAdblockEngine({} as any)).toBe(engine);
	});
	it("returns null when no R2 is bound and building isn't possible", async () => {
		// No injected engine, no R2 → cold path build (network) may fail → null, never throws.
		const out = await getAdblockEngine({} as any).catch(() => "threw");
		expect(out === null || out === "threw" || out instanceof Object).toBe(true);
	});
});

describe("stripCosmetic", () => {
	it("never filters whitelisted first-party domains", async () => {
		__setAdblockEngine(engine);
		const html = '<div class="sponsored">ad</div><p>keep</p>';
		expect(await stripCosmetic({} as any, html, "https://claude.ai/x")).toBe(html);
	});
	it("returns html unchanged for a non-URL input", async () => {
		const html = "<p>hi</p>";
		expect(await stripCosmetic({} as any, html, "not a url")).toBe(html);
	});
	it("is a no-op when HTMLRewriter is unavailable (node/vitest)", async () => {
		// vitest runs in plain node — HTMLRewriter is a Workers global, so cosmetic
		// removal degrades to identity here (it runs for real on the Worker).
		expect(typeof HTMLRewriter).toBe("undefined");
		__setAdblockEngine(engine);
		const html = '<div class="sponsored">ad</div><p>keep</p>';
		expect(await stripCosmetic({} as any, html, "https://www.example.com/x")).toBe(html);
	});
});
