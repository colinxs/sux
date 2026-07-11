---
title: Un-parking the verb program — what's actually worth reviving
status: design
cluster: meta
type: proposal
summary: "Verb-by-verb triage of the parked search/shop/travel/teach-ask/style-edit/platform corpus against the current 95-fn set and the domains.md pivot; ranked build order; top picks spec'd."
tags: [sux, meta, parked, design]
updated: 2026-07-11
---

# Un-parking the verb program

Grounding pass over the seven-doc ROADMAP.md corpus (`search.md`, `shop.md`, `travel.md`,
`teach-ask.md`, `style-edit.md`, `platform-upgrades.md`, `algebra.md`) — all `status: parked`,
all dated 2026-07-09 — against what has actually shipped since and what `SUX.md` (also
2026-07-09, later in the day) and `domains.md` (2026-07-09/10) decided instead. No code in this
pass; this is the design/triage phase per the workflow's brief.

**Bottom line up front:** almost none of this is worth reviving *right now*. The corpus was
parked the same day `SUX.md` repointed the whole project at the knowledge-core pivot, and that
pivot is still mid-flight (`domains.md` Phases 2–5: jmap ✅ shipped, imessage, dropbox ✅
shipped, gate integration — all higher-value and already spec'd). Reviving the web-verb program
now would be scope-splitting against an unfinished, higher-priority build. Where I do recommend
action, it's narrow: one slice of `platform-upgrades.md` (a `job`/cron primitive) has a genuine
dependency from *both* programs, and `teach-ask.md` should be explicitly superseded rather than
left "parked" — its own sibling doc already replaced it with something 20x cheaper.

## 0. What changed since parking (2026-07-09 → today)

- Fn count moved from the 89 the corpus was costed against to **95**, entirely from the
  domains.md program: `obsidian` write/edit/delete, `ingest`, `dropbox`, `jmap`. None of the
  seven parked docs' fns exist (`grep`ped `sux/src/fns/` — no `teach`/`ask`/`style`/`edit`/
  `travel`/`notify`/`diff`/`job`/`browse`/`entity`/`_fanout`/`_filter`/`_kb`).
- The fns the parked corpus proposes to **delete** are all still live and working: `search`,
  `web_search`, `shop`, `product_search`, `oracle`, `preferences`, `voice`, `todoist` — all ✅
  with tests per `sux/FUNCTIONS.md`. Nothing has bit-rotted; there's no forcing function to touch
  them.
