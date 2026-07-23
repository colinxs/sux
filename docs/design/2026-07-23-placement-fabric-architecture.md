# The Placement Fabric — nodes, edges, and one deterministic resolver

Status: design / settled at model level · Date: 2026-07-23
Scope: `sux` (the Worker + `Fn` registry) · `suxlib` (op layer, later) · policy/config in git · trust in D1
Supersedes: the T0–T3 tier ladder as a **type** (it survives only as a derived display label)
Builds on: `2026-07-23-capabilities-wedge-router-control-plane.md`,
`2026-07-23-self-hosted-compute-and-model-tiering.md` (+ `-implementation-plan.md`)

**Provenance.** Six parallel design workflows, 165 agents, ~26M tokens, every load-bearing claim put
through adversarial refutation against live code. §9 records the claims that **failed** that pass —
read it before trusting anything here that cites a file.

---

## 1. The reframe

> "most of what we build can/should run everywhere. So maybe feature A is implemented by a worker,
> stateless/stateful container, short/long lived vm, running on github actions, cloudflare, aws,
> metal, router or some combination thereof (fallback, swappable, tiered, proxied). We build NODES
> (code/infra/automation/workflows) connected by EDGES (client/server locations, state models,
> implementations) that can be intelligently combined (hub and spoke model with router at center,
> sub routers, tiered/fallback/reroute/balance)." — owner, 2026-07-23

This replaces the box-vs-edge decomposition entirely. "Blocked on the box" ceases to be a category:
an unavailable placement is an **edge whose health probe is failing**, and the node keeps working
through its other edges. Degradation stops being a special-cased clause and becomes the normal
operation of edge selection.

## 2. Node and edge

A **node** is a capability, declared once, **placement-free**. It is realized by the already-shipped
`Fn` (212 non-test modules under `sux/src/fns`), gaining only what a resolver must decide over:
`requires`, `sensitivityMax`, `riskTier`/`maxAutonomy`, `idempotent`, and `edges`. **Nothing on a node
names a location, vendor, transport, tier, or runtime.**

An **edge** is one realization of one node at one place. It carries the owner's three properties
directly — location, state model, implementation — plus what consent needs (`operator`,
`jurisdiction`, `retentionMs`, `admitsUpTo`, `atRestUpTo`) and what ordering needs (`latencyHintMs`,
`floor`, `admits`, `unusable`, `selftest`).

**Migration is empty by construction: an `Fn` with no `edges` is one implicit edge and is
byte-identical to today.** Adoption is per-fn and reversible per-fn.

> **Falsification test for the whole program.** Each migration must *net-delete* a hand-written
> ladder. If migrating `_ingest_route` and the egress ladder does not remove more code than it adds,
> stop and cut back.

## 3. Topology — fixed stages, not free recursion

```
0 ENTRYPOINT  sux Worker · always · stateless · binds identity + risk tags + consent
      ↓ (only on escalation)
1 PLANNER     the oracle · long-lived OR on-demand · agentic
      ↓ (only if the substrate has internal choices)
2 LOCALITY    sub-router within a substrate (metal choosing among its containers)
      ↓
3 EXECUTOR    terminal
```

Forward-only. **Cycles are unrepresentable**, which is strictly better than a hop budget — a budget
caps a bug at runtime; a fixed stage sequence makes the bug inexpressible and lets every path be
enumerated statically. It also bounds the per-request decision record to a known shape.

- **Depth is fixed; breadth is unbounded and safe.** Multi-sink fan-out is N parallel dispatches, each
  walking the same finite sequence. Breadth terminates; only depth runs away.
- **The planner iterates in time, not in depth.** A multi-step plan issues successive dispatches, each
  re-entering at stage 2. Two separate bounds: stage depth is structural; planner iteration is a budget.
- **The hub is also a spoke** — "run it here in the Worker" is the zero-hop edge, so local execution
  needs no special case.
- **Edge-originated work** (box cron, Mac-on-open sweep) may start locally rather than round-tripping
  through Cloudflare. The invariant is not "everything enters through the Worker" but **"every
  decision lands in one ledger and passes one policy."**

