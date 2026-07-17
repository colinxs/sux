import { type Fn, FRONT_VERBS } from "../registry";

// The sux capability surface — the single curated map of the whole toolset, shared
// by the `sux` root verb (mobile-safe tool call) and the public `GET /llms.txt`
// (CDN-cacheable, no secrets). Both render from the SAME source so the map can never
// drift between the two surfaces or from the deployed registry.

export type DomainSpec = { key: string; blurb: string; leaves: string[] };

// Curated grouping of the leaf fns into human-legible domains. A fn may appear under
// more than one domain when it genuinely serves both (a leaf is still one tool). Any
// registered fn NOT covered here is surfaced under "other" at render time, so a newly
// added leaf can never silently vanish from the map.
export const DOMAINS: DomainSpec[] = [
	{ key: "search", blurb: "Web search across engines (Kagi, Google, Brave, DDG, Tavily, Exa).", leaves: ["search", "web_search", "tavily"] },
	{
		key: "fetch",
		blurb: "Retrieve & render pages through a residential proxy, with the scrape → render escalation ladder for bot-walled sites; snapshots, redirects, robots, crawl.",
		leaves: ["scrape", "render", "proxy", "crawl", "wayback", "redirects", "robots"],
	},
	{
		key: "extract",
		blurb: "Parse HTML/text into structure — links, tables, metadata, readability, feeds, sitemaps, contacts, entities, CSS-select, grep, subtitles.",
		leaves: ["extract", "readability", "tables", "metadata", "feed", "sitemap", "extract_contacts", "entities", "select", "grep", "subtitles"],
	},
	{
		key: "research",
		blurb: "Academic & forum databases with citation shaping and similarity.",
		leaves: ["arxiv", "pubmed", "openalex", "crossref", "semantic_scholar", "clinical_trials", "stackexchange", "reddit", "citation", "find_similar"],
	},
	{
		key: "shop",
		blurb: "Product / price / store search — fan-out (shop, product_search) or a named retailer.",
		leaves: ["shop", "product_search", "amazon", "walmart", "costco", "homedepot", "lowes", "kroger", "bestbuy", "ebay", "ace", "weekly_ad"],
	},
	{
		key: "convert",
		blurb: "Format transforms — markdown/html/csv/json/xml/yaml, PDF build/fill, image transcode, font-case fold.",
		leaves: ["markdown", "html", "csv", "json", "xml", "yaml", "pdf", "fillable", "image_convert", "fontcase"],
	},
	{
		key: "compute",
		blurb: "Encode / hash / compress / archive / OCR, Workers-AI text (summarize, translate, classify, redact), token-pack + declutter, voice restyle.",
		leaves: ["encode", "hash", "compress", "archive", "ocr", "summarize", "translate", "classify", "redact", "pack", "declutter", "voice"],
	},
	{
		key: "data",
		blurb: "Places, people, crypto, media, and network/DNS control-plane intel.",
		leaves: ["places", "people", "people_finder", "coingecko", "youtube", "watch", "linkedin", "facebook", "controld", "tailscale"],
	},
	{
		key: "storage",
		blurb: "R2 content-addressed blob store, KV, the Dropbox app-folder, and the `files` namespace verb (whole-Dropbox on the one /mcp connector).",
		leaves: ["store", "kv_get", "kv_put", "kv_list", "kv_delete", "dropbox", "files"],
	},
	{
		key: "recall",
		blurb: "Memory: capture into the vault (ingest / the `vault` namespace verb), study whitelisted material you own (study), then recall/oracle synthesize a cited answer across your stores — weighting studied material above the model + web.",
		leaves: ["obsidian", "vault", "ingest", "study", "recall", "oracle"],
	},
	{ key: "tasks", blurb: "Todoist tasks & projects, plus calendar + tasks via the `calendar` namespace verb (Fastmail CalDAV).", leaves: ["todoist", "calendar"] },
	{ key: "money", blurb: "Personal finance — Monarch Money accounts, balances, transactions, budgets, cashflow (read-only).", leaves: ["monarch"] },
	{ key: "mail", blurb: "Fastmail over the raw JMAP conduit (byte-exact methodCalls + auth + gates), plus the `mail` + `contact` namespace verbs on the one /mcp connector.", leaves: ["jmap", "mail", "contact"] },
	{ key: "compose", blurb: "Server-side combinators — map+reduce (batch), parallel fetch (batch_fetch), and {{prev}}-piping (pipe).", leaves: ["batch", "batch_fetch", "pipe"] },
	{ key: "meta", blurb: "This map (sux), the `fn` escape hatch (call any leaf by name), preferences, feedback issues, self-diagnostics, and the autonomy-gate mirror.", leaves: ["sux", "fn", "preferences", "issue", "selftest", "autonomy_status"] },
];

