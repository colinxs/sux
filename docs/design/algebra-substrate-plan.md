---
title: Un-parking the data algebra — a grounded plan
status: draft
cluster: algebra
type: design
summary: "Maps docs/proposals/algebra.md onto the live 95-fn registry, finds its premises stale (it was substrate for five never-built web-retrieval domains that SUX.md parked), salvages three still-real ideas, proposes a minimal Phase-0, and lists the decisions only Colin can make — first of which is whether the parked program is even still a goal."
tags: [sux, algebra, design]
updated: 2026-07-11
---

# Un-parking the data algebra — a grounded plan against the live registry

**Decision up front.** [algebra.md](../proposals/algebra.md) is a large, well-hardened design (20 resolved decisions, 43 folded issues) for a `records[]`/`filter`/`map`/`reduce`/`augment` combinator layer. But it was written as *substrate* — its own opening line says it "sits UNDER five sibling features and owns none of their domains" (`search`, `shop`, `teach`/`ask`, `style`/`edit`, `travel`). None of those five were ever built, and [SUX.md](../proposals/SUX.md) — the pivot doc, updated the same day algebra.md was parked — explicitly parks "the web `search`/`shop`/`travel`/algebra corpus" and redirects engineering to the vault hub-and-spokes ([domains.md](../proposals/domains.md), memory *digital-life spine*). Verified against the live tree (2026-07-11): the registry has moved on and algebra.md's premises are stale. **Three ideas survive un-parking; the rest should stay parked.** The load-bearing question is decision #1 below: *is the web-retrieval program still a goal at all?* If no, this reduces to two small standalone chores.

This is a plan, not code. No code was written for it.

---

## 1. What algebra.md is

A combinator layer over a `{records: Rec[], meta}` envelope, split in two:

- **A pure algebra** — `filter` / `map` / `reduce` over records: single-invocation, zero egress, `cacheable`, freely composable inside `pipe`/`batch`.
- **An effectful algebra** — `augment` (the join) plus the existing `batch`/`batch_fetch`/`crawl`: keeps the amplification caps, now denominated in *subrequests* and backstopped by a per-request **subrequest ledger** (`env._budget`).
- Plus **dispatch-layer compression** (`save`/handle spill, `/s/<uuid>` round-trip) and a pile of correctness grafts (JSON-safe emission, a shared `dig()`, a `RECORD_PATHS` migration table, coverage-conditional caching of summarize folds).

The one structural thesis: every amplification cap in the tree exists because *every map is effectful* (one element = one fetch); separating the pure algebra from the effectful one is what lets the pure side be uncapped and the effectful side be honestly ledger-bounded.

Crucially, algebra.md is explicit that it **owns none of the domains it serves**. It defers the filter DSL to `search` (`_filter.ts`, R19 — a hard dependency with the "fork if search slips" escape hatch deleted), the retail term→product matcher to `shop` (`searchByTerm` freeze, §4.3), and the distillation home to `teach` (`_reduce.ts` + `oracle` absorption, R14). It is infrastructure for a program, not a standalone feature.

---

## 2. Why its premises are stale — grounded against the live 95-fn registry

Verified in this worktree, 2026-07-11:

| algebra.md premise | Live reality (2026-07-11) | Evidence |
|---|---|---|
| Substrate for five sibling domains (search/shop/teach-ask/style-edit/travel) | **None built.** No `teach`/`ask`/`style`/`edit`/`travel` fns; no `_records`/`_filter`/`_fanout`/`_reduce`/`_augment` modules | `sux/src/fns/` has none of these files |
| `filter`/`map`/`reduce`/`augment` are being added | **None exist** | no `filter.ts`/`map.ts`/`reduce.ts`/`augment.ts` |
| R20: delete `grep`/`select` (folded into `filter`) | **Both live** and documented under Extract/parse | `sux/FUNCTIONS.md`, `fns/grep.ts`, `fns/select.ts` |
| `product_search`/`web_search` folded into a unified `search` verb (search.md §11) | **Both still present; no `search` verb** | `fns/product_search.ts`, `fns/web_search.ts` |
| Filter DSL is a hard dep on `search`-owned `_filter.ts` (R19) | search.md never shipped → **no owner exists**; a `filter` today would block forever or need its own grammar | no `_filter.ts` |
| `price` augmenter imports `shop`'s frozen `searchByTerm` (§4.3) | **No `shop`/`_retail_fanout.ts`**; the augmenter has no upstream | absent |
| `teach` absorbs `oracle`; `_reduce.ts` is the single distillation home (R14) | **`oracle` shipped standalone**; `recall`/`preferences` shipped instead; no `teach` | `fns/oracle.ts`, `fns/recall.ts`, `fns/preferences.ts` |
| "the un-migrated **89** today" (RECORD_PATHS migrates these producers) | **95 fns**; new producers (`jmap`/`ingest`/`dropbox`/`todoist`) added since, none records-shaped | `FUNCTIONS.md`: "95 functions" |

The meta-fact behind every row: **[SUX.md](../proposals/SUX.md) (updated 2026-07-09) is the pivot.** It declares the git-markdown knowledge store the core, makes every tool "a markdown convention + store ops," and says of the web corpus: *"The web `search`/`shop`/`travel`/algebra corpus is a separate, unrelated tool… It does not share the knowledge store and should not be entangled with it. Parked."* [domains.md](../proposals/domains.md) confirms where the effort went (vault hub, jmap/imessage/dropbox spokes, the six verbs). algebra.md's own frontmatter reads `status: parked`. **Implementing it verbatim would reintroduce deleted dependencies** (delete `grep`/`select`, assume `_filter.ts`, assume a shop core) against a registry that no longer matches its map.

---

## 3. The three ideas that survive un-parking

Each is evaluated for whether it still holds against the *current* 95 fns, independent of the parked program.

### 3.1 `dig()` de-duplication — REAL and tiny
`pipe.ts:35` and `batch.ts:34` contain **byte-identical** copies of:
```ts
function dig(value: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((v, k) => (v != null && typeof v === "object" ? (v as any)[k] : undefined), value);
}
```
Both power the `{{prev}}` / `{{item}}` / `{{items}}` token resolvers. Collapsing them into one shared helper is a pure internal refactor with no surface change, no new fn, and no dependency on the records envelope. This is the cleanest salvage. (algebra.md §1.5 bundled this with `toRecords`; the `dig` half stands alone — `toRecords` is net-new envelope infra and does *not* survive as a standalone.)

### 3.2 JSON-safe emission (U+2028/U+2029) — REAL but **already shipped privately; latent, not a live bug**
Grounding refines algebra.md R7's framing:
- The exact escape **already exists** at `_jmap.ts:59-61` (`JSON.stringify(v).replace(/ /g,"\\u2028").replace(/ /g,"\\u2029")`), private to the jmap fn.
- The shared `ok()` emitter (`registry.ts:155`) does **not** escape.
- `normalize.ts:63` does fold `[  ]→\n` — the "poison" algebra.md R7 warns about — **but only runs on non-`raw` fns.** All 21 `raw:true` fns (which is where hand-built JSON envelopes live) **bypass `normalize`**, and `JSON.stringify` already emits spec-valid JSON (U+2028/U+2029 are legal *inside* JSON string values, so `JSON.parse` round-trips them fine).

**Conclusion: there is no live JSON-parse defect against the current registry.** The jmap escape is defensive hardening for JS-`eval`/JSONP-style consumers, not a fix for a live crash. The real remaining value is *generalizing* the jmap helper into a shared `okJson()` so any future records-shaped or raw fn is safe-by-construction and the escape stops being copy-pasted — worth doing **only alongside** the first new records-emitting fn, not as a standalone "bug fix."

### 3.3 The subrequest ledger (`env._budget`) — the ONE genuinely-unsolved current-state gap
This is the piece with live teeth, and it is **independent of the entire algebra/records program.**