- `SUX.md` (written the same day, explicitly "supersedes the earlier ten-proposal sprawl") states
  the parked corpus is "a separate, unrelated tool" from the core and reframes `ask` as "not a new
  engine — two store ops and Claude." That is a direct, dated repudiation of `teach-ask.md`'s
  design, which the corpus itself never updated to reflect (`teach-ask.md` still opens "supersedes
  all prior drafts" — it doesn't know it was the one superseded).
- `domains.md`'s Phase 4 ("standing sweeps" for mail-inbox and Notes-mailbox triage) and its
  `job` registry needs are the one place a parked-corpus module (`platform-upgrades.md`'s
  `job`+cron) would plug into *live* work, not just the parked one.

## 1. Verb-by-verb verdict

### `algebra.md` — substrate, not a verb; defer as a whole, salvage nothing solo
`_records.ts`/`_fanout.ts`/`_filter.ts` plus `map`/`filter`/`reduce`/`augment` fns. Real design
quality, but it's infrastructure with **zero standing consumers** until `search`/`shop` are
rewritten to emit its envelope — building it alone adds 4 fns and 3 modules that nothing calls.
Not worth doing in isolation. **Verdict: bundled with search/shop rewrite or not at all.**

### `search.md` + `shop.md` — pure refactor, no new capability, high blast radius
Both fully spec'd (95%+ decision tables resolved) rewrites that collapse `web_search` +
`product_search` + the `shop` router into one `search(query, backends, filter)` + a rebuilt
`shop(item)` comparison engine, on top of the algebra fanout/filter substrate. The value is real
but narrow: caller ergonomics (one verb instead of four), a composable records envelope, a string
WHERE-DSL. **It adds no capability Colin doesn't already have** — `search`, `web_search`,
`product_search`, and `shop` all work today. The cost is not narrow: it deletes and replaces four
shipped, tested fns (`search.md` decision 10: "Deleted: `web_search`, `product_search`... Net
89→87") for an ergonomics win, while `_filter.ts`'s WHERE-DSL alone is a small parser/interpreter
to get right on Workers (no `eval`). **Verdict: superseded by priority, not by better design —
real candidate for a future cycle once the personal-data build is stable, not now.**

### `travel.md` — the one genuinely new capability, but unconfirmed demand + real blockers
Nothing today does flights/hotels/attractions/visa/price-trend dossiers. Spec is mature (two-phase
DAG, visa harm-avoidance = refuse-don't-guess, production Amadeus). But: (a) no signal anywhere in
`domains.md`/`ROADMAP.md`/recent commits that travel planning is an active want — it reads as
speculative scope carried from an earlier planning pass, not a stated need; (b) it has a hard
technical dependency on `platform-upgrades.md`'s `job` registry for `track` (ROADMAP's own DAG:
step 11 consumes step 10); (c) needs a production Amadeus account/credentials, unset up. **Verdict:
blocked — confirm demand with Colin before spending any design cycles refining it further; if
confirmed, it's gated on the `job` primitive below.**

### `teach-ask.md` — actively recommend NOT building as specced; supersede explicitly
This is the most over-specified document in the corpus: 24 resolved decisions (R1–R24) working
through consolidation monotonicity proofs, a refresh-cursor livelock-avoidance argument, stable
citation-label invariants under eviction/reordering, kind-scoped KV keys to prevent cross-kind
clobbers. It is good, careful engineering — for a bespoke agentic-acquisition knowledge base with
its own KV schema (`_kb.ts` v3), R2 raw-text spillover, and a *second* git-backed vault repo
(`KB_VAULT_REPO`, separate from the primary vault). That entire apparatus exists to solve a
problem `SUX.md`, written the same day, says doesn't need solving: "`ask` → `search` the vault,
`read` the top hits, answer with citations. Not a new engine — two store ops and Claude." The
vault already has the write/edit/delete ops teach-ask would need to build from scratch, plus the
`recall` fn already shipped as "personal cross-store recall." Reviving `teach-ask.md` now would
mean building a parallel knowledge store the project explicitly decided against maintaining.
**Verdict: kill, don't revive.** If a knowledge-engine gap is ever felt (vault search recall
degrades — `domains.md` names the trigger: "keyword recall misses at scale, nowhere near 224
notes"), the fallback is Smart Connections / a semantic layer over the *existing* vault, not
`_kb.ts`. Recommend re-labeling this doc's frontmatter `status: superseded` pointing at
`SUX.md` §"Later tools, same shape" so a future reader doesn't re-discover 650 lines of dead
design.

### `style-edit.md` — capability already covered by shipped fns; low urgency
Proposes deleting `preferences` and `voice` and replacing them with a spec'd `style`/`edit` pair
(closed style-dimension taxonomy as the injection boundary, block-region rewrite machinery,
bidirectional entity census for fidelity). But `voice` ("AI text-restyler") and `preferences`
("KV-backed style-preference profile that LEARNS over time and continually self-distills") are
**both already shipped and working** — `sux/FUNCTIONS.md` lists both ✅ with tests. This is the
same shape as search/shop: a quality/architecture upgrade over a capability gap that doesn't
exist, not new capability. Smaller blast radius than search/shop (two fns, not four; no shared
substrate to build first beyond the `_kb.ts` voice kind, and even that can degrade to reusing
`preferences`'s existing KV shape). **Verdict: lowest-regret of the "rewrite" trio if the
personal-data build ever has slack — but still not urgent.**

### `platform-upgrades.md` — five bundled upgrades; one has live pull, four don't yet
`notify` / `diff` / `job` (+cron drain) / mac-LLM tier / `browse` / Cloudflare Workflows /
`entity`. Bundled as "one substrate" in the doc, but they don't have to ship together:
- **`job` + `sux:job:` cron registry** is the one piece with a *live* consumer signal outside its
  own parked doc: `domains.md`'s triage verb describes "standing sweeps" (mail-inbox, Notes-mailbox)
  that are exactly a cron-drain shape, and `travel.md`'s `track` needs the same registry. Two
  independent call sites (one live, one blocked-on) for one primitive is the strongest "worth
  building" signal in the whole corpus.
- `notify` is a thin dependency of `job` (fires on completion) — ships alongside it, not separately.
- `diff`, `browse`, `entity`, the mac-LLM tier, and Workflows infra have no current consumer named
  outside this doc's own five-item bundle. Defer.
**Verdict: unbundle. `job`+`notify` (cron registry) is the one piece worth spec'ing next; the rest
stays parked until something outside this doc needs them.**

## 2. Prioritized ranking (effort × value, current state)

| Rank | Item | Effort | Value now | Why |
|---|---|---|---|---|
| 1 | `job`+`notify` (slice of platform-upgrades) | **S–M** | **Medium-high** | Only parked module with a live consumer (`domains.md` triage sweeps) plus a blocked-on one (travel `track`); small, self-contained, no deletions of working code |
| 2 | style/edit rewrite | M | Low-medium | Capability already exists via `voice`+`preferences`; this is a quality upgrade, not a gap-fill; smallest blast radius of the "rewrite" items |
| 3 | search/shop rewrite (+ algebra substrate) | **L (bundled)** | Medium | Real ergonomics win, zero new capability, deletes 2–4 shipped/tested fns; algebra alone is dead weight without this |
| 4 | travel | L | **Unconfirmed** | Only genuinely new capability in the corpus, but no demand signal found and hard-blocked on #1's `job` registry + unset Amadeus creds |
| 5 | teach/ask | **XL** | **Low — do not build** | Superseded same-day by `SUX.md`'s vault-native `ask`; 650 lines of proven-over-engineered design for a problem the project decided not to have |
| — | `diff`/`browse`/`entity`/mac-LLM/Workflows | M–L each | Low (no consumer) | No call site anywhere outside their own doc; leave parked until one appears |

Effort/value here is read off design maturity + existing overlap, not a line-by-line estimate —
all seven docs are essentially "spec complete," so effort tracks (a) how much of the underlying
capability already exists (search/shop/style/edit: mostly) and (b) how much new substrate a
revival drags in (teach/ask, algebra: a lot).

## 3. Top picks, spec'd enough to build next

Only one item clears the bar of "worth spending a build cycle on before the personal-data program
finishes." Everything else in this section is a *scoping* of what to spec, not a green light to
start coding.

### 3a. `job` + `notify` — cron/scheduler primitive (top pick)
- **What ships:** one `sux:job:<id>` KV registry (state machine: `pending → running →
  done|failed`, each record self-contained enough to run cold — same discipline the
  `anthropic:schedule` skill already requires); a `job` fn (`create`/`get`/`list`/`cancel`) over
  it; a Worker Cron Trigger that drains due jobs; a `notify` fn that fires on `done`/`failed`
  (initially: write a KV notification record + optional webhook, no new transport).
- **Why now:** `domains.md` Phase 4's mail-inbox and Notes-mailbox "standing sweeps" are the
  first real caller — building the registry as part of implementing those sweeps (rather than
  bespoke ad-hoc cron logic inside the mail triage skill) is strictly cheaper than building it
  twice. `travel.md`'s `track` is a second, currently-blocked, caller — no cost to unblock it for
  free.
- **Scope cut from `platform-upgrades.md`:** ship *only* §`job`+`notify`. Do not pull in `diff`,
  `browse`, `entity`, mac-LLM tier, or Workflows — none has a caller yet; each is a separate,
  independently-triggerable revival later.
- **Files to touch (build phase, not this one):** new `sux/src/fns/job.ts`, `sux/src/fns/notify.ts`,
  a `sux:job:` KV schema doc section, a Cron Trigger entry in `sux/wrangler.jsonc`, registry
  entries in `sux/src/fns/index.ts` (via `npm run gen:index`, never by hand per CI gate 5).
- **Blockers:** none technical. Sequencing blocker only: land after (or alongside) whichever of
  `domains.md` Phase 4's sweeps is built first, so the registry's shape is driven by a real
  caller instead of guessed in the abstract.
- **Risk:** low — additive, no deletions, small surface (2 new fns + 1 cron trigger).

### 3b. `teach-ask.md` disposition — not a build, a bookkeeping fix (do alongside 3a)
Not a "top pick to build" — a **top pick to close out**, so the parked corpus stops presenting
650 lines of live-looking design as pending work. Concretely: flip `docs/design/teach-ask.md`'s
frontmatter `status: parked` → `status: superseded`, add a one-line pointer to `SUX.md`'s
"Later tools, same shape" section, and drop it from `ROADMAP.md`'s feature table (or annotate the
row "superseded — see SUX.md"). Effort: trivial (frontmatter + one doc edit). Value: prevents a
future session from re-discovering and re-litigating a design the project already rejected.

### 3c. Travel demand confirmation — a conversation, not a spec (do before 3a's `track` work)
Not code, not even design — a five-minute check with Colin: is travel-dossier generation
(`travel.md`) still wanted? If yes, it slots in after 3a ships (it consumes the `job` registry
directly) and the existing 554-line spec needs no rework, just an Amadeus production credential.
If no, strike it from `ROADMAP.md`'s feature table and remove `travel.md`'s pull on `job`'s design
(one dependency arrow, not a redesign). Either answer is cheap to act on; the expensive mistake
would be building `job` shaped around a speculative `track` consumer that never materializes.

## 4. What I would NOT spec further right now

- `search.md`/`shop.md`/`algebra.md` as a bundle — correct design, wrong time; revisit once
  Phases 2–5 of `domains.md` are done and there's slack for a pure-ergonomics refactor of working
  code.
- `style-edit.md` — same reasoning, smaller stakes; revisit if `voice`/`preferences`'s output
  quality becomes a felt problem (no evidence of that yet).
- `diff`/`browse`/`entity`/mac-LLM/Workflows — no consumer anywhere; don't spec infrastructure
  looking for a caller.

## Related
- [[ROADMAP]] — the coherence anchor this doc triages against
- [[SUX]] — the pivot that reframed everything here as parked
- [[domains]] — the live, higher-priority program this doc defers to
- [[teach-ask]], [[style-edit]], [[search]], [[shop]], [[travel]], [[platform-upgrades]], [[algebra]] — the seven docs triaged above
