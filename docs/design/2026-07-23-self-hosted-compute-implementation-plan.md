# Self-Hosted Compute & Model Tiering — Implementation Plan

Status: draft / planning · Date: 2026-07-23
Plans the phases in `2026-07-23-self-hosted-compute-and-model-tiering.md`. Companion to
`2026-07-23-cross-vendor-token-optimization-spec.md`.
Repos: `sux` · `suxlib` · `metal` · `nix` · `suxrouter` · `SuxOS/.github`

Effort key: **S** ≤1 session · **M** 1–2 sessions · **L** dedicated multi-session.
Every sux code change must pass the CI gate (`npm run ci`: type-check, vitest, check:node,
gen:index drift, wrangler dry-run). Every metal change must build the system closure in CI
before merge (pull-GitOps converges the box).

---

## Dependency graph & critical path

```
Phase 1 (Attic cache + cloud runners) ──────────────┐  independent, no box/consent deps
Phase 6a (classify cascade, sux-only) ──────────────┤  independent
Phase 0 (connectivity + consent + audit + OCR gate) ─┤─► unblocks box-side work
        │                                            │
        └─► Phase 0.5 (glue spine) ──────────────────┴─► the coherence layer 2–5 register into
                │
                ├─► Phase 2 (on-prem OCR)          needs 0-connectivity, registers via 0.5
                ├─► Phase 3 (embeddings/rerank)    needs 0-connectivity, registers via 0.5
                ├─► Phase 4 (T0 small-model tier)  needs 0-connectivity, registers via 0.5
                └─► Phase 5 (verify + DeepSeek)    needs 0-consent + 0.5 router/eval
```

**Recommended first sprint (parallel, no cross-deps):**
1. **Phase 1a — Attic cache** (cache-first; helps every runner immediately).
2. **Phase 6a — `classify` embedding cascade** (sux-only, pure token/cost win, no infra).
3. **Phase 0a — connectivity** (Tailscale on box + Worker→box transport; unblocks 2/3/4).

Then **Phase 0.5 (glue spine)** — the taxonomy + at-rest classification + eval harness that
Phases 2–5 register into (build it *before* those, or they fragment into point integrations) —
then Phase 2 (closes the Mistral PHI leak) → Phase 3a (reranker) → Phase 4.

**Transport decision, made concrete so sux-side work isn't blocked:** plan the sux→box client
as **transport-agnostic** — a base URL + bearer/service-token from env (`SELFHOST_*_URL`,
`SELFHOST_TOKEN`). Default Worker→box path = **cloudflared tunnel ingress + Cloudflare Access
service-token** (box already plans the tunnel; least new infra). Tailscale is the build-plane +
admin fabric. Swapping transports never touches fn code.

---

## Phase 0 — Connectivity, consent, audit, OCR gate

**Objective:** a Worker↔box path + the 6-axis consent gate + content-free egress audit; gate
the existing un-audited Mistral OCR egress. Prereq for all box-consuming and cross-vendor work.

### 0a. Connectivity (Effort: M) — `metal`, `sux`
1. `[metal]` new `modules/tailscale.nix` — `services.tailscale.enable`, authkey via sops-nix, add to `hosts/elk-newt/default.nix` imports. Box joins tailnet (admin + build-plane).
2. `[metal]` `modules/tunnel.nix` (the planned cloudflared) gains an **ingress hostname per box service** (e.g. `compute.suxos.net → 127.0.0.1:<port>`), fronted by **Cloudflare Access with a service-token**.
3. `[sux]` new `src/selfhost.ts` — a tiny transport-agnostic client: `postSelfhost(env, service, body)` reading `SELFHOST_<SERVICE>_URL` + `SELFHOST_TOKEN` (added to `RtEnv` in `registry.ts`, per the "add bindings to RtEnv not worker-configuration.d.ts" gotcha). Every `race`/fallback path degrades to the existing edge engine when the URL is unset or the box is down.
4. **Acceptance:** a `selftest`-style probe fn confirms the Worker can reach `compute.suxos.net` with the service-token and gets a health 200; unset → clean "not configured" skip.

