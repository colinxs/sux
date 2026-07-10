---
title: sux verb vocabulary
status: designed
cluster: namespaces
type: proposal
summary: "Collapses ~90 leaf fns into ten front-door verbs + batch/pipe; handle discipline (references-not-payloads) makes the shared fan-out/reduce cheap."
tags: [sux, namespaces, designed]
updated: 2026-07-09
---

# sux Verb Vocabulary — the /mcp universal namespace

**Status:** proposal · **Scope:** the stateless query plane of the four-namespace system
**Grounded in:** `sux/src/registry.ts`, `sux/src/fns/index.ts`, `sux/src/proxy.ts`, `sux/src/fns/render.ts`, `sux/src/fns/oracle.ts`

---

## 0. Framing

sux is the **stateless query plane** of a four-namespace system:

```
        ┌──────────────────────── sux (compute) ────────────────────────┐
        │  reads OUT to the web   ·   reads IN to three stateful stores   │
        └───────────────┬───────────────┬───────────────┬────────────────┘
                        │               │               │
                  vault=notes      files=blobs      mail=Fastmail
                 (obsidian ns)   (dropbox/R2 ns)    (JMAP ns)
```

sux holds no durable state, so it can **run anywhere** (the execution ladder) and
**leave from anywhere** (the egress ladder). The three stores are their own MCP
namespaces with their own **write** algebra (designed separately). `oracle` is the
crown of sux and the **read** half of the cross-store algebra: find + synthesize +
cite, never mutate.

### The one locked rule — references, not payloads

Every verb obeys the cross-cutting handle discipline:

- A verb that **finds/lists** returns **handles** (urls / blob-ids / vault paths /
  message-ids) + light metadata. Never the bytes or full bodies — unless a caller
  explicitly reads **one** record.
- A verb that **stores/transforms** **accepts a handle** and does the fetch/move/write
  **server-side**, so large data never transits model context.
- Every list-producing verb has a **batch form** that takes a *list* of references and
  fans out server-side in **one call** (built on the `batch` / `batch_fetch`
  combinators). This is what lets agentic skills do bulk: 100 items = a few calls,
  zero bytes in context.

Each verb section below states, explicitly: **handle in / handle out / batch form.**

---

## 1. The verbs at a glance

Ten front-door verbs + two combinators. Colin's named examples (`search`, `fetch`,
`shop`, `oracle`) are all first-class. Every one of the 90 user fns is reachable
through **exactly one** verb; the same fns remain individually callable as raw
escape-hatches. `selftest` (the 91st import) is a CI diagnostic and is **not** a verb.

| Verb | Intent | Selector | Rolls up | Handle out |
|---|---|---|---|---|
| **search** | Discover across web + scholarly + community corpora | `sources` | search·web_search·tavily·find_similar · arxiv·pubmed·openalex·crossref·semantic_scholar·clinical_trials·stackexchange·reddit | urls + metadata |
| **fetch** | Retrieve a resource through the egress ladder | `origin` × `op` | proxy·scrape·geo_fetch·render·batch_fetch·crawl·redirects·robots·sitemap·feed·wayback·watch | text (single read) / blob-id |
| **extract** | Parse structure out of a page/handle | `what` | extract·readability·select·grep·tables·metadata·contacts·entities·declutter | small JSON |
| **transform** | Convert bytes/format + Workers-AI text ops | `op` | json·csv·xml·yaml·markdown·html·pack·subtitles·fontcase·encode·hash·compress·archive · summarize·translate·classify·redact·voice·ocr·preferences | inline / blob-id |
| **shop** | Retail/commerce search + detail | `stores` | shop·product_search·amazon·walmart·homedepot·lowes·costco·ace·kroger·bestbuy·ebay·weekly_ad·winco | product refs |
| **media** | Build a binary artifact from handles | `op` | pdf·fillable·image_convert | blob-id |
| **people** | Person / org / place / domain-data lookup | `kind`,`sources` | people·people_finder·places·linkedin·facebook·youtube·coingecko | profile/url refs |
| **store** | Persist + capture (write-through to R2/KV/Dropbox/vault) | `backend` | store·kv_get·kv_put·kv_list·kv_delete·dropbox·obsidian·ingest | uuid / path / key |
| **oracle** | Cross-store find + synthesize + cite (READ half) | `sources` | oracle (+ reaches obsidian·dropbox·store·jmap·search) | answer + citations[] |
| **infra** | Control-plane read + feedback | `op` | tailscale·controld·issue | config JSON |
| **batch** *(combinator)* | MAP a verb over inputs + server-side REDUCE | — | batch | list / reduced |
| **pipe** *(combinator)* | COMPOSE verbs into a pipeline (`{{prev}}`) | — | pipe | last step |