## 4. Two routers, strictly layered

**The placement selector sits BELOW the content router.** The argument is regress, not taste:

> The content router is itself a capability → therefore a node → therefore it has edges → therefore
> its own placement must be resolved. If the two routers were one function, **resolving where to
> classify would require classifying.**

So model-free resolution is a *structural requirement*, not a latency preference. Three supporting
differences, each independently disqualifying a merge:

| | Content router | Placement selector |
|---|---|---|
| Signature | `(content, ctx) → destination(s)` | `(node, ctx) → one edge` |
| Wrong answer | irreversible (emails the wrong person) | retryable at zero semantic cost |
| Fail-safe | degrades **closed** → `gated` | degrades **open** → compiled-in floor |
| Evidence window | human non-correction over **days** | mechanical success in **milliseconds** |

The content router's output (a sink) is the placement selector's input. **Composition, not identity.**

They share, physically and not by convention: one `admit()`, one `route` row shape discriminated by
`kind`, one `decision` audit shape, one health contract.

## 5. Resolution — pure, filter → order → chain

`resolve(fn, ctx, health, grants) → Plan | Denied` is a **pure total function**: lookups, set
containment, lattice comparisons, a total-ordered sort. No I/O, no model call — **enforced by a
dependency test asserting the module imports nothing capable of fetching.** Mechanism, not convention:
one accidental `await` there taxes every interactive call.

**FILTER** (boolean, order-independent): requirement containment · sensitivity admissible in-flight
and at-rest · the policy gate · residency (`grantDuration ≥ retentionMs`) · the `admits` predicate ·
reroute exclusion · breaker closed-or-floor · health not `down` · deadline fit · secrets available
here · idempotency permits retry.

> **`unknown ≠ down`.** An unprobed edge is ordered **last, never filtered** — otherwise a health-plane
> outage takes the whole fabric down.

**ORDER** — lexicographic on `[policyFriction, breakerRank, healthRank, pinRank, declarationIndex, id]`.
Lexicographic rather than weighted because a tuple is explainable in one audit row, a weight vector is
not, and there are no ground-truth weights to tune. `pinRank` reuses `rung-memory`'s shipped learned
pin, constrained so it may **reorder survivors but never add an edge that failed the filter** — that
containment is the entire safety property of learned routing.

**No cost term.** `sux#920` is CLOSED as `not_planned` — declined, not deferred.

**The whole scheduler was deleted.** Every candidate set in this fabric is **size two** (`obsidian.ts:403`
ships `enum:["git","remote"]`; `willProxy` is proxy|direct; `needsDurable` is inline|durable; `llm()` is
workers-ai|openai). A spillover factor over three endpoints is a step function; a hash ring over two is
a coin flip. Deleted: priority spillover, panic thresholds, hash rings, weighted score vectors, hedge,
quorum, weighted balance, retry budgets, queues, leases, fencing tokens, DLQ/redrive. What remains is
**~150 lines**.

**Balance is deliberately absent, and that is an answer.** Round-robin serves homogeneous replicas
sharing load; this fabric has none — every edge is differently priced, trusted, and capable. Hedging is
additionally *unsafe*: `race` never preemptively kills a loser, so a hedged vendor call pays twice and a
hedged write writes twice.

**The owner's four semantics land as:** tiered = the ordered chain · fallback = the fold · reroute =
re-resolve excluding the failed edge · proxied = an edge whose location is `proxy:residential`, not a
mode. Fan-out stays separate — a tee to N named targets is a different question from picking one of N,
and conflating them is how a router becomes unexplainable.

## 6. One policy spine

> Executing capability C at edge E **is** egressing C's input to E's operator, **plus delegating that
> operator whatever ambient authority E holds.**

Placement is not analogous to egress — it is a **superset**, and the extra term folds into the
*subject* rather than becoming a second gate. All six consent axes transfer with the subject widened;
`self` becomes a legal operator value, which is what makes a self-hosted edge expressible at all.

**Dual filter:** `(risk tags × operator matrix) → allow | redact | deny`.

