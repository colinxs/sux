# PLAN — **sux**

> An edge-hosted, residentially-proxied engine of composable functions (Julia-style
> generic verbs + multiple dispatch). Any useful transform / query / scrape / proxy
> is a function. **Kagi is just one function now.** "We basically re-invented the
> programmable edge." Name: `sux` — short, in the mux/multiplex family.

Living document, **continually revised** (not just appended): as features land, the
structure is refactored to stay coherent — new directives hit **§ Incoming**, then
get folded into invariants / design / phases / features and deduped.

## Vision
A fast, cheap, hard-to-block search/commerce engine that emulates the best of
Bing / Google / Wikipedia / store sites — with lossless efficiency and a clean,
always-available simple path.

## Architecture — two services

**Service 1 · `kagi-mcp` (core) — the simple option, always kept**
```
Claude ──OAuth──▶ CF (OAuthProvider) ──▶ KV (state/cache) ──▶ Worker ──▶ public Kagi MCP
```
Transparent OAuth→Kagi proxy. KV cache · tool curation · audit · rate-limit ·
observability · QUIC. No scraping, no proxy. Stays lean & reliable.

**Service 2 · `sux` — the engine (general functions in the cloud)**
```
Claude ──MCP──▶ sux Worker  (all work here: parse, render, ocr, transform, cache)
                     │ smartFetch — EVERY outbound query (direct fallback = simple option)
                     ▼
              Tailscale node (DUMB, residential IP only — no work)
                     ▼
              { Kagi, Google, Home Depot, Costco, any URL }
```
Same qualities as core (KV cache · rate-limit · observability · QUIC). OAuth-gated.
Residential node is a pure fetch pass-through (HMAC + SSRF guard + host allowlist).

## Design — Julia-inspired (generic functions + multiple dispatch)
The tool layer is built like Julia's standard library: a **small set of generic
verbs**, each with **methods specialized by argument type/format**, that **compose**.

- **Generic verbs:** `fetch · convert · extract · optimize · compress · render ·
  ocr · pack · archive · summarize · search · fill · watch`. Few verbs, not N bespoke tools.
- **Multiple dispatch:** the method is chosen by the types/shapes of **all** args —
  `convert(from, to)`, `optimize(::PNG)` vs `optimize(::PDF)` vs `optimize(::Text)`,
  `extract(::HomeDepotPage)` vs `extract(::JSONLD)`. Site/format adapters are just methods.
- **Composability & promotion:** a **generic fallback** method means everything
  "just works" (unknown format → `optimize` falls back to gzip; unknown site →
  `extract` falls back to generic `scrape`). Add one method and it plugs into F1/F2/F5/F7 at once.
- **Broadcasting:** any verb applies over a collection (batch a list of URLs/docs/files).
- **Bidirectional pairs** (invariant) are natural method pairs: `compress`/`decompress`,
  `pack`/`unpack`, `encode`/`decode`, `convert(A,B)`/`convert(B,A)`.
- **Function-call style:** uniform, predictable, agent-first signatures; MCP exposes a
  few generic verbs (with a `type`/`target`) rather than a sprawling tool list.

*Payoff:* new formats, sites, and conversions are **one method each** — no N² glue —
mirroring how Julia gets `1.0 + 1.0im` for free.

## Cross-cutting invariants (apply to BOTH services)
- **KV caching** everywhere results are reusable.
- **QUIC/HTTP-3** (automatic at the edge) + **observability** (Workers Logs) on.
- **Per-user rate limit** + fail-closed allowlist gate.
- **Always keep the simple option** — proxy optional, direct fallback always.
- **Transparent lossless optimization before caching** (see Feature F1).
- **Agent-first** — every tool is built for LLM agents: structured/predictable
  output, `*_inspect` companions that return schemas, idempotent, token-efficient
  (heavy work server-side, only distilled results returned), errors are actionable.