### 0b. Consent gate + sensitivity (Effort: M–L) — `sux`
1. `[sux]` new `src/gate.ts` — pure `gateEgress(vendor, sensitivity, consent) → {allow, redact} | {deny, reason}`, `sux.decisions`-style, fuzz-tested for default-deny. (Six axes per strategy §4.)
2. `[sux]` `registry.ts` — add optional `sensitivity?: Sensitivity` to the `Fn` type; declare floors on the personal/public fns (vault/mail/files/calendar/contact/recall/oracle/study/mychart → `personal`+domain; scrape/search/crawl → `public`).
3. `[sux]` `proxy.ts` `EgressContext` — add a `sensitivity` field alongside `login`/`reqId`; provenance = max over `pipe`/`batch` sources (thread through `batch.ts`/`pipe.ts`).
4. `[sux]` consent storage via the existing `preferences` fn — add a `vendor_consent` scope; KV keys `consent:vendor:{login}:{vendor}:{scope}` with TTL; default-deny.
5. `[sux]` enforcement at the two chokepoints: `ai.ts` `llm()` (before any third-party lane) and `_ocr.ts` (before Mistral). Interactive path denies with the reason; durable path can raise an `ask`-gate for grant.
6. **Acceptance:** fuzz test proves no `personal→third-party` allow without a grant; a personal-class fn with no consent returns the typed deny, not a silent send.

