---
name: sux-web
description: >-
  Search, fetch, render, crawl, and extract web content through the sux MCP
  connector's residential proxy and browser-rendering backends. Use whenever a
  task needs live web data — a search, a page fetch, article/table/metadata
  extraction, a site crawl, or a JS-heavy or bot-walled page (Akamai,
  PerimeterX, DataDome). Teaches when to escalate from a cheap fetch to
  render backend:mac + solve.
---

# sux-web — web search, fetch, render, crawl, extract

All tools below are exposed by the **sux** MCP connector
(`https://sux.colinxs.workers.dev/mcp`). Route web work through them instead of
a generic fetch: sux egresses from a residential IP (Tailscale proxy /
curl-impersonate node) and can drive a real browser, so it reaches pages that
block datacenter IPs.

## Choose the cheapest tool that works — escalate only when blocked

1. **Search** → `search` (Kagi, the default) or `web_search`.
2. **Static / server-rendered page** → `scrape` (raw HTML via residential proxy).
3. **JS-rendered page** → `render` `backend:cf` (headless Chromium).
4. **Bot-walled page** (empty shell, challenge, captcha) → `render` `backend:mac`,
   add `solve:true` if still challenged.

Escalate one rung at a time. Most pages are handled by `scrape`; reach for
`render` only when the content is injected by JavaScript or the site walls the
proxy.

## Search

- **`search`** — Kagi web search. Args: `query` (required), `limit` (≤50),
  `workflow` (`search`|`news`|`videos`|`podcasts`|`images`), domain scoping
  (`include_domains`, `exclude_domains`), time (`time_relative` day|week|month,
  `after`, `before`), `file_type`, `lens_id`. Returns numbered results — cite by
  number. This is the default general-purpose search.
- **`web_search`** — multi-engine search over `engine`: `kagi` (default),
  `ddg` (keyless, cheap, scraped via the proxy — good no-key default), `google`
  (real SERP rendered in the mac backend; heavier, opt-in), `brave`, or `all`
  (fan out + dedupe by URL with consensus ranking). Set `summarize:true` for a
  Workers-AI synthesis with `[n]` citations. Use `all`+`summarize` for a quick
  cross-engine briefing.
- **`find_similar`** — Exa neural search: pass a `url` for "more like this" or a
  `query` for neural web search (needs EXA_API_KEY).

## Fetch a page

- **`scrape`** — `url` (required), `method`. Raw HTML/text through the
  residential proxy (direct fallback). First choice for pages that block
  datacenter IPs but don't need JS.
- **`render`** — headless-browser fetch that executes JS. Key args:
  - `url` (required)
  - `as`: `html` (default) | `text` | `screenshot` | `pdf`
  - `wait_until`: `load`|`domcontentloaded`|`networkidle0` (default)|`networkidle2`;
    `wait_ms` (≤10000) for late JS
  - `residential` (default true — egress from a home IP), `stealth` (default true
    — realistic UA/viewport, masks `navigator.webdriver`)
  - `block_resources` to abort image/font/css/media for faster html/text
  - `backend`: `cf` (default, fast Cloudflare Browser Rendering) | `mac`
    (residential patched browser — patchright — that solves active JS bot
    challenges like the Akamai sensor)
  - `solve` (backend:mac only): force the CapSolver headed tier that auto-solves
    DataDome/reCAPTCHA/hCaptcha/Turnstile. The mac backend auto-escalates to this
    when a page looks blocked; set `true` to force it.
  - screenshots/PDFs return a content-addressed `/s/<uuid>` URL by default
    (`delivery:base64` to inline).
- **`geo_fetch`** — proxy fetch with an exit-locale hint (`geo:` e.g. `us-ca`, `de`).
- **`proxy`** — low-level raw HTTP transport (status/headers/body; `as:base64`
  for binary). The primitive under `scrape`.
- **`batch_fetch`** — fetch many URLs concurrently (`urls[]`, ≤100). `as:"url"`
  bulk-downloads each response's raw bytes to R2 and returns `/s/<uuid>` refs
  instead of inlining megabytes.

### When to use `backend:mac`

Use it for sites with an **active** JS bot wall that `cf` can't clear:
Home Depot, Walmart, Lowe's, Ace, Amazon, WinCo, Google SERP/Shopping, and any
page that returns an empty shell or a challenge under `backend:cf`. It is slower
(a real residential browser), so don't default to it — escalate only after `cf`
returns junk. If it still fails, add `solve:true`.

## Extract structure from a page

Each of these accepts a `url` (fetched via proxy) **or** raw `html` — pass HTML
you already rendered to avoid a second fetch.

- **`readability`** — main article content, dropping nav/footer/aside. Returns
  `{ title, byline?, text }`.
- **`extract`** — `what`: `links` | `jsonld` | `text`.
- **`tables`** — HTML tables → `json` (rows keyed by header) or `csv`; `index`
  picks one table.
- **`metadata`** — title/description/canonical/favicon + all `og:*`/`twitter:*`.
- **`select`** — CSS-selector query (tag/.class/#id/[attr]/descendant combinators;
  no `>`/`+`/`~`/pseudo). Returns matched text, or an attribute with `attr`.
- **`grep`** — regex over `text` or a fetched `url` (`context` lines, `max`).
- **`contacts`** — emails, phones, social profiles from a page/text.
- **`entities`** — dates/money/percent/emails/urls/phones/handles (regex NER).
- **`declutter`** — uBlock-style HTML cleanup (strips ads/consent/scripts);
  compose **before** `summarize`/`readability`/`markdown` for cleaner output.
- **`feed`** — RSS/Atom → normalized items. **`sitemap`** — sitemap(.xml) → URLs.
- **`robots`** — parse robots.txt (`path` to test an agent rule).
- **`redirects`** — trace a URL's redirect chain hop by hop.
- **`wayback`** — Internet Archive: `mode:snapshot` (closest to `at`) or
  `mode:history` (captures over time — great for change/price history).

## Crawl a site

- **`crawl`** — breadth-first from a seed `url`: follows same-origin links up to
  `depth` (≤3) and `max` pages (≤100), returning each URL + title.
  `same_origin:false` allows off-site links (still capped).

## Compose without round-trips

- **`pipe`** — chain sux tools: `steps:[{tool,args}]`, inject the previous output
  with `{{prev}}` or `{{prev.a.b}}`. Runs server-side.
  Example: `scrape` → `declutter` → `readability` → `summarize`.
- **`batch`** — map one tool over many inputs (`over`+`args` with `{{item}}`, or
  `calls[]`), with an optional server-side `reduce` (`concat`|`summarize`) or
  `reduce_with:{tool,args}`. Keeps bulk results out of context.

## Typical routes

- "What's the latest on X?" → `search` (or `web_search engine:all summarize:true`).
- "Read this article" → `scrape` (or `render` if JS) → `readability`.
- "This page is empty / blocked" → `render backend:mac` (+ `solve:true`).
- "Screenshot / PDF this page" → `render as:screenshot|pdf`.
- "Prices over time" → `wayback mode:history`.