- **Citations everywhere** — all results carry source provenance (see Feature F4).
- **Bidirectional** — every transform ships with its inverse, as a symmetric pair:
  compress↔decompress, pack↔unpack, encode↔decode, parse↔serialize, OCR↔render,
  fill↔read (forms), fetch↔publish, convert(A→B)↔convert(B→A). No one-way streets.

## Fetch/render ladder (Service 2, per URL — stop at first success)
1. Kagi search snippet (cheapest; often has the price already)
2. Plain fetch + parse embedded JSON (JSON-LD / `__NEXT_DATA__` / microdata)
3. Wayback `id_` snapshot (free, bypasses anti-bot; also price history)
4. Residential fetch via the dumb node (beats datacenter-IP blocks)
5. Browser Run render (JS sites; Cloudflare IPs — not Akamai)
6. OCR on screenshot (Workers AI vision) — last resort

## Retailer tiering (from research)
- **Kroger** → official API (`api.kroger.com`, OAuth client_credentials, per-store price/stock/aisle). Clean.
- **Ace Hardware** → plain fetch, parse JSON-LD + Kibo JSON. Easy.
- **Home Depot / Lowe's / Costco** → Akamai + datacenter-IP block → residential fetch + cloud parse, or barcode → Barcode Lookup.

## Barcode engine
Grep `gtin` (JSON-LD `gtin13/12/8/14`, microdata, OG meta; validate check digit) →
Barcode Lookup `stores[]` (+ UPCitemdb fallback, Open Food Facts for grocery) for
cross-store prices. Sidesteps the anti-bot wall. Cache by GTIN.

## Key API facts (researched)
- Kagi: Search **$12/1k**, Extract **$4/1k** (extracts dominate cost → snippet-first, cap extract_count≤3).
- Summarizer: Kagi ~$0.12/page vs **Workers AI `@cf/meta/llama-3.2-3b-instruct` ~$0.0003/page (~300× cheaper)**.
- Browser Run: `quickAction("content"|"markdown"|"json")`, $0.09/browser-hr, needs Workers Paid.
- OCR: `@cf/meta/llama-3.2-11b-vision-instruct`.
- Wayback: Availability + CDX (`collapse=digest`) + `id_` raw content — unauthenticated, Worker-friendly.

---

## Residential egress unlocks (think big)
A residential IP is the superpower: it defeats datacenter-IP blocks, IP rate limits,
and much geo-restriction. That turns a huge surface into agent tools. Each becomes
a function (or adapter) on Service 2, all citation-bearing + agent-first + cached.

**High-value verticals (each = a tool / adapter):**
- **Search engines direct** — Google / Bing SERPs (residential defeats SERP blocks) → real `google`/`bing` tools + knowledge panels
- **YouTube** — transcripts, metadata, search, comments, chapters (F6)
- **Social** — Reddit, X, Instagram, TikTok, LinkedIn public data
- **Local** — Google Maps / Yelp: businesses, hours, reviews, geo
- **Commerce** — Amazon, Home Depot, Lowe's, Costco, Best Buy (residential + barcode)
- **Travel** — Google Flights, Kayak, hotels (price scraping)
- **Real estate** — Zillow, Redfin listings
- **Jobs** — Indeed, LinkedIn
- **Reviews** — aggregate across sources
- **Finance / news / weather / sports** — data feeds that IP-gate
- **Price & change monitoring** — snapshot over time (ties Wayback + scheduled)
- **Geo-priced data** — region-specific pricing/availability by exit locale

> Governance: respect robots/ToS where required, throttle, cache hard, low volume.
> Scope/legal posture is the operator's call; the engine implements politely.

**General primitive:** `scrape` (fetch via residential + cloud parse) is the base;
high-value sites get thin **adapters** (structured extraction) on top.

---

## Proposed signatures (big-idea verbs)
Each is one `Fn` (its own file). Dispatch on a discriminator arg (Julia-style).
Binary I/O is base64 in/out. Status legend: ✅ done · 🔨 building · ⬜ queued.