Today the amplification caps are per-tool *step-count* caps with **no global backstop**:
- `pipe.ts`: `MAX_STEPS = 25`, `BLOCKED_STEP_TOOLS = {pipe, batch, batch_fetch, crawl}`
- `batch.ts`: `MAX_CALLS = 100`, `NESTED_FANOUT_TOOLS = {pipe, batch_fetch, crawl}`, `MAX_NESTED_CALLS = 25`
- `batch_fetch.ts`: `MAX_URLS = 100`

A `batch(pipe(...))` at worst case (`MAX_NESTED_CALLS × MAX_STEPS ×` per-step fetches) can drive well past Cloudflare's ~1000-subrequest ceiling with **nothing to stop it** → a hard `1102`/`1015`, not a graceful truncation. `env._egress` already exists but is set on the **shared** `env` binding (`index.ts:206`) — exactly the cross-request race algebra.md R3 flagged; there is no `_budget`, no `_depth`, and no `width` field on `Fn` (`registry.ts` has `cacheable`/`cost`/`ttl` only). A per-request `env._budget` ledger that every fan-out/`smartFetch` decrements, soft-truncating with `meta.truncated:true` before 1102, is worth its own design cycle **whether or not the algebra ever ships**.

### What does NOT survive as a standalone
- `filter`/`map`/`reduce`/`augment` as fns — `filter`'s grammar was deferred to a nonexistent `search`-owned `_filter.ts`; `augment`'s `price` adapter needs a nonexistent shop core; `reduce op:summarize`'s home was a nonexistent `teach`.
- The `records[]` envelope + `RECORD_PATHS` migration + `records:true` flag + selftest conformance — large, and premised on the 89-producer registry that has since changed shape.
- `save`/handle-spill dispatch compression — couples tightly to the envelope and the finalize reorder.

---

## 4. A minimal Phase-0 (conditional on decision #1 = "keep going")

Two tiny, independently-landable steps that disrupt no existing fn. **Only worth starting if the retrieval program is being revived** (see §6.1); otherwise skip straight to §3.3's ledger as a standalone.

