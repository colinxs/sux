---
name: sux
description: Route a task to the right sux edge function — web search (Kagi + native Google), scrape/fetch through a residential proxy (smart/full/geo), crawl a site, extract/parse HTML (links, tables, metadata, readability, feeds, sitemaps, contacts, entities), convert formats (markdown, html, csv, json, xml, yaml, subtitles), build/fill PDFs, convert images, compress/archive/encode/hash, declutter + token-pack, Workers-AI text (summarize, translate, classify, ocr, redact), archived snapshots (wayback), product search (shop), and storage (R2 store + KV). Use when the user wants any web fetch, data transform, extraction, or lightweight compute done at the edge via the sux MCP connector.
---

# sux — the edge function engine

sux is one Cloudflare Worker exposing 50 composable functions as MCP tools
(Julia-style generic verbs + multiple dispatch). **Kagi is just one function (`search`).**
Full inventory + status: **`sux/FUNCTIONS.md`** (run `npm run docs` to regenerate).

## How to route

Pick the **narrowest** function that answers the need; compose in front of heavier ones
to keep token cost down (e.g. `grep`/`select`/`readability` before dumping a whole page).

| The user wants… | function |
|---|---|
| web search / news | `search` (Kagi) · `web_search` (kagi + native Google via SerpAPI; `engine:"all"` fans out + can `summarize`) |
| product search across retailers | `shop` (gshop/amazon/walmart/home_depot via SerpAPI) |
| fetch a page that blocks datacenter IPs | `scrape` |
| force every request through a residential exit | `proxy` (full residential) |
| pick the exit region for geo-priced / geo-gated data | `geo_fetch` |
| crawl a whole site / follow links | `crawl` |
| main article text (strip nav/ads) | `readability` |
| links / JSON-LD / plain text from HTML | `extract` |
| tables · metadata · feeds · sitemaps | `tables` · `metadata` · `feed` · `sitemap` |
| CSS-select / regex-grep a page | `select` · `grep` |
| emails & phones · named entities | `contacts` · `entities` |
| subtitles / transcript track from a video page | `subtitles` |
| redirect chain · robots rules | `redirects` · `robots` |
| convert formats (verb = target) | `markdown` · `html` · `csv` · `json` · `xml` · `yaml` · `subtitles` |
| strip ads/nav/tracking from HTML | `declutter` (compose before summarize/readability/markdown) |
| build / merge / paginate a PDF | `pdf` (anything→PDF: merge, TOC, forms, metadata, OCR) |
| add fillable form fields to a PDF | `fillable` |
| convert an image format | `image_convert` |
| compress / archive / encode / hash | `compress` · `archive` · `encode` · `hash` |
| pack / shrink tokens of a payload | `pack` |
| summarize / translate / classify / OCR | `summarize` · `translate` · `classify` · `ocr` |
| PII redaction | `redact` |
| archived snapshot / page history | `wayback` |
| chain tools server-side (COMPOSE) | `pipe` (`{{prev}}` feeds each step) |
| run one tool over many inputs (MAP) | `batch` · `batch_fetch` (many URLs) |
| stash / fetch content by handle or URL | `store` (R2, content-addressed) · `kv_get`/`kv_put`/`kv_list`/`kv_delete` |
| report a bug | `issue` |

## Fetch routing modes (keep all three)

- **smart** (default) — cheapest rung first; residential only when a datacenter IP is
  blocked; direct fallback so it never hard-fails. (`scrape`.)
- **full proxy** — force everything through the residential exit, no fallback. (`proxy`.)
- **geo** — pick the exit locale for region-priced / geo-gated data. (`geo_fetch`.)

## Conventions

- Every result is MCP text; structured data is JSON, binary is base64 inside JSON
  (or `as:"url"` for a CAS-backed download link on binary outputs).
- Cacheable functions are memoized in KV by a hash of their arguments — repeat calls are free.
- Converters are named for their **target** format (`markdown`, `html`, `csv`, `json`,
  `xml`, `yaml`) and auto-detect the input — e.g. call `json` with CSV or YAML in, `csv`
  with JSON in.
- `image_convert` runs via the Images binding; `pdf`/`fillable`/`ocr` handle document I/O.

## Token discipline

sux does the heavy work server-side and returns only the distilled result. Prefer
projecting first: `grep`/`select`/`readability` to slice, `declutter` to strip chrome,
`pack` to squeeze — then hand the small result to the model.