- ⬜ `proxy(url, method?="GET", headers?, body?, geo?)` → `{status, headers, body, bytes}` — raw residential transport (the base everything builds on).
- ✅ `protocol(url, method?="GET", headers?, body?, as?="text"|"json"|"headers", max_bytes?)` → structured HTTP response. Routes via proxy. **DONE** (`fns/protocol.ts`, tested).
- ⬜ `query(api, params)` — call a known API adapter. `api ∈ {kagi, kroger, barcode, dns, whois, weather, ip_geo, ...}`; dispatch on `api`.
- ⬜ `scrape(url, what?="auto", site?)` → structured extraction; dispatch on host → site adapter, fallback generic.
- ⬜ `compress(data, codec, direction="compress"|"decompress", level?)` — bidir. `codec ∈ {gzip, deflate, brotli, zstd, 7z}` (gzip/deflate native; zstd/7z via WASM). base64 for binary.
- ⬜ `ocr(source, kind?="image"|"pdf", lang?)` → text. `source` = url|base64; Workers AI vision.
- ⬜ `shrink(source, kind="pdf"|"image", lossless?=true, target_kb?)` → optimized bytes (base64) + size delta. Lossless default; lossy opt-in.

## Greenlit method catalog (ALL obvious = pre-approved)
Scope is open-ended: **any useful transformation, query, scrape, or proxy** is in
scope. Everything below is **greenlit** — build without further asking. Each is a
method on a generic verb (Julia-style); new ones get added as methods.

**convert** (bidirectional): html↔markdown · md↔pdf · html→pdf · pdf→text/images ·
docx/xlsx/pptx↔pdf/text · epub↔ · csv↔json↔yaml↔toml↔xml · svg↔png · image
png/jpeg/webp/avif↔ · srt↔vtt · latex→pdf.

**encode/decode** (bidirectional): base64 · hex · url · gzip/brotli/zstd · jwt · qr-code.

**optimize/compress** (F1): lossless recompress (oxipng/webp/pdf) · minify (html/css/js/json) ·
opt-in lossy downscale.

**extract**: text/tables/links/metadata from html/pdf/docx · JSON-LD/microdata/`__NEXT_DATA__` ·
gtin/barcode · entities/dates/amounts · main-content (readability).

**text/ai**: summarize · translate · classify/tag · embed · chunk · redact/PII · diff · sentiment · rewrite.

**media**: ocr (image→text) · render (text/url→image/pdf) · resize/crop/thumbnail ·
audio transcribe · video→frames/keyframes.

**data**: dedup · sort/filter/join/flatten · hash (sha256/md5) · checksum · validate (schema).

**docs** (F2): merge/split pdf · fill/read forms (F3) · watermark · pack/unpack archives (F5).

**query**: web/news/images/video/scholarly search · local_shop · barcode lookup ·
dns/whois · ip-geo · unit/currency convert · calc · datetime · weather · quote (stock/crypto).

**scrape** (residential adapters, F7): youtube (F6) · reddit · maps/yelp · amazon · big-box ·
zillow/redfin · flights/hotels · jobs · social · reviews.

**proxy** (residential): fetch any url · geo-select exit · session/cookies · POST/forms · header/UA control.

> Governance: obvious → auto-greenlit. Only flag the **non-obvious**: anything with
> real $ (paid APIs, Browser-Run volume), legal/ToS gray areas (bulk download,
> auth-walled data), or destructive/irreversible actions.

## Phased roadmap
- **P0 — Split (DONE):** core clean; research-tools scaffolded, deployable MCP server (local_shop + scrape working, KV cache, gate, proxy, dumb node).
- **P1 — Deploy Service 2:** own secrets + GitHub OAuth callback.
- **P2 — Kagi cost cuts (both):** snippet-first, cap extract_count, dedupe URLs, longer TTLs.
- **P3 — Barcode engine + Kroger/Ace adapters.**
- **P4 — Web archive tool + price history (Wayback).**
- **P5 — Browser Run render + OCR + Workers-AI summarizer.**
- **P6 — Home Depot/Lowe's/Costco via residential fetch.**
- **P7 — Knowledge quality (Wikipedia/Wikidata, multi-source synthesis).**

---

## Feature backlog

