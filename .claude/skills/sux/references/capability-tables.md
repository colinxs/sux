## Web search

| Intent | Function |
|---|---|
| Default web search | `search` (Kagi). Scope with `include_domains`/`exclude_domains`/`time_relative`/`after`/`before`/`file_type`; `workflow: news\|videos\|podcasts\|images`; lens via `lens_id` (Academic=2, Forums=1, Programming=15, News360=29, Recipes=120, Small Web=107) |
| Cross-engine / second opinion / no-key | `web_search` — `engine: kagi\|ddg\|google\|brave\|all`; `all` fans out, merges, and can `summarize: true` |
| Synthesized answer + sources | `tavily` (`depth: advanced` for deeper) |
| "More like this page" / semantic search | `find_similar` (Exa: `url` for similar pages, `query` for neural search) |

## Fetch, extract, page anatomy

| Intent | Function |
|---|---|
| Fetch a page (bot-shy sites, datacenter-IP blocks) | `scrape` |
| JS-rendered page, screenshot, or page→PDF | `render` (`as: html\|text\|screenshot\|pdf`; `backend: mac` for Akamai-hard sites) |
| Force everything through the residential exit (raw HTTP: headers, POST, binary) | `proxy` |
| Fetch from a specific country/locale (geo-priced / geo-gated data) | `proxy` with an `x-exit-geo` header (e.g. `us-ca`, `de`) |
| Many URLs at once | `batch_fetch` (`as: "url"` = bulk download to R2) |
| Follow links breadth-first | `crawl` (depth ≤ 3, max 100) |
| Article body only (no nav/ads) | `readability` |
| Strip ads/consent/tracking, keep HTML | `declutter` (compose before summarize/markdown) |
| Links / JSON-LD / plain text from HTML | `extract` |
| CSS-selector query | `select` (subset: no `>`, `+`, `~`, pseudo-classes) |
| Regex over a page or text | `grep` |
| HTML tables → JSON/CSV | `tables` |
| Title/OG/twitter meta | `metadata` |
| Emails/phones/social links on a page | `extract_contacts` |
| Subtitles / transcript track ↔ SRT/WebVTT | `subtitles` |
| Redirect chain, robots.txt, sitemap, RSS/Atom | `redirects`, `robots`, `sitemap`, `feed` |
| Historical snapshot / change history | `wayback` |
| Detect whether a page changed since last check | `watch` |
| Detect GitHub pipeline activity (merge queues, PRs, issues, Actions) | `watch_pipeline` |

### Fetch routing modes (keep all three)

- **smart** (default) — cheapest rung first; residential only when a datacenter IP
  is blocked; direct fallback so it never hard-fails. (`scrape`.)
- **full proxy** — force everything through the residential exit, no fallback. (`proxy`.)
- **geo** — pick the exit locale for region-priced / geo-gated data. (`proxy` with an `x-exit-geo` header.)

## Research & reference

| Domain | Function |
|---|---|
| CS/math/physics preprints | `arxiv` |
| Biomedical literature | `pubmed` (PubMed query syntax, field tags OK) |
| Any-discipline scholarly graph + citation counts | `openalex` |
| DOI metadata | `crossref` |
| Abstracts + PDFs across fields | `semantic_scholar` |
| Clinical studies | `clinical_trials` |
| Programming/sysadmin Q&A | `stackexchange` (`site:` superuser, askubuntu, math, …) |
| Reddit posts / subreddits / comments | `reddit` (read-only app-only OAuth) |
| Crypto prices | `coingecko` (`search` for the id, then `price`) |
| YouTube videos | `youtube` |

Overlap rule: papers-in-general → `openalex` or `semantic_scholar`;
"preprint"/CS-math-physics → `arxiv`; anything medical → `pubmed`.

## Shopping, places, people