### 0c. Egress audit + OCR gate (Effort: S) — `sux`
1. `[sux]` reuse `proxy.ts`'s egress-audit Loki line — emit `{reqId, login, vendor, class, grantId|null, bytesOut, redacted}` on every third-party LLM/OCR call; **never content**.
2. `[sux]` `_ocr.ts` — deny `phi`/`personal`-tagged bytes to Mistral by default (extend `_assimilate`'s existing refusal to `study`/`_scan_ingest`/`_document_radar`). This is the interim gate; Phase 2 is the real fix (on-prem path).
3. **Acceptance:** a PHI-tagged OCR call with no on-prem backend + no consent is denied and audited; a public image still OCRs via Mistral.

---

## Phase 0.5 — The glue spine (build before Phases 2–5)

**Objective:** the coherence layer that makes the arc a *glue layer* instead of 5 point
integrations. Every box-consuming phase registers into it. Skipping it forces a retrofit.
**Effort: L** (foundational). Depends on 0a for the cross-tier pieces; the taxonomy/at-rest/eval
pieces can start immediately.

1. **`0.5a` Capability/sink taxonomy** — `[suxlib]`+`[sux]`. Unify `caps.models` / `caps.storage`
   / `caps.egress` / `caps.actions` under **one governed effect shape**
   `{tier, sensitivityCeiling, health, fallbackChain, governor}`. Extends suxlib's existing
   `caps`/`sink`/governor machinery. Phases 2–5 then *register a sink*, not wire a client.
2. **`0.5b` At-rest sensitivity** — `[sux]`+`[suxlib]`. The §4 class travels **with the
   Handle/record through the CAS**, not just in-flight — so the storage router (KV/R2/Vectorize/
   box-DB/vault/Dropbox) and the compute router share one lattice. A datum's class governs
   *where it may live*, not only where it may be sent.
3. **`0.5c` Cross-tier content-addressed cache** — `[suxlib]`. Extend the `Handle`/`Store` CAS so a
   box-computed embedding/OCR/summary is content-addressed and reused by the Worker (and vice
   versa). Makes the box a cache-warm tier; storage analog of Phase 1's cache-first insight.
4. **`0.5d` Per-tier observability + cost/latency** — `[sux]`+`[.github]`. OTel spans **follow a
   request across the tunnel**, tagged `{tier, vendor, tokens, $, ms}` (telegraf→Grafana already
   the sink). Generalize the CI budget-governor concept from "minutes" to "per-tier runtime
   spend." **Routing is unmakeable without this.**
5. **`0.5e` Eval harness for routing** — `[sux]`. A golden-set scoring each tier on each task
   class (reuse the `*.test`/`selftest` discipline). Turns the old-vs-new-school framework from a
   doc into a **policy the router reads** — otherwise tiering is guesswork.
6. **`0.5f` Graceful-degradation contract + health registry** — `[sux]`. Each capability declares
   a fallback chain + health probe; `selftest` reports per-tier availability; op-engine
   circuit-breakers gate each box service. "Box down" is a routing event, never a hard failure.

**Acceptance:** Phase 2's OCR sink registers through `0.5a` with a declared fallback + at-rest
class; a trace shows a request crossing Worker→box→vendor with per-tier cost tags; the eval
harness scores T0 vs T1 on one task class.

### 0.5 addendum — interface gaps from the capabilities arc (feed in *before* the spine sets)

Added 2026-07-23. The capabilities arc's wedge —
`2026-07-23-capabilities-wedge-router-control-plane.md`, the edge router / graduated-trust /
memory control plane — consumes the spine as its primary client. It needs six things the spine
spec above did not anticipate. Fold each into the corresponding 0.5 sub-phase so the payoff arc
registers cleanly instead of retrofitting. (The substrate arc is source/sensitivity-shaped; the
router adds the **sink/action and control** shape.)

- **G1 → `0.5a` sink taxonomy gains a sink-side risk axis.** The unified effect shape
  `{tier, sensitivityCeiling, health, fallbackChain, governor}` is source-driven (where a datum
  may *go* by its sensitivity). Add `{riskTier, maxAutonomy}` — the **blast radius of the action
  a sink performs** (archive-newsletter = low, may auto; reply-to-human / delete / send-money =
  high, never auto). §4's binary direction-axis is the germ; this generalizes it to a graded cap.
  `riskTier` is a **static** property of the sink; `maxAutonomy` is the ceiling the trust ladder
  may not cross.
- **G2 → `0.5a`/`0.5f` expose the consent ceiling as a readable bound.** The 6-axis consent grant
  (esp. the duration axis: once/session/N-hours/standing) is the **static ceiling**; the wedge's
  graduated-trust ladder auto-raises *within* it and must be able to **read it and never exceed
  it** (trust ⊂ consent). Expose `consentCeiling(login, class, vendor|sink) → tier|autonomy` as a
  pure query the trust engine calls before every promotion.
- **G3 → `0.5d` one audit/decision schema, two event types.** §4/0.5c's content-free egress audit
  line `{reqId, login, vendor, class, grantId, bytesOut, redacted}` and the wedge's append-only
  `decision` ledger `{route, action, confidence, outcome, was_challenge}` are the **same audit
  substrate** seen from egress vs routing. Define **one** schema in 0.5d with an event-type
  discriminator; do not build two ledgers. (The wedge stores routing rows in D1; the egress rows
  stay the Loki line — but the *schema* is shared so a single audit view spans both.)
- **G4 → `0.5f` degradation contract carries the router fail-safe-default.** Add the control-plane
  store (D1) to the health registry. When it is unreachable the router **drops every route to
  `gated`** (propose-only) rather than auto-firing on stale trust — the GAIE fail-safe-default
  invariant. "Control plane down" is a routing event that removes automation, never one that
  removes safety.
- **G5 → `0.5e` eval harness scores routing + trust, not only tier quality.** Extend the golden
  set with (content → correct sink) pairs (routing precision) and a held-out labeled set for
  **trust calibration** (are auto-graduated routes actually low-error?) plus a **challenge-
  acceptance rate** metric (the automation-bias guard: a route that approves injected
  `was_challenge` decoys it should reject must not graduate).
- **G6 → `0.5b` at-rest class travels on control records; D1 joins the lattice.** The router's
  `memory_item` row carries the 0.5b at-rest class so **hygiene eviction is class-aware** (a
  `phi`/`legal-privileged` item is never soft-hidden into an edge cache that violates its
  ceiling). Add **D1 to 0.5b's storage lattice** (`KV/R2/Vectorize/box-DB/vault/Dropbox` → add
  `D1`), classed **first-party-CF**: control *metadata* (route/decision/memory_item bookkeeping)
  may live there; PHI *content* may not (→ box-DB/vault).

**Net effect on 0.5:** `0.5a` grows a sink/action axis, `0.5b` grows one storage tier + carries
class on control rows, `0.5d` defines a shared audit schema, `0.5e` grows routing/calibration
scorers, `0.5f` registers the control plane. No new sub-phase; the spine's shape widens from
"compute/storage routing" to "compute/storage **and action/control** routing" — which is what
makes the always-on agent expressible on it.

---

## Phase 1 — Warm cache + cloud build plane (no AI)

**Objective:** cut GitHub action-minutes on the heavy non-Claude builds; isolate untrusted CI
off the home box.