> **Naming is bidirectional:** the verb is the front door; the fn is the leaf. `shop`
> the verb dispatches to `shop` the fn (a store router) and to `amazon`/`lowes`/… — the
> collision is intentional. Raw leaf calls stay legal for escape-hatch work.

---

## 2. Per-verb design

### 2.1 `search` — discovery

> One line: neural + keyword + scholarly + community discovery, one selector, deduped.

```ts
search(
  query,                       // string | string[]      ← array = batch fan-out
  sources = ["web"],           // ["web","similar","scholar","community","news"]
  limit = 10,
  filter,                      // (row) => boolean        server-side map/filter
  time_relative,               // recency window
  merge = "dedupe",            // reduce across sources: dedupe | rank | concat
  proxy = false                // opt-in residential egress for the Kagi query
)
```

**Selector `sources` → fns:**

| source | dispatches to | egress |
|---|---|---|
| `web` | `web_search` (engine=kagi\|ddg\|google\|brave\|all), `search` (Kagi workflows), `tavily` | direct (kagi) · residential (`proxy:true`, ddg default) · mac (google SERP) |
| `similar` | `find_similar` (Exa: url→more-like-this, or neural query) | direct |
| `scholar` | `arxiv`, `pubmed`, `openalex`, `crossref`, `semantic_scholar`, `clinical_trials` | direct |
| `community` | `reddit`, `stackexchange` | residential (reddit `.json`) · direct (SE) |
| `news`/`videos`/`podcasts`/`images` | `search` (`workflow` arg) | direct |

**Handle out:** rows of `{url, title, snippet, source, score}` — **references only, never
page bodies**. To read a body, hand the `url` to `fetch`/`extract`/`oracle`.
**Handle in:** `find_similar` accepts a `url` handle (server-side neural lookup).
**Batch form:** `query: string[]` → server-side fan-out over queries × sources in one
call; `merge` reduces. Under the hood this is `batch(search, over=queries)`.
**Cacheable:** yes — web `ttl300`, scholar `ttl1800`, `find_similar` `ttl900`.
**Algebra:** parallel fan-out across sources (shared `smartFetch` concurrency);
`filter` = map/filter; `merge` = reduce; results **augment** each other (dedupe on url).

---

### 2.2 `fetch` — retrieval through the egress ladder

> One line: get a resource — raw, rendered, crawled, or archived — from whichever
> exit gets past the wall.

```ts
fetch(
  url,                         // string | string[]      ← array = batch_fetch
  origin = "auto",             // EGRESS selector: auto | cloud | router | local | mac
  op    = "get",               // get | crawl | redirects | robots | sitemap | feed | wayback | watch
  as    = "text",              // text | html | json | url(blob) | screenshot | pdf
  method = "GET", headers, body,
  render = false,              // force JS render (escalates origin toward mac)
  ...op_args                   // depth/max for crawl, mode/at for wayback, selector/label for watch, geo for locale
)
```

**Selector `op` → fns:** `get`→`proxy`/`scrape`/`geo_fetch`/`render`/`batch_fetch`,
`crawl`→`crawl`, `redirects`→`redirects`, `robots`→`robots`, `sitemap`→`sitemap`,
`feed`→`feed`, `wayback`→`wayback`, `watch`→`watch`. `render:true` or `origin:"mac"`
routes to `render` (headless Chromium, backend cf\|mac). `geo` sets the exit-locale
hint (`geo_fetch`).

**Handle discipline (the important part):**
- `as:"text"|"html"|"json"` → returns the body **only because the caller asked to read
  this one** resource.
- `as:"url"|"screenshot"|"pdf"` and **all** array/bulk fetches → the bytes are streamed
  **server-side into R2** and the call returns a **blob-id handle** (`/s/<uuid>`), never
  the bytes. This is the rule that keeps a 50-URL download at ~zero context cost.

**Batch form:** `url: string[]` → `batch_fetch` (~8 concurrent), returns a **list of
blob-ids** (with `as:"url"`) or a list of texts. `crawl` is the recursive batch form.
**Cacheable:** most yes; `redirects` and `watch` **false** (live / stateful).
**Algebra:** `batch_fetch`/`crawl` = parallel fan-out; `watch` = compress-to-KV
(hash vs last-seen); `wayback` augments a live fetch with history.

