---
title: Claude profile snippet
status: reference
cluster: meta
type: reference
summary: "Compact snippet to paste into the claude.ai Profile so chats without skills can still route to sux tools."
tags: [sux, meta, reference]
updated: 2026-07-09
---

# Claude profile snippet — sux routing

Paste the block below into claude.ai → **Settings → Profile → "What personal
preferences should Claude consider in responses?"**. It teaches every chat to
route work through the sux connector without needing a skill. Keep it in sync
with `.claude/skills/sux/SKILL.md` (the fuller Claude Code version) — every
function in `sux/FUNCTIONS.md` should stay named here (enforced by
`scripts/check-skill-sync.mjs`).

---

I have a personal MCP connector, **sux** (a large web/data/compute toolkit). When a task needs live web data, page fetching, document work, or an edge transform, reach for sux instead of declining or answering from memory. Routing:

- **Web search:** `search` (Kagi; domain/date/file filters, lens_id: Academic=2, Forums=1, Programming=15, News360=29). Cross-engine or keyless second opinion: `web_search` (engine: kagi|ddg|google|brave|all). Synthesized answer + sources: `tavily`. "More like this" / neural: `find_similar`.
- **Fetch a page:** `scrape`; JS-heavy or bot-walled: `render` (backend:"mac" + solve for the hardest sites, e.g. Home Depot/Walmart); raw HTTP through the residential exit: `proxy` (pin an exit country with an `x-exit-geo` header); many URLs at once: `batch_fetch`; follow links breadth-first: `crawl`; trace the hop chain: `redirects`; robots.txt: `robots`; has a page changed since last check: `watch`; detect GitHub pipeline activity: `watch_pipeline`; old versions: `wayback`.
- **Page anatomy:** article text: `readability`; strip ads/chrome first: `declutter`; links/JSON-LD/text: `extract`; CSS query: `select`; regex over text: `grep`; tables: `tables`; title/OG metadata: `metadata`; emails/phones/socials: `extract_contacts`; RSS/Atom: `feed`; XML sitemap: `sitemap`; SRT↔WebVTT: `subtitles`.
- **Research / reference:** `arxiv` (CS/math/physics), `pubmed` (biomedical), `openalex`/`semantic_scholar` (any field), `crossref` (DOIs), `clinical_trials`, `stackexchange`, `reddit`.
- **Shopping / local / people:** `shop` (cross-merchant router) or `product_search` (fan one term across retailers), or a named retailer: `amazon`, `walmart`, `homedepot`, `lowes`, `bestbuy`, `ebay`, `costco`, `kroger`, `ace`, `winco` (store-locator only); grocery flyer deals by ZIP: `weekly_ad`. Local businesses: `places`. Who-is-X / org directory: `people`; deep public-source dig on one named person: `people_finder`; profile/company by URL: `linkedin`; Graph node/edge: `facebook`; UW directory lookup: `uw`. Crypto prices: `coingecko`. Videos: `youtube`.
- **Documents & media:** `pdf` (anything→PDF, merge/split/OCR; ask for as:"url" delivery), add form fields: `fillable`, image→text: `ocr`, convert/resize an image: `image_convert`, `summarize` (handles URLs and YouTube), `translate`.
- **Convert formats** (named for the target, input auto-detected): `json`, `yaml`, `csv`, `xml`; `markdown` (HTML→MD), `html` (MD→HTML).
- **Text / AI:** `classify` (zero-shot labels), `entities` (regex NER), `redact` (scrub PII), `voice` (restyle into a tone or a learned profile), `preferences` (learn + persist that writing voice for `voice` to reuse), `oracle` (teach it knowledge from text/URLs → distilled to KV, then answer problems from Claude's own knowledge + the learned base), `study` (learn WHITELISTED material you own — text/url/pdf → distilled into an `oracle` topic and WEIGHTED above the model's own knowledge + web; a compressed index, never a verbatim copy), `recall` ("what do I know about X?" — synthesized across your vault + mail + web, each claim cited; studied material outranks the model + web), `advise` (advice GATED by an authoritative source you `ingest` first, not free-floating opinion).
- **Compute:** `compress`, `archive` (zip), `encode` (base64/hex/url), `hash`, `fontcase` (case + unicode fonts), `pack` (JSON rows → token-cheap TSV).
- **Compose & persist:** chain steps server-side with `pipe`; map over many inputs with `batch` (reduce:"summarize" to get one answer back); stash blobs in `store`; small key-values via `kv_put`/`kv_get`/`kv_list`/`kv_delete`; my Obsidian vault via `obsidian`; capture url/text/search-results into the vault with `ingest` (big blobs auto-route to Dropbox); Dropbox app-folder files via `dropbox`; bulk download-and-shelve many URLs to R2 with `put`; Todoist tasks (batch-oriented) via `todoist`; BibTeX/CSL reference management over a vault References/ folder with `citation`.
- **Mail (Fastmail/JMAP):** `jmap` — the full protocol as one verb (`method`+`args` or a `calls` batch; auto session/accountId/`using`; `paginate`; `upload`/`download`; `allow_send`/`allow_destroy` gate send/destroy). The ergonomic email operations (search/read/thread/send/draft/archive/masked) are ACTIONS on the `mail` front verb — e.g. `mail({action:"search"})` — dispatching into the underlying `mail_*` namespace tools (reached only through the verb, not as their own front-door verbs); reach for `jmap` here for calendars/contacts/MaskedEmail. Autonomous inbox triage (classify + REVERSIBLE label/archive/undelete ops only) via `mail_triage`. Calendars + tasks (CalDAV): `calendar`; contacts (ContactCard): `contact`. A read-only morning digest that fans out over mail/calendar/tasks/bills into one "good morning" note (reply drafts STAGED, never sent; dormant unless armed): `briefing`.
- **Personal finance (read-only):** `monarch` — Monarch Money accounts/balances/transactions/budgets/cashflow/holdings; sux NEVER moves money (needs `MONARCH_TOKEN`).
- **Personal health (read-only):** `mychart` — Epic SMART-on-FHIR clinical records (labs/vitals/conditions/meds/notes) via `status`/`connect`/`pull`/`get`; raw FHIR + Apple Health land under a private R2 `phi/` prefix, never public share links (needs `EPIC_CLIENT_ID`/`EPIC_CLIENT_SECRET`/`EPIC_FHIR_BASE` + a one-time `/mychart/connect` login).
- **Infra / meta:** `selftest` (which fetch-ladder rungs are up), `controld` (DNS view), `tailscale` (tailnet view), `autonomy_status` (which act-on-your-behalf surfaces are armed right now — read-only booleans, never secret values). Prefer as:"url" delivery for big/binary outputs to keep the chat light. If a sux tool misbehaves, log it with `issue`; request a new capability with `suggest`. Any leaf tool not named above is reachable by name via the `fn` escape hatch (`fn({name, args})`).

## Related

- [[Functions-MOC]]
- [[sux-verbs]]
