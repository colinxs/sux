---
name: sux
description: Route a task to the right sux edge function and chain them when needed — web search (Kagi, native Google, Brave, DDG, Tavily, Exa), scrape/render through a residential proxy with an escalation ladder (scrape → render) for bot-walled sites, crawl, extract/parse HTML (links, tables, metadata, readability, feeds, sitemaps, extract_contacts, entities, subtitles), research databases (arxiv, pubmed, openalex, crossref, semantic_scholar, clinical_trials, stackexchange, reddit), convert formats (markdown, html, csv, json, xml, yaml), build/fill PDFs, OCR, convert images, compress/archive/encode/hash, declutter + token-pack, Workers-AI text (summarize, translate, classify, redact), archived snapshots (wayback), product/price/store search (shop + named retailers), places/people, crypto (coingecko), YouTube, Obsidian notes, vault capture (ingest url/text/query with blob routing), and storage (R2 store + KV + Dropbox app folder). Use whenever the user wants any web fetch, scrape/render of a page (including Akamai/PerimeterX-walled sites), data transform, extraction, research lookup, or lightweight compute done at the edge via the sux MCP connector.
---

# sux — the edge function engine

sux is one personal Cloudflare Worker exposing **a large suite of composable functions** as MCP
tools (Julia-style generic verbs + multiple dispatch). **Kagi is just one function
(`search`).** The full inventory, status, and per-function summaries live in
**`sux/FUNCTIONS.md`** — that file is the source of truth (run `npm run docs` to
regenerate it from `sux/src/fns/*.ts`). This skill maps intent → function.

When a task needs live web data, a page fetch, document work, or an edge transform,
reach for sux instead of declining or answering from memory.

## Front door: front verbs vs. the `fn` escape

`tools/list` advertises only **~19 front verbs** — `sux`, `fn`, `search`, `scrape`,
`shop`, `ingest`, `recall`, `oracle`, `pipe`, `batch`, `store`, `preferences`,
`issue`, `proposals`, plus the personal-namespace verbs `vault`, `mail`, `files`,
`calendar`, `contact`. Everything else — covered in `references/capability-tables.md` — is a **leaf**: reach it with the escape
hatch **`fn({name, args})`** — e.g. this skill writes `tables({html})`, you call
`fn({name:"tables", args:{html}})`; `arxiv({query})` → `fn({name:"arxiv", args:{query}})`.
A leaf dispatched via `fn` behaves byte-identically to a direct call (same cache, same
deadline). Cache flags (`fresh`, `summarize`) go **inside** `args`. Front verbs are
called directly, no wrapper. When unsure what exists, call **`sux()`** for the live
capability map, or `sux({domain})` to zoom one group.

## Two principles before dispatching

1. **Escalate fetching gradually.** Plain `scrape` (residential proxy, cheapest)
   → `render` (cf-residential headless Chromium — JS executed, egressing from a
   home IP past datacenter-IP bot detection; screenshot / page→PDF). Don't start at
   the top — a render spins up a browser. For the hardest retail walls
   (Akamai/PerimeterX), the retailer fns (`amazon`, `walmart`, `homedepot`, `lowes`,
   `ace`) internally fall back to a paid residential unlocker after cf. `selftest`
   probes which rungs of the ladder are currently up.
2. **Keep bulk data out of context.** Pick the **narrowest** function, and compose
   lighter ones in front of heavy ones. Chain steps server-side with `pipe`, fan
   out with `batch` (let its `reduce`/`reduce_with` merge), ask for `as:"url"`
   delivery on big/binary outputs (a ~100-token `/s/<uuid>` ref instead of
   base64), and re-encode row data with `pack`.

## Full capability tables

The 10 domain tables (web search, fetch/extract, research, shopping, documents,
transforms, composition/storage/memory, infra/meta) live in
**`references/capability-tables.md`** — load it once you know which domain the
task falls in (or need the full map). Kept out of this file so a routine trigger
doesn't pull in categories the task doesn't touch.

Leaf index (semantics + args in `references/capability-tables.md`; call any via
`fn({name, args})`): `ace`, `advise`, `agenda`, `amazon`, `autonomy_status`, `batch_fetch`,
`audit_log`, `briefing`, `citation`, `consolidate`, `contact_consolidate_plan`, `costco`, `dropbox`, `feed`, `files_consolidate_plan`, `fontcase`, `get`, `homedepot`,
`imessage`, `jmap`, `kv_get`, `kv_put`, `kv_list`, `kv_delete`, `learn`, `life_wiki`, `linkedin`, `lowes`,
`mail_domain_backfill`, `mail_sieve`, `mail_sieve_hc`, `mail_sieve_backfill`, `mail_triage`, `mail_triage_plan`, `monarch`, `mychart`, `mychart_reconcile_plan`, `obsidian`, `onboard`, `people_finder`, `put`, `redirects`,
`robots`, `sitemap`, `study`, `suggest`, `todoist`, `uw`, `vault_consolidate_plan`, `voice`, `walmart`, `watch`,
`watch_pipeline`, `vault_cross_link_plan`, `web_search`, `webpush`, `weekly_ad`.

## Conventions

- Every result is MCP text; structured data is JSON, binary is base64 inside JSON
  (or `as:"url"` for a CAS-backed download link on binary outputs).
- Cacheable functions are memoized in KV by a hash of their arguments — repeat
  calls are free.
- `image_convert` runs via the Images binding; `pdf`/`fillable`/`ocr` handle
  document I/O.

## Token discipline

sux does the heavy work server-side and returns only the distilled result. Project
first: `grep`/`select`/`readability` to slice, `declutter` to strip chrome, `pack`
to squeeze — then hand the small result to the model.

## Worked examples

- "What are people saying about X on forums this week?"
  → `search { query: "X", lens_id: "1", time_relative: "week" }`
- "Is this $200 air fryer cheaper anywhere?"
  → `shop { query: "..." }` (or `product_search` to fan across retailers), then the
  named retailer tool to confirm
- "Summarize these five articles into one brief"
  → `batch { tool: "readability", over: [urls...], args: { url: "{{item}}" }, reduce: "summarize", include_results: false }`
- "Get the pricing table off this JS-heavy page"
  → `pipe { steps: [{ tool: "render", args: { url, as: "html", block_resources: true } }, { tool: "tables", args: { html: "{{prev}}" } }] }`
- "Turn this doc into a PDF I can send"
  → `pdf { text: "...", title: "...", as: "url" }` and share the returned link

## When something fails

Escalate the fetch ladder first (`scrape` → `render`, cf-residential headless
Chromium; the retail fns then fall back internally to a paid unlocker for hard
walls); run `selftest` to see which rungs are up; try `wayback` if the live
page is gone. Key-gated tools (`tavily`, `find_similar`, `youtube`, `places`,
`bestbuy`, `ebay`, `kroger`, `facebook`, `controld`, `tailscale`) fail cleanly when
the secret is unset — fall back to `search` / `shop` / `scrape`. If a tool errors or
returns wrong output, file it with `issue { tool, text }` so it lands in the
server's feedback log.
