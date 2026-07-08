---
name: sux-router
description: Route a natural-language request to the right sux MCP tool. Use when the user wants to search the web, fetch/scrape/render a page (including bot-walled sites), search papers or clinical trials, look up products/prices/stores, find people/places/contacts, convert documents or data formats (PDF, OCR, JSON/YAML/CSV/XML, markdown), summarize/translate/classify text, check crypto prices, read Obsidian notes, or chain several of these steps together.
---

# sux tool router

sux is a personal Cloudflare Worker MCP server (~70 tools). This skill maps
intent → tool. Two principles before any table:

1. **Escalate fetching gradually.** Plain fetch → `scrape` (residential proxy)
   → `render` (headless Chromium, JS executed) → `render {backend:"mac"}`
   (residential patched browser that clears Akamai/PerimeterX, auto-solves
   captchas; add `solve: true` to force the solver tier). Don't start at the top —
   mac is slow and a shared resource.
2. **Keep bulk data out of context.** Chain steps server-side with `pipe`,
   fan out with `batch` (and let its `reduce`/`reduce_with` do the merging),
   ask for `as: "url"` delivery on big/binary outputs (returns a ~100-token
   `/s/<uuid>` ref instead of base64), and re-encode row data with `pack`.

## Web search

| Intent | Tool |
|---|---|
| Default web search | `search` (Kagi). Scope with `include_domains`/`exclude_domains`/`time_relative`/`after`/`before`/`file_type`; `workflow: news\|videos\|podcasts\|images`; lens via `lens_id` (Academic=2, Forums=1, Programming=15, News360=29, Recipes=120, Small Web=107) |
| Cross-engine / second opinion / no-key | `web_search` — `engine: kagi\|ddg\|google\|brave\|all`; `all` fans out, merges, and can `summarize: true` |
| Synthesized answer + sources | `tavily` (`depth: advanced` for deeper) |
| "More like this page" / semantic search | `find_similar` (Exa: `url` for similar pages, `query` for neural search) |

## Fetch, extract, page anatomy

| Intent | Tool |
|---|---|
| Fetch a page (bot-shy sites, datacenter-IP blocks) | `scrape` |
| JS-rendered page, screenshot, or page→PDF | `render` (`as: html\|text\|screenshot\|pdf`; `backend: mac` for Akamai-hard sites) |
| Article body only (no nav/ads) | `readability` |
| Strip ads/consent/tracking, keep HTML | `declutter` (compose before summarize/markdown) |
| Links / JSON-LD / plain text from HTML | `extract` |
| CSS-selector query | `select` (subset: no `>`, `+`, `~`, pseudo-classes) |
| Regex over a page or text | `grep` |
| HTML tables → JSON/CSV | `tables` |
| Title/OG/twitter meta | `metadata` |
| Emails/phones/social links on a page | `contacts` |
| Many URLs at once | `batch_fetch` (`as: "url"` = bulk download to R2) |
| Fetch from a specific country/locale | `geo_fetch` |
| Raw HTTP (headers, POST, binary) | `proxy` |
| Follow links breadth-first | `crawl` (depth ≤ 3, max 100) |
| Historical snapshot / change history | `wayback` |
| Redirect chain, robots.txt, sitemap, RSS/Atom | `redirects`, `robots`, `sitemap`, `feed` |

## Research & reference

| Domain | Tool |
|---|---|
| CS/math/physics preprints | `arxiv` |
| Biomedical literature | `pubmed` (PubMed query syntax, field tags OK) |
| Any-discipline scholarly graph + citation counts | `openalex` |
| DOI metadata | `crossref` |
| Abstracts + PDFs across fields | `semantic_scholar` |
| Clinical studies | `clinical_trials` |
| Programming/sysadmin Q&A | `stackexchange` (`site:` superuser, askubuntu, math, …) |
| Crypto prices | `coingecko` (`search` for the id, then `price`) |
| YouTube videos | `youtube` |

Overlap rule: papers-in-general → `openalex` or `semantic_scholar`;
"preprint"/CS-math-physics → `arxiv`; anything medical → `pubmed`.

## Shopping, places, people

