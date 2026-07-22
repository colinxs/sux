// Importance ranking for sux functions (Bosman-set). Drives BOTH the MCP
// tools/list order (gen-index) and the docs order (gen-docs): most-important
// tools surface first, which helps agent attention and token budgeting.
// Unranked functions fall to the end, alphabetically. Optimize in this order.
export const IMPORTANCE = [
	// Tier 0 — flagship core: transport + search + primary parse/distill
	"search", "scrape", "render", "proxy", "extract", "readability", "summarize",
	// Tier 1 — token-economy primitives (compose in front of everything)
	"grep", "select", "pack", "compress", "declutter",
	// Tier 2 — high-value transforms + batching
	"batch", "batch_fetch", "metadata", "tables", "markdown", "html", "csv", "json", "xml", "yaml", "archive", "encode", "hash",
	// Tier 3 — extraction + AI text
	"feed", "sitemap", "extract_contacts", "entities", "redact", "translate", "classify", "ocr",
	// Tier 4 — net/intel + geo + remaining convert + flagship queries
	"pubmed", "clinical_trials", "youtube", "wayback", "redirects", "robots", "crawl", "subtitles",
	"pdf", "fillable", "image_convert",
	// Tier 5 — web search variants + research/reference
	"consensus", "web_search", "tavily", "find_similar", "arxiv", "openalex", "crossref", "semantic_scholar", "stackexchange", "reddit", "coingecko",
	// Tier 6 — retail / shopping
	"shop", "product_search", "amazon", "walmart", "homedepot", "lowes", "bestbuy", "ebay", "costco", "kroger", "ace", "weekly_ad",
	// Tier 7 — people / places / social
	"people", "people_finder", "places", "linkedin", "facebook", "uw",
	// Tier 8 — notes / knowledge / vault + learning
	"obsidian", "ingest", "citation", "consolidate", "recall", "oracle", "study", "advise", "learn", "preferences", "life_wiki", "agenda",
	// Tier 9 — mail (JMAP)
	"jmap", "mail_triage", "mail_sieve", "mail_sieve_backfill", "briefing",
	// Tier 10 — personal namespaces (one /mcp) + finance/health
	"vault", "mail", "files", "calendar", "contact", "monarch", "mychart",
	// Tier 11 — batching/composition + watch/automation
	"pipe", "watch", "watch_pipeline",
	// Tier 12 — storage primitives + meta/feedback
	"kv_get", "kv_put", "kv_list", "kv_delete", "store", "put", "dropbox", "issue", "suggest",
	// Tier 13 — agent/autonomy + infra/meta
	"proposals", "selftest", "autonomy_status", "controld", "tailscale", "sux", "fn", "todoist",
	// Tier 14 — misc AI/format
	"voice", "fontcase",
];

const RANK = new Map(IMPORTANCE.map((n, i) => [n, i]));
// Sort comparator: known-rank first (by rank), then unknown alphabetically.
export function byImportance(a, b) {
	const ra = RANK.has(a) ? RANK.get(a) : Infinity;
	const rb = RANK.has(b) ? RANK.get(b) : Infinity;
	return ra !== rb ? ra - rb : a < b ? -1 : a > b ? 1 : 0;
}

// Fail loudly when IMPORTANCE references a function that no longer exists —
// mirrors gen-docs.mjs's reverse guard so a rename/removal can't leave phantom
// names silently steering (or failing to steer) tools/list order. Only runs
// when this module is the entrypoint (`node scripts/importance.mjs`), since
// gen-docs.mjs and gen-index.mjs import byImportance without wanting fs I/O.
if (import.meta.url === `file://${process.argv[1]}`) {
	const { readdirSync } = await import("node:fs");
	const { dirname, join } = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	const FNS = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "fns");
	const registered = new Set(
		readdirSync(FNS)
			.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts" && !f.startsWith("_"))
			.map((f) => f.replace(/\.ts$/, "")),
	);
	const phantom = IMPORTANCE.filter((n) => !registered.has(n));
	if (phantom.length) {
		console.error(`importance: IMPORTANCE references unknown function(s): ${phantom.join(", ")}`);
		process.exit(1);
	}
	console.log(`importance: ${IMPORTANCE.length} ranked / ${registered.size} registered — no phantom names.`);
}
