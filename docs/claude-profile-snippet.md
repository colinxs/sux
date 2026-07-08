# Claude profile snippet — sux routing

Paste the block below into claude.ai → **Settings → Profile → "What personal
preferences should Claude consider in responses?"**. It teaches every chat to
route work through the sux connector without needing a skill. Keep it in sync
with `.claude/skills/sux/SKILL.md` (the fuller Claude Code version) — every one
of the 88 fns should stay named here.

---

I have a personal MCP connector, **sux** (88 web/data/compute tools). When a task needs live web data, page fetching, document work, or an edge transform, reach for sux instead of declining or answering from memory. Routing:

- **Web search:** `search` (Kagi; domain/date/file filters, lens_id: Academic=2, Forums=1, Programming=15, News360=29). Cross-engine or keyless second opinion: `web_search` (engine: kagi|ddg|google|brave|all). Synthesized answer + sources: `tavily`. "More like this" / neural: `find_similar`.
- **Fetch a page:** `scrape`; JS-heavy or bot-walled: `render` (backend:"mac" + solve for the hardest sites, e.g. Home Depot/Walmart); raw HTTP through the residential exit: `proxy`; pin an exit country: `geo_fetch`; many URLs at once: `batch_fetch`; follow links breadth-first: `crawl`; trace the hop chain: `redirects`; robots.txt: `robots`; has a page changed since last check: `watch`; old versions: `wayback`.
- **Page anatomy:** article text: `readability`; strip ads/chrome first: `declutter`; links/JSON-LD/text: `extract`; CSS query: `select`; regex over text: `grep`; tables: `tables`; title/OG metadata: `metadata`; emails/phones/socials: `contacts`; RSS/Atom: `feed`; XML sitemap: `sitemap`; SRT↔WebVTT: `subtitles`.
- **Research / reference:** `arxiv` (CS/math/physics), `pubmed` (biomedical), `openalex`/`semantic_scholar` (any field), `crossref` (DOIs), `clinical_trials`, `stackexchange`, `reddit`.
- **Shopping / local / people:** `shop` (cross-merchant router) or `product_search` (fan one term across retailers), or a named retailer: `amazon`, `walmart`, `homedepot`, `lowes`, `bestbuy`, `ebay`, `costco`, `kroger`, `ace`, `winco` (store-locator only); grocery flyer deals by ZIP: `weekly_ad`. Local businesses: `places`. Who-is-X / org directory: `people`; deep public-source dig on one named person: `people_finder`; profile/company by URL: `linkedin`; Graph node/edge: `facebook`. Crypto prices: `coingecko`. Videos: `youtube`.
- **Documents & media:** `pdf` (anything→PDF, merge/split/OCR; ask for as:"url" delivery), add form fields: `fillable`, image→text: `ocr`, convert/resize an image: `image_convert`, `summarize` (handles URLs and YouTube), `translate`.
- **Convert formats** (named for the target, input auto-detected): `json`, `yaml`, `csv`, `xml`; `markdown` (HTML→MD), `html` (MD→HTML).
- **Text / AI:** `classify` (zero-shot labels), `entities` (regex NER), `redact` (scrub PII), `voice` (restyle into a tone or a learned profile), `preferences` (learn + persist that writing voice for `voice` to reuse), `oracle` (teach it knowledge from text/URLs → distilled to KV, then answer problems from Claude's own knowledge + the learned base).
- **Compute:** `compress`, `archive` (zip), `encode` (base64/hex/url), `hash`, `fontcase` (case + unicode fonts), `pack` (JSON rows → token-cheap TSV).
- **Compose & persist:** chain steps server-side with `pipe`; map over many inputs with `batch` (reduce:"summarize" to get one answer back); stash blobs in `store`; small key-values via `kv_put`/`kv_get`/`kv_list`/`kv_delete`; my Obsidian vault via `obsidian`.
- **Infra / meta:** `selftest` (which fetch-ladder rungs are up), `controld` (DNS view), `tailscale` (tailnet view). Prefer as:"url" delivery for big/binary outputs to keep the chat light. If a sux tool misbehaves, log it with `issue`.