| Intent | Function |
|---|---|
| Product search, no retailer named | `shop` (routes over the retail fns) |
| Fan one term across many retailers | `product_search` (kroger, walmart, homedepot, … at once) |
| Named retailer | `amazon`, `walmart`, `homedepot`, `lowes`, `bestbuy`, `ebay`, `costco`, `kroger` (+ QFC/Fred Meyer/Ralphs banners via `chain`; pass `zip` for prices), `ace` |
| Grocery weekly-ad / flyer deals by ZIP | `weekly_ad` (Flipp, keyless) |
| Local businesses / points of interest | `places` (free-text, e.g. "hardware store near 98133") |
| Who is X / org directory | `people` (`extract_contacts: true` pulls emails/phones from the top hit; `source: usagov` for federal agencies) |
| Deep-dig one named person across public sources | `people_finder` (fans UW directory + `linkedin` + `facebook` + `web_search` into one deduped profile; public-listed data only) |
| LinkedIn profile/company (URL in hand) | `linkedin` |
| Facebook Graph node/edge | `facebook` |
| University of Washington person lookup | `uw` (public faculty/staff/student directory at directory.uw.edu; also feeds `people_finder`) |

Retailer note: amazon/walmart/homedepot/lowes/ace ride the mac render backend —
slow, best-effort; bestbuy/ebay/kroger are official APIs — prefer them when the
retailer is interchangeable.

## Documents & media

| Intent | Function |
|---|---|
| Anything → PDF; merge/split/pages/bookmarks/metadata/forms/OCR | `pdf` (use `as: "url"` for delivery) |
| Add fillable form fields to a PDF | `fillable` |
| Text out of an image | `ocr` |
| Convert/resize an image (png/jpeg/webp/avif) | `image_convert` (Images binding) |
| Summarize a page, long doc, or YouTube video | `summarize` (pass `url` — Kagi handles YouTube natively; `text` for raw input) |

## Text & data transforms

Converters are named for their **target** format and auto-detect the input — e.g.
call `json` with CSV or YAML in, `csv` with JSON in.

