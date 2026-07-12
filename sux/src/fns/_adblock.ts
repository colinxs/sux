// Cosmetic ad/annoyance stripping for declutter (Phase 1 — no browser, token win).
//
// Engine: @ghostery/adblocker (pure JS, no WASM — runs on Workers and in node/vitest).
// We keep the SERIALIZED engine blob in R2 (bound as env.R2) and deserialize it
// once per isolate into module scope; a weekly-ish rebuild (staleness-gated, driven
// by the daily cron) refreshes it. Per request we call getCosmeticsFilters(), pull the
// plain CSS selectors out of the returned stylesheet, drop the ones native HTMLRewriter
// can't parse (uBO procedural `:has`/`:xpath`/`+js`, sibling combinators), and DELETE the
// matching DOM with HTMLRewriter before token-pack. NEVER filters our own/trusted domains.

import { FiltersEngine } from "@ghostery/adblocker";
import { parse as parseUrl } from "tldts-experimental";
import type { RtEnv } from "../registry";

// The serialized-engine blob key in the R2 store (`R2` binding, bucket `sux-mcp`).
export const ADBLOCK_R2_KEY = "adblock/engine.bin";
// Rebuild the engine when the stored blob is older than this (≈ weekly refresh,
// ridden on the existing daily cron so no extra Cron Trigger is needed).
export const ADBLOCK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Registrable domains we NEVER cosmetically filter: Claude/Anthropic surfaces
// (incl. the artifact host) and sux's own Worker/site — an adblock false-positive
// on these would corrupt first-party content the user explicitly asked for.
const WHITELIST_DOMAINS = new Set(["anthropic.com", "claude.ai", "claude.com", "claudeusercontent.com", "colinxs.workers.dev", "colinxsummers.com"]);

/** True when `hostname` belongs to a whitelisted first-party domain (never filtered). */
export function isWhitelisted(hostname: string): boolean {
	const { domain } = parseUrl(`https://${hostname}`);
	if (domain && WHITELIST_DOMAINS.has(domain)) return true;
	// Defensive suffix match too (parseUrl can return null for odd hosts).
	return [...WHITELIST_DOMAINS].some((d) => hostname === d || hostname.endsWith(`.${d}`));
}

// getCosmeticsFilters compiles selectors into a stylesheet: `sel1,\nsel2 { display:
// none !important; }` with rule blocks separated by blank lines (see adblocker's
// createStylesheet). Recover the bare selector list by taking each block's prelude
// (everything before ` {`) and splitting on commas.
export function extractSelectors(styles: string): string[] {
	const out: string[] = [];
	for (const block of styles.split("}")) {
		const brace = block.indexOf("{");
		if (brace === -1) continue;
		for (const raw of block.slice(0, brace).split(",")) {
			const sel = raw.trim();
			if (sel) out.push(sel);
		}
	}
	return out;
}

// Native HTMLRewriter supports tag/class/id/attribute selectors, descendant and `>`
// child combinators. It CANNOT parse uBO procedural pseudos (`:has`, `:xpath`,
// `:-abp-…`, `:contains`, `:matches-css`, `:upward`, `:remove`, `:style`, …) — which
// modern adblock lists ship freely now that `:has` is native CSS — nor sibling
// combinators (`+`, `~`). A single unparseable selector makes `.transform()` throw
// and drops the whole page, so pre-filter to the safe subset. Attribute operators
// like `[class~="ad"]` keep their `~`/`+` inside brackets, so only reject a sibling
// combinator when it appears space-delimited between compound selectors.
const UNSAFE_PSEUDO = /:(?:has|xpath|contains|matches-css|matches-media|matches-path|min-text-length|upward|remove|style|nth-ancestor|watch-attr|-abp-|if|if-not)\b|:-abp-/i;
export function htmlRewriterSafe(selector: string): boolean {
	if (!selector) return false;
	if (selector.includes(":has(") || UNSAFE_PSEUDO.test(selector)) return false;
	if (/\s[+~]\s/.test(selector)) return false;
	return true;
}

/** Plain, HTMLRewriter-safe cosmetic selectors for `url` from a loaded engine. */
export function cosmeticSelectors(engine: FiltersEngine, url: string): string[] {
	const { hostname, domain } = parseUrl(url);
	const { styles } = engine.getCosmeticsFilters({
		url,
		hostname: hostname ?? new URL(url).hostname,
		domain: domain ?? undefined,
		getBaseRules: false, // curated per-hostname rules only — the giant generic base list is the false-positive-prone set, and dropping it avoids ever needing the multi-MB raw list on the request path
		getInjectionRules: false, // no scriptlets — Phase 1 is DOM-only
		getExtendedRules: false, // no procedural/extended selectors
		getRulesFromDOM: false, // streaming rewrite — we don't have the class/id set upfront
		getRulesFromHostname: true,
	});
	return extractSelectors(styles).filter(htmlRewriterSafe);
}