### F1 — Transparent lossless file optimization before caching
When the engine downloads/produces a file, **losslessly optimize it before the KV
cache write**, transparently (decode/serve identical bytes on read).

- **Tier A (now, cheap, universal):** store cache payloads **Brotli/Gzip-compressed**
  in KV; decompress on read. Lossless, transparent, cuts KV storage + read egress.
  Text/HTML/JSON/markdown benefit most. Use `CompressionStream`/`DecompressionStream`
  (Web-standard, available in Workers).
- **Tier B (format-specific lossless recompression):**
  - PNG → lossless (oxipng/zopflipng via WASM)
  - JPEG → lossless optimize (jpegtran-style)
  - WebP lossless, GIF, SVG minify, PDF object-stream compaction
  - Runs in the cloud Worker (WASM); never at the dumb node.
- **Tier C (opt-in lossy size reduction):** when the caller allows it — image
  downscale/quality, PDF flatten/downsample, `image_compress` tool. Lossy is
  **never** applied transparently; always explicit + reports size delta.
- **Rules:** Tier A/B are lossless & transparent; Tier C is opt-in. Record original
  vs optimized size in the audit log; skip if already optimal; bound CPU per file.
- **Where:** a `cachePut(key, bytes, contentType)` wrapper that optimizes-then-stores,
  and `cacheGet` that reverses Tier-A compression. Applies to **both services'** caches.

### F2 — Document management (emulate the best of paperless-ngx)
A document layer on the same stack. Best paperless-ngx features, mapped to Cloudflare:

| paperless-ngx feature | Our implementation |
|---|---|
| Consumption pipeline (watch folder / email / upload) | Ingest tool + **Queues** (async), **Cloudflare Email** routing for mail-in |
| OCR scanned docs → searchable text | **Workers AI** vision (`llama-3.2-11b-vision`) on page images/PDF renders |
| Store originals + archival copy | **R2**: original bytes + normalized **PDF/A-style** archival; **lossless-optimized (F1)** before store |
| Auto-tagging: tags, correspondents, document types | **Workers AI** LLM classification → structured metadata |
| Metadata extraction (dates, amounts, correspondents, totals) | LLM + regex; store in **D1** (queryable) |
| Full-text + semantic search | **Vectorize** (embeddings) + D1 full-text; hybrid rank |
| De-duplication | content **SHA-256** hash + **barcode/GTIN** (ties to barcode engine); reject/merge dupes |
| Barcode-based document separation | grep barcodes in page source/scan → split multi-doc scans |
| Storage paths / organized filing | template-driven R2 key paths from extracted metadata |
| Custom fields | D1 schema + per-doc JSON |
| Versioning / history + audit | R2 versioning + audit log |
| Encryption at rest | R2/D1 at rest; sensitive fields optionally app-encrypted |

- **Tools:** `doc_ingest`, `doc_search`, `doc_get`, `doc_classify`, `doc_tag`.
- **Where:** Service 2 (all work in cloud); OCR/classify via Workers AI; originals in R2.
- **Ties in:** F1 (lossless optimize before R2/KV store), barcode engine (dedup/split), OCR ladder rung.

### F3 — Form filling (agent-driven)
- **PDF forms:** read AcroForm fields, fill from supplied values, flatten optionally
  (pdf-lib WASM in the cloud Worker). Tool: `form_fill` (url/doc + field map → filled PDF in R2).
- **Web forms:** detect fields, submit programmatically via the residential node
  fetch (POST) or Browser Run for JS forms. Tool: `web_form_submit`.
- Agent-shaped: `form_inspect` first returns the field schema so an agent knows what to fill.

### F4 — Citations & provenance (cross-cutting)
Every search result, extracted fact, and generated answer carries **source
provenance**: URL, retrieved-at timestamp, exact snippet/quote, and (when archived)
the Wayback snapshot id. Answers are assembled with inline citations `[n]` → source
list. Non-negotiable for a trustworthy "next search". Applies to `kagi_search`,
`scrape`, `google`, `local_shop`, doc answers.