**Step 0a — `dig()` de-dup (pure refactor).** Extract the shared `dig` into `_util.ts` (or a new `_records.ts` if we're committing to the envelope name); import it in `pipe.ts` and `batch.ts`; delete the two copies. No new fn, no schema change, no `FUNCTIONS.md`/`index.ts` churn (nothing added to the registry). CI surface: `type-check` + the existing `pipe`/`batch` tests. One small PR. This is landable *regardless* of decision #1 — it's just cleanup.

**Step 0b — one self-contained `filter` fn with its OWN minimal WHERE grammar.** Not borrowed from the nonexistent `search`-owned `_filter.ts`. Contract:
- Input `records`: a JSON array, a `{records:[...]}` envelope, or a `/s/<uuid>` handle (three explicit shapes — **no `RECORD_PATHS` migration of existing producers**).
- Grammar: `path op value` clauses joined by `and`/`or`/`not` with parens; ops `= != < <= > >= has in exists`. v1 ships a subset; **no regex** (`~` reserved).
- `cacheable`, `raw`, zero egress, absent from `BLOCKED_STEP_TOOLS`/`NESTED_FANOUT_TOOLS`. A pure new fn cannot disrupt existing fns — it only adds surface — so it needs no feature flag to be safe (a flag is optional if we want a dark-launch).
- Reviewable in one sitting. Ships the shared `okJson()` (§3.2) as its emitter.
- **Additive only:** it does **not** absorb/delete `grep`/`select` in v1 (see decision #3).

**Phase-0 explicitly does NOT do:** the `records[]` migration, `RECORD_PATHS`, `map`, `reduce`/the hierarchical summarize fold, `augment`, `save`/handles, or the ledger. Each is a separate, larger project.

**Honest caveat:** even Step 0b's value is thin if decision #1 is "no" — a `filter` over records is most useful once *producers emit records*, which is the parked program. If the retrieval program stays parked, Phase-0 realistically collapses to just Step 0a (cleanup) plus the ledger (§3.3), and the `filter` fn waits.

---

## 5. Risks

- **Tar-pit / scope creep.** algebra.md is 43 interlocking issues; "just filter" tends to pull in `toRecords`, which pulls in `RECORD_PATHS`, which pulls in migrating every producer. The discipline: `filter` v1 reads three explicit input shapes and *nothing migrates*.
- **Staleness.** Building to algebra.md verbatim reintroduces deleted deps (deletes `grep`/`select`, assumes `_filter.ts`/shop core). Treat algebra.md as **archived rationale, not a spec.**
- **CI gates (per CLAUDE.md).** Any new fn ⇒ `npm run gen:index && npm run docs`, commit `sux/src/fns/index.ts` + `sux/FUNCTIONS.md`. Absorbing `grep`/`select` later also touches the SKILL, the `plugins/sux-router` mirror, and the profile snippet (check-skill-sync CI) — a breaking, multi-file change, not a one-liner.
- **The ledger is architectural, not a quick win.** It touches `index.ts` dispatch, every fan-out site, and adds `Fn.width` + `env._depth`/`env._budget`. Real value, but its own cycle — do not fold it into a `filter` PR.
- **Opportunity cost.** Engineering is pointed at the vault spine (digital-life spine, PR #32). Un-parking algebra competes with that for the same attention.

---

## 6. Needs Colin's decision on…

1. **Is the parked web-retrieval program (`search`/`shop`/`travel`/algebra) still a goal?** *(load-bearing — answer this first.)* SUX.md parks it; the digital-life spine is where effort is going. **If NO:** stop here — salvage only the `dig()` de-dup (§3.1) and, on its own merits, the subrequest ledger (§3.3, decision #4); leave algebra.md archived and everything else in this doc moot. **If YES / later:** proceed to #2.
2. **Full envelope, or a couple of standalone utilities?** The `records[]` envelope + producer migration + `RECORD_PATHS` + conformance selftest is the expensive 90%. A standalone `filter`/`map`/`reduce` that reads three input shapes *without migrating any producer* is ~10% of the cost for most of the ergonomics. Which ambition?
3. **`grep`/`select`: keep or fold?** algebra.md R20 deletes them into `filter`'s text/html methods. They're live and used, and folding is a breaking change across skill + plugin mirror. Keep them and make `filter` purely additive, or commit to the absorb+delete cycles?
4. **Green-light the subrequest ledger independently?** It's the one piece with live teeth (`batch(pipe(...))` can 1102 today) and zero dependency on the algebra. Prioritize it as its own design cycle regardless of #1?
5. **Rollout posture — flag or not?** A pure new `filter` fn is additive and low-risk unflagged; the ledger changes dispatch for *every* request and probably wants a kill-switch env var. Given `bypassPermissions` + auto-deploy-on-merge-to-`main`, confirm whether new pieces land dark-launched behind a flag or straight in.

---

## Provenance

Verified in worktree at HEAD `origin/main` on 2026-07-11: `sux/FUNCTIONS.md` reports **95 functions**; `grep`/`select`/`product_search`/`web_search` all live; none of `filter`/`map`/`reduce`/`augment` or `_records`/`_filter`/`_fanout`/`_reduce`/`_augment`/`_retail_fanout` or `teach`/`ask`/`style`/`edit`/`travel` exist; `_jmap.ts:59-61` already escapes U+2028/U+2029; `ok()` (`registry.ts:155`) does not; `normalize.ts:63` folds LS/PS→`\n` for non-raw fns only; `pipe.ts:35` and `batch.ts:34` hold identical `dig()` copies; `env._budget`/`_depth`/`Fn.width` are absent, `env._egress` is set on the shared env at `index.ts:206`.

## Related

- [[algebra]] — the parked design this plan audits (archived rationale)
- [[SUX]] — the pivot that parked the web corpus
- [[domains]] — where the engineering effort went (vault hub-and-spokes)
- [[Parked-Retrieval-MOC]]