Risk tags are a **set, not an ordered scale** — `phi`, `legal`, `embarrassment`, `secrets`, `financial`.
A public court filing is legally fine anywhere but embarrassing; a routine lab value is PHI but not
embarrassing. `legal` disqualifies **by category** (third-party disclosure can waive privilege
regardless of that party's posture); `phi`/`embarrassment` disqualify **by counterparty attribute**.
`embarrassment` has no external definition — it is learned from owner corrections and **fails closed**.

Three risk notions stay separate, because conflating them blocks low-blast-radius actions on
high-sensitivity content:

| Risk of… | Values | Governs |
|---|---|---|
| **Disclosure** (content) | phi · legal · embarrassment · secrets · financial | which operators are eligible |
| **Action** (sink) | archive → reply → delete → send-money | autonomy ceiling |
| **Breakage** (target) | reversible → irreversible → sacred | gating + required rollback |

**Fail direction is asymmetric and deliberate:** health degrades **open**; policy degrades **closed**,
to compiled-in grants at full six-axis arity — *not* to an `operator === "self"` shortcut, since `self`
is the most privileged operator in the fabric. Both closed self-DoSes on cold start; both open leaks.

**A policy refusal is terminal.** `FAIL_CODES` (`registry.ts:728`) has nine members, none meaning
"denied on policy," while `blocked`/`upstream_error` are reroute-eligible — so today's PHI fence (a
bare `throw` in `_assimilate.ts`) ported into a chain would become "edge A refused, try edge B."
`denied_by_policy` and `no_feasible_edge` are added and **excluded from the reroute set**. This is the
single most important safety fix in the design.

**Table integrity:** a KV/D1 snapshot may **restrict** an edge's ceilings, never widen one; a widening
snapshot is rejected at load. Without this, a decision that is code-reviewed and ruleset-gated becomes
an unreviewed KV write.

## 7. Request properties

**Mode** `{sync | async-push | async-pull | streaming}` + deadline. One mechanism: every dispatch
returns a handle; sync is blocking on it. **Deadline overrun degrades to async rather than erroring** —
a timeout becomes a mode change. Async is what makes cheap/slow/unmetered placements eligible at all;
push and pull differ in infrastructure (a channel vs durable storage only), so both exist.

**Effort** `{satisfice | best-of-N | exhaustive}` + budget + depth. Selects the fan-out topology;
terminates on a deterministic predicate (count / dry / budget), reusing the proven loop-until-count and
loop-until-dry shapes. **Retry and fan-out are bounded by node idempotency** — a non-idempotent node
gets one attempt regardless of requested effort unless it carries an idempotency key. Exhaustive
effectively implies async.

## 8. Breakage, undo, and sacred edges

Caution is a function of the **undo story**, not apparent scariness. A sweeping refactor inside git is
cheap; a one-line change to `owl-tegu` is not.

**Sacred is derivable, not hand-labeled:** an edge is sacred iff **its own recovery path traverses it**.
Break `owl-tegu` and you cannot reach `owl-tegu` to fix it. In control terms: you cannot drive a plant
through an actuator the control signal must itself pass through.

| Target | Undo substrate | Class |
|---|---|---|
| repos, vault, docs | `git revert` | reversible → generous autonomy |
| elk-newt config | NixOS generation rollback | reversible |
| Workers | version rollback | reversible |
| **owl-tegu** | **none (self-referential)** | **sacred** |
| sent mail, money, published content | none | irreversible → hard cap |

**Trust promotion speed is proportional to undo strength.** Note this arrives at the same autonomy cap
the automation-bias research demanded, from an entirely independent direction.

**Config is git-static, not hot-reloadable** — automation adjusts routing by opening PRs, which avoids
the whole version-skew/split-brain class. Three planes at three mutation rates: policy/topology = git ·
learned trust = D1 · health = runtime probe. Determinism is over the full input tuple. This yields
`trust ⊂ consent` cleanly: **ceiling authored in git, position learned in D1.** Automation may propose
anything but may never auto-land a change that **widens its own authority** (path-scoped review, not
convention).

## 9. ⚠️ Corrections — claims that FAILED adversarial verification

Recorded because they are the part most easily lost, and several are seductive.

