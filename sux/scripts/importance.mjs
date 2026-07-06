// Importance ranking for sux functions (Bosman-set). Drives BOTH the MCP
// tools/list order (gen-index) and the docs order (gen-docs): most-important
// tools surface first, which helps agent attention and token budgeting.
// Unranked functions fall to the end, alphabetically. Optimize in this order.
export const IMPORTANCE = [
	// Tier 0 — flagship core: transport + search + primary parse/distill
	"search", "scrape", "protocol", "proxy", "extract", "readability", "summarize",
	// Tier 1 — token-economy primitives (compose in front of everything)
	"grep", "shrink", "select", "optimize", "json_query", "pack", "truncate", "count_tokens", "compress",
	// Tier 2 — high-value transforms + batching
	"batch", "batch_fetch", "metadata", "tables", "html_markdown", "csv_json", "archive", "encode", "hash", "diff", "dedupe",
	// Tier 3 — extraction + AI text
	"feed", "sitemap", "gtin", "contacts", "entities", "redact", "translate", "classify", "embed", "ocr",
	// Tier 4 — net/intel + geo + remaining convert + flagship queries
	"pubmed", "clinical_trials", "youtube", "local_shop", "wayback", "barcode_lookup", "geo_fetch", "latency",
	"dns", "headers", "redirects", "robots", "whois", "ip_geo", "tls_info", "crawl",
	"yaml_json", "xml_json", "subtitles",
	// Tier 5 — utilities
	"jwt", "calc", "units", "datetime", "validate", "word_count", "sort", "frequency",
	"template", "regex_replace", "htmlentities", "flatten", "sample", "base_convert",
	"color_convert", "checksum", "querystring", "url_parse", "slugify", "case_convert",
	"humanize", "uuid", "random", "mask", "anonymize", "scrub_headers", "strip_metadata", "qr",
	// Tier 6 — storage primitives + meta/feedback
	"kv_get", "kv_put", "kv_list", "kv_delete", "issue", "suggest", "lint",
	// Tier 7 — planned stubs (need Browser Rendering / WASM)
	"html_to_pdf", "pdf_to_text", "pdf_to_images", "office_to_pdf", "image_convert",
];

const RANK = new Map(IMPORTANCE.map((n, i) => [n, i]));
// Sort comparator: known-rank first (by rank), then unknown alphabetically.
export function byImportance(a, b) {
	const ra = RANK.has(a) ? RANK.get(a) : Infinity;
	const rb = RANK.has(b) ? RANK.get(b) : Infinity;
	return ra !== rb ? ra - rb : a < b ? -1 : a > b ? 1 : 0;
}
