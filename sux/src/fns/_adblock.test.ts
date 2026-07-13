import { FiltersEngine } from "@ghostery/adblocker";
import { afterEach, describe, expect, it, vi } from "vitest";
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
	it("returns curated per-hostname selectors, dropping generic base rules and procedural ones", () => {
		const sels = cosmeticSelectors(engine, "https://www.example.com/article");
		expect(sels).toContain(".sponsored");
		expect(sels).toContain("#promo");
		// generic base rules are excluded (getBaseRules:false) — only per-host curated
		// rules apply, so the site-agnostic `##div[id^="google_ads_"]` must NOT appear.
		expect(sels).not.toContain('div[id^="google_ads_"]');
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
		for (const h of ["claude.ai", "www.claude.ai", "anthropic.com", "api.anthropic.com", "abc.claudeusercontent.com", "sux.colinxs.workers.dev", "suxos.net", "colinxsummers.com"]) {
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
	it("returns null when no R2 is bound — never builds on the request path", async () => {
		// No injected engine, no R2 → null immediately, no network build.
		expect(await getAdblockEngine({} as any)).toBeNull();
	});
	it("returns null on a cold/never-primed R2 WITHOUT building the engine (no request-path fetch)", async () => {
		// R2 present but the blob is missing: getAdblockEngine must NOT fall back to a
		// multi-second raw-list build on the caller's path — it returns null and lets the
		// cron populate R2 out of band. A stubbed fetch proves no build fetch happens.
		let fetched = 0;
		vi.stubGlobal("fetch", vi.fn(async () => {
			fetched++;
			return new Response("", { status: 200 });
		}));
		try {
			const env = { R2: { get: async () => null } } as any;
			expect(await getAdblockEngine(env)).toBeNull();
			expect(fetched).toBe(0);
		} finally {
			vi.unstubAllGlobals();
		}
	});
	it("returns null (not a throw) when the R2 blob is corrupt/unversioned", async () => {
		const env = { R2: { get: async () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }) } } as any;
		expect(await getAdblockEngine(env)).toBeNull();
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