// The personal-data namespaces are reached by FRONT VERBS on the single `/mcp` connector,
// NOT as separate /<domain>/mcp connectors — those are retired (see connectors.ts). Each
// verb dispatches into its underlying `<verb>_*` namespace tools (handle-discipline: list/
// search return refs, exactly one deliberate byte-read per namespace). The `verb` here is
// the personal-data member of registry's FRONT_VERBS; asserted below so this can't drift.
export const NAMESPACES: Array<{ key: string; verb: string; blurb: string }> = [
	{ key: "vault", verb: "vault", blurb: "Obsidian notes over git — read/write/append/edit, daily notes, capture (`vault_*`). Also reachable via the `obsidian` + `ingest` leaves." },
	{ key: "mail", verb: "mail", blurb: "Email on Fastmail over JMAP (`mail_*`: search/read/thread/draft/send). Calendar/tasks are the `calendar` verb (CalDAV, `cal_*`/`task_*`), contacts the `contact` verb (`contact_*`)." },
	{ key: "files", verb: "files", blurb: "Dropbox files (`files_*`) — Mode A app-folder always-on; Mode B whole-Dropbox read/search with a gated, firewalled write path." },
];

// Guard: every namespace verb above is a real front verb (single /mcp connector). If a
// verb is renamed/removed in the registry this trips at import/test time instead of the
// map silently pointing at a dead verb.
for (const n of NAMESPACES) {
	if (!FRONT_VERBS.has(n.verb)) throw new Error(`_surface: namespace verb "${n.verb}" is not a registered front verb`);
}

export const firstSentence = (desc: string): string => {
	// Split on a sentence-ending period, but not the period inside `e.g.`/`i.e.` — those
	// abbreviations would otherwise truncate a description at their first dot.
	const t = (desc.split(/(?<!\be\.g)(?<!\bi\.e)\.\s/)[0] ?? "").trim();
	return t.length > 140 ? `${t.slice(0, 139)}…` : t;
};

// Single-domain zoom: each leaf with its own one-line summary. Returns null when the
// domain key is unknown so callers can shape their own not-found message.
export function renderDomain(fns: Fn[], domain: string): string | null {
	const want = domain.trim().toLowerCase();
	const d = DOMAINS.find((x) => x.key === want);
	if (!d) return null;
	const byName = new Map(fns.map((f) => [f.name, f]));
	const lines = d.leaves.map((n) => {
		const fn = byName.get(n);
		return fn ? `- \`${n}\` — ${firstSentence(fn.description)}` : `- \`${n}\` — (unavailable)`;
	});
	return [`# sux · ${d.key}`, "", d.blurb, "", `Call any of these directly as its own tool, e.g. \`${d.leaves[0]}({…})\`.`, "", ...lines].join("\n");
}

export const domainKeys = (): string[] => DOMAINS.map((x) => x.key);

// Full overview: every domain with its leaf names, the namespaces, and how to invoke.
// Compact enough to read on a phone, complete enough to route from.
export function renderOverview(fns: Fn[]): string {
	const covered = new Set(DOMAINS.flatMap((d) => d.leaves));
	const out: string[] = [];
	out.push("# sux — capability map");
	out.push("");
	out.push(
		`${fns.length} tools on ONE \`/mcp\` connector. tools/list shows only the front verbs; every other tool is a leaf — reach it with \`fn({name, args})\`, e.g. \`fn({name:"arxiv", args:{query}})\`. Front verbs you can call directly: \`search\`, \`scrape\`, \`shop\`, \`ingest\`, \`recall\`, \`oracle\`, \`pipe\`, \`batch\`, \`store\`, plus the personal-data verbs \`vault\`, \`mail\`, \`files\`, \`calendar\`, \`contact\`. Pass \`sux({domain})\` to expand any group below.`,
	);
	out.push("");
	out.push("## Domains");
	for (const d of DOMAINS) {
		out.push("");
		out.push(`### ${d.key}`);
		out.push(d.blurb);
		out.push(`Leaves: ${d.leaves.map((n) => `\`${n}\``).join(", ")}`);
	}

	// Any registered leaf not placed in a domain — keeps the map exhaustive as the
	// registry grows without this file being updated.
	const uncovered = fns.map((f) => f.name).filter((n) => !covered.has(n));
	if (uncovered.length) {
		out.push("");
		out.push("### other");
		out.push("Registered leaves not yet grouped:");
		out.push(`Leaves: ${uncovered.map((n) => `\`${n}\``).join(", ")}`);
	}

	out.push("");
	out.push("## Personal-data namespaces (front verbs on the one /mcp connector)");
	for (const n of NAMESPACES) {
		out.push("");
		out.push(`### ${n.key} — \`${n.verb}\` verb`);
		out.push(n.blurb);
	}

	out.push("");
	out.push("## How to reach anything");
	out.push("- A front verb (in tools/list): call it directly, e.g. `search({query})`, `scrape({url})`.");
	out.push('- Any other leaf: `fn({name, args})`, e.g. `fn({name:"tables", args:{html}})`. Cache flags like `fresh` go inside `args`.');
	out.push('- Zoom a domain for per-leaf summaries: `sux({domain:"shop"})`.');
	out.push("- Compose leaves server-side: `batch` (map+reduce), `pipe` ({{prev}} chaining).");
	out.push("- Personal data: call the front verb directly — `vault`, `mail`, `files`, `calendar`, `contact` — each dispatching into its `<verb>_*` namespace tools on the one /mcp connector (the old /<domain>/mcp connectors are retired).");

	return out.join("\n");
}