### F5 — Archive handling (bidirectional)
- **Unpack:** `.zip / .tar / .gz / .tgz / .bz2` (WASM inflate) → enumerate → feed each
  file into the F2 doc pipeline (OCR / classify / index) + F1 optimization. Tool: `archive_extract`.
- **Pack:** bundle a set of files/docs into `.zip`/`.tar.gz` for download/export. Tool: `archive_create`.
- Symmetric pair per the **Bidirectional** invariant. (Distinct from **web archive /
  Wayback**, which is the fetch-ladder rung + price history.)

### F6 — YouTube (residential)
- `youtube_transcript(video)` — captions/transcript (huge for research/summarize) — the flagship
- `youtube_metadata(video)` — title, channel, views, description, chapters, thumbnails
- `youtube_search(query)` — video results
- `youtube_comments(video)` — top comments
- Residential IP is what makes YouTube's transcript/InnerTube endpoints reliably
  reachable (they hard-block datacenter IPs). Transcript → feeds summarize/citations.

### F7 — Scraping as a first-class system
- **Base tool** `scrape` (done): residential fetch + cloud parse.
- **Adapter layer:** per high-value site, a thin structured extractor (JSON-LD /
  embedded JSON / DOM) returning clean fields + citations. Registry-driven so new
  sites are cheap to add. Covers the verticals above.
- **Change monitoring:** `watch(url)` → periodic residential snapshot + diff (ties Wayback + scheduled tasks).

---

## Incoming (raw directives, newest last)
- KV caching in both services. ✔ (invariant)
- QUIC in both services. ✔ (automatic)
- General tools in the cloud, proxied to residential; **no work at residential** (dumb node). ✔
- Do both Service 1 and Service 2. ✔
- Always keep the simple option. ✔ (invariant)
- **Transparently, losslessly optimize downloaded files BEFORE caching.** → Feature F1.
- **Emulate the best features of paperless-ngx** (OCR, auto-tag/classify, full-text+semantic search, archival store, dedup, barcode split). → Feature F2.
- **Adapted for agents** → cross-cutting "Agent-first" invariant.
- **Form filling** → Feature F3.
- **File size reduction** → Feature F1 (Tier C, opt-in lossy).
- **OCR** → Feature F2 + ladder rung 6 (Workers AI vision).
- **Citations** → Feature F4 (cross-cutting provenance).
- **Image compression** → Feature F1 (Tier B lossless / Tier C lossy).
- **Archive handling** (zip/tar/gz unpack → ingest) → Feature F5.
- **Bidirectional archive** (pack ↔ unpack) → Feature F5 extended.
- **Bidir everything** → cross-cutting "Bidirectional" invariant (every transform has its inverse).
- **Think big — residential proxy unlocks a LOT** → new "Residential egress unlocks" catalog (SERPs, social, local, travel, real estate, jobs, price monitoring, geo-priced data).
- **Scraping** (as a function/system) → Feature F7 (base `scrape` + adapter layer + change monitoring).
- **YouTube** (as a function) → Feature F6 (transcript/metadata/search/comments).
- **JuliaLang / function-call style / emulate those principles** → new "Design — Julia-inspired" section (generic verbs + multiple dispatch + composability + fallback + broadcasting).
- **Continually revise plan as features are added** → stated in the header; plan is refactored, not just appended.
- **Any useful transformation/query/scrape/proxy is in scope; greenlight all obvious** → new "Greenlit method catalog" (open-ended, obvious = pre-approved; only non-obvious/$/legal/destructive gets flagged).
- **Repo structure reflects it: one function per file; everything is Workers** → DONE. `sux/src/fns/<name>.ts` (one Fn each) + `registry.ts` projects them into MCP tools/list + dispatch + KV cache. Add a capability = add one file + list it in `fns/index.ts`. All bundled into the one `sux` Worker.
- **Better name — "kagi is just a function now / we invented cloudflare"** → renamed to **`sux`** (Service 2 Worker `sux/`). Kagi becomes a function inside it. Service 1 stays the lean dedicated Kagi connector.