// Module-scope engine cache (per isolate). Deserializing the R2 blob costs ~ms and
// pins ~2MB, so do it once and reuse for the isolate's lifetime.
let cached: { engine: FiltersEngine; at: number } | null = null;

/** Test seam: inject (or clear with null) the module-scoped engine. */
export function __setAdblockEngine(engine: FiltersEngine | null): void {
	cached = engine ? { engine, at: Date.now() } : null;
}

// A fresh engine from the ghostery prebuilt full list (EasyList ads + EasyPrivacy
// tracking + Fanboy annoyances). Fetches the prebuilt serialized engine from the
// CDN and falls back to parsing the raw lists — public list downloads, so plain
// global fetch (not the residential proxy). ONLY called off the request path (the
// daily refreshAdblockEngine cron): it resolves to ~14 raw-list HTTP fetches + a
// multi-second parse, which must never run on a caller's response path.
async function buildEngine(): Promise<FiltersEngine> {
	return FiltersEngine.fromPrebuiltFull(fetch);
}

/**
 * The deserialized engine for this isolate, or null if unavailable. Reads the
 * serialized blob from R2 (deserialize is version-checked — a stale-version blob
 * throws). It NEVER builds the engine here: a cold/missing/corrupt blob returns
 * null (declutter simply skips adblock this request) and the daily
 * refreshAdblockEngine cron populates R2 out of band, so the expensive raw-list
 * build can never land on the caller's response path (or blow the CPU limit). All
 * failures degrade to null, logged so a permanently-broken binding isn't silent.
 */
export async function getAdblockEngine(env: RtEnv): Promise<FiltersEngine | null> {
	if (cached && Date.now() - cached.at < ADBLOCK_MAX_AGE_MS) return cached.engine;
	if (!env.R2) return null;
	try {
		const obj = await env.R2.get(ADBLOCK_R2_KEY);
		// Cold / never-primed R2 → skip stripping this request; the cron builds it.
		if (!obj) return null;
		const engine = FiltersEngine.deserialize(new Uint8Array(await obj.arrayBuffer()));
		cached = { engine, at: Date.now() };
		return engine;
	} catch (e) {
		console.warn(`adblock: engine unavailable (R2 error or stale/corrupt blob), skipping cosmetic strip: ${String((e as Error)?.message ?? e)}`);
		return null;
	}
}

/**
 * Rebuild the serialized engine into R2 when missing or older than
 * ADBLOCK_MAX_AGE_MS. Best-effort, idempotent, safe to call every cron tick — it
 * only does network work ≈ weekly. `force` skips the staleness check.
 */
export async function refreshAdblockEngine(env: RtEnv, force = false): Promise<void> {
	if (!env.R2) return;
	if (!force) {
		const uploaded = (await env.R2.head(ADBLOCK_R2_KEY).catch(() => null))?.uploaded;
		if (uploaded && Date.now() - uploaded.getTime() < ADBLOCK_MAX_AGE_MS) return;
	}
	const engine = await buildEngine();
	await env.R2.put(ADBLOCK_R2_KEY, engine.serialize());
	cached = { engine, at: Date.now() };
}

/**
 * Delete ad/tracker/annoyance DOM from `html` for `url` using the engine's cosmetic
 * selectors + native HTMLRewriter (`el.remove()`). Returns `html` unchanged when the
 * host is whitelisted, the engine is unavailable, there are no safe selectors, or
 * HTMLRewriter isn't present (e.g. node/vitest) — a best-effort pre-clean, never a
 * failure path.
 */
export async function stripCosmetic(env: RtEnv, html: string, url: string): Promise<string> {
	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch {
		return html;
	}
	if (isWhitelisted(hostname)) return html;
	if (typeof HTMLRewriter === "undefined") return html;
	const engine = await getAdblockEngine(env);
	if (!engine) return html;
	const selectors = cosmeticSelectors(engine, url);
	if (selectors.length === 0) return html;
	try {
		const rewriter = new HTMLRewriter();
		const handler = {
			element(el: { remove: () => void }) {
				el.remove();
			},
		};
		for (const sel of selectors) rewriter.on(sel, handler);
		return await rewriter.transform(new Response(html)).text();
	} catch (e) {
		// A selector HTMLRewriter rejected despite htmlRewriterSafe would otherwise
		// silently no-op the whole page — log so it's diagnosable, not invisible.
		console.warn(`adblock: HTMLRewriter transform failed for ${url}, returning html unchanged: ${String((e as Error)?.message ?? e)}`);
		return html;
	}
}
