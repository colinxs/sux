// Generate sux/FUNCTIONS.md from the function source files. Zero deps — parses
// each fns/<name>.ts for its tool `name` + `description`, infers category and
// status, and emits a grouped reference table. Run: `npm run docs`.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { byImportance } from "./importance.mjs";

const FNS = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "fns");

// Category → ordered member tool names. Every function must appear in exactly
// one category — the reverse guard below fails the build on any that don't, so
// this list can't silently rot as functions are added (the taxonomy mirrors the
// hand-written catalog in sux/README.md).
const CATEGORIES = [
	["Net / transport", ["proxy", "scrape", "render", "redirects", "robots", "crawl", "watch", "watch_pipeline"]],
	["Extract / parse", ["extract", "readability", "tables", "metadata", "feed", "sitemap", "extract_contacts", "select", "grep", "subtitles"]],
	["Convert", ["markdown", "html", "csv", "json", "xml", "yaml", "image_convert", "pdf", "fillable"]],
	["Compress / encode / data", ["compress", "encode", "hash", "archive"]],
	["Token optimization", ["pack", "declutter"]],
	["Text / AI", ["summarize", "translate", "classify", "ocr", "entities", "redact", "voice", "fontcase"]],
	["Batching / composition", ["batch", "batch_fetch", "pipe", "run"]],
	["Storage", ["kv_get", "kv_put", "kv_list", "kv_delete", "store", "put", "dropbox"]],
	["Web search / query", ["search", "web_search", "tavily", "find_similar", "wayback", "get"]],
	["Retail / shopping", ["shop", "product_search", "amazon", "walmart", "homedepot", "lowes", "bestbuy", "ebay", "costco", "kroger", "ace", "weekly_ad"]],
	["Research / reference", ["arxiv", "pubmed", "openalex", "crossref", "semantic_scholar", "clinical_trials", "stackexchange", "reddit", "coingecko", "youtube"]],
	["People / places / social", ["people", "people_finder", "places", "linkedin", "facebook", "uw"]],
	["Notes / knowledge / vault", ["obsidian", "ingest", "citation", "consolidate", "vault_consolidate_plan", "vault_cross_link_plan"]],
	["Knowledge / learning", ["recall", "oracle", "study", "advise", "learn", "preferences", "life_wiki", "agenda", "onboard"]],
	["Mail (JMAP)", ["jmap", "mail_triage", "mail_triage_plan", "mail_sieve", "mail_sieve_hc", "mail_sieve_backfill", "mail_domain_backfill", "briefing"]],
	["Personal namespaces (one /mcp)", ["vault", "mail", "files", "calendar", "contact", "contact_consolidate_plan", "imessage"]],
	["Agent / autonomy", ["proposals", "webpush"]],
	["Personal finance", ["monarch"]],
	["Personal health", ["mychart"]],
	["Feedback / meta", ["issue", "suggest"]],
	["Infra / meta", ["selftest", "autonomy_status", "controld", "tailscale", "sux", "fn", "todoist"]],
];

const files = readdirSync(FNS).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts" && !f.startsWith("_"));
const dir = readdirSync(FNS);

const byName = new Map();
for (const f of files) {
	const src = readFileSync(join(FNS, f), "utf8");
	const name = src.match(/:\s*Fn\s*=\s*\{[\s\S]*?\bname:\s*"([^"]+)"/)?.[1] ?? f.replace(/\.ts$/, "");
	const desc = (src.match(/description:\s*\n?\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? "").replace(/\\"/g, '"');
	const tested = dir.includes(f.replace(/\.ts$/, ".test.ts"));
	byName.set(name, { name, desc, tested });
}

// Fail loudly when CATEGORIES references a function that no longer exists —
// otherwise renames silently push functions into an uncategorized limbo.
const missing = CATEGORIES.flatMap(([, names]) => names).filter((n) => !byName.has(n));
if (missing.length) {
	console.error(`gen-docs: CATEGORIES references unknown function(s): ${missing.join(", ")}`);
	process.exit(1);
}

// Reverse guard: fail loudly when a function exists but sits in no category —
// this is what let half the surface silently pile into an "Other" bucket. Add
// new functions to CATEGORIES above (this generator's counterpart to the
// forward guard) so the taxonomy stays honest as the fn count grows.
const uncategorized = [...byName.keys()].filter((n) => !CATEGORIES.some(([, names]) => names.includes(n))).sort();
if (uncategorized.length) {
	console.error(`gen-docs: function(s) missing from CATEGORIES: ${uncategorized.join(", ")} — add each to a category in gen-docs.mjs.`);
	process.exit(1);
}

const one = (s) => {
	const t = s.split(/\.\s/)[0].trim();
	return (t.length > 100 ? `${t.slice(0, 100)}…` : t).replace(/\|/g, "\\|");
};

let total = 0;
let tested = 0;
let body = "";
for (const [cat, names] of CATEGORIES) {
	const rows = [];
	for (const n of [...names].sort(byImportance)) {
		const fn = byName.get(n);
		if (!fn) continue;
		total++;
		if (fn.tested) tested++;
		rows.push(`| \`${fn.name}\` | ${fn.tested ? "✓" : "—"} | ${one(fn.desc)} |`);
	}
	if (!rows.length) continue;
	body += `\n### ${cat} (${rows.length})\n\n| function | test | summary |\n|---|---|---|\n${rows.join("\n")}\n`;
}

const md = `# sux — function reference

> Auto-generated by \`npm run docs\` from \`sux/src/fns/*.ts\`. Do not edit by hand.

**${total} functions** · ${tested} with tests.
Each function is one \`Fn\` file, projected into the MCP \`tools/list\` by \`src/registry.ts\`.
${body}
---

_Legend_: every function returns MCP text content; binary I/O is base64 inside JSON.
Cacheable functions are memoized in KV by a hash of their arguments.
`;

writeFileSync(join(FNS, "..", "..", "FUNCTIONS.md"), md);
console.log(`Wrote FUNCTIONS.md — ${total} functions (${tested} tested).`);
