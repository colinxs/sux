---
title: search — one retrieval verb
status: parked
cluster: retrieval
type: proposal
summary: "One retrieval verb over web/research/social/retail backends with a string WHERE-DSL; emits the records envelope so combinators compose."
tags: [sux, retrieval, parked]
updated: 2026-07-09
---

# `search(query, backends, filter)` — one unified retrieval verb

**Angle: caller-ergonomics.** Every decision is made from one question — *what does the frontier model on the other side of the MCP boundary reliably produce on the first try?* — then reconciled with the Workers constraints and the co-signed sibling freezes (`algebra.md`, `shop.md`). Where the user's spec and the platform conflict — the `filter = page -> page.reviews > 4.5` lambda cannot run, because **there is no `eval` on Workers** — this design picks the faithful, safe realization (a string WHERE-expression) and says why.

The verb collapses four fan-out surfaces into one: `web_search` (4 engines + consensus merge), `product_search` (7 retailers + isolation), the `shop` single-store *router*, and the Kagi-only `search`. It emits the algebra's `{records, meta}` envelope so `map`/`filter`/`reduce`/`augment` compose over its output, and it owns the filter DSL (`_filter.ts`) that the algebra's standalone `filter` fn imports.

## Resolved decisions

| # | Decision |
|---|---|
| 1 | `filter` is a **string WHERE-expression** (`price < 100 and rating > 4.5`), not a lambda (banned: no eval) and not a JSON AST (5× tokens, brace-mismatch on every call). |
| 2 | `backends` accepts a group alias, a single name, or a mixed array; `all` is the cheap default and **excludes** mac-render backends (google + render retailers), opt-in by name. The **≤3 render cap is ONE shared budget across both dispatch buckets** — `google` (tier:`render` in `direct`) is counted together with the render retailers (in `retail`) because all serialize on the one concurrency-1 mac solver; excess → `skipped[]`. When google is co-selected, `fanoutRetail`'s `maxConcurrentRenders` is decremented to `3-1` to reserve google's solver lane, so the 45s/50s budgets still hold (§4.1/§4.3/§6). Those two fixes cure solver *contention*, not google's intrinsic render *duration*: google is also passed its OWN per-render `renderTimeoutMs:38000` through the §4 adapter signature (§5), so a slow google render is cut at ≤38s to a `code:"timeout"` note whose inner render caches via `ctx.waitUntil` (re-call in ~30s is a hit) — its own graceful-degradation path, distinct from the retail slot's (which degrades the same way but at its `shop.md`-frozen ~80s (shop R1) render cap, not google's 38s) — never a bare cut by the 50s budget. |
| 3 | Results are flat `SearchResult` records on the algebra envelope; missing field → predicate false; only augmenters nest (`rec.aug.*`). |
| 4 | Rate-limit weight is charged by the **resolved backend set**, not a static `Fn.cost` — resolved **at the pre-dispatch gate** (co-signed `extraCost`/`weightedRateLimit` change, §10), never "reported from inside `run()`" (the gate charges before `run()` exists). |
| 5 | The fan-out is **cached unfiltered** at a **fixed per-backend fetch ceiling** (independent of `filter` and `limit`, §8); `filter`/`limit`/`fields` apply post-cache and the cache key omits all three, so one fixed-size set is reused across differently-filtered **and** differently-limited calls, order-independently. |
| 6 | A partial envelope carrying any transient `meta.errors` code (`timeout`/`rate_limited`/`blocked`) is **noCache**; clean results cache with `staleGrace: 600`. |
| 7 | `compileFilter` is extended (co-signed with algebra) to return `Predicate & { paths: string[] }` so the closed-loop self-diagnosis (`meta.paths_missing`) works. |
| 8 | The `~` regex operator is deferred out of v1 (grammar reserves it); v1 ships `has` substring. When `~` lands it is a **Thompson NFA** (linear, no backtracking) — never an unbounded `new RegExp`. |
| 9 | `meta.fields` / `meta.paths_missing` are computed over the **pre-filter** set at each kind's filter stage (raw fetched set for non-web; post-merge consensus-stamped set for web, §5/§7.4), so a filter that matched nothing still self-diagnoses — and `consensus` never falsely reports missing. |
| 12 | **Filter timing splits by kind** (§5/§8): non-web backends filter **per-backend pre-merge**; the **web block filters post-merge, after `consensus` is assigned**. Because `consensus` is a merge-time field the adapters never emit, a uniform pre-merge predicate would drop 100% of web rows on the advertised `consensus >= 2` (§2/§9) — the web path reorders (fan out → `normUrl` merge → predicate → union → global `limit`) to make it work. |
| 10 | Deleted: `web_search`, `product_search` (gated). `shop` router → absorbed into `search(backends:[name])`; the name `shop` is reused by the comparison engine (`shop.md`). Net `89 → 87`. |
| 11 | Force-live is the **universal `fresh` flag — one flag, both cache layers**, co-signed to be **captured onto `env._fresh` in addition to still being `delete`d from args at `index.ts:166–169`** (the strip stays — it keeps the top-level cache key clean so a fresh call overwrites the same entry per the `index.ts:153–159` comment; only the capture onto `RtEnv` is new) so it clears the top-level dispatch cache **and** §9's inner unfiltered fan-out cache. `search` invents no second `no_cache` arg (§1 is `additionalProperties:false` — it would be unreachable). |

---

## 0. What the caller writes vs. what runs

```
search(query:"Makita XFD131", backends:["home_depot","kagi"], filter:"rating > 4.5")
```

- `backends` accepts a **group alias string** (`"all"`), a **single name**, or a **mixed array** of aliases + names. `home_depot` is accepted and aliased to `homedepot` (the caller writes the name it naturally reaches for).
- `filter` is a **string WHERE-expression**, not a lambda and not a JSON AST (§7). The spec's arrow-function needs an interpreter the platform forbids; the string form is both the faithful realization and the highest first-try-accuracy surface for an LLM.
- Result is a `{records:[SearchResult…], meta}` envelope; survivors are flat records the model can immediately `filter`/`map`/`reduce`/`augment` further.

---

## 1. Input schema

`sux/src/fns/search.ts`, `Fn`: `cost` is a **function** `(env, args) => resolveBackends(env, args.backends).cost` evaluated at the pre-dispatch gate (§10; co-signed widening of `Fn.cost` to `number | ((env,args)=>number)`), `width:30, records:true, cacheable:true, ttl:300, staleGrace:600`.

```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "required": ["query"],
  "properties": {
    "query":   { "type": "string", "description": "Concise, keyword-focused query. One topic per call." },
    "backends": {
      "default": "all",
      "description": "Group alias, one backend name, or an array mixing both. Groups: all | web | research | social | retail. Named groups hold ONLY fast backends: 'web' = kagi/ddg/brave/tavily/exa (NOT google); 'retail' = kroger/bestbuy/ebay/costco (NOT amazon/walmart/homedepot/lowes/ace). Every mac-render backend (google + those 5 retailers) is in NO group — name it explicitly to include; 'all' likewise skips them for cost. So backends:'retail' returns only the fast retailers; to reach Amazon/Walmart/Home Depot/Lowe's/Ace name them.",
      "anyOf": [
        { "type": "string", "enum": ["all","web","research","social","retail","kagi","ddg","google","brave","tavily","exa","arxiv","pubmed","openalex","crossref","semantic_scholar","clinical_trials","stackexchange","reddit","youtube","kroger","bestbuy","ebay","costco","amazon","walmart","homedepot","home_depot","lowes","ace","fred_meyer","qfc","ralphs"] },
        { "type": "array", "items": { "type": "string", "enum": ["all","web","research","social","retail","kagi","ddg","google","brave","tavily","exa","arxiv","pubmed","openalex","crossref","semantic_scholar","clinical_trials","stackexchange","reddit","youtube","kroger","bestbuy","ebay","costco","amazon","walmart","homedepot","home_depot","lowes","ace","fred_meyer","qfc","ralphs"] } }
      ]
    },
    "filter":  { "type": "string", "description": "Optional WHERE-expression applied server-side before limit (non-web per-backend pre-merge; web post-merge so `consensus` filters work — §5). Grammar in the tool description." },
    "limit":   { "type": "integer", "minimum": 1, "maximum": 100, "default": 10, "description": "Truncates the MERGED result set post-fan-out; NOT a per-backend fetch target. Per-backend yield is bounded (§8): ≤30 web/research/social, ≤15 per retailer — so a large limit only fills by fanning across many backends, never from one. A single-retailer call returns ≤15 regardless of limit." },
    "fields":  { "type": "array", "items": { "type": "string" }, "description": "Project survivors to these flat fields (token economy)." },

    "workflow":       { "type": "string", "enum": ["search","news","videos","podcasts","images"], "default": "search", "description": "Kagi web mode (kagi backend only)." },
    "include_domains":{ "type": "array", "items": { "type": "string" }, "description": "Kagi-native; also enforced post-merge as a host filter across every web backend." },
    "exclude_domains":{ "type": "array", "items": { "type": "string" } },
    "time_relative":  { "type": "string", "enum": ["day","week","month"], "description": "Kagi backend only." },
    "after":          { "type": "string", "description": "ISO date, e.g. 2024-01-15 (kagi)." },
    "before":         { "type": "string" },
    "file_type":      { "type": "string", "description": "e.g. pdf (kagi)." },
    "lens_id":        { "type": "string", "description": "Kagi lens: Academic=2, Forums=1, Programming=15, News360=29, Recipes=120, Small Web=107." },

    "zip":      { "type": "string", "pattern": "^\\d{5}$", "description": "5-digit US ZIP — forwarded to zip-aware retail backends (kroger store prices + deal overlay; homedepot localization). WITHOUT it kroger rows have NO price." },
    "proxy":    { "type": "boolean", "default": false, "description": "Route the Kagi web query through the Tailscale residential proxy (direct fallback)." }
  }
}
```

`limit` max is `100`, but it is a **post-merge truncation ceiling, not a per-backend fetch target** — and the honest rationale is narrow. It does **not** preserve single-backend or bulk-retail retrieval: retail is intentionally capped at **15/retailer** and every non-retail backend at **≤30** (the §8 shared-cache over-fetch ceiling), both applied per backend *before* merge. So no single backend can fill a `limit` above its own yield — `search(backends:"walmart", limit:100)` returns ≤15, `search(backends:"kagi", limit:100)` ≤30. The 100 cap therefore only ever matters for a wide `all` fan-out whose per-backend yields **sum** past 100 (24 backends × their ceilings), where it bounds the merged list. (Genuine bulk single-retailer retrieval is *not* on offer here — it would require a co-signed paginated `fanoutRetail`, reopening `shop.md`'s cache-sharing invariant, §4.3/§8; the schema `limit` description and `meta.truncated` stamp below reconcile the surface with the fixed-15 design instead.) `backends` is an `anyOf` of two properly-scoped alternatives — a `string` with an `enum`, OR an `array` whose `items` carry the same `enum` — so a mixed array like `["home_depot","kagi"]` actually validates while a garbage name is still rejected before dispatch. A standalone top-level `enum` is deliberately **not** used: draft-07/2020-12 scope a bare `enum` to the WHOLE instance (deep-equal one listed scalar), which rejects every array value regardless of `type`, silently gutting the flagship mixed-array capability — the `anyOf` split is the only construction that reaches both validation goals. The enum lists every group + name + banner alias the caller may reach for.

**Why the surface is this shape:** every optional beyond `query`/`backends`/`filter` is a field the model already fills from other sux verbs — `limit`, `zip`, `proxy`, the Kagi scope block (verbatim from today's `search`, closing the gap where `web_search`'s kagi engine silently dropped every scope arg, `web_search.ts:117`). `include_domains`/`exclude_domains` are generalized — enforced post-merge as a host match across *all* web backends, because a caller who passes `include_domains` means it for the whole web result set, not one engine.

---

## 2. Tool description (progressive disclosure — the only doc the model reliably sees)

~175 words:

> **One search verb across web, research, social, and retail backends — fan out in parallel, filter server-side, return a unified record list.** `backends`: a group (`all`, `web`, `research`, `social`, `retail`) or specific names (`kagi`, `arxiv`, `reddit`, `homedepot`…), or an array mixing them. Groups hold only fast backends — `web` = kagi/ddg/brave/tavily/exa, `retail` = kroger/bestbuy/ebay/costco — and never fire a mac render. Every render backend is in NO group: name `google` (for web) and Amazon/Walmart/Home Depot/Lowe's/Ace to include them. `all` is the cheap default and likewise skips them (slow renders degrade gracefully — a render exceeding its cap becomes a `code:"timeout"` note whose inner result caches for a re-call hit, ≤3 render backends/call).
> `filter` runs server-side **before `limit`** — it changes *which* results survive: `price < 100 and rating > 4.5`. Clauses `field op value` joined by `and`/`or`/`not` with parens. Ops: `= != < <= > >=`, `has` (substring/member, ci), `in [a,b]`, `exists`. Numbers unquoted, strings 'single-quoted'.
> Filterable fields **by kind** — web: `snippet date consensus`; product: `price promo_price rating reviews brand in_stock`; paper: `year citations journal`; post/video: `score comments views likes channel subreddit`; arrays `authors tags categories` (`has`/`in`). A numeric filter keeps only kinds carrying that field. **If out=0, read `meta.paths_missing` — likely a typo'd field; `meta.fields` lists the real keys.** Pass `zip` for Kroger prices + deals.

The description carries the **field catalog by kind** inline — the progressive disclosure that lets the model write a correct `filter` on the first call. The closed loop (§7.4) handles the rest: `meta.fields` + `meta.paths_missing` teach the exact keys of the data actually returned.

---

## 3. The unified record — `SearchResult`

`sux/src/fns/_search.ts`. Every field is a **single identifier** (filter paths are one identifier; only augmenters nest under `rec.aug.<name>`). A record populates only the fields its backend carries; missing → false makes cross-kind filtering safe without per-kind branching.

```ts
export type SearchKind = "web" | "product" | "paper" | "post" | "video";

export interface SearchResult {
  title: string;
  url: string;
  _src: string;            // backend id — the ONE reserved provenance key (algebra R8); == retailer for retail
  kind: SearchKind;
  snippet?: string;        // web snippet | paper abstract | post/selftext
  date?: number;           // NORMALIZED epoch seconds — every backend's native date folded here (§3.1)

  consensus?: number;      // web: # engines that returned this URL (§9)

  price?: number;          // 0/absent = "no price" mapped to ABSENT via normalizeMoney (algebra R10)
  promo_price?: number;
  rating?: number;         // 0–5
  reviews?: number;
  brand?: string;
  in_stock?: boolean;
  condition?: string;
  retailer?: string;

  year?: number;
  citations?: number;
  journal?: string;
  doi?: string;

  score?: number;          // upvotes
  comments?: number;
  answers?: number;
  answered?: boolean;
  views?: number;
  likes?: number;
  channel?: string;
  subreddit?: string;
  status?: string;         // clinical_trials

  authors?: string[];
  tags?: string[];
  categories?: string[];
}
```

### 3.1 Date normalization — the one non-obvious adapter obligation

The research/social recon found **five incompatible date representations** (ISO datetime, non-ISO "2023 Jan 15", bare year int, unix epoch, none). A flat single-identifier DSL cannot compare `published` uniformly across them. **Every adapter converts its native date to `date` = epoch seconds** at normalization (year-only → epoch of Jan 1, and *also* emits `year`). So `date > 1704067200` works across arxiv/pubmed/reddit/stackexchange with zero per-source logic, and `year >= 2020` works for research. The DSL stays dumb.

**The DSL accepts ISO/date-string operands on date fields.** `date > '2024-01-01'` is parsed to epoch at compile time via `Math.floor(Date.parse(operand) / 1000)` — the `/1000` is load-bearing: `Date.parse` returns **milliseconds**, but the `date` field is normalized to epoch **seconds** (§3), so a raw `Date.parse` operand would be 1000× too large and `date > '2024-01-01'` would compile to `rec.date(≈1.7e9 sec) > 1.7e12` → **false for every record** (and `<` → true for every record). Invariant: **`date` operands, whether bare integers or coerced date strings, are epoch SECONDS, never `Date.parse`'s milliseconds.** A bare-integer operand (`date > 1704067200`) is already seconds and passes through uncoerced, so both forms land on the identical seconds axis. An unparseable date string yields `NaN` from `Date.parse`; the compiler guards this and routes it to the §7.4 teaching path (bad_input) rather than letting the clause silently become NaN→false. The caller never has to hand-compute epoch seconds — otherwise the closed loop is silently defeated (an LLM writes a date string, gets zero results, and `paths_missing` is empty because the field exists). `after`/`before`/`time_relative` remain Kagi-native scope args distinct from the `date` filter field.

### 3.2 The missing-field trap, made ergonomic

Because `price`, `citations`, `views` default to **absent** (never `0`), `filter:"price < 100"` keeps only records that *have* a price under 100 and drops every web/paper/post record (missing → false) — correct if surprising. The description states this; the escape hatch is native: `filter:"price < 100 or not exists price"`. Crossref/semantic_scholar's `citations:0`-on-unknown and youtube's en-masse `undefined` stats are normalized to **absent-not-zero** so `exists citations` is truthful.

---

## 4. Backend registry + adapter interface

`sux/src/fns/_search.ts`.

```ts
export interface SearchAdapter {
  name: string;
  group: "web" | "research" | "social";
  kind: SearchKind;
  envKey?: string;               // availability gate (web_search available() semantics)
  cost: number;                  // summed by resolveBackends; charged at the gate via Fn.cost fn (§10)
  inAll: boolean;
  tier: "fast" | "render";       // deadline budgeting (render = google here)
  maxFetch: number;
  run(env: RtEnv, q: { query: string; limit: number; route: "auto" | "proxy"; scope?: SearchScope; renderTimeoutMs?: number }): Promise<SearchResult[]>;
}

export const SEARCH_BACKENDS: Record<string, SearchAdapter>;   // web + research + social
export const GROUPS: Record<"web"|"research"|"social"|"retail"|"all", readonly string[]>;
// A banner alias expands to (backend, extra-args) — NOT a bare name rewrite — so it can carry filter.chain:
export const BACKEND_ALIASES: Record<string, { name: string; args?: Record<string, unknown> }>;
export function resolveBackends(env: RtEnv, sel: string | string[]):
  { direct: string[]; retail: Array<{ name: string; args?: Record<string, unknown> }>; skipped: Array<{ name: string; why: string }>; cost: number; googleSelected: boolean };
// `direct` is the FULL set of resolved non-retail backends — web + research + social (§4.1), one array,
// not web-only — so all 15 non-retail backends dispatch (§5). retail stays the ONE composite slot (§4.3).
// `googleSelected` = google (the lone tier:"render" member of `direct`) survived the SHARED render cap (§4.1),
// so §5 can decrement fanoutRetail's maxConcurrentRenders and reserve google's slot on the concurrency-1 solver.
```

Each adapter is a thin wrapper over an existing fn/parser mapping its native shape → `SearchResult[]`. Availability mirrors `web_search.available()` (`web_search.ts:138`): usable iff `!envKey || env[envKey]`.

**`renderTimeoutMs` bounds a render-tier backend's own render duration** — the second, intrinsic-duration backstop next to the contention backstops (§4.1 shared cap, §4.3 decrement). The cap + decrement stop google from *delaying* the retail legs; they do nothing about how long google's own render takes. So §5 passes google (the lone `tier:"render"` member of `direct`, §4.1, and search's OWN direct backend) a `renderTimeoutMs:38000` — strictly under the 50s `totalBudgetMs` with headroom — so an intrinsically slow google render (the upper half of §2's advertised render band) is cut at ITS 38s timeout to a `code:"timeout"` note whose inner render still caches via `ctx.waitUntil` (re-call in ~30s is a hit), rather than being silently cut by the 50s budget and returning a bare `code:"timeout"` with no cached inner. The retail render legs degrade the same way but at a DIFFERENT cap: `fanoutRetail`'s per-leg `renderTimeoutMs` is the `shop.md`-frozen **80_000** (shop R1 — NOT the adapter-native ~55s, which sits below the cold-walmart 2-load max) (`> softDeadlineMs`, so a cold walmart render survives to completion and caches under `waitUntil` for the re-call), and search's §5 `fanoutRetail` call omits `renderTimeoutMs` to inherit it. google's 38s and the retail legs' ~80s are different render timeouts, and that is fine — they are bounded against each other only by the shared ≤3 solver cap and the `maxConcurrentRenders` decrement, never by a shared 38s abort. Fast-tier backends ignore the arg.

### 4.1 Backend groups, `all` exclusions, aliases

| group | members | in `all`? |
|---|---|---|
| **web** | kagi, ddg, brave, tavily, exa | yes |
| | **google** | **no** — mac render (opt-in) |
| **research** | arxiv, pubmed, openalex, crossref, semantic_scholar, clinical_trials | yes |
| **social** | stackexchange, reddit, youtube | yes (reddit via proxy, isolated; youtube only if `YOUTUBE_API_KEY`) |
| **retail** | kroger, bestbuy, ebay, costco | yes (FAST_TIER) |
| | **amazon, walmart, homedepot, lowes, ace** | **no** — RENDER_TIER (opt-in, **≤3/call enforced**) |

**Group membership is literal, and every named group excludes every render-tier backend.** `GROUPS.web` = {kagi,ddg,brave,tavily,exa} (google is in NO group — reach it only by name); `GROUPS.research` = {arxiv,pubmed,openalex,crossref,semantic_scholar,clinical_trials}; `GROUPS.social` = {stackexchange,reddit,youtube}; `GROUPS.retail` = {kroger,bestbuy,ebay,costco} (the 5 render retailers amazon/walmart/homedepot/lowes/ace are in NO group — name them). Only the special `all` group is *computed* (`available ∩ inAll`); the other four are **fixed literal arrays** that name only fast-tier members and exclude every `tier:"render"` backend. So `search("drill", backends:"retail")` fans only Kroger/BestBuy/eBay/Costco — never Amazon/Walmart/Home Depot/Lowe's — and `backends:"web"` never fires a google render.

`all` = `available ∩ inAll`. Explicitly **naming** a backend overrides `inAll` (and is the ONLY way to reach a render-tier backend, since no group contains one). `resolveBackends` expands aliases, dedupes, drops unavailable key-gated backends into `skipped[]` (with the reason), **enforces the render-tier cap of ≤3 per call**, and hard-`fail`s only if *zero* backends resolve. **When a selected group omits render-tier backends it would otherwise be expected to cover** — a `retail` group (omits the 5 render retailers), a `web` group (omits google), or `all` (omits all 6) — `resolveBackends` stamps each excluded render backend into `skipped[]` with `why:"render-tier — not in group; name explicitly to include"`. This gives the §7.4 closed loop the signal that Amazon/Walmart/Home Depot/Lowe's/Ace (and google for web) EXIST and were omitted, rather than silently dropping the most-wanted retailers — mirroring how the ≤3 cap and unknown names already surface via `skipped[]`.

**The ≤3 render cap is ONE shared budget spanning BOTH buckets.** Every `tier:"render"` backend counts against it regardless of which bucket it resolves into: `google` (the only render member of `direct`, §4/§4.1) is counted **together** with the render retailers routed into `retail` (`amazon/walmart/homedepot/lowes/ace`). This is load-bearing because all of them serialize on the **one concurrency-1 mac solver** (§4.3) — google is not a free extra render lane just because it dispatches as its own top-level `direct` slot outside `fanoutRetail`'s budget. `resolveBackends` walks the resolved render set in selection order, admits the first 3, and drops the rest to `skipped[]` with `"render cap 3/call (shared across google + render retailers) — name fewer or run separate calls"`. So `backends:["google","homedepot","lowes","ace"]` admits `google,homedepot,lowes` and skips `ace` (never 4 solver jobs); `["google","homedepot","lowes"]` admits all 3 and sets `googleSelected:true`; `["homedepot","lowes","ace"]` admits all 3 with `googleSelected:false`.

**Banner aliases carry args.** `fred_meyer`/`qfc`/`ralphs` expand to `{ name: "kroger", args: { chain: "Fred Meyer" } }` (etc.) — an alias that dropped the chain would silently return generic Kroger results. `home_depot` → `{ name: "homedepot" }`.

**Unknown name never hard-fails the call.** A typo'd or nonexistent name in a mixed array routes to `meta.skipped` (`why:"unknown backend"`), consistent with the never-fail-the-whole-call philosophy — only a selection that resolves to *zero* backends hard-`fail`s (teaching message lists valid groups/names).

### 4.2 Quantified: the fleet becomes backends

The fn-count cap is lifted, so the retailer fleet and research/social DBs are addressable backends. **24 backends** replace the old split: 6 web + 6 research + 3 social + 9 retail. Each stays a **standalone fn** too, kept for its detail/action surfaces (`amazon(action:'product')`, `kroger` locations, `reddit(action:'comments')`); `search` just fans them.

### 4.3 Retail is ONE composite slot, not nine

The five render retailers share a **single mac node whose solver is serialized at concurrency 1** (verified: `render_server.py` runs headless-then-solver, up to 2 page loads). If each were an independent top-level slot, five concurrent renders would queue → ~5× wall-clock → blow 60s. So the retail group is a **single composite slot** delegating to the shared `fanoutRetail` (`_retail_fanout.ts`, `shop.md`), which owns render budgeting (45s soft deadline, `maxConcurrentRenders:3`, and the `shop.md`-frozen per-leg `renderTimeoutMs:80000` — `> softDeadlineMs`, so a cold render survives to completion and caches under `waitUntil`).

```ts
const fr = await fanoutRetail(env, { term: query, retailers: resolved.retail, zip, maxConcurrentRenders: 3 - (resolved.googleSelected ? 1 : 0), bustRenders: env._fresh });
const productRecords = fr.products.map(taggedToSearchResult);   // fr.errors → meta.errors; fr.pending → meta.errors code:"timeout"
```

**google's mac render and the retail composite slot contend on the ONE concurrency-1 solver.** `fanoutRetail` owns render budgeting (45s soft deadline, `maxConcurrentRenders`, `renderTimeoutMs:80000`) as if it owned the node — but google (§4, `tier:"render"`, resolved into `direct`) dispatches as its own top-level slot (§5) and serializes on the **same** solver `fanoutRetail` is pacing, invisible to it. Two backstops keep the 45s/50s budgets honest: (1) the shared ≤3 cap (§4.1) counts google with the render retailers, so total solver pressure never exceeds 3 jobs; (2) when google is among the admitted render backends (`resolved.googleSelected`), `search` **reserves one solver slot for it** by passing `maxConcurrentRenders: 3 - (googleSelected ? 1 : 0)` into `fanoutRetail` — so a `[google,homedepot,lowes]` call runs retail at `maxConcurrentRenders:2` alongside google's one render, and the solver sees ≤3 concurrent jobs, not 3-inside-the-budget-plus-1-outside. Without this decrement, `fanoutRetail` would size its 45s budget assuming it owns all 3 lanes while google steals one, the 50s `totalBudgetMs` fires, and both google and the retail slot return a bare-cut `code:"timeout"` — exactly on the advertised "name google + retailers to opt in" call. **The decrement + shared cap fix *contention* (queuing/delay), not google's intrinsic render *duration*** — a solver-free but intrinsically slow google render (§2's upper render band) would still overrun the 50s budget. So google's slot is *also* handed its own `renderTimeoutMs:38000` (§4/§5) — search-owned, and DISTINCT from the retail legs' `shop.md`-frozen ~80s cap: a google render exceeding 38s is cut at ITS timeout to a `code:"timeout"` note whose inner render caches via `ctx.waitUntil` (the retail render legs degrade the same way, but at their ~80s cap, which is `> softDeadlineMs` so a cold render survives to completion) — rather than being cut by the 50s `totalBudgetMs`. So neither google nor the retail slot is cut by the *50s budget / FN_DEADLINE*; each is bounded by its own render timeout (google 38s, the retail legs ~80s) and degrades gracefully past it. `maxConcurrentRenders` is a `shop.md`-frozen `fanoutRetail` arg (no signature change); only the value `search` passes changes.

`fanoutRetail`'s signature is **frozen by `shop.md`** — `fanoutRetail(env, {term, retailers, zip, softDeadlineMs?, renderTimeoutMs?, maxConcurrentRenders?, fresh?, bustRenders?, renderSoftTtlMs?, suppressRenderStaleRefresh?})`, with **no `fetchN`**. `search` passes **`bustRenders: env._fresh`** (and omits `renderSoftTtlMs`/`suppressRenderStaleRefresh`, so retail render legs keep native soft ttl + normal SWR): the seam's default `fresh` fallback busts only FAST-tier legs (`shop.md` §1), so without `bustRenders` a `fresh:true` retail search would serve every render leg (amazon/walmart/homedepot/lowes/ace) STALE from its per-leg `callFnCached` cache — silently violating the §9 one-flag-both-layers guarantee. Passing `bustRenders: env._fresh` makes `env._fresh` bust fast **and** render legs uniformly (`shop.md` §1 co-signs this contract). Every inner retail leg fetches shop's fixed schema-default limit (**15**), applying any clamp to rows-kept AFTER retrieval; that fixed inner ask is the sole mechanism behind shop's `callFnCached` key-sharing (the "walmart render 2 min ago is a hit" guarantee, R6/R10). A varying inner fetch is *incompatible with cache-sharing* — differently-filtered searches would fragment the shared render cache and re-pay ~5× render cost — so `search` yields: it does **not** thread `fetchN` into `fanoutRetail`. Instead `search` applies its `filter` predicate to the (up to 15) returned retail rows **before** its own global `limit` truncation. The retail slot's effective over-fetch is thus capped at the 15-row ceiling (§8: `maxFetch("retail")=15`); the marquee `rating > 4.5` example filters against those ≤15 rows, not an unbounded over-fetched set. A larger retail over-fetch would require a co-signed change to `shop.md`'s `fanoutRetail` signature + `callFnCached` cache-key design, not a unilateral edit here.

**Coordinated dependency:** for `rating > 4.5` to work, the retail adapters must surface `rating`/`reviews`, present in every raw payload the parsers currently drop (bestbuy `customerReviewAverage`, walmart `averageRating`, homedepot/lowes state-blob `reviews.averageRating`, amazon tile `a-icon-alt`; kroger/costco/ace/ebay omit → missing⇒false correctly excludes them). Adding `rating?`/`reviews?` to `RetailProduct` in `_retail.ts` lands in the retail-group cycle (§13). The marquee filter is dead without it.

**Deals stay on the `shop` verb.** `shop`'s old `deals` route (→ `weekly_ad` Flipp flyer) is **not** a `search` backend — flyer deals are a comparison-engine concern (`shop.md` owns the weekly-ad overlay, gated on `zip`). `search` covers product retrieval; `shop` covers deal overlay + comparison. This is stated so the capability isn't silently orphaned by deleting the shop router.

---

## 5. Fan-out, merge, consensus — via the shared `_fanout` core

Top-level spread uses the generic `fanout()` (`_fanout.ts`, algebra §2). Slots = one per selected non-retail backend (the single `resolveBackends.direct` array — web + research + social) + one composite retail slot. The merge/filter-timing split below keys off each record's `rec.kind`, **not** off which return-array the backend came from — so a single `direct` array is correct, and "the web block" throughout §5/§7.4/§8 means records with `kind === "web"`, never "the resolveBackends slots". Research/social/product records filter per-backend pre-merge; `kind === "web"` records filter post-merge after `consensus` is assigned.

```ts
const slots: Slot<SearchResult[]>[] = [
  ...direct.map(name => ({ key: name, run: () => SEARCH_BACKENDS[name].run(env, { query, limit: fetchN(name), route, scope, renderTimeoutMs: SEARCH_BACKENDS[name].tier === "render" ? 38_000 : undefined }) })),
  ...(retail.length ? [{ key: "retail", run: () => fanoutRetail(env, { term: query, retailers: retail, zip, maxConcurrentRenders: 3 - (googleSelected ? 1 : 0), bustRenders: env._fresh }).then(mapProducts) }] : []),
];
const out = await fanout(env, slots, { concurrency: 6, totalBudgetMs: 50_000 });
```

**Merge / consensus (web kind only).** The three inconsistent normalizers today collapse onto the **one canonical `normUrl`** (`web_search.ts:144-150`, co-signed): `Map<normUrl, {rec, consensus, order}>`, first sighting sets order, duplicates increment `consensus` and backfill `snippet`, sort `consensus desc → order asc`. Non-web kinds are **not** cross-deduped — unioned in backend order. Default record order: consensus-ranked web block, then research, social, retail; each backend keeps its own relevance order. The caller reorders with `map(sort_by:…)` since it is a records envelope.

**Filter timing splits by kind — because `consensus` is a merge-time field.** `consensus` is assigned *only* by the fold above (adapters never emit it), so a per-backend pre-merge predicate would see every web record with `consensus === undefined` → missing-field → false (§7.3), silently dropping 100% of web rows on `filter:"consensus >= 2"` — the advertised marquee (§2, §9). So the **web block filters POST-merge**: fan out web engines → `normUrl` merge (assign `consensus`) → apply `compileFilter` to the merged, consensus-stamped web records. **Every non-web kind filters per-backend PRE-merge** (§8), which is correct because non-web kinds never cross-dedupe — there is no merge-time field to wait for. Union the (filtered) web block with the (per-backend-filtered) non-web records, then truncate to the global `limit`.

---

## 6. The 60s deadline → partial-result envelope

`FN_DEADLINE_MS=60_000` (`index.ts:41,252`) resolves to a **bare error with zero partials** if `run()` doesn't return in time. `search` must **never let it fire**: `fanout` runs a `totalBudgetMs:50_000` soft deadline (10s headroom), races `Promise.allSettled`, and returns whatever settled as a **success envelope**. The retail slot's internal 45s bound nests under that. **The one subtlety: google is a SECOND consumer of the same concurrency-1 mac solver** (§4, `tier:"render"`) dispatched as its own top-level `direct` slot outside `fanoutRetail`'s budget, so the 45s-nests-under-50s guarantee only holds if google's render is counted against the same solver budget the retail slot is pacing. Two facts secure it (§4.1/§4.3): `resolveBackends` counts google in the **shared ≤3 render cap** (so total solver pressure across both buckets is ≤3 jobs, never the 4-job "5 blows 60s" hazard), and `fanoutRetail`'s `maxConcurrentRenders` is **decremented to `3 - (googleSelected ? 1 : 0)`** when google is co-selected — reserving google's solver lane out of the shared budget so the retail slot's 45s bound and the 50s `totalBudgetMs` still hold on the advertised `[google, homedepot, lowes]` opt-in call. Those two facts secure google against solver *contention*; google's own render *duration* is bounded separately by the `renderTimeoutMs:38000` §5 passes it (§4/§4.3), so an intrinsically slow google render (§2's upper render band) is cut at its own ≤38s timeout — not by the 50s budget. The honest guarantee is therefore **not** "neither returns `code:"timeout"`" but: neither google nor the retail slot is cut by the *50s `totalBudgetMs` / FN_DEADLINE*; each is bounded by its own render timeout (google 38s, the retail render legs' `shop.md`-frozen ~80s), and a render exceeding it degrades to a `code:"timeout"` note whose inner render caches via `ctx.waitUntil` (re-call in ~30s is a hit) — graceful degradation, not a bare deadline error. Unfinished slots → `meta.errors[]` with `code:"timeout"` and the note `"still running — inner result caches via waitUntil; re-call in ~30s for a hit"` (render inner writes land via `ctx.waitUntil` at the `fanoutRetail`/`callFnCached` layer, so the retry is a cache hit). `FanoutOutcome` maps 1:1 onto the envelope. Concurrency is capped at 6 — the Workers outbound-socket ceiling — so "24 in parallel" is honestly **"6 live, the rest serialized, tail truncated at ~50s"**. `all` therefore returns whatever the 6-lane pool clears; slow tail backends land in `meta.errors` — the description does not oversell simultaneity.

**Ledger + nesting:** `search` declares `Fn.width = 30` and is added to `batch`'s `NESTED_FANOUT_TOOLS`. Because `MAX_NESTED_CALLS=25` bounds *count* not *render load*, `batch`/`pipe` account the mapped tool's `Fn.width` against the per-request work budget (`env._budget`, `REQUEST_SUBREQ_BUDGET=900`, decremented by `fanout`/`smartFetch`, soft-truncating with `meta.truncated:true` before CF 1102). **`search` is added to `pipe`'s `BLOCKED_STEP_TOOLS`** — pipe has no width accounting today, and a `pipe([search, reduce])` step could fan thousands of subrequests inside a single deadline; callers pre-fetch with a standalone `search` call and feed the resulting handle/records into the pipe. (This is the honest choice over inventing a pipe width-budget mechanism in the same cycle.)

---

## 7. The filter DSL — `_filter.ts` (owned here, co-signed with the algebra `filter` fn)

### 7.0 Exports (frozen — the algebra's `filter` fn imports these, co-signed)

```ts
export type Predicate = ((rec: Rec) => boolean) & { paths: string[] };
export function compileFilter(expr: string): Predicate;   // throws FilterError → caller does failWith("bad_input", …)
```

`compileFilter` returns a `Predicate` **carrying the referenced field paths** (`p.paths`) — the extension over the original freeze. Both `search` (for `meta.paths_missing`) and the algebra `filter` fn need it, so it is a **co-signed change to `algebra.md`**: the exports are `Predicate & { paths }` and `compileFilter`, and both consumers rebase onto them together.

### 7.1 String DSL vs. structured JSON predicate — the ruling

The string DSL wins decisively for this workload — and is the only faithful realization (the lambda needs `eval`, banned).

| | string `"price < 100 and rating > 4.5"` | JSON `{"and":[{"field":"price","op":"<","value":100},…]}` |
|---|---|---|
| LLM prior | enormous (SQL WHERE) | thin, bespoke key names |
| tokens / call | ~7 | ~35 |
| dominant failure | rare precedence slip | brace/bracket mismatch **every** call; value-typing |
| as a pipe token | trivial | must escape nested JSON in a JSON arg |

The JSON form's one advantage (no quoting/precedence ambiguity) is bought at a constant brace-matching tax on every call to avoid a rare precedence mistake. **Decision: string DSL.**

**The one ergonomic hedge (co-signed into the freeze).** The lexer accepts the four likeliest LLM slips as synonyms — `==`→`=`, `&&`→`and`, `||`→`or`, `contains`→`has` — normalized before parse. This changes no canonical operator and adds no grammar production; the algebra `filter` inherits it for free. Because it touches the shared grammar, it is landed as a co-signed edit to `algebra.md` + `_filter` tests together, not a unilateral search-side rewrite.

### 7.2 Full grammar (recursive descent, LL(1), no backtracking)

```
expr    := orExpr
orExpr  := andExpr ( "or"  andExpr )*
andExpr := notExpr ( "and" notExpr )*
notExpr := "not" notExpr | primary
primary := "(" expr ")" | existsClause | clause
existsClause := "exists" path                 # PREFIX — matches the "not exists price" idiom
clause  := path binaryOp operand
path    := ident ( "." ident )*               # dotted ONLY to reach aug.* (algebra R9); flat is the norm
binaryOp:= "=" | "!=" | ">" | ">=" | "<" | "<=" | "has" | "in"    # "~" reserved, deferred (§7.5)
operand := number | string | bool | null | list
list    := "[" ( literal ( "," literal )* )? "]"
literal := number | string | bool | null
number  := "-"? DIGIT+ ( "." DIGIT+ )?
string  := "'" ( [^'\\] | "\\" . )* "'"  |  "\"" ( [^"\\] | "\\" . )* "\""
bool    := "true" | "false"
null    := "null"
ident   := [A-Za-z_] [A-Za-z0-9_]*
```

`exists` is **prefix** (`exists price`, `not exists price`) — the original design had a postfix/prefix contradiction; prefix wins because it matches the `not exists price` idiom the docs teach. Precedence `not > and > or`, parens override. Paths resolve via the shared `dig()` (`_records.ts`) so `aug.price.value` works for the algebra `filter` fn.

### 7.3 Operator + missing-field semantics (co-signed table)

| op | on present value | on **missing/null** field |
|---|---|---|
| `= !=` | typed equality (num↔num; string ci for `=`, see below) | **false** (`!=` too — missing ≠ "not equal") |
| `> >= < <=` | numeric; both coerced; either NaN → false; date field coerces ISO operand via `Math.floor(Date.parse(operand)/1000)` → epoch SECONDS (never ms), unparseable → §7.4 bad_input | **false** |
| `has` | substring (ci) if string; membership (ci) if array | **false** |
| `in [..]` | equals any literal; array field → non-empty intersection | **false** |
| `exists path` | true iff present **and non-null** | **false** |

Missing field → **false for every op except `exists`** (matches algebra R11 verbatim). `has` on a missing field is `false` (a record with no `tags` "has" nothing). String `=` is case-insensitive (an LLM writing `brand = 'makita'` should match `Makita`); use `has` for substring. Both fns co-sign this table.

### 7.4 Parse errors that teach + the closed loop

1. **Syntax** (catchable) → `failWith("bad_input", …)` with the offending token, a caret, what was expected, and a did-you-mean. The synonym lexer absorbs `==`/`&&`/`||`/`contains`. A **lambda-shaped filter** (`"p->p.reviews>4.5"`, the user's own example form) hits the parser at `->` and returns: *"filter is a WHERE-expression, not a lambda: write `reviews > 4.5` (fields joined by and/or/not)."*
2. **Wrong field name** — uncatchable at parse time (fields are data-dependent), so fixed by **progressive disclosure in the output**. Every response carries `meta.fields` (union of keys) and `meta.paths_missing` (`{rating: 87}` = 87 records lacked `rating`) — **computed over the PRE-filter set at the stage each kind's predicate runs** (§5): the raw fetched set for non-web kinds, and the **post-merge consensus-stamped set for web**. Filtering web pre-merge would have made `paths_missing` misfire — reporting `{consensus: N}` because consensus is genuinely absent before the merge — steering the LLM to "typo'd field" when the field is real but computed one stage later; sampling web after the merge means `consensus` shows up in `meta.fields` and never falsely populates `paths_missing`. Computed over the pre-filter set, not the survivors, so a filter that matched nothing still reports the real keys and the missing count instead of an empty diagnostic. A typo'd filter returns `out:0` and self-diagnoses on the next turn. This closed loop is why the compact description suffices.

### 7.5 Safety — no `eval`, no catastrophic backtracking

- **Parser:** hand-written recursive descent, single-pass linear tokenizer, **no `Function`/`eval`, no `new RegExp` for the grammar**. Bounded: `MAX_EXPR_LEN=4000`, `MAX_TOKENS=512`, `MAX_DEPTH=32` (rejects `(((…)))` with a teaching error). Every clause is O(1)/O(field-size).
- **`~` regex is deferred out of v1.** It is the rarest operator and the only ReDoS surface, and the safe implementation (a Thompson NFA — linear O(n·m), immune to catastrophic backtracking, over a documented subset `literals . * + ? [..] ^ $ |`) is real work that shouldn't gate the verb. **v1 ships `has` (substring) and reserves `~` in the grammar** (using it → teaching error: "regex match not yet supported; use `has` for substring"). When `~` lands in a later cycle it is the NFA — **never** an unbounded `new RegExp`, whose backtracking a 4000-char bound does not save from pathological patterns. This sidesteps the graft contradiction (NFA-vs-bounded-RegExp) by shipping neither risky path in v1.
- **Post-SANE reality:** `normalizeArgs` (NFC, defont, zero-width-strip, LS/PS→`\n`) runs on `filter` before `run()` and before the cache key. Grammar literals are ASCII and survive SANE. Because `search` emits via `okRecords`/`safeStringify` (escaping U+2028/2029), a scraped title with LS/PS can't poison the envelope even though `search` is non-`raw`.

---

## 8. Over-fetch — a fixed per-backend ceiling, independent of `filter` and `limit`

The inline `filter` applies **before `limit`**, and its timing splits by kind (§5): **non-web backends filter per-backend PRE-merge; the web block filters POST-merge, after `consensus` is assigned** (a pre-merge web predicate would see `consensus === undefined` on every record and drop the advertised `consensus >= 2` filter — see §5). Either way a post-hoc `pipe(search→filter)` would see only survivors of the cut, so pushing the predicate down changes semantics and justifies the inline arg.

The per-backend fetch size is a **fixed ceiling that does not vary with `filter` presence or the caller's `limit`** — every call, filtered or not, `limit:10` or `limit:20`, fetches the same set:

```
SEARCH_OVERFETCH_CEILING = 30
fetchN(backend) = min(backend.maxFetch, SEARCH_OVERFETCH_CEILING)
```

Each backend fetches `fetchN` on **every** call (unfiltered browse included). The predicate (if any) then runs by kind (§5): on each non-web backend's list **before merge**, and on the web block **after merge** (so a `consensus` clause filters against assigned consensus, not `undefined`); survivors union, then the global list truncates to `limit`. Capped per backend by its schema max (kagi 50, ddg/google ~40, research 20–25, social 20). **This is deliberate: an unfiltered call now over-fetches too** — it pays the same fan-out subrequest cost as a filtered one — because the fixed size is precisely what lets §9 cache one unfiltered set and reuse it across every filter and every `limit`. Making the fetch conditional on `filter` (the earlier draft's `filter ? limit*N : limit`) would silently defeat the marquee `rating > 4.5` guarantee: an unfiltered `limit:10` browse would populate the shared key with 10 rows, and a later filtered call for the same query would filter against those 10 instead of the ceiling (§9). The fixed ceiling mirrors §4.3's fixed-15 inner-fetch invariant for the retail slot, adopted for exactly the same cache-sharing reason; making both over-fetch sizes constant (rather than one fixed, one filter-conditional) is what keeps §8 and §9 consistent. If `SEARCH_OVERFETCH_CEILING < survivors` a filter may under-return; `meta.paths_missing` + `by_backend` counts expose it. The **retail composite slot does not participate in `fetchN`** — `fanoutRetail` has no `fetchN` arg and fetches shop's fixed schema-default 15 per inner leg (the invariant shop's R6/R10 cache-sharing depends on), so `maxFetch("retail")=15` and the ceiling collapses to `min(15,30)=15`: `search` applies its `filter` to those ≤15 retail rows before the global `limit`, and cannot widen the retail over-fetch without a co-signed change to `shop.md`.

**Truncation is never silent.** When the requested `limit` exceeds the achievable merged yield (`sum(by_backend) < limit` — the single-retailer `limit:100`→≤15 case, but also any `all` call whose backends under-deliver), `search` stamps `meta.truncated:true` with a `meta.truncation_reason` (e.g. `"per-backend yield bounded: retail ≤15/retailer, web/research/social ≤30 — limit unreachable from the resolved backend set"`). So the LLM that wrote `limit:50` on one retailer expecting 50 rows sees *why* it got ≤15 in `meta`, not just a short list with no signal — closing the caller-misuse gap the schema description opens against.

---

## 9. Cache, freshness, consensus

**Cache the UNFILTERED fan-out.** The cache key is `{query, resolved-backends, zip, scope}` — **not** `filter`/`limit`/`fields`, which apply post-cache, and **not** the fetch size, which is now a fixed per-backend ceiling (§8) independent of `filter` and `limit`. Because the cached set is always the same fixed size regardless of who populates it, an unfiltered browse and a filtered call for the same query collide on the same key **and see the same rows** — the over-fetch survives cache order-independently (a filtered call that hits an earlier unfiltered call's set still filters against the full ceiling, never a `limit`-sized 10-row rump, so unfiltered-then-filtered yields the same survivor count as filtered-first). Folding `limit` or `filter` into the key would fragment the cache and destroy the reuse that makes the fan-out affordable (two `search("Makita")` calls with different filters or limits would each pay the full render). `search` runs the fan-out (or reads the cached unfiltered set), then applies `compileFilter` + `limit` truncation + `fields` projection on the way out.

**Partial results are not cached.** When `meta.errors[]` carries any transient code (`timeout`/`rate_limited`/`blocked`), the envelope is marked `noCache` — a slow-backend partial must not be served as authoritative for the stale-grace window. Only a clean (or settled-4xx/empty) fan-out is cached.

**Freshness (`staleGrace`).** `search` sets `Fn.staleGrace = 600` (the field `shop.md` R8 adds to `Fn`, consumed by `deferCacheWrite` as `expirationTtl = softTtl + (fn.staleGrace ?? CACHE_STALE_GRACE_SECONDS)`). Without it, `ttl:300` serves stale up to **24h** (`CACHE_STALE_GRACE_SECONDS=86_400`, `mcp-util.ts:58`) — dishonest for live retrieval. 600 caps the stale window at 10 min.

**Force-live is the universal `fresh` flag — one flag, both cache layers.** §9 keeps a SECOND cache inside `run()` (the unfiltered fan-out keyed `{query, resolved-backends, zip, scope}`) separate from the top-level dispatch cache (keyed on full args). Today `fresh` is `delete`d from args at `index.ts:166–169` before `run()` and gates ONLY the top-level read (`index.ts:262`, `if (key && !fresh)`), so it never reaches this inner cache — a bare `fresh:true` would clear layer-1, re-enter `run()`, then read the expensive render/retail rows STALE from layer-2 with no signal (the exact silent-staleness trap this design exists to avoid — dishonest for live retrieval precisely when it matters). The fix is a **co-signed dispatch change** (shared substrate, sibling sign-off): the parsed `fresh` boolean is **captured onto `RtEnv` (`env._fresh`) in addition to still being `delete`d from args at `:166–169`** — the strip stays exactly as today (`if ("fresh" in rawArgs) { fresh = Boolean(rawArgs.fresh); delete rawArgs.fresh; }`, so the top-level cacheKey stays clean over the remaining args, a fresh call overwrites the same entry rather than diverging into a `fresh`-namespaced key no normal call reads, and `fn.run` never sees a stray `fresh` arg per the `index.ts:153–159` comment); the only new line is `env._fresh = fresh;` alongside where `env._egress` is already assigned. This preserves the universal cache-overwrite invariant for **all** cacheable fns (removing the `delete` would silently strand every normal caller on the stale top-level entry). `search` then gates its §9 fan-out read on it (`if (cached && !env._fresh)`, still deferring the write) so ONE flag honestly clears both layers. `search` invents **no** second `no_cache` passthrough: §1 is `additionalProperties:false` with no `no_cache` property, so the arg would be rejected as `bad_input` before dispatch — unreachable by an implementer copying the schema; reusing `fresh` is the leaner, bidirectional choice. A bare `fresh:true` is thus honestly live across both layers. **The retail composite slot has a THIRD cache layer** — `fanoutRetail`'s per-leg `callFnCached` render cache (`shop.md` §1/§6) — and `env._fresh` alone does **not** reach it: the seam's default `fresh` fallback busts FAST-tier legs only, so re-entering `run()` under `fresh:true` re-invokes `fanoutRetail` and re-reads every render leg (amazon/walmart/homedepot/lowes/ace) STALE from its untouched per-leg cache. So `search` **passes `bustRenders: env._fresh`** into `fanoutRetail` (§4.3/§5) — the single co-signed contract by which `env._fresh` busts fast AND render legs uniformly. Omitting it would reintroduce the exact silent-staleness trap on the retail tier. `shop`, by contrast, wires `bustRenders: args.bust_renders` (independent of `env._fresh`) to keep its render tier cheap — the tier-selective divergence is expressed by argument, never by branching on caller identity (`shop.md` §1).

**Consensus** is a web-only flat field (`filter:"consensus >= 2"` = URLs ≥2 engines agree on).

---

## 10. Cost, rate-limit, error envelope

**Cost is per-call, and the charge site is the pre-dispatch gate — so the resolution must live THERE.** The weighted limiter runs at the `tools/call` gate (`index.ts:344`, `weightedRateLimit`), and `extraCost(name)` today computes `Math.max(0, (findFn(FUNCTIONS, name)?.cost ?? 1) - 1)` — it reads the **static** registered `Fn.cost` (`registry.ts:135`, `cost?: number`) purely from the tool *name*, and charges those extra tokens **before** dispatch ever calls `search.run()`. `resolveBackends` only exists *inside* `run()`, after the charge is already applied (or already 429'd), so there is no channel for a value "reported from inside `run()`" to reach it — a static `cost:5` would let `search(backends:"all")` cost the same as `search(backends:"kagi")`, and a `cost` set to a *function* would make `(fn.cost ?? 1) - 1` → `NaN` → `Math.max(0, NaN)` = `NaN` → the extra-charge loop never runs (a silent zero charge). Both are the exact failure this decision claims to prevent.

**The fix is a co-signed change to the shared rate-limit/registry substrate** (siblings that also want per-call cost must agree — not a search-local edit): extend `extraCost`/`weightedRateLimit` (`rate-limit.ts`) to accept the call **arguments** (already on `rpc.params.arguments`; `env` is already passed) and, for `search`, run `resolveBackends(env, args.backends)` **at the gate** to compute the summed extra render tokens before dispatch. This keeps the single pre-dispatch charge site and the 429 short-circuit intact — the gate charges by the actually-resolved backend set, so `search(backends:"all")` with five named render backends is charged for that render weight while `search(backends:"kagi")` is not. `Fn.cost` is widened to `number | ((env, args) => number)` and `extraCost` is updated to **evaluate** it when it is a function (guarding the current `NaN` path: `typeof cost === "function" ? cost(env, args) : cost`, coerced through `?? 1`); `resolveBackends` still returns its summed `cost` for `meta`/diagnostics, but that value is now consumed by the gate-side `Fn.cost` function, not "reported" from within `run()`.

```jsonc
"meta": {
  "source": "search",
  "total": 42, "truncated": false,
  "fields": ["title","url","price","rating","snippet","date","consensus"],
  "paths_missing": { "rating": 12 },
  "by_backend": { "kagi": 10, "ddg": 8, "homedepot": 6, "reddit": 0 },
  "skipped": [{ "name": "youtube", "why": "no YOUTUBE_API_KEY" }],
  "errors": [
    { "key": "reddit", "error": "datacenter IP blocked", "code": "blocked" },
    { "key": "web", "error": "filtered_all — no web result carries 'reviews' (kind 'web' has no such field); all merged web rows dropped", "code": "filtered_all" },
    { "key": "amazon", "error": "solver budget — still rendering; re-call for cache hit", "code": "timeout" }
  ]
}
```

`by_backend` carries a count for **every dispatched backend** — the `"reddit": 0` entry is a social backend that produced a slot only because `resolveBackends.direct` is the full web+research+social set (§4/§5); had `direct` stayed web-only, reddit would never dispatch and this key could not appear. Failures live **only** in `meta.errors[]` (algebra R8), FailCode-typed. Per-backend isolation: a throw/timeout/`blocked` in one backend never aborts siblings. **When a filter empties an entire kind's block, a targeted `filtered_all` note is stamped so the caller sees results were *filtered out*, not that a backend failed or that the filter is broken — and the note is keyed by the stage the predicate ran (§5), never per-web-backend.** The web block filters ONCE post-merge on the merged `normUrl` set (§5), after which per-web-engine provenance for a drop no longer exists — so whenever the post-merge web predicate empties the merged web block, a **single** note keyed `"web"` is stamped, REGARDLESS of cause: a kind-absent field (the marquee `reviews > 4.5` + `web` case — `kind:web` has no `reviews`, so no merged web row carries it) and a merge-time field (`consensus >= 2` dropping every URL below 2 engines) are the identical post-merge drop, uniform across all web engines, and both key `"web"`. Per-backend `filtered_all` keys are reserved strictly for **non-web kinds**, which filter per-backend pre-merge (§5) — there the attribution to a specific backend is real (e.g. a `citations`-on-`reddit` clause drops reddit's own rows, keyed `"reddit"`). `search` hard-`fail`s only on: empty `query`, a filter parse error, or zero resolvable backends — everything else returns a success envelope with partials + errors so `pipe` composition never breaks on a flaky leg. `summarize:true` (old `web_search`) is not a `search` arg → the universal dispatch-layer `summarize` flag applies for free, and a caller passing it in `filter` gets a teaching error pointing at `reduce(op:"summarize")`.

---

## 11. Deleted / absorbed / kept (fn-count)

| fn | fate |
|---|---|
| **`web_search`** | **DELETED** — 4 engines + consensus merge + `normUrl` → `search`'s web group + §5 merge. `summarize:true` is not re-added inline (the universal `summarize` flag + `pipe([search, reduce])` cover it). Edit `gen-docs.mjs:22` or gen-docs exits 1. |
| **`product_search`** | **DELETED — gated** (`shop.md` R11): kept as a ~30-line `fanoutRetail` wrapper for one overlap cycle, deleted only after `search(backends:'retail')` ships and consumes `fanoutRetail`. `search(backends:'retail')` covers only the fast retailers (kroger/bestbuy/ebay/costco); product_search's render retailers (amazon/walmart/homedepot/lowes/ace) stay reachable **by name** (`search(backends:['amazon',…])`, ≤3/call), so the deletion is no silent capability regression. |
| **`shop` (thin router)** | **ABSORBED** — `shop store:amazon` → `search(backends:['amazon'])`. The **name** `shop` is reused by the comparison engine (`shop.md`), kept in place. `search` retrieves; `shop` compares; they share `_retail_fanout.ts`. Deals overlay stays on `shop`. |
| **9 retailer + 6 research + 3 social + `tavily`/`find_similar`** | **KEPT** — standalone detail/action surfaces; gain a second life as backends. |

**Net from this design: −2** (`web_search`, `product_search`); `search` rewritten in place. `89 → 88` at `web_search` deletion, `→ 87` at the gated `product_search` deletion. The standalone `filter`/`map`/`reduce`/`augment` are counted in `algebra.md` (+4) and consume *this* `_filter.ts`.

---

## 12. New/changed modules

| file | role |
|---|---|
| `sux/src/fns/search.ts` | rewritten verb: schema, `resolveBackends`, `fanout` spread, merge, cache-unfiltered + post-filter, envelope emit |
| `sux/src/fns/_search.ts` | `SearchAdapter`, `SEARCH_BACKENDS`, `GROUPS`, `BACKEND_ALIASES`, `SearchResult`, `taggedToSearchResult`, per-backend normalizers |
| `sux/src/fns/_filter.ts` | **owned here** — `Predicate & {paths}`, `compileFilter`, tokenizer (+synonyms), recursive-descent parser, `dig` integration; `~`/NFA deferred |
| consumed | `_records.ts`, `_fanout.ts` (algebra), `_retail_fanout.ts` (`shop.md`) |
| `registry.ts` | add `Fn.staleGrace?`, `Fn.width?`, `Fn.records?`; widen `Fn.cost` to `number \| ((env,args)=>number)` (shared with siblings) |
| `rate-limit.ts` | co-signed: `extraCost`/`weightedRateLimit` take `env` + call `args`, evaluate a function `Fn.cost` (guard `NaN`), so the gate charges `search` by `resolveBackends` (§10) |
| `index.ts` (dispatch) | co-signed: capture the parsed `fresh` boolean onto `env._fresh` **in addition to** still `delete`ing it from args at `:166–169` (add `env._fresh = fresh;` where `env._egress` is set; the strip stays so the top-level cache key is unchanged and a fresh call overwrites the same entry), so `search`'s §9 inner fan-out cache honors force-live (§9) |

---

## 13. Migration — one change per plan→test→deploy→push cycle

Prereqs (land first, from siblings): `_records.ts` (algebra cycle 0), `_fanout.ts` (algebra cycle 1), `_retail_fanout.ts` (`shop.md` step 1). `search`'s cycles:

0. **`_filter.ts`** on the co-signed frozen grammar + `_filter.test.ts`. Blocks on the frozen spec (incl. the `paths` export), not on the algebra `filter` fn shipping. The algebra `filter` fn rebases onto these exports.
1. **`search` → records envelope, web group.** Absorb `web_search`'s engines + `normUrl` merge; emit `SearchResult` (`records:true`); Kagi scope; `backends` + inline `filter`; cache-unfiltered + post-filter; the **co-signed `fresh` pass-down** (§9 — `env._fresh` into `run()`, gate the inner fan-out read on it; sibling sign-off, must land WITH the inner cache so force-live is honest from day one). **Delete `web_search`** (edit `gen-docs.mjs:22`, `gen:index`, `docs`, SKILL.md, `check-skill-sync --write`).
2. **Research group** adapters — date/citation normalization + fixtures.
3. **Social group** — three envelope-key normalizers, reddit proxy isolation, youtube key gate.
4. **Retail group** via `fanoutRetail` composite slot; add `rating`/`reviews` to `RetailProduct`/adapters. Then **gate-delete `product_search`** (docs → 87). Add `search` to `batch`'s `NESTED_FANOUT_TOOLS` + `pipe`'s `BLOCKED_STEP_TOOLS`.
5. **`staleGrace:600`** (if not landed by `shop`), `Fn.width`, and the **co-signed gate cost change** (§10): widen `Fn.cost` to `number | ((env,args)=>number)`, teach `extraCost`/`weightedRateLimit` (`rate-limit.ts`) to pass `env` + `rpc.params.arguments` and evaluate a function `cost` (guarding the `NaN` path), register `search`'s `cost` fn as `(env,args)=>resolveBackends(env,args.backends).cost`; ledger verification. Sibling sign-off required (shared substrate).

Each cycle: `gen:index` + `docs`, hand-edit SKILL.md, mirror `plugins/sux-router/skills/`.

---

## 14. Doc / test impact

- **`gen-docs.mjs:22`** drop `web_search` from `CATEGORIES["Query / APIs"]` (mandatory or gen-docs exits 1).
- **`FUNCTIONS.md`** auto: count `89 → 88 → 87`; add the column-coverage-by-kind note (which backends populate `rating`/`price`/`citations`).
- **SKILL.md** (hand-edited): rewrite `search`; delete `web_search`/`product_search` prose; add field-catalog-by-kind + the worked example; `\b`-name the algebra `filter` fn.
- **Tests:** `_filter.test.ts` (grammar table, precedence, each op, missing→false, prefix `exists`, arrays, synonyms, teaching errors, deferred-`~` error, depth/length caps, post-SANE quoting, **date-string coercion unit golden** — `date > '2024-01-01'` KEEPS a record with `date` = epoch-seconds of 2024-06-01 and DROPS one from 2023; this fails against a raw-`Date.parse` (ms) implementation, pinning the seconds axis and catching the 1000× regression — plus an unparseable date-string operand → §7.4 bad_input, not NaN→false). `search.test.ts` (mock `./index`/`_retail_fanout`; per-backend isolation; consensus merge; **`filter:"consensus >= 2"` filters the web block POST-merge** (survivors = URLs ≥2 engines returned, NOT zero — a pre-merge predicate would see `consensus:undefined` and drop all; a lone all-web-dropped case stamps `{key:"web", code:"filtered_all"}` and lists `consensus` in `meta.fields`); non-web `filter` runs per-backend pre-merge; over-fetch→filter→limit ordering (unfiltered-then-filtered yields the SAME survivor count as filtered-first — fixed-ceiling fetch + cache order-independence, so an unfiltered `limit:10` browse populating the key does not starve a later filtered call to a 10-row set); `all` excludes render backends; render-cap ≤3 as ONE shared budget across buckets (`["google","homedepot","lowes","ace"]` admits 3, skips `ace`, never 4 solver jobs); **google + render-retailer co-selection** (`["google","homedepot","lowes"]` → `googleSelected:true`, total solver pressure ≤3, `fanoutRetail` receives `maxConcurrentRenders:2` **and NO `renderTimeoutMs` override** (inherits shop's frozen ~80s), google's own direct slot receives `renderTimeoutMs:38000`, and neither google nor the retail slot is cut by the 50s `totalBudgetMs`/FN_DEADLINE — each is bounded by its OWN render timeout (google 38s, the retail legs ~80s); assert a google render exceeding 38s degrades to a `code:"timeout"` note whose inner render caches via `waitUntil` (re-call = hit), NOT a bare deadline error, and do NOT assert the false "neither returns `code:"timeout"`" that fast mocks let pass); single-retailer `limit:100` returns ≤15 AND stamps `meta.truncated:true`+`truncation_reason` (yield-bounded, non-silent); unknown-name→skipped; empty-query/parse-error hard-fail; cache-unfiltered reuse across filters AND limits (a fixed-ceiling set populated by `limit:10` is reused by `limit:20` and by any filter); force-live via `fresh:true` bypasses ALL THREE cache layers — the top-level dispatch cache, the §9 inner fan-out read (`env._fresh` gate), AND the retail render legs' per-leg `callFnCached` cache (asserting `fanoutRetail` receives `bustRenders: env._fresh`, so a warm render leg like walmart is NOT served stale under `fresh:true` — the fast-only `fresh` fallback alone would leave it cached); a warm inner set is NOT served under `fresh:true`; partial→noCache; `filtered_all` note; date-normalization golden per kind). Fuzz/registry auto-cover. injection-guard unaffected.

---

## Deliberate scope cuts

- **`~` regex operator** — deferred to a post-v1 cycle (Thompson NFA). v1 ships `has`.
- **`pipe([search, …])`** — `search` is `BLOCKED_STEP_TOOLS`; callers pre-fetch and feed records in. A pipe width-budget mechanism is future work.
- **Deals / weekly-ad** — stays on the `shop` comparison verb, not a `search` backend.
- **Cross-kind consensus** — only web results dedupe; other kinds union in backend order.

## Co-signed changes to `algebra.md`

1. `compileFilter` returns `Predicate & { paths: string[] }` (was `Predicate`) — the algebra `filter` fn adopts the same signature.
2. The lexer synonym set (`==`→`=`, `&&`→`and`, `||`→`or`, `contains`→`has`) is part of the shared grammar.
3. `exists` is **prefix**; missing-field → false for all ops except `exists` (R11 confirmed).
4. `Fn.staleGrace?`, `Fn.width?`, `Fn.records?` are the shared `Fn` fields (also in `shop.md`).

## Related

- [[filter-dsl]]
- [[fanout]]
- [[records-envelope]]
- [[shop]]
- [[Parked-Retrieval-MOC]]