---

### 2.3 `extract` — parse structure

> One line: pull links / tables / article / contacts / entities out of a handle,
> fetching server-side.

```ts
extract(
  source,                      // url (handle) | html | text     ← array = batch
  what = "text",               // text|links|jsonld|readable|tables|meta|contacts|entities|select|grep|declutter
  selector,                    // for what=select (CSS)
  pattern, context, max,       // for what=grep (regex)
  format = "json", index       // for what=tables
)
```

**Selector `what` → fns:** `links|jsonld|text`→`extract`, `readable`→`readability`,
`select`→`select`, `grep`→`grep`, `tables`→`tables`, `meta`→`metadata`,
`contacts`→`contacts`, `entities`→`entities`, `declutter`→`declutter`.

**Handle in:** accepts a `url` handle → fetches **server-side via residential**
(`proxy.ts` url-mode) so the raw HTML never enters context; you get back only the small
extracted structure. **Handle out:** compact JSON (links list, table rows, contact set…).
**Batch form:** `source: string[]` → fan out one `what` over many urls in one call
(`batch(extract, over=urls)`) — e.g. tables from 50 pages → one merged reduce.
**Cacheable:** yes. **Algebra:** each url-mode extract is fetch→parse (**augment**);
`grep`/`select` are map/filter; batch is fan-out + reduce.

---

### 2.4 `transform` — bytes, formats, and Workers-AI text

> One line: content in → transformed content out. Deterministic format/byte ops **and**
> AI text ops, one `op` selector.

```ts
transform(
  data,                        // inline value | blob-id handle | url
  op,                          // see below
  to, from,                    // format targets (e.g. csv→json, en→fr)
  ...op_args,                  // style/max_words, labels, types, codec, algo, direction…
  as                           // "url" to return a blob-id for large output
)
```

**Selector `op` → fns.** Two banks under one roof (both are "content → content"):

| bank | ops → fns |
|---|---|
| **format / byte** | `json`·`csv`·`xml`·`yaml`·`markdown`·`html`·`pack`·`subtitles`·`fontcase`·`encode`·`hash`·`compress`·`archive` |
| **Workers-AI text** | `summarize`·`translate`·`classify`·`redact`·`voice`·`ocr`·`preferences` |

**Handle in:** large `data` may be a **blob-id** (or `url`) — `transform` fetches it
server-side (e.g. `ocr` on an image handle, `summarize` on a url via Kagi Universal
Summarizer). **Handle out:** small results inline; large results (`archive`, `compress`,
`pdf`-ish blobs) → **blob-id** with `as:"url"`. **Batch form:** `batch(transform,
over=[...])` — e.g. translate 40 rows, reduce=concat.
**Cacheable:** deterministic ops yes (`csv`/`encode` `ttl86400`); AI ops yes but costed
(cost2); `preferences` **false** (stateful KV, feeds `voice`).
**Algebra:** `pack` **is** compress-to-KV for token saving; `voice`+`preferences` =
augment (learned profile restyles text); AI ops map over batch, `reduce_with` a tool.

> Placement notes: `subtitles` lives here (pure text converter, not media); `ocr` lives
> here (Workers-AI text op, not media); `preferences` is the stateful store behind
> `voice` — kept in this verb because its purpose is voice-spec distillation.

---

### 2.5 `shop` — commerce (existing router, promoted)

> One line: search/price a product across retailers; egress auto-picked per store.

```ts
shop(
  query,
  stores = ["all"],            // ["home depot","lowes","amazon","walmart","costco","ace",
                               //  "kroger","bestbuy","ebay","winco","weekly_ad"]
  action = "search",           // search | detail
  filter,                      // (row) => boolean   e.g. r => r.rating > 4.5
  zip, limit = 10
)
```