- **`Locus` is not new vocabulary** — it is the owner's own shipped term (workspace/org/repo;
  `2026-07-15-loci-redesign-design.md`; a CLAUDE.md section). **Renamed `Placement`**, generalizing the
  live `IngestRouteBlobRef.placement` (`_ingest_route.ts:44`).
- **`edge` collides** with `"sux — the edge function engine"`, test-locked at `skill-prompt.test.ts:37`.
  node/edge stay as **prose**; the code identifier is **`Rung`** (reusing shipped `rung-memory`).
- **The seam is `Fn`, not suxlib's `resolveLeaf`** — sux never calls it (zero grep hits);
  `LEAF_REGISTRY` governs 13 local byte-transforms. Three of four candidate architectures attached one
  layer too low.
- **`llm()` is NOT the egress chokepoint.** `ai.ts:108` fell back to `api.openai.com` via bare `fetch`
  on any Workers-AI failure — an execution-time **operator substitution invisible to `auditEgress`**,
  and the only path handing user prompt content to a *third-party* operator (Workers AI is first-party
  Cloudflare). **Fixed in [#1454](https://github.com/SuxOS/sux/pull/1454)**: now `smartFetch`, with
  `api.openai.com` added to `DIRECT_HOST_RE` so the route is unchanged, plus a regression guard
  asserting bare `fetch` stays untouched. **`smartFetch` (proxy.ts) is the real egress seam** — the
  fabric's egress rung should attach there, not at `llm()`.
  - ⚠️ **The `_ocr.ts` half of this finding was false and is retracted.** `_ocr.ts:77` calls
    `smartFetch`; line 19 is only the `MISTRAL_OCR_URL` **constant**, and an agent inferred a call
    from the constant's presence. Mistral OCR has always been audited. Generalize the lesson: *an
    agent citing a string/URL constant's line as a "call site" is a recurring false-positive shape.*
  - Still open, lower severity: three bare-`fetch` sites that carry **no user content** —
    `utils.ts:62` and `grafana.ts:247` (GitHub), `index.ts:602` (Kroger OAuth).
  - Genuinely unexamined, different axis: OCR hands Mistral a **public `/s/<uuid>` CAS handle**
    (`putBlob`), so a PHI document is briefly fetchable at an unauthenticated URL. Not an audit gap —
    an at-rest/exposure question, and it interacts with the "never cache `/s/<uuid>`" rule in §10.
- **`staged()` is not a chokepoint either** — `stage.ts:52-56` deliberately excludes
  `ingest`/`dropbox`/`kv_*`/`obsidian`.
- **Facet derivation was anti-conservative** — `registry.ts:817` `WRITE_DESTRUCTIVE` has
  `openWorldHint:false`, so `!readOnlyHint && openWorldHint ⇒ canEgress` is **false** for
  `store`/`ingest`/`dropbox`: the one documented exfil channel read as non-egressing.
- **Commit-confirm on `owl-tegu` is inert as designed** — `presence-metrics:63-99` emits `ts="$NOW"` for
  any joined MAC, and a LAN break produces no leave events, so the confirm always fires. **Resolution:
  decouple generation from deployment** — commit the generated artifact, ship via the existing manual
  deploy script. No autonomous channel to a sacred edge.
- **A lethal-trifecta predicate can never fire in stage 0** — the Worker is stateless and one-fn-per-
  request; the **client model is the sequencer**, so three separate `tools/call`s each pass individually.
- **`git check-attr` is not a pure function of the tree** — untracked `.git/info/attributes` overrides
  committed attributes with `git status` clean. Kills gitattributes-based classification.
- **Filenames are disclosure** (`2022-Medication-Dispute-Dr-Sheehan.md`) — a path-floor scheme publishes
  what it exists to hide; the same vector that rejects git-crypt.
- **`render` has no `backend: cf|mac`** — `mac-render.ts` does not exist; `b8473ea1` dropped the tier.
- **Repo consolidation is 12→10, not 12→6** — `suxos-net` and `suxdash` each own a `wrangler.jsonc`;
  folding them forces path-filtered deploy workflows, this org's own required-check jam variant 3.
- **Nix already *is* the two-stage resolver** — the `builders` spec matches
  `requiredSystemFeatures ⊆ supportedFeatures` then orders by `speedFactor`. Populate it; do not
  reimplement. Node-side contribution is `passthru.sux` (`passthru` because it does not enter the
  derivation hash, so annotating placement can never cold-bust a cached result).
- **Cachix is already half-wired** (`metal/ci.yml`, cache `suxos`) — the Attic/R2 plan rebuilt it.

**Do not implement, ever:**
1. **Caching `/s/<uuid>`** — it is a *revocable capability handle*; cache serves before the Worker, so a
   deleted/expired/PHI-reclassified handle keeps serving publicly for a year.
2. **Auto-landing knip's unused-file deletions** — removes `sux/test/e2e/vitest.e2e.config.ts`
   (`package.json:17`) and `sux/test/shims/cloudflare-workers.ts` (`vitest.config.ts:15`).

## 10. Owner decisions (taken — do not re-ask)

1. **Data placement deferred.** v1 edges constrained to a shared CAS namespace; `sha256` already
   carries placement-free identity, so the door stays open.
2. **Consent-gated edge → route silently elsewhere**, and record the would-have-asked verdict in the
   ledger so the hidden capability is discoverable without interrupting.
3. **Auto-promotion asymmetric by operator** — `self` may promote on mechanical evidence; any
   third-party edge requires one human confirmation per (node, edge), closing the
   quietly-wrong-but-200 path that `looksBlocked()` proves is real.
4. **Single vault**, `suxvault` retired; vault safety is an at-rest placement constraint, not a repo
   partition. The stub/handle split is tabled with rationale, not killed.

## 11. Sequencing

0. **Unblock** — route every fn invocation through one `callFn()` boundary; per-request context and the
   sensitivity lattice with provenance join. *(Without these, anything else is decorative — and note the
   lattice is **new work**: `grep sensitivity --include=*.ts` returns four comments and zero code.)*
1. **Contracts** — `Edge`/`Placement`/`NodeDecl` types + the `placed()` helper + registry lint;
   `admit()` as one six-axis gate with policy denial made terminal; `resolve()` pure filter/order/chain.
2. **Prove it by deleting ladders** — per-edge governor key and `Served` provenance; migrate
   `_ingest_route` (the reference migration); migrate the egress ladder so proxy becomes a place, not a
   mode. *(The `retail-render` migration is **dropped** — see §9.)*
3. **Control plane** — bind D1, author edge/grant tables, compile a KV snapshot; health probes and the
   breaker-as-trust-ladder with loop separation; decision ledger split by evidentiary weight (every
   policy verdict durable and unsampled; per-call mechanical outcomes sampled).
4. **Generalize** — edge conformance suite; op-layer placed leaves in suxlib. **Last, not first** — that
   layer carries none of today's traffic.

## 12. Open

- ~~The **`llm()`/`_ocr.ts` egress hole** (§9) is the highest-priority correctness fix and gates widening
  PHI intake.~~ **Closed** by [#1454](https://github.com/SuxOS/sux/pull/1454) — and it was half a
  phantom (see §9). What it settles for this design: **`smartFetch` is the egress seam**, so the
  policy spine's egress rung attaches there.
- **The `/s/<uuid>` handle is the live PHI-exposure question**, and it is not the one that was being
  asked. OCR publishes a document at an unauthenticated public URL so Mistral can fetch it. §10
  already forbids *caching* that path (a revocable capability handle must not outlive revocation);
  what is unanalyzed is the exposure window itself, and whether a signed/expiring handle or a
  push-bytes upload should replace it for `phi`-tagged content.
- MCP traffic attribution must be re-grouped **by authenticated principal**, not user-agent — the
  `claude@` bot and `m@` human present the same UA, so the earlier "one client" inference is unsupported.
  (The 405 fix stands regardless; only the cost/causal story is unresolved.)
- The tooling/language doctrine (typed helpers vs nushell vs Go/Rust to replace fragile `bash`+`jq`) has
  its research banked but its synthesis unfinished.