| Intent | Function |
|---|---|
| Anything → JSON (auto-detects yaml/csv/xml) | `json`; inverses: `yaml`, `csv`, `xml` |
| HTML ↔ Markdown | `markdown` (HTML→MD), `html` (MD→HTML) |
| Translate | `translate` (m2m100, `to` code) |
| Zero-shot label text | `classify` |
| Dates/money/emails/URLs/phones from text | `entities` (regex, no model) |
| Scrub PII | `redact` |
| Restyle text into a tone or a learned voice | `voice` (rewrites into a `style` and/or a saved `profile`, preserving facts/names/links) |
| Teach / persist a preferred writing voice | `preferences` (`action: learn` appends an exemplar and re-distills a style spec in KV; `voice` folds it back) |
| "What do I know about X?" — recall from YOUR life, cited | `recall` (`question`; `sources`: vault\|mail\|web, default all → fans out across your Obsidian notes + Fastmail + the web and synthesizes ONE answer with each claim tagged [vault:…]/[mail:…]/[web]; READ-only, grounded-not-invented, graceful per-source degrade) |
| Teach a knowledge base, then answer from it | `oracle` (`knowledge`: text/URL/book → distilled + saved to KV under `topic`; `problem` alone answers using Claude's own knowledge + the learned KB; `action: get\|list\|forget`) |
| Learn WHITELISTED material you own, weighted above the model + web | `study` (`source` + `kind`: text\|url\|pdf → distills a document you own/have the right to use into a whitelisted `oracle` topic; `oracle`/`recall` then rank it above the model's own knowledge and [web], cited [whitelisted:topic]; a compressed index, never a verbatim copy; `action: learn\|list\|forget`) |
| Personal advice GATED by a source you trust, not free-floating LLM opinion | `advise` (grounds each recommendation in an authoritative source you `ingest` first, and cites what it leaned on) |
| Case/unicode-font conversion | `fontcase` |
| base64/hex/url, hashes, compression, zip/gzip | `encode`, `hash`, `compress`, `archive` |
| JSON rows → token-cheap TSV | `pack` |

## Composition, storage, memory

| Intent | Function |
|---|---|
| Chain tools server-side (A's output → B) | `pipe` (`{{prev}}` / `{{prev.path}}` feeds each step) |
| Same tool over many inputs, optionally reduced | `batch` (`over` + `args` template, `reduce: concat\|summarize`, or `reduce_with` a tool) |
| Stash/retrieve blobs (content-addressed R2) | `store` |
| Small persistent key-values | `kv_put`, `kv_get`, `kv_list`, `kv_delete` |
| Todoist tasks | `todoist` (`action: list/add/update/complete/reopen/delete/projects`; needs `TODOIST_TOKEN`; delete is confirm-gated; NOTE: `due_string` via update on a recurring task replaces its recurrence — reschedule a single occurrence in the app) |
| Reference management — BibTeX/CSL + a vault References/ library | `citation` (`action: format` entries→BibTeX+CSL, `capture` a type:citation note, `export` References/*.md→a combined .bib; handle-first PDFs) |
| Obsidian vault: list/read/search/append/write/edit/delete notes | `obsidian` (default `backend: git`; `edit` = surgical find/replace; `tools`/`call` need `backend: remote`; mutating actions refuse dot-prefixed paths; reads KV-cached with git-HEAD validation + Mac-asleep fallback on remote `read`) |
| Capture url/text/search-results into the vault (provenance note in Inbox/; blobs ≤1MB → vault attachment, larger → public Dropbox link) | `ingest` (`url` \| `text` \| `query`; `summarize`/`compress` passes; `blobs: dropbox` forces Dropbox; explicit `path` overrides Inbox and overwrites — default paths never do) |
| Dropbox app-folder files (human-facing blob store; syncs to devices) | `dropbox` (`op: put/get/list/delete/share`; paths relative to /Apps root; `list` paginates via `cursor`; put returns a PUBLIC anyone-with-the-link URL) |
| Fastmail email/calendars/contacts over the full JMAP protocol | `jmap` (raw conduit: `calls:[[method,args,callId]]` or `method`+`args`; auto session/accountId/`using`; `paginate` past page limits; `upload`/`download` blobs; `allow_send`/`allow_destroy` gate send/destroy; needs `FASTMAIL_TOKEN`). The ergonomic mail operations (search·read·thread·send·draft·archive·masked) are ACTIONS on the `mail` front verb — `mail({action:"search"})` — that dispatch into the underlying `mail_*` namespace tools (reached only through the verb, never as standalone front verbs or `fn` leaves); use `jmap` here when you need the raw protocol (MaskedEmail, calendars, contacts). |
| Autonomous inbox triage — classify messages and (when armed) act | `mail_triage` (armed mode uses REVERSIBLE ops ONLY — add/remove labels, archive/unarchive, undelete; never sends or hard-deletes) |
| Morning briefing — read-only fan-out over unread/important mail, calendar, tasks, and bill/deadline cues → ONE "good morning" digest appended to today's Daily note | `briefing` (reply drafts are STAGED to Drafts for approval, NEVER sent; DORMANT unless `BRIEFING_ENABLED`, and stages zero drafts until `BRIEFING_STAGE_DRAFTS` is ALSO set; `dry_run` mutates nothing; each source degrades independently) |
| Monarch Money — READ-ONLY personal finance (accounts, balances, transactions, budgets, cashflow, categories, holdings) | `monarch` (sux NEVER moves money — no transfer/trade op exists and the raw `graphql` escape refuses mutations; needs `MONARCH_TOKEN`) |

## Infrastructure & meta

| Intent | Function |
|---|---|
| Probe the fetch ladder — which rungs are up | `selftest` |
| Read your ControlD DNS setup (read-only) | `controld` |
| Read your Tailscale tailnet control plane | `tailscale` |
| Report a bug / wrong output from a sux tool | `issue { tool, text }` (lands in the server-side feedback log) |
| Request a new sux capability / feature | `suggest { text }` (logs a feature request to the same server-side feedback log) |
| Which act-on-your-behalf surfaces are ARMED right now | `autonomy_status` (read-only booleans — mail-triage / Mode-B Dropbox writes / self-improve loop / cron trigger, each with its consequence + reversibility; never secret VALUES, never cached) |