**Selector `stores` → fns:** `shop` (single-store router) and `product_search`
(multi-store fan+merge) dispatch to `amazon`, `walmart`, `homedepot`, `lowes`, `costco`,
`ace`, `kroger`, `bestbuy`, `ebay`, `weekly_ad`, `winco`.
**Egress (delegated, per store):** mac render (`amazon`, `walmart`, `homedepot`, `lowes`,
`ace`, `winco` — Akamai/PerimeterX/reCAPTCHA); residential curl-impersonate (`costco` —
JA3 wall); direct API (`kroger`, `bestbuy`, `ebay`, `weekly_ad`, `facebook`-style).
**Handle out:** product **references** `{url, title, price, rating, store, id|asin|sku}`
— not full PDPs. `action:"detail"` = an explicit single read of one product.
**Batch form:** `product_search` **is** the fan-out (term × retailers, server-side
merge) — one call covers N stores. **Cacheable:** yes (cost3/5, `ttl300` on several).
**Algebra:** fan-out across stores; `filter` = map/filter; merge = reduce/dedupe.

---

### 2.6 `media` — build a binary artifact

> One line: assemble PDFs / fill forms / convert images from handles; get a blob-id back.

```ts
media(
  op,                          // pdf | fillable | image_convert
  sources,                     // blob-ids / urls (handles) — the inputs
  ...op_args,                  // pages/toc/fields for pdf; fields/flatten for fillable; to/width/fit for image
  as = "url"                   // returns a blob-id
)
```

**Selector `op` → fns:** `pdf`, `fillable`, `image_convert`.
**Handle in:** `sources` are **handles** (blob-ids or urls); `media` fetches/merges
server-side. **Handle out:** the built artifact is written to R2 → **blob-id**
(`/s/<uuid>`); bytes never transit context. **Batch form:** `batch(media, over=[...])`
(e.g. convert 30 images). **Cacheable:** yes. **Algebra:** `pdf` merge = reduce over
source handles; `image_convert` maps.

---

### 2.7 `people` — person / org / place / domain-data

> One line: resolve a person, place, org, profile, or data-API entity to a reference.

```ts
people(
  query,                       // name | org | place | @handle | url
  kind = "person",             // person | place | org | profile | social | video | crypto
  sources,                     // ["uw","linkedin","facebook","web"]  (for aggregation)
  extract_contacts = false
)
```

**Selector `kind`/`sources` → fns:** `person`→`people`/`people_finder`,
`place`→`places`, `profile`→`linkedin`, `social`→`facebook`, `video`→`youtube`,
`crypto`→`coingecko`.
**Egress:** direct APIs (`places`, `facebook`, `youtube`, `coingecko`); mac render
(`linkedin`, and `people_finder`'s scrape legs); residential (`people`
`extract_contacts`).
**Handle out:** entity **references** `{name, url|profile_url, snippet}`; contact
details opt-in. **Batch form:** `people_finder` **is** the aggregator fan-out
(name × sources); array `query` fans further via `batch`.
**Cacheable:** yes (cost3/5, `ttl120` coingecko, `ttl300` facebook).
**Algebra:** `people_finder` = fan-out + merge; contacts = augment.

> Ambiguous placements (noted, not hidden): `youtube` and `coingecko` are domain-data
> APIs, not "people." They ride here as `kind=video|crypto` rather than spawning a
> one-fn `data` verb. Flagged for a future split if the data-API set grows.

---

### 2.8 `store` — persist + capture (write-through)

> One line: sux's thin write-through into R2 / KV / Dropbox / vault, plus the canonical
> capture verb `ingest`. (The **full** stateful stores are their own namespaces.)

```ts
store(
  op,                          // put | get | list | delete | share
  backend = "r2",              // r2 | kv | dropbox | vault | ingest
  data | base64 | id | key | path,
  ttl_seconds, ...
)
```

**Selector `backend` → fns:** `r2`→`store`; `kv`→`kv_get`/`kv_put`/`kv_list`/`kv_delete`;
`dropbox`→`dropbox`; `vault`→`obsidian` (git/remote/local + stateful MCP handshake);
`ingest`→`ingest` (capture url/text/query → vault, summarize/compress, blob routing).
**Handle in:** accepts blob-ids / urls — `ingest` **fetches the url server-side**,
summarizes/compresses, routes blobs, and writes to the vault; the bytes never touch
context. **Handle out:** the persisted **handle** — R2 `uuid` (`/s/<uuid>`), KV `key`,
Dropbox `path`, or vault note `path`. **Batch form:** `batch(store, over=[...])` for
bulk put/ingest. **Cacheable:** **false** (all stateful).
**Algebra:** `ingest` = augment (summarize/compress-to-KV before write); this is the
**write** boundary — sux originates the persistence, the store namespaces own the state.

> Relationship to the four namespaces: `store` is the **sux-side convenience** for
> writing into R2/KV/Dropbox and the vault. The rich per-store write algebra (vault
> ops, mail send, etc.) lives in those namespaces and is designed separately. `oracle`
> is the **read** counterpart across the same stores.

