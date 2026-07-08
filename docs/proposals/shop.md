# shop(item) — cross-retailer price-comparison engine

`shop` is a **specialized commerce verb**, not "search with retail backends." `search` *retrieves* (fan out, normalize, isolate failures, return a list). `shop` *compares*: it resolves which listings are the same product, normalizes prices to comparable units, overlays live flyer deals, stamps every number with its true age, and returns one structured comparison table. Recommendation ("buy the Lowe's one") stays with the frontier-model caller — the server never synthesizes prose judgment (Workers AI is too weak to be the reasoner; the schema's user *is* a frontier model, so hand it clean structured facts). `shop` owns **zero fetching**; it composes the same retail adapter core the unified `search` refactor consumes.

This design folds in the tournament winner ("comparison-engine" angle), all three judges' grafts, and the 45 adversarial issues (7 blockers, 22 majors). Every contested point is resolved once, below.

---

## 0. Resolved decisions

| # | Decision | Resolution | One-line justification |
|---|---|---|---|
| R1 | 60s dispatch deadline (index.ts:41 wraps `shop.run`) | `fanoutRetail` runs an internal **45s soft deadline**; race `Promise.allSettled` against it; unfinished retailers → `pending[]`/`errors[]`, partials returned. Render-tier inner calls set `renderTimeoutMs` to **~80s** (≥ the cold-walmart 2-load max of ~75s, with margin — *not* the adapter-native ~55s, which is below that max, and never a 38s abort): the invariant is `renderTimeoutMs ≥ max cold-render time (~80s ≥ the cold-walmart 2-load max)` **and** `renderTimeoutMs > softDeadlineMs`, so a render that overruns the 45s wait lands in `pending[]` (never `errors[]`) and keeps running under `ctx.waitUntil` to completion (up to ~75–80s for a cold walmart, not the earlier-claimed ~50–55s, which contradicted the 45–75s cold figure), writing `sha256(walmart:canonicalArgs)` to KV so the ~30s-later re-call is a genuine inner-cache hit. `ctx.waitUntil` holds the ~25–35s gap between the 45s soft-deadline response and the ~80s render completion: the waitUntil budget is bounded by **CPU** time (30s default, raisable to 5 min on the paid plan via `limits.cpu_ms`), not wall-clock, and a pending render is I/O-bound (awaiting the node at ~0 CPU), so the gap is comfortably inside budget and R6's shop-warms-walmart is reachable by construction — it does not fall back to "walmart caches only via a direct call." A shorter 38s inner abort is both redundant (the 45s soft-deadline race already caps shop's wait) and fatal (it kills a promptly-started render at t0+38s, before the 45s deadline can classify it as unfinished, drops it into `errors[]`, and leaves `waitUntil` nothing to cache — so cold walmart's 2 loads / 45–75s could never render+cache and the re-call never hits). A **partial (pending-bearing) envelope is returned `result.noCache`** (§2/§6) so the instructed re-call re-executes `run()` and folds in the now-cached render legs (R6) — otherwise shop's own 300s envelope cache (R8) would serve the stale partial back and the deadline-recovery would silently no-op. | A single mac render is 30–60s and a headless→solver escalation is two serialized page loads; shop *cannot* wait for all of them inside 60s, so it must return partials by construction — and must not cache those partials, or the re-call-for-a-hit contract collides with R8. |
| R2 | Default tier | **`tier:'fast'`** (kroger, bestbuy, ebay, costco, +flipp, +places) is the default; render additions are explicit opt-in. **`tier:'full'` auto-selects a bounded ≤3 render subset** (category-appropriate, deterministic rule — see §2/§3 guard 5), *not* all five; `retailers[]` may name more but the §3 render-cap guard truncates the resolved set to ≤3. The **≤3 render retailers/call cap is enforced in `run()`**, not merely asserted. **`tier:'full'` (and any explicitly-named render retailer) is refused inside a `pipe`/`batch` step** — when `run()` sees `env._depth > 0` it rejects with a teaching error: its ≤45s render wall-time is the SAME hazard that hard-blocks `search` from pipe (algebra §6), and the subrequest-denominated `PIPE_FETCH_BUDGET` cannot express it (`pipe([shop×8])` is width-legal at ≈56 ≤ 60 but 8 render-tier steps ≈ 360s ≫ 60s). The **fast tier (<5s, `width:7`) stays fully pipe-composable**, so the marquee `pipe([shop, filter, augment, reduce])` (a fast-tier grocery run) is unaffected; a pipe needing render results pre-fetches with a standalone `shop tier:'full'` call and feeds the records in (the error names both alternatives). | The fast tier is API/curl, <5s, free; renders are the only thing that can blow the deadline *and* bloat solver budget (capped at 2/call), so they never fire unless asked, never exceed 3, and are never a pipe step. |
| R3 | Retailer selection surface (Judge 0/1 mixed enum vs Judge 2 `tier`+override) | Adopt **Judge 2**: `tier:'fast'|'full'` + optional `retailers[]` override. One `HINT_ESCALATE` constant drives both the `hint` field and `retailers_skipped`. | Pseudo-values (`'all'`,`'api'`) inside a name enum are a schema smell; `tier` subsumes them and the hint teaches a retry that actually validates against the schema. |
| R4 | Fuzzy threshold (Judge 0 `0.7` brand vs Judge 2 `0.6` brand) | The dispute is **moot on the wrong metric**. Symmetric Jaccard is dead code (real same-item cross-retailer pairs score 0.3–0.5). Replace with **asymmetric containment** `|∩|/|smaller set|`: **≥0.60 brand-confirmed, ≥0.75 brandless.** | On containment the design's own HD(13-tok)/Lowe's(9-tok) pair scores 7/9=0.78 and clusters *without* the model key; on Jaccard it scored 0.47 and never fired. Containment makes the tier live; 0.60/0.75 (Judge 2, stricter-where-blind) is the calibrated pair. |
| R5 | `best` selection | `best` = **lowest NEW-condition effective offer**; add `spread:{low,high,used_low}`. Used/refurb never wins `best`. | The winner's own example crowned a used eBay listing — internally inconsistent; the used floor still surfaces in `spread`. |
| R6 | Cache sharing (the "walmart render 2 min ago is a hit" claim) | **Canonicalize the inner ask**: `fanoutRetail` requests each adapter's **schema-default limit (15)** always, slices to the clamp locally. `callFnCached` fills the same defaults for direct calls before keying. | cacheKey hashes exact args; a varying `limit` guarantees a miss. Fixed-15 makes shop's inner arg shape match direct calls, so entries actually share. |
| R7 | `callFnCached` completeness | It reuses the **extracted `finalize` pipeline** (normalizeText + `clampResult`; skip summarize) and threads `ctx` via `env._egress.ctx`. | Otherwise dispatch-written and shop-written entries diverge byte-wise under the same key and never share (breaks single-flight too). |
| R8 | Freshness / SWR grace (`CACHE_STALE_GRACE_SECONDS=86_400`) | Add **`Fn.staleGrace`**; set **600s for shop**. Inner render-tier calls reached via shop apply a **1800s read-side soft-ttl override and do NOT trigger the SWR background refresh** (the override is reader-scoped — the shared KV entry keeps its native soft ttl, R6/§6). | A price-comparison verb serving a 24h-stale table while claiming ≤300s is dishonest. `cacheable:false` would 5× render cost on repeats; 600s caps stale serve at 10 min. Suppressing inner render refresh stops repeat shop calls silently re-rendering. The ttl:300 envelope cache applies **only to fully-settled results**; a pending-bearing partial is `result.noCache` (R1/§2), so the deadline-recovery re-call is never defeated by shop's own envelope cache. |
| R9 | `age_s` source | **Required column** on every price row; derived from the entry's **own write time** — store `storedAt` (epoch ms) in `CacheMeta` at write, and return **`age_s = round((now − storedAt) / 1000)`** from `callFnCached`, independent of the reader's `ttl`. `softTtlOverride` must **not** participate in age derivation. | The `softExpiresAt − ttl·1000` back-derivation is silently wrong whenever a render entry is shared across ttl-divergent contexts (R6/R8): a direct walmart write (native soft ttl) read by shop's `softTtlOverride:1800` inner call mis-derives `storedAt` by `(writerTtl − 1800)`s, over-reporting age by up to 25 min on the exact shared-hit path R6 celebrates. Storing `storedAt` makes age true regardless of reader ttl; the legacy gap is covered by the existing `age_s:null` fallback (new writes carry `storedAt`, old ones stay null). Separately, the reverse leak is closed by making shop's 1800s soft-ttl a **read-side override** (§6): the R6-shared entry keeps its native soft ttl, so a direct caller's stale/SWR decision is unaffected while shop's 1800s window is computed per-read. |
| R10 | Per-retailer ask formula (graft `clamp(ceil(limit*2/n),3,10)`) | Keep the clamp, but it governs the **per-retailer candidate count fed to the clusterer** (a pre-clustering bound), not rows fetched (fetch is always default-15 per R6) and not the final per-group row count (that is `limit`, applied post-clustering — §4 "Row selection", R17). Drop the "caps render-page waste" claim. | Render adapters fetch exactly one page regardless of `limit`; the clamp only trims candidate list length and is incompatible with cache-sharing if it varies the fetch. Its 3-floor × N-retailer product must be re-bounded by the post-cluster `limit` truncation or a group doubles the caller's requested row count. |
| R11 | product_search deletion | **Gated** on `search(query, backends:'retail')` shipping and consuming `fanoutRetail`. Kept registered as a thin wrapper for one overlap cycle; deleted only after search lands. | Deleting it removes the only bulk ungrouped retrieval (limit 100, flat list); shop (limit 25, forced groups) is not a substitute. |
| R12 | Milwaukee-style letterless models (`2804-20`) | Second key pattern: `/^\d{3,4}-\d{1,3}$/` accepted **when a known brand token co-occurs**. | Milwaukee's entire catalog is numeric-hyphenated; the letter-required rule silently drops the one high-signal token. |
| R13 | places "nearby stores" leg (Judge 1 graft 2) | **Adopt**, zip-gated, runs in the fast wave (one Google-Maps fetch, ~1s) → `nearby_stores[]`. | Free, fast, fits the deadline, and answers the one shopper question ("can I get it today") shop otherwise can't. |
| R14 | `_flipp.ts` helper (Judge 1 graft 5) vs cache | Deal leg calls **`callFnCached('weekly_ad',…)`** (keeps its ttl-3600 cache); `_flipp.ts` is the shared parse/merchant-map module both `weekly_ad` and the overlay import. | Satisfies the graft's "no text-envelope re-parse" intent without forfeiting the flyer cache. |
| R15 | weekly_ad / winco fate | Both **kept** as standalone verbs (reject Judge 1's weekly_ad deletion). winco stays a locator; `places` already surfaces WinCo stores; shop never calls winco. | Constraint: adapters keep standalone surfaces; winco has no online catalog to compare. |
| R16 | fn count | **89 → 88** (product_search removed), realized at the gated deletion; **89 during the overlap cycle**. shop replaces shop in place (no net change). | Honest count for the docs-sync commit at each step. |
| R17 | `limit` semantics (schema said "rows per group + groups"; only impl was the per-retailer clamp — no step truncated a group) | Three named roles, fixed pipeline order (§4 "Row selection"): (1) `clamp(ceil(limit*2/n),3,10)` is a **pre-clustering candidate bound** per retailer; (2) item mode truncates **each group to `limit`** rows post-clustering (best always kept, priceless dropped first, sort by effective_price asc); (3) category mode = **max groups**. | The clamp's 3-floor × N retailers doubled the caller's requested row count (`limit:8`+eBay ≈ 13 rows) and made `max:25` unreachable at `n:2`; a post-cluster truncation is the missing reconciling step so `limit` predicts output size. |
| R18 | `fresh` flag (shop declared its own `oneOf:[bool,'all']`; the universal `fresh` is stripped to boolean at dispatch) | Drop shop's in-schema `fresh`; consume the **universal boolean `env._fresh`** (search.md §9/§12 co-signed dispatch threading) for the fast-tier bust; add a **distinct `bust_renders:true`** in shop's own schema for the render-tier bust. | A boolean `env._fresh` can't carry `'all'` into `run()`, so shop's advertised render escape hatch was unreachable, and re-declaring `fresh` in-schema reinvents exactly the cache-control arg search.md forbids (`additionalProperties:false` makes it unreachable). One `fresh` semantics across both docs. |

---

## 1. The search/shop boundary (stated and defended)

```
search  →  RETRIEVES:  fan out, normalize, isolate failures, return a flat list. Caller reads listings.
shop    →  COMPARES:   entity resolution + unit price + deal overlay + freshness stamping over the SAME
                       fan-out. Caller reads a table of resolved products with a `best` pointer.
```

They share one fetch layer and diverge only in what they compute on top. shop adds four things search deliberately does not: (1) *which listings are the same product*, (2) *price-per-unit across pack/size variance*, (3) *live flyer deals joined onto rows*, (4) *the true age of every number*. If a task needs the raw merged list (bulk retrieval, `limit` up to 100), that is `search(backends:'retail')`, not shop.

### Layering

```
Layer 0  adapter fns (unchanged, keep standalone detail/action surfaces)
         kroger, bestbuy, ebay, costco, amazon, walmart, homedepot, lowes, ace,
         weekly_ad, winco, places
Layer 1  retrieval core — NEW sux/src/fns/_retail_fanout.ts (extracted from product_search)
         fanoutRetail(env, opts): registry-name dispatch, Promise.allSettled + soft deadline,
         per-retailer TaggedProduct[] + errors[] + pending[]
         → consumed by BOTH search(query, backends:'retail') AND shop
Layer 2  commerce intelligence — shop  (sux/src/fns/shop.ts + pure sux/src/fns/_compare.ts)
         entity resolution + unit-price + deal overlay + freshness stamping. No fetch.
```

### The seam contract (`sux/src/fns/_retail_fanout.ts`)

The single interface the two in-flight refactors must agree on. Whichever lands first **owns this file**; the other rebases onto `FanoutResult`.

```ts
export type TaggedProduct = RetailProduct & {
  retailer: string;
  age_s: number | null;
  price_scope: "store" | "online" | "session-store";
  shipping_cost?: number;
};
export type FanoutResult = {
  products: TaggedProduct[];
  by_retailer: Record<string, number>;
  errors: Array<{ retailer: string; error: string }>;
  pending: Array<{ retailer: string; why: string }>;
};

export const RETAIL_ADAPTERS = ["kroger","bestbuy","ebay","costco","amazon","walmart","homedepot","lowes","ace"] as const;
export const FAST_TIER   = ["kroger","bestbuy","ebay","costco"] as const;         // official API + 1 residential curl (costco); free, <5s
export const RENDER_TIER = ["amazon","walmart","homedepot","lowes","ace"] as const; // mac render, cost 5 each, 30–60s

export async function fanoutRetail(env: RtEnv, opts: {
  term: string;
  retailers: ReadonlyArray<string | { name: string; args?: Record<string, unknown> }>;
  zip?: string;
  softDeadlineMs?: number;      // default 45_000
  renderTimeoutMs?: number;     // default 80_000 (≥ the cold-walmart 2-load max, ~75s, with margin — NOT adapter-native ~55s); MUST be ≥ max cold-render time AND > softDeadlineMs so an overrun lands in pending[], not errors[]
  maxConcurrentRenders?: number;// default 3 (see R1/R21)
  fresh?: boolean;              // default env._fresh; busts FAST-tier legs ONLY — a consumer wanting all-leg busting must ALSO pass bustRenders: env._fresh
  bustRenders?: boolean;        // default false; applied as fresh:true to RENDER-tier legs ONLY
  renderSoftTtlMs?: number;     // default adapter-native soft ttl; shop passes 1_800_000
  suppressRenderStaleRefresh?: boolean; // default false; shop passes true
}): Promise<FanoutResult>;
```

**Per-tier cache policy is a channel, not a hardcode.** The seam owns per-leg `callFnCached` opts, so the two consumers diverge by *argument*, never by branching on caller identity inside `fanoutRetail`: baking shop's 1800s/suppress policy into the file would silently corrupt search's retail caching (R11), and a tier-selective `env._fresh` bust has no meaning search can express. The four freshness signals ride these opts, each scoped to exactly one tier. `fresh` (falling back to `env._fresh` when omitted) busts **fast-tier legs only** — renders stay cached; `bustRenders` sets `fresh:true` on **render-tier legs only** — fast legs untouched; `renderSoftTtlMs` and `suppressRenderStaleRefresh` set each render leg's `softTtlOverride`/`suppressStaleRefresh` (§6), defaulting to adapter-native ttl + normal SWR. **shop** calls `fanoutRetail(env, {…, bustRenders: args.bust_renders, renderSoftTtlMs: 1_800_000, suppressRenderStaleRefresh: true})` and relies on `env._fresh` for the fast bust (R8/R18) — deliberately wiring `bustRenders` to its own `args.bust_renders` (independent of `env._fresh`) to keep the render tier cheap. **search** (`backends:'retail'`, R11) omits `renderSoftTtlMs`/`suppressRenderStaleRefresh` (so its render legs get native soft ttl + normal SWR) and passes `bustRenders: env._fresh`, so `env._fresh` busts **every** leg uniformly — fast via the `fresh` opt fallback, render via `bustRenders` — honoring search.md's one-flag-both-layers guarantee. If search instead omitted `bustRenders`, its `env._fresh` would bust fast legs only and every render leg (amazon/walmart/homedepot/lowes/ace) would serve STALE from its per-leg cache — silently defeating search.md's universal-fresh honesty guarantee. The two never share a hardcoded policy; the tier-selective divergence is expressed by *argument* (search passes `bustRenders: env._fresh`, shop passes `bustRenders: args.bust_renders`), never by branching on caller identity.

Each `retailers` entry is either a bare registry name (`"walmart"`) or a `{name, args?}` object; the entry's `args` is threaded into that adapter's `callFnCached` call. This is the channel that carries the kroger `chain` filter for banner aliases (`fred_meyer`/`qfc`/`ralphs` → `{name:"kroger", args:{chain:"Fred Meyer"}}`) — a bare `readonly string[]` seam could not, so a banner comparison would silently collapse to generic Kroger results. Both consumers rely on this: search.md's `resolveBackends` emits exactly this `Array<{name; args?}>` shape as `resolved.retail`, and shop's own §3 banner→kroger mapping uses it. `FanoutResult` is unchanged — the input `opts` widen in two ways: the `retailers` entry shape (bare name → `{name, args?}`) **and** the four per-tier cache-policy opts above (`fresh`/`bustRenders`/`renderSoftTtlMs`/`suppressRenderStaleRefresh`) that carry shop's render freshness policy and R18's tier-selective bust through the seam instead of shop reaching into per-leg `callFnCached` opts directly.

`RetailProduct` (the shared adapter record, owned here) carries **`rating?: number`** and **`reviews?: number`** — surfaced by the bestbuy `customerReviewAverage`, walmart `averageRating`, homedepot/lowes state-blob `reviews.averageRating`, and amazon tile `a-icon-alt` parsers (search.md §4.3 enumerates them). `TaggedProduct` inherits both, so search's `taggedToSearchResult` mapping and its `filter:"rating > 4.5"` marquee have the fields they read, and algebra's `augment` `price` adapter (TaggedProduct-shaped) inherits them for free. They are optional: populated for bestbuy/walmart/homedepot/lowes/amazon, **omitted** for kroger/costco/ace/ebay (payloads lack them). The field-surfacing lands in the shared retail-adapter cycle search.md §13 schedules — not a shop-owned side task.

`costco` sits in `FAST_TIER` but is a **residential-proxy curl**, not an official API — documented so the search refactor's backend groups don't mislabel it. Step 1 lands `fanoutRetail` with the **verbatim 7-retailer list** product_search uses today (kroger, walmart, homedepot, amazon, lowes, costco, ace — behavior-neutral, tests green); step 1.5 extends `RETAIL_ADAPTERS` to add bestbuy + ebay with fixture tests proving both emit `{products:[…]}`.

### The `searchByTerm` co-signed export (shop owns the retail term→product core)

algebra.md §4.3's shipped v1 `augment` `price` adapter (build cycle 7) depends on a shop-owned term→best-product-per-retailer wrapper. shop **owns and freezes** it — the co-sign is bilateral, exactly as search.md co-signs `_filter.ts`:

```ts
// sux/src/fns/shop.ts (exported for algebra.md's _augment price adapter)
export async function searchByTerm(env: RtEnv, term: string, opts: {
  retailers: string[];
  zip?: string;
}): Promise<Map<string /*retailer*/, TaggedProduct>>;
```

It is a thin wrapper: `fanoutRetail(env, {term, retailers, zip})` (§1) → build the query object internally as `{ modelKeys: extractModelKeys(term), brand: undefined, terms: term.split(/\s+/) }` → `clusterProducts(products, q)` (§4), then return the **best `TaggedProduct` per retailer** (the group member with the highest containment score under the existing `FUZZY_CONTAIN_BRAND`/`FUZZY_CONTAIN_BLIND` thresholds, new-condition preferred). Callers pass a **bare `term` string** — the wrapper constructs the `clusterProducts` `q` object itself, so there is no call-shape mismatch with `clusterProducts(products, q: {modelKeys, brand?, terms})`. This signature is **frozen and bilaterally co-signed**: shop.md carries the co-sign for `searchByTerm` exactly as search.md carries it for `_filter.ts`. It lands one cycle after `_compare.ts` (§9 step 4.5).

---

## 2. The 60s deadline — the hardest constraint (honest arithmetic)

`index.ts:41` sets `FN_DEADLINE_MS = 60_000`; `index.ts:252` wraps every `fn.run` (shop included) in `withDeadline`, which on timeout **resolves to a bare `isError` with zero partial results and never caches**. The node's render server always runs a **headless pass first, then escalates to a headed solver pass** (up to 2 page loads per render retailer), with solver passes **serialized at concurrency 1** (`SOLVER_CONCURRENCY=1`, +15–35s each). walmart forces `solve:true`, so every cold walmart search is 2 page loads. Node deploys `CONCURRENCY=4`. Workers caps **6 simultaneous outbound connections**. A cold `shop(tier:'full', fresh:true, bust_renders:true)` as originally specced is structurally >60s → the whole call dies and the caller retries, repaying the full render cost while the abandoned renders keep running detached.

**The fix is budgeting, not hoping:**

1. **Internal soft deadline.** `fanoutRetail` races `Promise.allSettled(legs)` against `AbortSignal.timeout(45_000)`. Whatever settled by 45s is returned; unfinished render retailers become `pending:[{retailer, why:"still rendering (~80s inner timeout ≥ the cold-walmart 2-load max, past the 45s soft deadline) — this partial is not cached; the inner render runs to completion under waitUntil and caches its result, so a plain re-call in ~30s re-assembles it as a hit"}]`. The comparison pipeline then has ~10s of headroom before the 60s ceiling. **When `pending[]` is non-empty, `run()` marks the whole envelope `result.noCache`** (the §11 mechanism) so the instructed re-call actually re-executes `run()` instead of being served the cached partial from shop's own 300s envelope cache (§6). The re-executed fan-out then reads the now-finished render legs from THEIR inner cache — `callFnCached`'s KV write lands via `ctx.waitUntil`, fast legs still hit their own 300s inner cache, and the completed renders fold in as hits. Only a fully-settled (pending-empty) envelope takes the `cacheable:true`/`ttl:300` path (§6). Were the partial cached instead, an obedient plain re-call within 300s would be served the identical `pending:[{walmart}]` envelope, `run()` would never re-execute, and the recovery would silently fail on the exact cold-`tier:'full'`-one-slow-render path it exists for.
2. **Inner render timeout ≥ real render time, and > the soft deadline.** Render-tier inner calls set `renderTimeoutMs` to **~80s** (≥ the cold-walmart 2-load max of ~75s) — **not** the adapter-native ~55s (which sits *below* that max and re-breaks this very invariant), and never a 38s abort. The 45s soft-deadline race (§2.1) already caps how long *shop* waits, so a shorter inner abort is redundant; worse, it is fatal to the cache-for-retry contract. A promptly-started render aborted by its own 38s timeout at t0+38 dies *before* the 45s deadline can classify it as unfinished, so it lands in `errors[]` ("aborted"), never `pending[]`, and the aborted fetch leaves `waitUntil` nothing to persist — the re-call re-renders from cold and never hits; and cold walmart (2 loads, 45–75s) could never complete inside 38s — nor inside 55s — so shop could never render+cache walmart at all. The invariant instead: `renderTimeoutMs ≥ max cold-render time (~80s ≥ the cold-walmart 2-load max)` **and** `renderTimeoutMs > softDeadlineMs`, so a render that overruns the wait lands in `pending[]` and survives to completion under `ctx.waitUntil`. That window must hold the ~25–35s between the 45s response and the ~80s render completion: it is bounded by **CPU** time (30s default, raisable to 5 min on the paid plan via `limits.cpu_ms`), not wall-clock, and the pending render is I/O-bound (awaiting the node at ~0 CPU), so the wall-clock gap is comfortably inside budget — writing its KV entry for the ~30s-later re-call. If a genuinely stuck render must still be bounded, cap it at a value `≥` the ~75s cold-walmart max but `<` the waitUntil ceiling (e.g. 90s) — never below the 45s soft deadline and never below the cold-walmart max.
3. **Bounded render fan-out.** Render retailers launch in a wave of **at most `min(4, node CONC, 6-conn cap − fast legs in flight)` = effectively 3**, *after* the fast tier + flipp + places are dispatched. The **≤3 render subset is enforced in `run()`** (§3 guard 5), not left to wall-clock absorption: `tier:'full'` *selects* the ≤3 most relevant renders by the deterministic `itemCategory(item, modelKeys, brand)` rule (§4.1b: `"hardware"` → homedepot,lowes,ace; `"general"` → amazon,walmart; else `RENDER_TIER` order), and a `retailers[]` naming >3 renders is truncated by that **same** category-first rule (not input-array order) with the rest reported in `retailers_skipped`. `HINT_ESCALATE` recommends **at most 2 category-appropriate** render retailers, never all five.
4. **Late AbortSignal.** Each render's `AbortSignal.timeout` is created **per attempt, as late as possible**, not before it queues — a render waiting behind the 6-connection cap must not burn its abort budget while idle. Caller-side queue-induced timeouts are **exempt from `MAC_BREAKER_THRESHOLD` counting** so one `shop` fan-out cannot single-handedly trip the global mac-render breaker (which would fast-fail `render`/`linkedin`/`people_finder`/`walmart` for 30s).

**Worst-case wall clock, stated honestly:** fast tier resolves in <5s (parallel, but note the 6-conn cap means if 3 renders + costco-curl hold 4 slots, kroger/bestbuy/ebay/flipp share the remaining 2 and may serialize briefly). Three render retailers, cold, one of them walmart (2 page loads): headless passes parallel at CONC=4 (~30–40s), solver passes serialized at concurrency 1 (+15–35s each). The 45s soft deadline cuts this off and returns partials with the slowest render(s) in `pending[]`. **No call ever reaches 60s.**

**Subrequest budget:** worst case ≈ **40–50 subrequests** (kroger token+location+search = 3, ebay OAuth+search = 2, ≤3 renders, bestbuy 1, costco curl+retries, flipp 1, places 1, ~10 `callFnCached` KV get/put pairs, shop's own read/write, recordCall/Loki puts). The sux worker runs on the **paid Workers plan** (1000 subrequests/req — required already by the `browser` binding in `wrangler.jsonc`), so this is comfortable; on the free 50-subrequest plan it would flake exactly on the expensive path. Stated in the cost model, not hand-waved as "≪ limits."

---

## 3. Input schema (one polymorphic arg surface)

```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "required": ["item"],
  "properties": {
    "item":     { "type": "string",
                  "description": "What to compare — ONE product. A specific model ('Makita XFD131', 'Milwaukee 2804-20') or a category ('cordless drill'). Model/part numbers trigger tight same-item matching; category text returns grouped clusters. Do NOT put price caps ('under $100'), brands, or lists here." },
    "zip":      { "type": "string", "pattern": "^\\d{5}$",
                  "description": "5-digit US ZIP. Resolves a Kroger store (WITHOUT it kroger returns titles but NO prices — store-gated) and enables the weekly-ad deal overlay + nearby_stores. Non-grocery online prices don't need it." },
    "tier":     { "type": "string", "enum": ["fast","full"], "default": "fast",
                  "description": "'fast' = kroger,bestbuy,ebay,costco + flipp + places (free, <5s). 'full' auto-selects the ≤3 most relevant renders from amazon,walmart,homedepot,lowes,ace (heuristically classified — hardware brands/tools→homedepot,lowes,ace; else amazon,walmart; mac renders, ~30-60s each; slowest may return in pending) — NOT all five." },
    "retailers":{ "type": "array", "maxItems": 12, "items": { "type": "string",
                    "enum": ["kroger","bestbuy","ebay","costco","amazon","walmart","homedepot","lowes","ace","fred_meyer","qfc","ralphs"] },
                  "description": "Advanced override — name exactly the retailers to compare (supersedes tier). At most 3 render-tier retailers (amazon/walmart/homedepot/lowes/ace) are honored per call; naming more keeps the 3 most category-appropriate renders (same deterministic rule as tier:'full' — heuristically classified: hardware brands/tools→homedepot,lowes,ace; else amazon,walmart), NOT the first 3 as listed, and the rest land in retailers_skipped. Kroger banners (fred_meyer/qfc/ralphs) map to kroger with a chain filter. Order affects only the cache key, not which renders survive; prefer tier." },
    "deals":    { "type": "boolean", "default": true,
                  "description": "Overlay weekly-ad flyer deals (Flipp, keyless, free) — needs zip. Skipped with a note if zip is absent." },
    "brand":    { "type": "string", "description": "Constrain matching to this brand (post-retrieval filter)." },
    "budget_max":{ "type": "number", "description": "Drop rows whose effective price exceeds this (post-retrieval filter)." },
    "limit":    { "type": "integer", "minimum": 1, "maximum": 25, "default": 8,
                  "description": "Item mode = max rows retained per resolved group (best is always kept even if outside the cut); category mode = max groups returned. Groups are truncated to this AFTER clustering, so it bounds output/token size predictably." },
    "bust_renders": { "type": "boolean", "default": false,
                  "description": "Force-refetch the render tier — repays up to 3 mac renders (use only when a stale render is provably wrong). The universal `fresh:true` flag (stripped to boolean `env._fresh` at dispatch — search.md §9/§12) already busts fast-tier inner reads; `bust_renders` additionally busts the 1800s soft-TTL render cache. Tier-scoping semantics are defined authoritatively in §6." }
  }
}
```

### Tool description (~130 tokens — the calling model is the schema's user)

> **Cross-retailer price comparison for ONE item (read-only — returns prices, deals, urls; no cart, no checkout).** Give a specific product ('Makita XFD131') or a category ('cordless drill'); rows group by resolved product with `match: model|fuzzy|none` — `none` rows are never merged, judge them yourself. Raw UPC/barcode lookup is not wired yet — pass the product name or model number, not a bare UPC. Default `tier:'fast'` = free API tier (kroger, bestbuy, ebay, costco, <5s); set `tier:'full'` for amazon/walmart/homedepot/lowes/ace (mac renders, ~30-60s each, may return in `pending`). Pass a 5-digit `zip` for real Kroger store prices + weekly-ad deals + nearby stores; without it grocery rows have NO price. Put price caps in `budget_max` and brand in `brand`, never inside `item`. One item per call — for a list, `batch()` shop calls. Prices are timestamped (`age_s` per row), not live quotes; `fresh:true` forces a live refetch of the fast tier, `bust_renders:true` also re-renders.

### Polymorphism resolution (echoed in output as `mode` + `mode_reason`)

- `item` is **12–14 digits** → **barcode mode**: interim `failWith("bad_input", "barcode lookup not yet wired — pass the product name or model number instead")` (the stashed `barcode` fn is this mode's future integration point).
- `extractModelKeys(item)` yields ≥1 key **AND the key is the query's identity** (final content token or brand-adjacent, with no residual product-noun tokens after removing brand+key) → **item mode**. `'Makita XFD131'` → item. `'F150 floor mats'` → residual "floor mats" → **category mode**, F150 kept as a required filter term (not the product identity). `mode_reason` records the decision so the caller can override.
- otherwise → **category mode**.
- `brand`, `budget_max` are post-retrieval filters — never change the fetch.

### Caller-misuse guards (fail-fast in `run()`, before any fetch)

The dispatch layer does **no JSON-Schema validation** (`index.ts` dispatches straight to `run()`); the `zip` pattern is decorative. Every guard is a manual runtime check with a teaching message:

1. **Non-5-digit zip:** `if (zip && !/^\d{5}$/.test(zip)) fail("zip must be a 5-digit US ZIP (got 'Austin') — pass the ZIP, not a city; places('Austin TX stores') or kroger(action:'locations') can resolve one.")`
2. **Constraints in the item string:** pre-parse `/(?:under|below|less than|<)\s*\$?(\d+)/i` (and a leading `cheap(est)`) → strip from the fetch term, lift into `budget_max` (an explicit `budget_max` arg wins), and echo `"interpreted":{ "term":"cordless drill", "budget_max":100, "from_item":true }` so the model learns the arg surface.
3. **Multi-item lists:** `if (commaCount(item) >= 3 || (item.length > 120 && modelKeys.length === 0)) fail("shop compares ONE item per call. For a shopping list, call shop per item via batch: batch({calls:[{fn:'shop',args:{item:'milk',zip:'98383'}}, …]}) — results stay separate and cacheable.")` — fails **before** the fan-out so zero renders are spent.
4. **Unknown top-level keys (e.g. `track`):** any key outside the recognized allowlist `{item, zip, tier, retailers, deals, brand, budget_max, limit, bust_renders}` → `fail("price tracking ships in v1.1 — meanwhile use watch(url, selector) on a product page.")` — never silently drop an advertised-later arg. `bust_renders` (shop's render-tier cache-bust) is explicitly **in** the allowlist. The universal `fresh` flag is **not** — it is stripped from args at dispatch into boolean `env._fresh` (search.md §9/§12), so it never reaches `run()`'s arg allowlist and shop must not declare it in-schema.
5. **Render cap (≤3 mac renders/call):** after resolving the retailer set — tier expansion (`full` selects the ≤3 category-appropriate renders) **then** `retailers[]` override **then** kroger-banner mapping (`fred_meyer`/`qfc`/`ralphs` → `kroger`, which is fast-tier and doesn't count) — count entries in `RENDER_TIER`. If **>3**, deterministically keep the 3 most category-appropriate renders in a stable, category-first order keyed on `itemCategory(item, modelKeys, brand)` (§4.1b: `"hardware"` → homedepot, lowes, ace; `"general"` → amazon, walmart; then remaining `RENDER_TIER` order) — **not** the first 3 in input-array order — echo the resolved category in `mode_reason`/`notes[]` so the caller can predict the survivor set, and push each surplus render into `retailers_skipped` with `why:"over render cap (≤3 mac renders/call) — name ≤3 render retailers in retailers[] to choose which"`. `tier:'full'` can never trip this (it pre-selects ≤3); only an explicit `retailers[]` with ≥4 renders does. Truncation runs **before** the fan-out so no render is dispatched only to be discarded. (The surviving three are still subject to the 45s soft deadline and may land in `pending[]`; the cap governs how many are *dispatched*, `pending[]` governs which finished.)

**Default-zip context:** no server-side KV zip resolution (a silently injected zip poisons the content-addressed cache key). The default zip lives in the **skill layer** — SKILL.md instructs the model to `kv_get shop:context` once and pass `zip` explicitly. Keys stay honest, zero code.

---

## 4. Entity resolution (`sux/src/fns/_compare.ts`, pure functions)

```ts
export const FUZZY_CONTAIN_BRAND = 0.60;   // brand-confirmed; calibrated on the goldens' real title-pair fixtures
export const FUZZY_CONTAIN_BLIND = 0.75;   // no brand on either side
export const DEAL_CONTAIN = 0.65;          // flyer-name tokens contained in product title
export const HINT_ESCALATE =
  "coverage thin — retry with tier:'full' (auto-selects the ≤3 most relevant of amazon,walmart,homedepot,lowes,ace; mac renders, ~30-60s each) " +
  "or name ≤3 render retailers in retailers:[…]. For hardware add homedepot,lowes; for general merch add amazon or walmart.";

export function extractModelKeys(text: string, brandHint?: string): string[];
export function itemCategory(item: string, modelKeys: string[], brand?: string): "hardware" | "general";
export function isCompatibilityAccessory(title: string, key: string): boolean;
export function conditionClass(row: TaggedProduct): "new" | "used" | "parts";
export function parseSize(s: string): { qty: number; unit: "oz"|"floz"|"lb"|"g"|"ml"|"l"|"ct"|"gal" } | undefined;
export function clusterProducts(products: TaggedProduct[], q: { modelKeys: string[]; brand?: string; terms: string[] }): ProductGroup[];
export function overlayDeals(groups: ProductGroup[], deals: FlippItem[]): void;
```

**1. Model-key extraction (the workhorse).** Hyphen-split each uppercase token, then:
- Accept `/^[A-Z0-9]{4,}$/` tokens that **interleave** letters and digits (≥1 letter AND ≥2 digits) → true part numbers (`XFD131`, `DCD771C2`).
- Accept `/^\d{3,4}-\d{1,3}$/` numeric-hyphenated tokens **only when a known brand token co-occurs** in the query/title (R12 — Milwaukee `2804-20`; brand supplies the letter-content guard).
- **Reject unit words** by a whole-word vocabulary check on the trailing alpha run when the leading run is purely numeric — `{V, VOLT, VOLTS, W, WATT, AH, MAH, OZ, OUNCE, LB, CT, COUNT, PK, PACK, PIECE, PC, IN, INCH, FT, FOOT, GAL, GALLON, MM, CM, ML, L, QT, PT}`. This catches the hyphenated long-forms a string-ending regex misses: `18-VOLT`, `5-GALLON`, `3-INCH`, `100-PACK`, `10-PIECE` (Lowe's writes every DeWalt/Makita title as `18-VOLT` — the #1 mass-merge leak). The suffix check applies to the **raw token before** hyphen-stripping.

**1b. Item category (the render-survivor selector).** `itemCategory(item, modelKeys, brand)` is a **pure heuristic** that classifies an `item` string so guard 5 (§3) can pick which ≤3 of the five render retailers survive the cap deterministically — it decides *product category*, orthogonally to `extractModelKeys` (which resolves *identity*). It returns **`"hardware"`** when either a hardware **brand token** co-occurs (reusing the same R12 brand vocab that anchors numeric model keys: DeWalt, Makita, Milwaukee, Ryobi, Bosch, Ridgid, Kobalt, Craftsman, Metabo/HPT, Skil, …) **OR** a hardware **category noun** appears (drill, driver, saw, sander, grinder, wrench, ladder, lumber, faucet, valve, fastener, …); otherwise **`"general"`**. The `brand` arg and any `modelKeys` are checked against the brand vocab too, so `'Makita XFD131'` → hardware even though `XFD131` is the identity token. **Documented default:** anything not matching either list — grocery (`'Oatly oat milk'`), general merch (`'air fryer'`, `'iPhone15 case'`), and ambiguous items — resolves to `"general"`, which maps to `amazon, walmart, then remaining RENDER_TIER order`, so no item is left without a deterministic survivor set. The classification is **heuristic, not authoritative** — a token-list match, echoed in `mode_reason`/`notes[]` (e.g. `"category:hardware — render survivors homedepot,lowes,ace"`) so the calling model can predict the survivor set the tool description promises.

**2. Model tier (`match:"model"`).** Rows whose title yields the query's key — but **demoted to `unmatched`** when any of:
- title matches `/\b(for|fits?|compatible|replacement|works with)\b/i` in a window before the key (eBay compatibility accessories — the #1 false positive: *"For Makita XFD131 18V Battery 5.0Ah"*), OR
- title carries **≥3 distinct model keys** (accessory cross-lists), OR
- row price is **<40% of the group's non-eBay median** (a $35 battery can't be the $179 kit).

The **kit/bare/tool-only/battery/charger token signature** sub-splits model-tier groups too (not just fuzzy) — *"Makita XFD131 — TOOL ONLY"* must not share a group with the kit. This is UPC-*grade* confidence, **not** UPC identity (search-tile payloads carry no GTIN); the envelope labels it `match:"model"` and `notes[]` states unmatched rows may still be the same product.

**3. Fuzzy tier (`match:"fuzzy"`).** Asymmetric **containment** `|∩|/|smaller token set|` (R4), not symmetric Jaccard: `≥0.60` when both rows carry a matching brand, `≥0.75` brandless. Variant tokens (`original/vanilla/unsweetened`, scent words) and kit/bare tokens **split** clusters the same way. Brand is lifted from the homedepot/lowes state blobs where present (it exists in the JSON the scrapers already window over) to keep the brand-confirmed path available for more than 4/9 retailers.

**4. Honest fallback (`match:"none"`).** Everything else lands in `unmatched[]` grouped by retailer, never silently merged.

**5. Category mode.** Deterministic greedy clustering: candidates sorted by `(retailer, id)`; centroid = union of member token sets recomputed on join; single pass. **A cluster is a `group` only if it spans ≥2 retailers** (comparison value); otherwise rows go to a flat `results[]` section explicitly labeled retrieval-not-comparison, with `hint:"no cross-retailer entities resolved — treat as search results"`. Category-mode groups are **expected to be mostly single-retailer** (retailers stock disjoint SKUs for category terms) — stated so the contract isn't oversold. Multi-retailer groups sort first, then by `best.price` ascending.

**Variant-SKU limitation** (stated in the fn description + `notes[]`): retailer-exclusive model variants (a drill sold as `DCD771C2` at one chain, a derivative SKU at another) are **not merged** by construction. When a render-tier retailer *did* return rows that model-failed, the coverage hint is **suppressed/softened** (coverage is thin because of identity, not retrieval — more renders can't fix it).

### Condition classification (R5, and one adapter over)

`best` = lowest **new-condition** effective offer. `conditionClass`:
- **used** iff `condition` matches `/refurb|used|open box|pre-?owned|parts/i` **OR** title matches `/\b(renewed|refurbished|open box|pre-?owned|used)\b/i` (catches Amazon "(Renewed)" tiles that carry no `condition` field — only eBay populates `condition`),
- **parts** iff `/for parts|not working/i` → excluded from `spread` entirely,
- **new** = `"New"` or (condition absent AND title clean).

Used/parts rows route to `spread.used_low` only; `best` is computed over new rows. eBay rows are flagged in `notes[]` since they're the only ones with real `condition`.

### Unit price (pack-aware)

`parseSize` handles `"16 oz"`, `"2 lb"`, `"12 ct"`, `"1 gal"`, `"500 ml"` **and multipacks**: `/(\d+)\s*[-x×]?\s*(pack|pk|count|ct)\b/i` multiplies the base size (`"Oatly 64oz 6 Pack"` → 384 floz, not 64). Kroger multipart sizes (`"4 ct / 15.25 oz"`) prefer the weight/volume component over count. Within a group, canonicalize to the **majority unit dimension** and **omit `unit_price`** for rows parsing to a different dimension (the omitted-field honesty rule, applied consistently). Fuzzy merges are **blocked when parsed total quantities differ by >25%** (stops a 6-pack merging with a single). `unit_price = (promo_price ?? effective_price) / canonicalQty`, emitted with `unit:"$/oz"` etc.; **absent when size doesn't parse** — no fabricated denominators. Cross-retailer unit price is **kroger + flipp only** today (the only adapters emitting `size`) — stated, not hidden.

### Deal overlay (asymmetric join)

When `zip` present and `deals` true, the deal leg calls `callFnCached('weekly_ad', {term, zip})` (R14 — keeps the ttl-3600 flyer cache). Merchant→retailer map (`fred meyer/qfc/ralphs/kroger → kroger`); mapped deals join group rows by **asymmetric containment** `|∩|/|smaller|` (the flyer name, 2–5 tokens) `≥ DEAL_CONTAIN` — symmetric Jaccard caps at ~0.3 for a 3-token flyer vs a 10-token title and joins nothing. Joined as `deal:{price, valid_to, merchant}`. Unmapped merchants (Safeway, Albertsons — no adapter) surface in a top-level `deals[]` section rather than being dropped.

### Row selection & the three meanings of `limit`

`limit` bounds output on **three distinct axes**, applied in a fixed pipeline order — an implementer must not conflate them:

1. **Per-retailer candidate trim (pre-clustering, item + category modes).** Each retailer's returned rows are trimmed to `clamp(ceil(limit*2/n), 3, 10)` (§7, R10), where `n` = resolved retailer count. This is a *candidate* bound feeding the clusterer — not the final row count — so a group can span multiple retailers each contributing up to `clamp(...)` rows and thus temporarily exceed `limit`.
2. **Cluster** (§4 steps 1–5).
3. **Per-group truncation (post-clustering, item mode).** Each resolved group's `rows[]` is truncated to **`limit`** rows, sorted by `effective_price` ascending; **`best` is always retained** even if it would fall outside the cut, and **priceless rows are dropped first**. This is the step that makes final output size predictable from `limit` and closes the gap where a per-retailer floor of 3 × N retailers otherwise doubled the row count the caller asked for.
4. **Category mode:** `limit` instead caps the **number of groups** returned (step 3 does not apply; groups are already whole clusters).

So `limit:8` in item mode yields **≤8 rows per group** (best-inclusive) regardless of how many retailers contributed candidates, and `limit:25` with `n:2` can reach the advertised 25 because the pre-cluster candidate bound (max 10/retailer) is not the final cap. All three roles are echoed in `notes[]` so the caller can predict output size.

---

## 5. Output contract — concrete example

`shop({ item:"Makita XFD131", zip:"98383", tier:"full", retailers:["kroger","bestbuy","ebay","homedepot","lowes","amazon"] })`:

```json
{
  "item": "Makita XFD131",
  "mode": "item",
  "mode_reason": "model key XFD131 is the query identity (brand-adjacent, no residual noun)",
  "model_keys": ["XFD131"],
  "zip": "98383",
  "retrieved_at": "2026-07-08T18:04:12Z",
  "retailers_searched": ["kroger","bestbuy","ebay","homedepot","lowes","amazon"],
  "retailers_skipped": [
    { "retailer": "walmart", "why": "not selected — coverage thin — retry with tier:'full' (…) or name specific retailers in retailers:[…]." },
    { "retailer": "ace", "why": "not selected" }
  ],
  "pending": [],
  "groups": [
    {
      "label": "Makita XFD131 18V LXT Brushless 1/2 in. Driver-Drill Kit",
      "model_key": "XFD131",
      "retailer_count": 4,
      "best": { "retailer": "amazon", "effective_price": 186.55, "condition": "new",
                "basis": "lowest new-condition promo_price??price+shipping among match:model rows" },
      "spread": { "low": 186.55, "high": 199.00, "used_low": 154.99 },
      "rows": [
        { "retailer": "amazon", "match": "model", "condition": "new",
          "title": "Makita XFD131 18V LXT Brushless Cordless 1/2\" Driver-Drill Kit (3.0Ah)",
          "price": 186.55, "effective_price": 186.55, "currency": "USD", "price_scope": "online",
          "url": "https://www.amazon.com/dp/B01M0N8256", "age_s": 0 },
        { "retailer": "homedepot", "match": "model",
          "title": "Makita 18V LXT Compact Brushless Cordless 1/2 in. Driver-Drill Kit XFD131",
          "price": 179.00, "effective_price": 179.00, "currency": "USD", "price_scope": "session-store",
          "url": "https://www.homedepot.com/p/305063316", "age_s": 41 },
        { "retailer": "lowes", "match": "model",
          "title": "Makita XFD131 18-Volt LXT Brushless Driver Drill Kit",
          "price": 199.00, "effective_price": 199.00, "currency": "USD", "price_scope": "session-store",
          "url": "https://www.lowes.com/pd/-/1000988734", "age_s": 118 },
        { "retailer": "ebay", "match": "model", "condition": "used",
          "title": "Makita XFD131 18V Brushless Drill Driver Kit 3.0 Ah — Open Box",
          "price": 154.99, "shipping_cost": 12.50, "effective_price": 167.49, "currency": "USD",
          "price_scope": "online", "url": "https://www.ebay.com/itm/2554...", "age_s": 34 }
      ]
    }
  ],
  "results": [],
  "unmatched": [
    { "retailer": "bestbuy", "match": "none", "title": "Makita 18V Battery 2-Pack (demoted: price <40% of group median)",
      "price": 99.00, "url": "https://api.bestbuy.com/..." }
  ],
  "nearby_stores": [
    { "name": "The Home Depot — Silverdale", "address": "…", "rating": 4.3, "website": "…" }
  ],
  "deals": [],
  "errors": [],
  "hint": null,
  "notes": [
    "age_s is age at retrieved_at; true row age = age_s + (now − retrieved_at). A settled (pending-empty) envelope like this one may itself be served up to 600s stale — check retrieved_at. A partial envelope (pending[] non-empty) is deliberately NOT cached (result.noCache), so a plain re-call re-assembles it live and picks up the finished renders as inner-cache hits. fresh:true forces the fast tier live, bust_renders:true re-renders.",
    "Each group's rows are truncated to limit (default 8) after clustering, sorted by effective_price ascending; best is always kept, priceless rows dropped first — so limit predicts output size.",
    "homedepot/lowes prices are session-store (the render session's default store, not zip 98383); kroger prices are store:<locationId>.",
    "eBay is the only retailer with real condition; its prices now include shipping_cost in effective_price. Others assumed new.",
    "No stock data for homedepot/lowes/amazon rows (field omitted, not false).",
    "Hardware compares carry title/price/url only — unit_price is kroger/flipp-only; promo is kroger/bestbuy-only."
  ]
}
```

The call above names exactly 3 renders (homedepot, lowes, amazon), so nothing is over-cap. Had the caller named 5 — `retailers:["amazon","walmart","homedepot","lowes","ace"]` — guard 5 keeps the 3 most category-appropriate renders (here homedepot, lowes, ace by the hardware category-first order, since `itemCategory("Makita XFD131", ["XFD131"])` returns `"hardware"` on the Makita brand token) and reports the surplus:

```json
"retailers_skipped": [
  { "retailer": "amazon",  "why": "over render cap (≤3 mac renders/call) — name ≤3 render retailers in retailers[] to choose which" },
  { "retailer": "walmart", "why": "over render cap (≤3 mac renders/call) — name ≤3 render retailers in retailers[] to choose which" }
]
```

**Honesty mechanics.** Every empty column is explicitly **omitted** (not silently absent, not fabricated), with a `notes[]` entry explaining the systematic gap. `best` is arithmetic only (a pointer, not a recommendation). `age_s` is **required** on every price row; `null` when derivable only from a legacy metadata-less entry (never faked `0`). Within each item-mode group, `rows` are truncated to `limit` (best always retained, priceless rows dropped first — §4 "Row selection"), then sorted by `effective_price` ascending with any surviving priceless rows last; `best` is **omitted** (not null-crowned) when no priced new-condition row exists, with a note.

`price_scope` semantics: `"store"` (kroger with zip — real store price), `"online"` (amazon/walmart/costco/bestbuy/ebay), `"session-store"` (homedepot/lowes/ace — whatever store the render session's geo landed in). This makes the homedepot situation honest instead of silently wrong.

### Column-coverage matrix (documented in FUNCTIONS.md so the caller never asks for data shop can't produce)

| field | retailers that populate it |
|---|---|
| `price` | all **except zip-less kroger** (store-gated → no price) |
| `promo_price` | kroger, bestbuy |
| `size` / `unit_price` | kroger (+ flipp deals) |
| `brand` | kroger, walmart, bestbuy, lowes-blob (lifted); **absent** for homedepot, ace, costco, ebay, amazon-search |
| `condition` | ebay only |
| `in_stock` | walmart, bestbuy |
| `shipping_cost` | ebay |
| `rating` / `reviews` | bestbuy, walmart, homedepot, lowes, amazon; **absent** for kroger, costco, ace, ebay |

For the Makita example, every render-retailer row is `{retailer, title, price, url}` — the deal/unit_price/promo machinery contributes nothing outside grocery. Stated plainly.

### `hint` triggers (one `HINT_ESCALATE` surface)

Fires when: (a) no group spans ≥2 retailers, OR (b) >50% of matched rows lack a price, OR (c) grocery-shaped retrieval with no zip (kroger rows present but 100% priceless) → `hint:"grocery prices require zip (Kroger store resolution) + enables flyer deals — re-call with zip"`. Suppressed when render-tier retailers already returned rows that model-failed (identity gap, not coverage gap — R-variant limitation).

---

## 6. Caching & freshness policy

- **shop itself:** `cacheable:true, ttl:300, staleGrace:600` (R8) — **but only for fully-settled (pending-empty) results.** `Fn.staleGrace` is a new optional field consumed by `deferCacheWrite` (`expirationTtl = softTtl + (fn.staleGrace ?? CACHE_STALE_GRACE_SECONDS)`), overriding the global 24h grace. A price-comparison verb must never serve a multi-hour-stale table; 600s caps the stale-serve window at 10 minutes. Staleness stays **visible**: `retrieved_at` + per-row `age_s`.
- **Partial envelopes are never cached (R1/§2):** when the 45s soft deadline truncated the fan-out (`pending[]` non-empty), `run()` sets `result.noCache` — the same mechanism §11's v1.1 `track` path uses — so the partial is never written under `sha256(shop:args)`. Without this, shop's own 300s envelope cache would defeat the deadline-recovery re-call: an obedient plain re-call with identical `item`/`zip`/`tier` would be served the cached `pending:[{walmart}]` envelope, `run()` would never re-execute, `fanoutRetail` would never re-read the (now-finished) render leg, and the caller would get back the identical partial with no signal that anything changed. Marking the partial `noCache` forces re-execution, and the completed inner render legs — cached under their own `sha256(walmart:canonicalArgs)` keys (R6) — fold in as hits (fast legs likewise hit their own 300s inner cache). The instructed re-call therefore costs KV reads, not renders.
- **`age_s` (R9):** `CacheMeta` gains a `storedAt` (epoch ms, stamped by `deferCacheWrite` at write); `callFnCached` returns `age_s = round((now − storedAt) / 1000)` for each inner entry, **independent of the reader's `ttl`**. `softTtlOverride` must NOT participate in age derivation. The superseded `softExpiresAt − ttl·1000` back-derivation is wrong by `(writerTtl − readerTtl)`s whenever an entry is shared across ttl-divergent contexts — guaranteed on the render tier, where a direct walmart write (native soft ttl) read by shop's `softTtlOverride:1800` inner call over-reports age by `(nativeTtl − 1800)`s (e.g. a 120s-old entry reported as 1620s). Storing `storedAt` makes the age column true regardless of reader ttl; and because shop's 1800s soft-ttl is a **read-side override** (next bullet), the stored entry keeps its native soft ttl, so a direct caller's stale/SWR decision is unaffected while shop's 1800s window is computed per-read from `storedAt` (`storedAt` governs age display, not freshness). Legacy metadata-less entries (no `storedAt`) yield `age_s:null`, never a faked `0`.
- **Inner cache sharing (R6/R7):** `fanoutRetail` dispatches every leg through `callFnCached(env, name, canonicalArgs, legOpts)`, where `canonicalArgs` always requests the adapter's **schema-default limit (15)**; the clamp trims rows *after* retrieval. `callFnCached` computes the same `cache:sha256(name:stableStringify(args))` key the dispatch layer does and **fills schema defaults before keying** so a direct `walmart{term:"drill"}` and shop's inner call hash identically → a walmart render done 2 min ago is a genuine hit inside shop. It reuses the extracted `finalize` pipeline (normalize + clamp, skip summarize), shares the module-level `inflight` single-flight map, and threads `ctx` via `env._egress.ctx`. The `legOpts` (`fresh`/`softTtlOverride`/`suppressStaleRefresh`) are **derived by `fanoutRetail` from the four per-tier opts (§1)**, per leg by tier — shop passes the policy once at the seam and never touches per-leg `callFnCached` opts itself.

```ts
// sux/src/mcp-util.ts
export async function callFnCached(env: RtEnv, name: string, args: Record<string, unknown>, opts?: {
  fresh?: boolean; timeoutMs?: number; softTtlOverride?: number; suppressStaleRefresh?: boolean;
}): Promise<{ text: string; isError: boolean; age_s: number | null }>;
```

- **Render-tier via shop:** shop passes `renderSoftTtlMs:1_800_000` + `suppressRenderStaleRefresh:true` at the seam (§1); `fanoutRetail` translates them to `softTtlOverride:1800` + `suppressStaleRefresh:true` on each render leg's `callFnCached` (R8). **`softTtlOverride` is strictly read-side.** `deferCacheWrite` ALWAYS stamps the stored entry with `softExpiresAt = storedAt + nativeSoftTtl` and `storedAt = now`, **never** the override — so the single R6-shared KV entry carries identical bytes whether a direct call or a shop leg wrote it. A reader with `softTtlOverride` recomputes freshness as `stale ⇔ (now − storedAt) ≥ softTtlOverride` (falling back to the stored native soft ttl when omitted); the override changes only **this reader's** stale/SWR decision, never the stored entry. So a repeat shop call serves the stale render **without** firing a background re-render (age_s discloses the staleness; that's the honesty mechanism), while a **direct** `render`/`walmart` caller reading the very same bytes still sees native ~300s freshness on the same entry and fires its own SWR — the reverse leak is closed by the read-side locus, not by `storedAt` (which governs only age display). Fast-tier legs keep ttl 300 with normal SWR. search omits both opts, so its render legs get adapter-native soft ttl + normal SWR (R11) — the divergence is by argument, not by a policy hardcoded in the shared file.
- **Force-live is tier-scoped across two distinct flags, both routed through the seam (R18):** the universal `fresh:true` (stripped to boolean `env._fresh` at dispatch — search.md §9/§12's co-signed change threads the parsed boolean into record-fns instead of `delete`ing it at `index.ts:166–169`; shop reads `env._fresh`, never `args.fresh`) busts fast-tier inner reads only — `fanoutRetail` reads `env._fresh` (or its `fresh` opt) and applies it to **fast-tier legs only**. Shop's own `bust_renders:true` (declared in §3, a **distinct** arg because the stripped-to-boolean `env._fresh` cannot carry a render-only signal into `run()`) is passed as the seam's `bustRenders` opt, which `fanoutRetail` applies as `fresh:true` to **render-tier legs only**, busting the 1800s soft-TTL render cache — so an obedient caller reacting to a deadline error can't accidentally repay the (≤3) renders. Neither flag reaches per-leg `callFnCached` from shop directly; the seam does the tier-selective routing shop can't express through a bare `env._fresh`. The two compose independently: `fresh:true` alone refetches the fast tier and leaves renders on cache; `bust_renders:true` repays the renders. Both docs share one `fresh` semantics via `env._fresh`.

---

## 7. Cost model

| tier | retailers | per-call cost | wall clock |
|---|---|---|---|
| **fast** (default) | kroger + bestbuy + ebay (official APIs) + costco (1 residential curl) + flipp + places | ~free, 0 renders | <5s (subject to 6-conn cap) |
| **+render** (`tier:'full'` or named) | each of amazon/walmart/homedepot/lowes/ace | **up to 2 node page loads each** (headless + solver escalation); solver passes serialized at concurrency 1 (+15–35s each); headless parallel at CONC=4 | 30–60s each (cold walmart's 2 loads up to ~75s); 45s soft deadline cuts off, slowest → `pending[]` |
| **worst case** (`retailers` = 3 renders incl. walmart, cold, `fresh:true` + `bust_renders:true`) | 3 renders → up to **6 node page loads** (walmart always solves; any looks_blocked escalates), + 4 API/curl + flipp + places + ~10 KV pairs ≈ **40–50 subrequests** | shop's *wait* bounded <60s by construction (45s soft deadline); renders exceeding 45s return in `pending[]` and keep running to completion under `waitUntil` at their ~80s inner timeout (≥ the cold-walmart 2-load max of ~75s; never a 38s abort, never the below-max ~55s), the ~25–35s post-response gap held by waitUntil's CPU-bounded budget (§2, I/O-bound render ≈ 0 CPU), caching for the retry while the partial envelope is `result.noCache` (§6), so the re-call re-executes and folds them in as inner-cache hits |

**Solver spend line:** the PX press-and-hold is a local mouse routine (free, but +15–35s serialized); CapSolver API spend applies only when the extension solves a real captcha (~$1–3/1k solves). Solver escalations are **capped at 2 per shop call**; further blocked retailers land in `errors[]` as `"blocked — solver budget exhausted"`. Rows fetched via the solver are flagged in `notes[]`.

Per-retailer **fetch** = default-15 (one page for render retailers regardless of `limit`); **per-retailer candidate trim** (pre-clustering) = `clamp(ceil(limit*2/n), 3, 10)`; each resolved group is then truncated to **`limit`** rows post-clustering (§4 "Row selection", best-inclusive, priceless dropped first). Registry `cost: 4`.

**Repeat-query economics (honest):** the 1800s render soft-TTL + suppressed inner SWR refresh (R8) means a re-check within 30 min serves cached renders with **no** background re-render — the SWR amplification the winner design under-counted is closed. Only `bust_renders:true` repays render cost.

---

## 8. Absorbed / deleted / kept (fn count: 89 → 88, at the gated deletion)

| fn/file | fate |
|---|---|
| `shop.ts` (thin router) | **replaced in place** — same name, new specialized contract. Single-retailer routing is `retailers:["kroger"]`; `store:"deals"` becomes `deals:true` (overlay). **fred_meyer route preserved**: `retailers:["fred_meyer"]` maps to kroger with the `chain:"Fred Meyer"` filter (R-migration; SKILL.md also documents `kroger(chain:"Fred Meyer", zip)` directly). |
| `product_search.ts` (+test) | **deleted — GATED (R11)** on `search(query, backends:'retail')` shipping and consuming `fanoutRetail`. Kept as a ~30-line thin wrapper over `fanoutRetail` for one overlap cycle (safe rollback). If search stalls, it stays indefinitely — the fn-count argument is weak against a capability hole (bulk ungrouped retrieval, limit 100, flat list). |
| `sux/src/tools/localshop.ts` | **deleted** — orphaned dead code; its price-ranked-table *idea* lives on as the comparison table; its snippet-price parsing (host-level, **$5 floor**, no geo) is not worth porting. Drop any `importance.mjs` / `PLAN.md` references if present. |
| `weekly_ad`, `winco`, `places`, all 9 retailer fns | **kept** — adapters keep standalone surfaces (constraint). `weekly_ad` stays the flyer-browse verb (reject Judge 1's deletion). **winco stays a locator** — `places` already surfaces WinCo stores, WinCo has no online catalog, shop never calls it (documented rationale). |
| homedepot phantom `zip` | schema arg + description claim **removed as a standalone early PR** (run() never reads it); shop reports `price_scope:"session-store"` instead of pretending. |
| walmart `in_stock` fabrication | **fixed as a standalone early PR**: `in_stock: it?.availabilityStatus ? it.availabilityStatus === "IN_STOCK" : undefined` at **both** walmart.ts:39 and :90 (benefits direct walmart callers too). |
| ebay `shipping_cost` | small additive adapter field from `shippingOptions[].shippingCost`; `_compare` folds it into `effective_price` (fixes the used_low / best bias). |
| stashed `barcode` / `ingredients` | not this cycle; shop reserves barcode mode as their integration point. |
| price tracking | **v1: out.** v1.1: `track:"<label>"` → `result.noCache`, KV `sux:shop:watch:<sha256((modelKey ?? normalizedItem) + "\n" + zip + "\n" + label)>` (parenthesized so labels/zips don't collide) storing `{ best, rows:[{retailer,price}], seen_at, prev }`. v1 rejects a stray `track` arg with a teaching fail (guard 4). |

---

## 9. Build order (one change per cycle; coordinates with the search refactor)

1. **Extract `_retail_fanout.ts`** from product_search with the **verbatim 7-retailer list** (kroger, walmart, homedepot, amazon, lowes, costco, ace) — truly behavior-neutral; product_search becomes a thin wrapper, tests green. *Shared seam — land first; both refactor branches rebase on it. Whichever lands first owns the file.*
1.5. **Extend `RETAIL_ADAPTERS`** to add bestbuy + ebay (+ fixture tests proving both emit `{products:[…]}`, covering ebay's `condition` and bestbuy's sku-detail action). Rename tiers `fast`/`render`; document costco's proxy-curl membership in `fast`.
2. **Standalone adapter-honesty PRs** (independent schema lies — don't wait on the shop rewrite): (a) remove homedepot phantom `zip`; (b) fix walmart `in_stock`; (c) add ebay `shipping_cost`.
3. **`callFnCached` in `mcp-util.ts`** + extract the `finalize` pipeline from index.ts + add `Fn.staleGrace` + add `storedAt` (epoch ms) to `CacheMeta`, stamped in `deferCacheWrite`; `fanoutRetail` dispatches through `callFnCached`. Fixes shop/retailer cache disjointness + age_s. Add a **key-collision test**: direct `walmart{term}` then shop fan-out → **1 render, not 2**. Add a **ttl-divergent age test**: direct `walmart{term}` write (native soft ttl), then a shop render-tier inner read of the same key with `softTtlOverride:1800` → assert `age_s` ≈ real elapsed seconds (e.g. 120), **not** `elapsed + (nativeTtl − 1800)`. Add a **reader-scoped-freshness test**: after a shop `softTtlOverride:1800` inner write+read of a shared key, a **direct** read of the same key at t0+400s reports the entry **stale** (native 300s) and fires SWR, while the shop read at t0+400s reports it **fresh** — proving the override is reader-scoped, not baked into the shared entry.
4. **`_compare.ts`** pure module + `_compare.test.ts` (see §10).
4.5. **`searchByTerm` in `shop.ts`** (§1 co-signed export) — thin wrapper composing `fanoutRetail` + `clusterProducts`, returning best `TaggedProduct` per retailer; unblocks algebra.md's cycle-7 `_augment` price adapter. Add a `searchByTerm` unit test: canned multi-retailer fixtures → one best row per retailer, bare-`term` call shape (asserts the `{modelKeys,brand?,terms}` query is built internally).
5. **Rewrite `shop.ts`** to the new contract + `shop.test.ts` (mock `./index` registry, `vi.hoisted`); golden: full comparison assembly from canned multi-retailer fixtures, incl. the deadline-partials path with its **partial-envelope-not-cached assertion** (a pending-bearing result sets `result.noCache`; an identical re-call is NOT served from shop's envelope cache — `run()` re-executes — while the now-completed inner render IS an inner-cache hit, so the retry costs KV reads not renders; and conversely a settled pending-empty result DOES take the `cacheable:true`/`ttl:300` path), the **render-cap path** (guard 5: `retailers[]` with all 5 renders → exactly 3 dispatched, and the surviving set follows `itemCategory` **not input-array order** — a hardware `item` keeps homedepot,lowes,ace while a general `item` keeps amazon,walmart even when the array lists renders in a different order; surplus in `retailers_skipped` with the over-cap `why`; `tier:'full'` → ≤3 category-appropriate renders selected), the **`limit`-truncation path** (R17: a group with candidates from N retailers under `limit:8` returns ≤8 rows with `best` retained and priceless rows dropped first; `limit:25`,`n:2` reaches >20 rows — proving the per-retailer clamp is not the final cap), and the **force-live path** (R18: `env._fresh` busts fast-tier inner reads but leaves render cache; `bust_renders:true` busts the render tier — `args.fresh` is never read).
6. **Gated (R11):** when `search(backends:'retail')` ships → delete `product_search.ts` (+test); docs sync to **88 fns**.
7. **Cleanup:** delete `localshop.ts`, fix any `importance.mjs`/`PLAN.md` staleness.
8. **(v1.1)** `track` arg; barcode-mode hookup when the stash lands.

Steps 2–5 have **no dependency on the search refactor** — only on step 1. `FanoutResult` is the non-negotiable interface either way.

---

## 10. Doc / test impact

- `npm run docs` → regenerate `sux/FUNCTIONS.md`; SKILL.md routing collapses "Product search, no retailer named" + "Fan one term across many retailers" into **"Compare prices for one item across retailers → `shop`"** (plus: named retailer → retailer fn; flyer deals → `weekly_ad`; **Fred Meyer specifically → `kroger(chain:"Fred Meyer", zip)`**; WinCo stores → `places`). Byte-mirror `plugins/sux-router/skills/`; update `docs/claude-profile-snippet.md`; add the `kv_get shop:context` default-zip ritual and the worked example *"Is this $200 air fryer cheaper anywhere?" → one shop call with zip from `kv_get shop:context`* to SKILL.md. CI `.github/workflows/skill-sync.yml` enforces.
- Commit sequence: `feat(shop): cross-retailer comparison engine (absorbs product_search)` → at overlap landing `docs(shop): sync FUNCTIONS.md/skill/snippet (89 fns, product_search deprecated)` → at gated deletion `docs(shop): sync to 88 fns`. (The docs count is honest at each step — the winner's single "sync to 88 fns" was wrong during the overlap cycle.)
- **`_compare.test.ts`** table (dns-suite bar: validation/happy/edge/error):
  - **Model-token reject cases:** `18V`, `100FT`, `3.0AH`, `18-VOLT`, `5-GALLON`, `3-INCH`, `100-PACK`, `10-PIECE`, pure numbers → **no key**.
  - **Model-token accept cases:** `XFD131`, `DCD771C2`, `Milwaukee 2804-20` (brand-anchored numeric).
  - **Compatibility guards:** `"For Makita XFD131 Battery"` rejected from the XFD131 group; `"XFD131 — TOOL ONLY"` splits from the kit; Amazon `"(Renewed)"` excluded from `best` but present in `used_low`; eBay `"Open Box"` → used_low; `"for parts"` excluded from spread.
  - **Mode detection:** `"F150 floor mats"` → category (residual noun); `"iPhone15 case"` → category; `"DCB205 charger"` → item.
  - **Item category (render-survivor selector):** `itemCategory("Makita XFD131", ["XFD131"])` → `"hardware"` (brand token); `"cordless drill"` → `"hardware"` (category noun, no model key); `"iPhone15 case"` and `"air fryer"` → `"general"`; `"Oatly oat milk"` (grocery) and a bare ambiguous term → `"general"` (documented default).
  - **Fuzzy:** the HD/Lowe's example pair clusters **without** the model key (containment 0.78 ≥ 0.75); a cross-brand generic pair does **not** merge (brandless 0.75 guard).
  - **Unit price:** sub-$5 grocery price ($3.99-class) **survives** (localshop $5-floor regression); 6-pack vs single **splits** (>25% quantity guard) and unit_price multiplies pack count (384 floz, not 64).
  - **Deal join:** a 3-token Flipp name joins a 10-token kroger title via asymmetric containment ≥0.65 (symmetric Jaccard would join nothing).
- **`searchByTerm` export** (§1 co-signed): covered in `shop.test.ts` — canned multi-retailer fixtures → exactly one best `TaggedProduct` per retailer, called with a bare `term` string (asserts the `{modelKeys, brand?, terms}` query object is constructed internally, no call-shape mismatch with `clusterProducts`). This is the frozen seam algebra.md's `_augment` price adapter consumes.
- **`callFnCached` cache tests** (in the `mcp-util` suite): the **key-collision** case (direct `walmart{term}` then shop fan-out → **1 render, not 2**), the **ttl-divergent age** case (direct `walmart{term}` write then shop `softTtlOverride:1800` inner read of the same key asserts `age_s` ≈ real elapsed, not `elapsed + (nativeTtl − 1800)`), guarding the `storedAt`-based derivation against regression to the ttl-back-derivation, and the **reader-scoped-freshness** case (after a shop `softTtlOverride:1800` write+read, a direct read at t0+400s reports stale + fires SWR while the shop read reports fresh — proving the override never mutates the shared entry's stored native soft ttl).
- Tests: net **+2** files (`_compare.test.ts`, fanout covered via rewritten `shop.test.ts`), **−1** (`product_search.test.ts`, at the gated deletion), `golden.test.ts` gains one comparison-assembly fixture.

**Known gaps stated, not hidden:** cross-retailer unit price is kroger/flipp-only; `in_stock` only walmart/bestbuy; brand absent for 5/9 retailers (fuzzy degrades to the brandless 0.75 path there); homedepot/lowes/ace prices are session-store; render-tier renders may return in `pending[]`; retailer-exclusive SKU variants are not merged. `rating`/`reviews` are populated only for bestbuy/walmart/homedepot/lowes/amazon (absent for kroger/costco/ace/ebay); their parsers land in the shared retail-adapter cycle (search.md §13) that both search's `filter:"rating > 4.5"` marquee and algebra's `augment` price adapter depend on.

---

## 11. Deliberate scope cuts

- **Price tracking → v1.1** (`track` arg, KV watch prefix, structured delta report). v1 rejects a stray `track` with a teaching fail rather than silently dropping it.
- **Barcode / UPC identity fn → future** (barcode mode interim-fails with a teaching message; it's the stash's integration seam, not +1 top-level fn).
- **Prose "buy the Lowe's one" recommendation → stays with the caller.** The server returns clean structured facts and an arithmetic `best` pointer; a frontier model does the judgment. Workers AI is too weak to be the reasoner, and the schema's user already is one.
