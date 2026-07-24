# Capabilities Arc — The Wedge: an Edge Router / Trust / Memory Control Plane

Status: draft / scoping · Date: 2026-07-23
Scope: `sux` (MCP worker) · `suxlib` (op-engine) · a new D1 binding · reuses Vectorize
Builds on: `2026-07-23-self-hosted-compute-and-model-tiering.md`,
`2026-07-23-self-hosted-compute-implementation-plan.md` (the substrate arc / "the machine"),
`2026-07-23-next-arc-capabilities-brainstorm-seed.md` (this arc's handoff)
Feeds back into: Phase 0.5 (glue spine) — see the addendum in the implementation-plan doc

## 0. Thesis — the wedge the seed asked for

The seed doc poses the wedge question as **"graph store (#1) or always-on agent (#4)?"** Both
of those are **box-resident** — blocked on Phase 0 connectivity and the Phase 0.5 spine, both
effort-L. This doc argues the wedge is **neither**: it is the **edge-resident control plane** of
the always-on agent — the router that classifies inbound/produced content, the graduated-trust
ledger that decides what may auto-fire, and the memory-hygiene lifecycle over the recall index.

It is the wedge because it **rides the substrate that already exists** (Cloudflare Workers +
Vectorize `sux-corpus`) plus **one new edge store (D1)**, and needs *nothing* from elk-newt to
ship. The substrate arc's own graceful-degradation contract (Phase 0.5f) then lets it **absorb
the box tiers as they come online** — the graph store (#1) and the real-time daemon (#4) become
the T0 upgrades this plane degrades to-and-from, not prerequisites.

Restated in the seed's terms: **the router *is* candidate #4, built edge-first.** Candidates #1
and #4's box-resident forms are its later T0 rungs.

## 1. Why edge-first is the value ÷ effort maximum

| | Box-resident wedge (seed #1/#4) | Edge control plane (this doc) |
|---|---|---|
| Blocked on Phase 0 connectivity | yes | **no** |
| Blocked on Phase 0.5 spine | yes | shapes it, ships alongside |
| New infra | Qdrant + graph engine + daemon on elk-newt | **one D1 database** |
| Recall if box down | degrades / unavailable | **unaffected** (Vectorize is edge) |
| Effort to first user value | L | **S–M** |

The control plane is small — `route`/`decision`/`memory_item` are a few tables of bookkeeping,
not a corpus — which is exactly why it fits D1 and why it is the cheapest thing that delivers the
always-on agent's core loop (classify → propose → learn → auto).

## 2. The three-plane store split (reconciles this arc with the substrate arc)

The substrate arc's §6.4 already says *"keep the query path on T1 (edge), move index-build to
T0 (box)."* This doc names the third plane that neither arc had made explicit: the **control
metadata** plane.

| Plane | Store | Holds | Uptime coupling |
|---|---|---|---|
| **Recall — T1 edge query** | **Vectorize** `sux-corpus` (768-dim cosine, per-domain namespace, `registry.ts:57`, `wrangler.jsonc:23`) | vectors for the always-up query hot-path | none (edge) |
| **Recall — T0 box index** | **BGE-M3 + Qdrant + reranker** (substrate Phase 3) | richer/PHI/hybrid index, index-build, rerank | box (best-effort) |
| **Control — edge** | **D1** (new binding) | `route`/`decision` trust ledger, `memory_item` decay + at-rest class | none (edge, first-party) |

The seed's *"retire the brute-force KV-cosine cores for Qdrant"* refers to the ~10k-capped
brute-force fallback, **not** Vectorize: Vectorize stays the edge query tier, Qdrant-on-box is the
T0 richer tier, and the KV-cosine fallback is what gets retired between them. D1 is **additive** —
the substrate arc approached from compute and never needed a queryable control store; the router
does.

**Why D1 and not the box for control state.** The router must read a route's current autonomy
ceiling on *every* inbound event (an edge event, per substrate §5). If that state lived on the
box, a box outage would force every decision to fail-safe to all-gated (§6) — acceptable but
friction-maximal exactly when the box is down. D1 keeps the control plane always-live at
near-zero cost, does the counters/joins/aggregations natively (SQLite), and — per the Phase 0.5b
storage lattice — is classed first-party-CF: **control metadata may live there; PHI *content* may
not** (PHI content → box-DB / vault). Confirmed net-new: `wrangler.jsonc` today declares only
`OAUTH_KV` + `VECTORIZE`, no D1.

## 3. The router — classify → route → propose

The unified bidirectional content-router. Every unit of content — inbound (mail / MyChart / chat
/ files) or produced (drafts / notes / code) — passes **one decision**: *what is this, where does
it go next, how confident.*

- **Multi-sink fan-out.** One email can become a calendar event **and** a task **and** a vault
  fact **and** an index entry when confidence is high on multiple facets. Most content still goes
  one place — good edges only, not an exhaustive mesh.
- **Tier-0 is deterministic (the sieve).** `_mail_triage.ts` is already this shape: a rules-stub
  table-driven classifier (`_mail_triage.ts:134`) with a `classify()` seam for a kNN-over-
  embeddings tier behind the rules stub's `unknown` (`_mail_triage.ts:4-8`). The router
  **generalizes that same three-rung escalation** (rules → embedding-kNN → LLM-on-ambiguous) from
  mail to every source — the substrate arc's §8 escalation ladder, and Cardinal-rule-#2a
  (deterministic before a model call) made structural. The sieve is not replaced; it *is* the
  router's tier-0 for the mail source.
- **The LLM only ever proposes.** Classification confidence + the destination's risk tier decide
  whether the proposal auto-fires or waits for approval. The ledger decides; the model never
  self-approves (the substrate arc's §4 direction-axis rule, and the documented
  LLM-auto-approver-overriding-the-human anti-pattern, designed against).

Subsumes `sux#1433` (input→destination router), the drafts→oracle output-indexing idea, and the
output-side reinforcement idea — **one primitive, both directions.**

## 4. Graduated trust — the ledger that decides what auto-fires

A **route** is a `(content_domain × destination_type)` pair. Each route sits on an autonomy
ladder and moves along it based on quantified, windowed history — not vibes.

```
gated  ──promote──►  assisted  ──promote──►  auto
(propose→approve)    (auto + per-item        (auto + batch
                      digest receipt,          digest only)
                      one-click undo)
        ◄──────── demote (instant, on any correction/rollback) ────────
```

- **Promotion** = a windowed tally over `decision`: approval-rate ≥ τ **and** override-rate ≤ τ
  **and** zero rollbacks across the trailing evaluation window. (Grounding: arxiv 2606.09122
  per-category autonomy ladders, deployed at Azure Networking; 2606.22484 "GAIE" formal
  invariants — monotonicity, fail-safe-default, totality.)
- **Demotion** = **instant, asymmetric** — one correction or rollback trips a circuit breaker
  back to `gated`. Slow to earn, instant to revoke.
- **Risk tier caps the ceiling.** A static per-destination-type `risk_tier` caps the *maximum*
  autonomy a route can ever reach, independent of how clean its history is: a high-risk sink
  (reply to a human, delete, send money) can **never** graduate past `assisted`; a low-risk sink
  (archive a newsletter, add a vault fact) may reach `auto`. This is the **de-biasing keystone**:
  research (IEEE S&P 2026, arxiv 2511.17959, 205 participants / 7,563 decisions) found **78.2% of
  users approved *wrong* proposals** when confidently presented (automation bias). Approval
  history is a noisy, biased oracle; the risk cap + challenge proposals (§4.1) keep a clean
  history from rubber-stamping a high-blast-radius action into auto.

### 4.1 De-biasing — challenge proposals

The trust engine periodically injects a `was_challenge` proposal it is *not* confident about (or
surfaces a low-confidence one with extra friction). A route whose approvals are indiscriminate
(approving challenges it should reject) does **not** graduate. This turns the `decision` ledger
from a rubber-stamp stream into a calibration signal.

### 4.2 Trust ⊂ consent — how this composes with the 6-axis gate

The substrate arc's 6-axis consent gate (§4) sets the **static ceiling** (which vendor/tier/
direction/duration a class of content may reach). The trust ladder **auto-raises within that
ceiling** based on learned history and **never exceeds it**. Consent is the grant; trust is the
learned automation of a granted route. (This is interface gap **G2** fed back to Phase 0.5.)

## 5. Memory hygiene — the backpack

Universal capture with opt-out; the oracle keeps everything by default and **soft-hides**, never
hard-deletes (the "backpack" principle). Lifecycle state lives in D1's `memory_item`, keyed by the
Vectorize vector id.

- **Dedup is deterministic-first.** Exact-hash match (`exact_hash` column, O(1)) before any
  vector-similarity call; near-dup only escalates to a Vectorize similarity query on a hash miss.
- **Decay is closed-form.** `R = e^(−(now − last_recalled_at) / strength_S)` (MemoryBank,
  AAAI 2024, arxiv 2305.10250). `strength_S` is an integrator that increments per recall;
  `last_recalled_at` resets per recall — usage-reinforced retention. In control terms: `S` is an
  integrator state, decay a first-order lag. `sux#1430` (recall relevance-feedback) is the input
  that increments `S` — folded in here, not standalone.
- **Eviction is class-aware.** Under size pressure, soft-hide the lowest-`R` items; a long-tail
  TTL backstop hard-hides the floor. But a `phi`/`legal-privileged` item's at-rest class (Phase
  0.5b, carried on the `memory_item` row — interface gap **G6**) constrains *where* it may be
  cached, so hygiene never demotes a PHI item into an edge cache that violates its ceiling.

## 6. Degraded-mode — the fail-safe-default

The router's degradation clause, fed into the Phase 0.5f contract (interface gap **G4**):

- **Box (T0) down:** recall degrades T0→T1 (Vectorize), rerank degrades to identity no-op
  (substrate Phase 3a's own contract) — **recall still works**.
- **D1 (control plane) unreachable:** the router cannot read current trust ceilings, so it
  **drops every route to `gated`** — propose-only, never auto-fire on stale trust. Fail-safe by
  construction (GAIE fail-safe-default). The always-on agent becomes a propose-only agent, never a
  silent-wrong one.

## 7. Schema (D1)

```sql
-- Trust plane
CREATE TABLE route (
  id            INTEGER PRIMARY KEY,
  content_domain TEXT NOT NULL,      -- medical|legal|finance|admin|personal|public|...
  dest_type     TEXT NOT NULL,       -- calendar|task|vault_fact|index|archive|reply|delete|...
  trust_state   TEXT NOT NULL DEFAULT 'gated',   -- gated|assisted|auto
  risk_tier     INTEGER NOT NULL,    -- static cap, from the per-dest-type risk taxonomy (G1)
  UNIQUE(content_domain, dest_type)
);

-- Append-only reinforcement + audit substrate (one stream; egress-audit is the sibling event — G3)
CREATE TABLE decision (
  id            INTEGER PRIMARY KEY,
  route_id      INTEGER NOT NULL REFERENCES route(id),
  content_ref   TEXT NOT NULL,       -- content-addressed handle, never content
  action        TEXT NOT NULL,
  confidence    REAL NOT NULL,
  outcome       TEXT NOT NULL,       -- approved|rejected|corrected|rolled_back|auto
  was_challenge INTEGER NOT NULL DEFAULT 0,
  decided_at    INTEGER NOT NULL
);

-- Memory plane (keyed to the Vectorize vector id)
CREATE TABLE memory_item (
  id               TEXT PRIMARY KEY, -- == Vectorize vector id
  created_at       INTEGER NOT NULL,
  last_recalled_at INTEGER NOT NULL,
  recall_count     INTEGER NOT NULL DEFAULT 0,
  strength_S       REAL NOT NULL,    -- integrator; increments per recall (#1430 feeds this)
  importance       REAL NOT NULL,    -- salience at capture
  source_domain    TEXT NOT NULL,
  at_rest_class    TEXT NOT NULL,    -- Phase 0.5b class; governs eviction target (G6)
  exact_hash       TEXT NOT NULL,    -- deterministic dedup
  hidden           INTEGER NOT NULL DEFAULT 0   -- soft-hide only, never DELETE
);
CREATE INDEX memory_item_hash ON memory_item(exact_hash);
CREATE INDEX decision_route_time ON decision(route_id, decided_at);
```

`route_metrics` is a **view/query over `decision`** in the trailing window — a few hundred routes,
so SQLite computes promotion eligibility on the fly; no denormalized counter to drift.

## 8. Code-level integration points (against real code, branch #1443)

- **New D1 binding** on `RtEnv` (`registry.ts:24`) — declared the same hand-on-RtEnv way
  `VECTORIZE` is (`registry.ts:57`), plus a `wrangler.jsonc` `d1_databases` entry beside the
  existing `kv_namespaces`/`vectorize` blocks (`wrangler.jsonc:15-23`). Registered as a storage
  sink through Phase 0.5a, not a bespoke capability.
- **Tier-0 reuse** — the router's mail source *is* `_mail_triage.ts`'s existing rules→kNN→LLM
  cascade (`_mail_triage.ts:4-8, 134`); other sources implement the same three-rung seam.
- **`llm()` stays the synthesis chokepoint** (`ai.ts:120`) — the router calls it only for the
  ambiguous residue and only to *propose*; the evolving router-`llm()` of substrate Phase 4b is
  where tier selection happens. No change to `llm()`'s contract from this doc.
- **Consent storage** reuses the `preferences` KV scope shape (`preferences.ts:19` `sux:prefs:`)
  the substrate arc's Phase 0b extends with `vendor_consent`; the trust ladder reads that ceiling.

## 9. Interface gaps fed back to Phase 0.5 (the seed's explicit ask)

Summarized here; specified in the implementation-plan doc's Phase 0.5 addendum.

| # | Gap | Into |
|---|---|---|
| G1 | sink taxonomy needs a **sink-side `{riskTier, maxAutonomy}`** axis, not just source `sensitivityCeiling` | 0.5a |
| G2 | **consent ceiling must be a value the trust engine reads and never exceeds** (trust ⊂ consent) | 0.5a/0.5f |
| G3 | **one audit/decision schema** — egress-audit and routing-decision are two event types on it, not two ledgers | 0.5d |
| G4 | degradation contract carries the **router fail-safe-default** (D1 down → all-gated) | 0.5f |
| G5 | eval harness scores **routing precision + trust calibration + challenge-acceptance rate**, not only tier quality | 0.5e |
| G6 | **`memory_item` carries the at-rest class**; eviction is class-aware; **D1 joins the 0.5b storage lattice** (first-party-CF) | 0.5b |

## 10. Testing / verification

- **Deterministic layers get red-green unit tests** (mirror `_mail_triage.test.ts`,
  `_answer_vectorize.test.ts`): exact-hash dedup, the decay closed form, the windowed promotion
  tally, and — critically — the **demotion circuit breaker** (one rollback → `gated`) and the
  **risk-tier cap** (a clean-history high-risk route never reaches `auto`).
- **De-biasing is testable:** a fixture stream of indiscriminate approvals including challenges
  must *not* graduate the route.
- **Degraded-mode is testable:** with the D1 binding unset, every route resolves `gated` and
  nothing auto-fires (byte-identical to a fresh install).
- **Eval (Phase 0.5e extension):** a golden set of (content → correct sink) pairs scores routing
  precision; a held-out labeled set scores trust calibration.

## 11. Sequencing within the two-arc program

1. **This doc + the Phase 0.5 addendum land first** (design), so the spine is built to carry
   G1–G6 before it sets.
2. **1.3 — the edge control plane** (this doc's §3–§7) builds against the finalized 0.5 taxonomy,
   in parallel with substrate Phase 1/0a — it needs only Vectorize + D1.
3. **1.4 — the box-resident upgrades** (Qdrant/graph #1, real-time daemon #4, Whisper-fed
   voice→draft, synthesis engine + specialist lenses) land as substrate Phases 3/4 bring the T0
   tiers online; the degradation contract already accounts for them.

The synthesis engine's four sparks (deadline / accumulation / gap / mandate) **register as**
`watch` / `routine` / `milestone` entries in the existing standing-automation registry — they do
**not** introduce a parallel scheduler (the one open reconciliation conflict, resolved by
subordination).

## 12. Open questions

- **Risk taxonomy authoring (G1)** — the per-destination-type risk tiers have **no prior art**
  (confirmed in research); they must be hand-authored and reviewed. Small but load-bearing.
- **Router entry point** — a single `route` fn the sources call, vs. a seam each source fn
  implements (like `classify()` in `_mail_triage`). Leaning: a shared `route()` core + per-source
  tier-0 adapters.
- **`decision` retention** — append-only forever (audit value) vs. windowed prune once trust
  stabilizes. Leaning: keep, it is small and it is the audit trail.