| Intent | Tool |
|---|---|
| Product search, no retailer named | `shop` (Google Shopping, cross-merchant) |
| Named retailer | `amazon`, `walmart`, `homedepot`, `lowes`, `bestbuy`, `ebay`, `costco`, `kroger` (+ QFC/Fred Meyer/Ralphs banners via `chain`; pass `zip` for prices), `ace`; `winco` is store-locations only |
| Local businesses / points of interest | `places` (free-text, e.g. "hardware store near 98133") |
| Who is X / org directory | `people` (`extract_contacts: true` pulls emails/phones from the top hit; `source: usagov` for federal agencies) |
| LinkedIn profile/company (URL in hand) | `linkedin` |
| Facebook Graph node/edge | `facebook` |

Retailer note: amazon/walmart/homedepot/lowes/ace ride the mac render backend —
slow, best-effort; bestbuy/ebay/kroger are official APIs — prefer them when the
retailer is interchangeable.

## Documents & media

| Intent | Tool |
|---|---|
| Anything → PDF; merge/split/pages/bookmarks/metadata | `pdf` (use `as: "url"` for delivery) |
| Add fillable form fields to a PDF | `fillable` |
| Text out of an image | `ocr` |
| Convert/resize an image (png/jpeg/webp/avif) | `image_convert` |
| SRT ↔ WebVTT | `subtitles` |
| Summarize a page, long doc, or YouTube video | `summarize` (pass `url` — Kagi handles YouTube natively; `text` for raw input) |

## Text & data transforms

| Intent | Tool |
|---|---|
| Anything → JSON (auto-detects yaml/csv/xml) | `json`; inverses: `yaml`, `csv`, `xml` |
| HTML ↔ Markdown | `markdown` (HTML→MD), `html` (MD→HTML) |
| Translate | `translate` (m2m100, `to` code) |
| Zero-shot label text | `classify` |
| Dates/money/emails/URLs/phones from text | `entities` (regex, no model) |
| Scrub PII | `redact` |
| Case/unicode-font conversion | `fontcase` |
| base64/hex/url, hashes, compression, zip/gzip | `encode`, `hash`, `compress`, `archive` |
| JSON rows → token-cheap TSV | `pack` |

## Composition, storage, memory

| Intent | Tool |
|---|---|
| Chain tools server-side (A's output → B) | `pipe` (`{{prev}}` / `{{prev.path}}`) |
| Same tool over many inputs, optionally reduced | `batch` (`over` + `args` template, `reduce: concat\|summarize`, or `reduce_with` a tool) |
| Stash/retrieve blobs (content-addressed R2) | `store` |
| Small persistent key-values | `kv_put`, `kv_get`, `kv_list`, `kv_delete` |
| Obsidian vault: list/read/search/append notes | `obsidian` (default `backend: git`; `remote` reaches the live vault and its ~15 vault tools via `action: tools`/`call`) |

## Worked examples

- "What are people saying about X on forums this week?"
  → `search { query: "X", lens_id: "1", time_relative: "week" }`
- "Is this $200 air fryer cheaper anywhere?"
  → `shop { query: "..." }`, then the named retailer tool to confirm
- "Summarize these five articles into one brief"
  → `batch { tool: "readability", over: [urls...], args: { url: "{{item}}" }, reduce: "summarize", include_results: false }`
- "Get the pricing table off this JS-heavy page"
  → `pipe { steps: [{ tool: "render", args: { url, as: "html", block_resources: true } }, { tool: "tables", args: { html: "{{prev}}" } }] }`
- "Turn this doc into a PDF I can send"
  → `pdf { text: "...", title: "...", as: "url" }` and share the returned link

## When something fails

Escalate the fetch ladder first (`scrape` → `render` → `render {backend:"mac",
solve:true}`); try `wayback` if the live page is gone. Key-gated tools
(`tavily`, `find_similar`, `youtube`, `places`, `bestbuy`, `ebay`, `kroger`,
`facebook`) fail cleanly when the secret is unset — fall back to `search` /
`shop` / `scrape`. If a tool errors or returns wrong output, file it with
`issue { tool, text }` so it lands in the server's feedback log.