### 1a. Attic binary cache (Effort: M) — `nix` (or a small new deploy)
1. Stand up **`atticd`** on a cheap always-on cloud node (or elk-newt initially), **storage backend = Cloudflare R2** (org already uses R2 for restic), Postgres or SQLite meta.
2. Per §6.1b: the Attic blob dataset is **`compression=off`/`lz4`** (Attic already zstd + cross-NAR-dedups); don't stack ZFS-zstd.
3. `[nix]`/`[metal]` CI: add the Attic URL as a **substituter** + `trusted-public-keys` in `flake-check.yml`, `ci-image.yml`, and metal `ci.yml`. **This is the cache-first win** — every runner (even ubuntu-latest) now pulls pre-built derivations.
4. **Acceptance:** a second CI run on an unchanged closure is a near-total cache hit (measure minutes before/after on metal `ci.yml`).

### 1b. Cloud ephemeral runners (Effort: M) — `nix`/new, `Soux/.github`, caller repos
1. Provision a cloud VPC (Hetzner/Fly/spot) NixOS host running **`services.github-runners.<name>`** with `ephemeral = true`, `replace = true`, a **runner group**, **private-repos-only**, persistent `/nix/store` + Attic substituter.
2. `[SuxOS/.github]` / caller stubs — route **trusted, non-Claude heavy builds** to the self-hosted label via a `runs-on` that picks self-hosted for `push`/trusted authors and **`ubuntu-latest` for fork/untrusted** PRs (reuse the existing `isTrusted` predicate; never run fork code on the runner).
3. Target jobs: metal `ci.yml` (closure), nix `flake-check.yml`/`ci-image.yml`, sux/suxrouter/suxlib `ci.yml` (npm+wrangler), suxrouter `build-image.yml`.
4. **Acceptance:** trusted-author PRs build on the self-hosted runner; fork PRs still on ubuntu-latest; minute burn on the target jobs drops. (Note: Claude-agent jobs stay hosted — self-hosting doesn't recover the subscription half.)

### 1c. OpenWrt build cache (Effort: S) — `suxrouter`
1. `[suxrouter]` `build-image.yml` — persistent **Docker-layer + downloaded-package cache** for the containerized ImageBuilder (not Attic; it's not Nix). On the self-hosted runner this is a local volume.
2. **Acceptance:** an unchanged image rebuild reuses cached ImageBuilder layers + package downloads.

---

## Phase 2 — On-prem OCR (closes the Mistral PHI leak)

**Objective:** a private, on-prem OCR path so PHI never leaves our hardware; unblock PHI assimilation.
Depends on 0a.

### 2a. OCR service on the box (Effort: M) — `metal`
1. `[metal]` new `modules/ocr.nix` — a **quadlet-nix container** running **PaddleOCR-VL** (high throughput, CPU/iGPU) or **Surya** (VLM, multilingual), exposed as an HTTP OCR endpoint on the tunnel/tailnet (`compute.suxos.net/ocr`). iGPU via `/dev/dri` if the VLM benefits.
2. **Acceptance:** POST a scanned PDF/image → structured text/markdown; latency acceptable for async paths.

### 2b. sux backend + PHI routing (Effort: M) — `sux`
1. `[sux]` `_ocr.ts` — add a self-hosted backend (`hasSelfHostedOcr(env)` on `SELFHOST_OCR_URL`) that **POSTs bytes directly** (no public `/s/<uuid>` handle — this is what closes the leak). Route `phi`/`personal` OCR to on-prem; keep Mistral for public/non-PHI (or as fallback).
2. `[sux]` `_assimilate.ts` — allow PHI OCR via the private path (lift the "refuse Mistral for PHI" block when on-prem is available).
3. `[sux]` `ocr.ts` — add the PDF path via the on-prem service (addresses the known "`ocr` fn has no PDF path" gotcha).
4. **Acceptance:** a PHI PDF OCRs end-to-end with **zero public-handle mint and zero third-party egress** (audit shows on-prem only); public image still uses Mistral.

---

## Phase 3 — On-prem embeddings + reranker

**Objective:** retrieval-quality win (a reranker sux lacks today) + PHI embeddings on-prem.
Depends on 0a. Split additive-first.

### 3a. Reranker (additive, do first) (Effort: M) — `metal`, `sux`
1. `[metal]` `modules/rerank.nix` — quadlet-nix container serving **BGE-reranker-v2-m3** (or ms-marco-MiniLM on CPU) as an HTTP rerank endpoint.
2. `[sux]` new `src/fns/_rerank.ts` — `rerank(query, candidates) → ordered` via `SELFHOST_RERANK_URL`; degrade to identity (no-op) when unset.
3. `[sux]` insert a rerank step in the retrieval path — `_answer.ts` and `recall.ts` query paths: after Vectorize/cosine top-k, rerank before synthesis. Additive, **no re-embedding/migration**.
4. **Acceptance:** rerank improves answer grounding on a fixture set; unset backend = byte-identical to today (no-op).

### 3b. On-prem embeddings (optional, heavier — migration) (Effort: L) — `metal`, `sux`
1. `[metal]` `modules/embed.nix` — text-embeddings-inference serving **BGE-M3** (dense+sparse, 8k ctx).
2. `[sux]` `_embed.ts` — add a self-hosted backend for the **index-build/`vectorize_backfill`** paths (background, PERSONAL); keep Workers-AI bge on the interactive query path.
3. **Migration:** bge-base (768-dim) → BGE-M3 (1024-dim) needs a corpus re-embed. Plan a dual-index/backfill cutover (mirror the existing Vectorize backfill cursor). **Defer unless 3a proves the box round-trip is fast enough** — reranker alone may capture most of the quality.
4. **Acceptance:** parity + fallback tests (mirror `_answer_vectorize.test.ts`); PHI embeddings computed on-prem.

---

## Phase 4 — T0 small-model tier

**Objective:** an on-prem small-LLM tier for async/PERSONAL synthesis (privacy + cost). Depends on 0a.

### 4a. Model server on the box (Effort: M) — `metal`
1. `[metal]` `modules/ollama.nix` — Ollama (or llama.cpp server) via quadlet-nix, **IPEX-LLM** for Iris Xe, serving **Qwen3-8B** / **Gemma3-4B** / a **DeepSeek-R1-7B distill**; OpenAI-compatible endpoint on the tunnel/tailnet. (Revisits metal's "don't chase GPU inference" — small-model serving is the different, viable workload; §11 decision.)
2. **Acceptance:** OpenAI-compatible `/chat/completions` returns at usable async tok/s for a 7–8B Q4.

### 4b. Router at the `llm()` chokepoint (Effort: M) — `sux`
1. `[sux]` `ai.ts` `llm()` — evolve from failover-only to a **router** taking `{difficulty, sensitivity, mode}`. Add the self-hosted backend (`SELFHOST_LLM_URL`, OpenAI-compatible). Backward-compat: default args → byte-identical to today.
2. Route the **async/PERSONAL** sites first (latency-insensitive, privacy-relevant): `_briefing`, `_infer_nudge`, `_assimilate`, `oracle` distill/redistill. Leave interactive `recall`/`advise` on T1/T2 until measured.
3. **Acceptance:** the async sites run on T0 when configured, fall back to Workers-AI when the box is down (audited); a per-site flag governs opt-in.

### 4c. (suxlib, later) `caps.models` sink registry (Effort: L) — `suxlib`
1. `[suxlib]` generalize `caps.llm` into a **tiered sink registry** so the op-engine's `race`/`reconcile`/`sink.fanout` fan across vendors as governed sinks. This is the durable-runtime version of 4b; do after 4b proves the routing at the worker chokepoint.

---

## Phase 5 — Cross-vendor verify + DeepSeek

**Objective:** decorrelated verification on high-stakes outputs; DeepSeek as a cheap T2 (public/consented only).
Depends on 0b/0c (vendor-axis consent).

### 5a. DeepSeek vendor (Effort: S) — `sux`
1. `[sux]` `registry.ts` `RtEnv` — `DEEPSEEK_API_KEY`; `ai.ts` — DeepSeek (OpenAI-compatible) as a router backend, **gated by the consent vendor axis** (China jurisdiction → never personal data; allowed for public/code).
2. **Acceptance:** a personal-class call can never route to DeepSeek even with a generic consent; a public/code call can.

### 5b. Runtime `verify:true` (Effort: M) — `sux`
1. `[sux]` opt-in `verify` mode on high-stakes fns (`oracle` answer, `recall`, `advise`, `_answer`) — run the same prompt through a decorrelated vendor, compare **by claim** (contradiction on facts/numbers/citations), attach a caveat + flag on disagreement; **never auto-pick a winner**. Cache both verdicts.
2. Durable path: express as op-engine `race([...], need)` + `reconcile`.
3. **Acceptance:** an injected factual contradiction is caught and surfaced; agreement returns cleanly; second-vendor outage degrades to the single answer.

### 5c. CI adversarial review (Effort: M) — `SuxOS/.github`
1. `[.github]` add a second-vendor **refute** stage to `security-review.yml` (structured verdict via the existing `--json-schema`); confirmed-by-both = high, single = triage, conflict = human. Org-level opt-in (private code egress is a deliberate org decision). Optionally a second-vendor **resilience tier** when the Anthropic pool is exhausted (degrade instead of `hold`-jam).

---

## Phase 6 — Old/new-school reclassification (sux-only, no infra)

**Objective:** move LLM-where-classical-suffices down the ladder; build the one place regex genuinely can't.

### 6a. `classify` embedding cascade (Effort: S) — `sux` — do first, independent
1. `[sux]` `classify.ts` — add an embedding-kNN gate: embed the label set + input, cosine; only call the LLM on a low-margin/ambiguous result (mirror `_mail_triage`'s three-tier design). Cheaper, more consistent for fixed label sets.
2. **Acceptance:** fixed-label classification returns without an LLM call on confident cases; ambiguous still escalates.

### 6b. Mail-triage binary → embedding classifier (Effort: S) — `sux`
1. `[sux]` `_mail_triage.ts:302` — replace the 8-token LLM spam verdict with an embedding/logistic classifier over filing history (already has the kNN vote adjacent). Removes even the ambiguous-residue LLM call.

### 6c. Person-NER (new-school where regex can't) (Effort: M) — `sux`
1. `[sux]` build the deferred `#1204` LLM person-extractor that `entities.ts` explicitly defers to (regex genuinely can't do names). This is the *correct* new-school escalation — pairs with the reclassification-down work as its inverse.

---

## Effort roll-up & sequencing

| Phase | Effort | Repo(s) | Deps | Value |
|---|---|---|---|---|
| 1a Attic | M | nix | — | minutes ↓ on every runner |
| 1b Cloud runners | M | nix, .github | 1a | minutes ↓, fork-risk removed |
| 1c OpenWrt cache | S | suxrouter | 1b | minutes ↓ |
| 6a classify cascade | S | sux | — | token/cost ↓ |
| 0a connectivity | M | metal, sux | — | unblocks box work |
| 0b/0c consent+audit | M–L | sux | — | privacy invariant |
| 0.5 glue spine | L | suxlib, sux, .github | 0a | coherence — 2–5 register into it |
| 2 on-prem OCR | M | metal, sux | 0a, 0.5 | closes PHI leak |
| 3a reranker | M | metal, sux | 0a | retrieval quality |
| 4 T0 model tier | M | metal, sux | 0a | private synthesis |
| 5 verify + DeepSeek | S–M | sux, .github | 0b/0c | correctness, cost |
| 3b embed migration | L | metal, sux | 3a | (optional) |
| 4c caps.models | L | suxlib | 4b | durable generalization |
| 6b/6c reclassify/NER | S–M | sux | — | ladder discipline |

**Start:** 1a + 6a + 0a in parallel (no cross-deps, three different surfaces). Then 2, then 3a, then 4.

## Open items to resolve before starting each box phase
- **§11 decisions** from the strategy doc (GPU-inference reversal, connectivity A/B, RAM, DeepSeek, consent granularity, cloud build host + Attic location).
- Each metal module lands only after CI builds the closure green (pull-GitOps).
- Whether to file these as tracking issues (per-work-item) or keep as this plan — I did **not** file issues (the batch dispatcher would auto-claim them); say the word to break Phase 1/0a/6a into issues.

## North-star capabilities (next arc — not this one)

The *payoff* features the substrate unlocks are deliberately a **separate arc** (build on the
spine, don't fold in). Seeded for continuation in
`2026-07-23-next-arc-capabilities-brainstorm-seed.md`: persistent store/graph on the box
(retire KV-cosine; a graph substrate for the knowledge graph / person-NER), multimodal recall
(Immich CLIP + Whisper into the same recall/graph), a personal on-prem fine-tune/LoRA (the
tight-integration north star), an always-on event agent (Home Assistant as source *and* sink),
and adjacent self-hosted replacements (Paperless/Nextcloud/SearXNG + a control-plane in suxdash).