---

### 2.9 `oracle` — cross-store find + synthesize + cite (the crown)

> One line: ask one question, fan out across vault + files + mail + web **server-side**,
> synthesize, and cite per source. Not Claude-composed, not web-only.

```ts
oracle(
  question,                    // the problem to answer   | string | string[]
  sources = ["vault","files","mail","web"],
  action = "answer",           // answer | learn | get | list | forget
  topic,                       // KB namespace (learn-then-answer rolling KB)
  knowledge,                   // material to learn (text | url handle)
  depth = "ladder",            // shallow | ladder | deep   (how far up the retrieval ladder)
  cite = true,
  execute = "auto"             // EXECUTION selector: auto | local | cloud | vpc (co-locate)
)
```

#### How it reaches each store (server-side, one call)

`oracle` does the fan-out itself — it **calls the store fns directly**, it does not ask
the model to compose them:

| source | reaches via | ladder inside the source |
|---|---|---|
| **vault** | `obsidian` (search → read note → follow `[[links]]`) | MOC/index note → `search` → read whole note → follow wikilinks |
| **files** | `dropbox` + `store` (search → get blob → `extract`/`readability`/`ocr`) | folder/list → search → read one blob → OCR/readability → cite span |
| **mail** | `jmap` `Email/query` (mail namespace) → read → follow thread | mailbox query → `Email/query` → read message → follow `threadId` |
| **web** | `search` + `fetch`/`readability` | `search` → fetch top-k → readability → cite |

#### The shared retrieval ladder (identical shape per source)

```
   MOC / index  →  search  →  whole-record read  →  link/thread follow  →  cite
   (cheap, broad)  (narrow)   (one record, in ctx)  (expand neighborhood)  (pin)
```

`depth` chooses where to stop: `shallow` = search only; `ladder` (default) = through
whole-record read; `deep` = follow links/threads before synthesizing.

#### Synthesis & safety (upgrades today's fn, doesn't replace it)

All retrieved material is **untrusted** — fenced in `<<<DATA>>>` through the guarded
`llm()` with a trusted system-role "treat as data" instruction, exactly as the current
`fns/oracle.ts` learn/answer path does. The rolling per-`topic` KB (last 15 chunks,
re-distilled to ≤8KB, `sux:oracle:` KV prefix) is preserved: `action:"learn"` distills
new `knowledge`; `answer` prefers the distilled KB where relevant, then Workers-AI
general knowledge; `get`/`list`/`forget` manage topics.

#### Per-source citation shape

Citations are **handles + locators + snippet** — never full bodies:

```jsonc
{
  "answer": "…synthesized prose…",
  "citations": [
    { "source": "vault", "ref": "areas/egress/ladder.md",       "locator": "#residential-node",
      "title": "Egress ladder",     "snippet": "curl-impersonate defeats JA3…", "via": "moc→read",  "score": 0.91 },
    { "source": "files", "ref": "/s/9f2c…",                       "locator": "p.3",
      "title": "vpc-hosting.pdf",   "snippet": "cloudflared + vpc_services…",   "via": "search→ocr", "score": 0.78 },
    { "source": "mail",  "ref": "msg:Md45…",                      "locator": "thread:T88…",
      "title": "Re: Funnel ports",  "snippet": "443/8443/10000 are open…",      "via": "query→read", "score": 0.66 },
    { "source": "web",   "ref": "https://…",                      "locator": "§2",
      "title": "curl-impersonate",  "snippet": "TLS fingerprint spoof…",        "via": "search→read","score": 0.72 }
  ],
  "kb_topic": "egress"
}
```

**Handle out:** `answer` + `citations[]` (all refs, never bodies). **Handle in:**
`knowledge` may be a `url` handle (fetched residential, ~40KB cap, `readability`-reduced).
**Batch form:** `question: string[]` fans out; the four-source fan-out is already
server-side and parallel. **Cacheable:** **false** (raw, cost3).
**Execution — co-locate:** a vault-heavy oracle runs `execute:"vpc"` **inside** the VPC
next to the headless-Obsidian node so the vault query is node-local ("vpc maybe
faster"); web sub-queries still climb the egress ladder from there. See §3.
**Algebra:** the whole verb **is** parallel fan-out + map/filter/reduce + augment +
compress-to-KV — using the shared engine, not a private copy.

---

### 2.10 `infra` — control-plane read + feedback

> One line: read Tailscale / ControlD config; log an issue.

```ts
infra(op, action, ...)         // op: tailscale | controld | issue
```

**Selector `op` → fns:** `tailscale` (devices/device/dns/keys), `controld`
(profiles/devices/rules), `issue` (log a sux bug to feedback KV).
**Handle out:** config JSON (read-only) / ack. **Cacheable:** `tailscale` `ttl120`,
`controld` `ttl300`, `issue` **false**.
**Note:** `issue` is described as the pair of a `suggest` fn that **does not exist** in
the registry — dangling reference; kept as a raw leaf under `infra`.

---

### 2.11 Combinators — `batch` & `pipe` (the algebra layer)

These are **not** leaf egress verbs — they are the **shared map/reduce/pipeline engine**
every verb's "batch form" is built on. Exposed as raw meta-verbs for arbitrary
composition an agent needs beyond a single verb's built-in batch form.

```ts
batch(tool, calls | (over + args), reduce = "concat", reduce_with)  // MAP + server-side REDUCE
pipe(steps = [ { tool, args /* with {{prev}} injection */ } ])       // COMPOSE
```

**Cacheable:** false (raw). **Rule:** verbs delegate their fan-out/reduce to these — no
verb reimplements concurrency or reduction privately (see §5).

---

## 3. Execution ladder (where CODE runs) — orthogonal to egress

sux is stateless, so the same call can execute in three places. This is **where the
code runs**, distinct from **where the outbound request leaves** (§4).

| Execution site | What it is | Best for |
|---|---|---|
| **local** | Desktop/Claude session, in-process code exec | zero-hop, private, instant; no cloud round-trip |
| **cloud** | Cloudflare Worker | always-on, default; the deployed `sux` worker |
| **vpc** | Private VPC node (cloudflared + `vpc_services`) | co-located next to a store (headless Obsidian) |

**Co-locate rule (Colin):** run sux **where the queried store lives.** An `oracle` over
the vault should `execute:"vpc"` so the `obsidian` query is **node-local** to the
headless-Obsidian box — the store round-trip collapses from Worker→Funnel→node to
in-VPC ("vpc maybe faster"). A pure-web `search` has no local store, so `cloud` (or
`local` for privacy) is fine.

---

## 4. Egress ladder (where the request LEAVES) — the third pillar

Governed by `smartFetch` / `willProxy(env,url,route)` in `proxy.ts`, with a hard SSRF
guard (`isBlockedTarget`) and CR/LF header-injection guard on both paths; every
`tools/call` ships an egress-audit line to Loki. `Route = auto | proxy | direct`.

**The `origin` selector maps to four paths; cheapest → heaviest, auto-escalating on
block (captcha / 403 / JS-challenge):**

```
 cloud(direct)  →  router(residential curl)  →  mac(real browser)
   Path 1              Path 2                       Path 4
```

| `origin` | Path | Mechanism | Owning fns |
|---|---|---|---|
| **cloud** | 1 · CF datacenter IP | plain `fetch()`; taken on `route:"direct"`, `DIRECT_HOST_RE` allowlist (kagi, cloudflare-dns, dns.google, ipwho.is, ip-api), or as the fallback rung (`proxy_fallback`/`binary_refetch`) | `tavily`,`youtube`,`places`,`kroger`,`bestbuy`,`ebay`,`facebook`,`coingecko`, all research (B); Kagi default in `search`/`web_search`; `render backend:cf residential:false` |
| **router** | 2 · residential OpenWRT node (100.98.238.70) | `fetchViaTailscale` → HMAC over Funnel → CGI `fetch.sh` + **curl-impersonate** (defeats JA3/TLS walls; HMAC on query string per uhttpd header-drop); real residential IP | `proxy`,`scrape`,`geo_fetch`,`batch_fetch`,`redirects`,`crawl`,`watch`,`feed`,`sitemap`,`robots`,`reddit`,`costco`,`wayback`, url-mode of all `extract` fns, `oracle` url-learn, `ingest`, `people` contacts; opt-in `search`/`web_search` (`proxy:true`); default for `ddg` |
| **local** | 3 · desktop session network | client side of the topology; **the Worker cannot originate here** | **zero owning fns** — only relevant when the local client follows a returned `/s/<uuid>` |
| **mac** | 4 · patchright/Chromium on the residential Mac (`:8790`/`:443`) | `renderViaMac` → HMAC POST `MAC_RENDER_URL/render`; runs JS to defeat **active** Akamai/PerimeterX; `solve:true` forces CapSolver headed tier | `render backend:mac`; `amazon`,`walmart`,`homedepot`,`lowes`,`ace`,`winco`,`linkedin`; `web_search engine=google` (SERP now JS-gated); routed by `shop`/`product_search`/`people_finder` |

**Composition with §3:** execution × egress are independent. A verb executing on the
**cloud** Worker can still egress via **router** or **mac**. An `oracle` executing in the
**vpc** (co-located with the vault) still climbs the **egress** ladder for its `web`
sub-queries. `origin:"auto"` lets `smartFetch` pick and auto-escalate; explicit `origin`
pins a rung.

---

## 5. The shared algebra (one engine, no private copies)

Every verb draws on the same four primitives — implemented once in the combinators /
`smartFetch` / cache, never reimplemented per verb:

- **Parallel fan-out** — `batch` / `batch_fetch` (~8 concurrent) + `smartFetch`
  concurrency. Every list-producing verb's *batch form* is `batch(verb, over=[...])`.
  `product_search`, `people_finder`, `crawl`, and `oracle`'s four-source fan-out are all
  this one engine.
- **Map / filter / reduce** — verbs take a `filter` predicate (map/filter) and a `merge`
  / `reduce` (`concat` | `summarize` | tool via `reduce_with`). `shop(filter=…)`,
  `search(merge=…)`, `batch(reduce=…)` are the same reduce.
- **Augment** — enrich a reference with a second pass: `people extract_contacts`,
  `voice`+`preferences`, `wayback` over a live fetch, `oracle` KB over general
  knowledge. Augmentation returns a richer handle, not a bigger payload.
- **Compress-to-KV** — shrink before it crosses a boundary: `pack` (token-saving rows),
  `watch` (hash vs last-seen), `ingest`/`oracle` distill-to-KV (≤8KB rolling KB),
  `store backend:kv`. The KV cache (`cacheable` ttls) is the shared substrate.

The handle discipline (§0) is what makes the algebra cheap: fan-out returns 100 handles,
reduce runs server-side, and only the final synthesized/cited result crosses into
context.

---

## 6. Worked examples

**1 · Retail with a filter (Colin's example)**
```ts
shop("Makita", stores=["home depot","lowes"], filter=r => r.rating > 4.5)
// → product_search fans over homedepot+lowes (both mac-render, Akamai/React),
//   merges, filters rating>4.5, returns refs {url,title,price,rating,store}. No PDPs.
```

**2 · Cross-store oracle, co-located in the VPC**
```ts
oracle(
  "What did we decide about the egress ladder and why does costco not use the mac backend?",
  sources=["vault","files","mail","web"],
  execute="vpc"              // run next to headless-Obsidian; vault query is node-local
)
// → obsidian search→read→follow [[links]]; dropbox/store search→ocr; jmap Email/query→thread;
//   web search→readability. Synthesizes, returns answer + citations[] (handles+locators+snippets).
```

**3 · Batched multi-source discovery, references only**
```ts
search(
  ["curl-impersonate JA3 bypass", "Akamai sensor PerimeterX"],
  sources=["web","community","scholar"]
)
// → fan-out over 2 queries × {web_search, reddit+stackexchange, semantic_scholar…},
//   deduped to a flat list of {url,title,snippet,source}. Zero bodies in context.
```

**4 · Egress escalation + bulk download as handles**
```ts
fetch(
  ["https://www.costco.com/…", "https://www.homedepot.com/…"],
  origin="auto", as="url"
)
// → costco escalates cloud→router (curl-impersonate, JA3); homedepot escalates →mac (Akamai JS).
//   Bytes stream server-side into R2; returns [ "/s/uuid1", "/s/uuid2" ] — two blob-ids, no bytes.
```

**5 · Pipeline (algebra combinator)**
```ts
pipe(steps=[
  { tool:"search",    args:{ query:"OpenWRT residential proxy setup", sources:["web"] } },
  { tool:"fetch",     args:{ url:"{{prev.0.url}}", as:"text" } },
  { tool:"extract",   args:{ source:"{{prev}}", what:"readable" } },
  { tool:"transform", args:{ data:"{{prev}}", op:"summarize", max_words:120 } }
])
```

---

## 7. Coverage map — proof of no orphans

All 90 user fns land in exactly one verb. `selftest` (91st import) is excluded as a
CI/diagnostic helper. Router/aggregator/combinator fns are marked *(meta)* — they are
composition layers, not new leaf capability.

| # | fn | verb | # | fn | verb |
|---|---|---|---|---|---|
| 1 | search | search | 46 | markdown | transform |
| 2 | web_search | search | 47 | html | transform |
| 3 | tavily | search | 48 | pack | transform |
| 4 | find_similar | search | 49 | subtitles | transform |
| 5 | arxiv | search | 50 | fontcase | transform |
| 6 | pubmed | search | 51 | encode | transform |
| 7 | openalex | search | 52 | hash | transform |
| 8 | crossref | search | 53 | compress | transform |
| 9 | semantic_scholar | search | 54 | archive | transform |
| 10 | clinical_trials | search | 55 | summarize | transform |
| 11 | stackexchange | search | 56 | translate | transform |
| 12 | reddit | search | 57 | classify | transform |
| 13 | proxy | fetch | 58 | redact | transform |
| 14 | scrape | fetch | 59 | voice | transform |
| 15 | geo_fetch | fetch | 60 | ocr | transform |
| 16 | render | fetch | 61 | preferences | transform |
| 17 | batch_fetch | fetch | 62 | shop *(meta)* | shop |
| 18 | crawl | fetch | 63 | product_search *(meta)* | shop |
| 19 | redirects | fetch | 64 | amazon | shop |
| 20 | robots | fetch | 65 | walmart | shop |
| 21 | sitemap | fetch | 66 | homedepot | shop |
| 22 | feed | fetch | 67 | lowes | shop |
| 23 | wayback | fetch | 68 | costco | shop |
| 24 | watch | fetch | 69 | ace | shop |
| 25 | extract | extract | 70 | kroger | shop |
| 26 | readability | extract | 71 | bestbuy | shop |
| 27 | select | extract | 72 | ebay | shop |
| 28 | grep | extract | 73 | weekly_ad | shop |
| 29 | tables | extract | 74 | winco | shop |
| 30 | metadata | extract | 75 | pdf | media |
| 31 | contacts | extract | 76 | fillable | media |
| 32 | entities | extract | 77 | image_convert | media |
| 33 | declutter | extract | 78 | people | people |
| 34 | json | transform | 79 | people_finder *(meta)* | people |
| 35 | csv | transform | 80 | places | people |
| 36 | xml | transform | 81 | linkedin | people |
| 37 | yaml | transform | 82 | facebook | people |
| 38 | store | store | 83 | youtube | people |
| 39 | kv_get | store | 84 | coingecko | people |
| 40 | kv_put | store | 85 | oracle | oracle |
| 41 | kv_list | store | 86 | tailscale | infra |
| 42 | kv_delete | store | 87 | controld | infra |
| 43 | dropbox | store | 88 | issue | infra |
| 44 | obsidian | store | 89 | batch *(meta)* | batch |
| 45 | ingest | store | 90 | pipe *(meta)* | pipe |

**Tally:** search 12 · fetch 12 · extract 9 · transform 20 · shop 13 · media 3 ·
people 7 · store 8 · oracle 1 · infra 3 · batch 1 · pipe 1 = **90** ✓.
Excluded: `selftest` (diagnostic).

**Raw / escape-hatch:** every leaf fn above remains individually callable by name — the
verbs are front doors, not walls. `batch`/`pipe` are the algebra substrate. `issue`'s
paired `suggest` fn does not exist in the registry (dangling reference, noted).

---

## 8. Open questions

1. **`youtube`/`coingecko` placement** — parked in `people` as `kind=video|crypto`; split
   into a `data` verb if the domain-API set grows.
2. **`store` vs the store namespaces** — `store` is sux's write-through convenience; the
   rich per-store write algebra lives in the vault/files/mail namespaces. Confirm the
   boundary so `store` and `oracle` stay the thin sux-side read/write pair.
3. **mail reach** — `oracle`'s `mail` source assumes a `jmap Email/query` capability
   reachable server-side from sux; confirm the mail namespace exposes it to the query
   plane (vs. oracle calling the mail MCP as a client).
4. **`execute` surfacing** — should `execute` be a per-call arg on every web verb, or
   only on `oracle` (the one verb with a co-locate payoff today)?

## Related

- [[handle-discipline]]
- [[Functions-MOC]]
- [[namespace-architecture]]
- [[oracle-supersession]]
- [[Namespaces-MOC]]
