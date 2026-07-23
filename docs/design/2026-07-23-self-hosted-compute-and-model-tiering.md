# SuxOS Fabric — Self-Hosted Compute, Model Tiering & the Sink/Source Glue

Status: draft / research + scoping · Date: 2026-07-23
Scope: fabric-wide — `sux` (MCP worker) · `suxlib` (op-engine) · `metal` (elk-newt) · `nix` · `SuxOS/.github` (CI)
Companion to: `docs/design/2026-07-23-cross-vendor-token-optimization-spec.md` (the egress gate this supersedes/absorbs)

## 0. Thesis

We have a bare-metal box (elk-newt) and a stateless edge (Cloudflare Workers). The
strategic move is not "self-host a frontier model" — the hardware can't (no GPU for
70B+). It's to treat **every model, algorithm, and vendor as a pluggable sink/source**,
and make sux the **glue** that routes each unit of work to the cheapest tier that clears
its quality bar — deterministic → embeddings → small self-hosted model → frontier API —
while keeping personal/PHI data on hardware we own whenever a tier there suffices.

Three concrete levers, in ascending ambition:
1. **Self-hosted CI runners** — recover GitHub action-minutes on the Nix closure builds (lowest risk, highest certainty).
2. **On-prem AI substrate** — OCR, embeddings, reranking, and async LLM batch on elk-newt = PHI never leaves our hardware, retrieval quality up, per-call fees gone.
3. **Tiered model routing** — the op-engine fans work across Workers-AI (first-party edge), elk-newt (on-prem), and Claude/OpenAI/DeepSeek (frontier API) as governed sinks.

This is the substrate for the larger vision: self-hosted, tightly-integrated replacements
for Google/Dropbox/Office/chatbot/Home-Assistant, where the *glue* — one op graph over one
content-addressed store with one consent model — is what enables features no siloed product can.

## 1. Organizing idea: everything is a sink/source; sux is the glue

This isn't new architecture — **suxlib's op-engine already is this gateway.** Today
`caps.llm` is one effect with two methods. The extension:

- `caps.models` = a **registry of tiered model sinks**, each a governed effect. Every sink
  already gets a `circuitBreaker` / `tokenBucket` / `concurrency` / `retries` / `memo`
  governor via `caps.governors["sink:<target>"]` (suxlib). Adding vendors = adding registry
  entries, not a subsystem.
- The combinators already express the patterns:
  - **`race([claude, openai, deepseek], need: 2)`** → cross-vendor quorum / adversarial verify. It already originates an abort to kill losing branches once the outcome is decided.
  - **`reconcile(Handle[]) → Handle`** → merge fanned outputs.
  - **`sink.fanout([workers-ai-cache, elk-newt-qdrant, vectorize])`** → one embedding to many stores.
  - **`map` / `pipe`** → fan an algorithm over items / compose tier-per-stage pipelines.
  - **`ask`** → the human consent/approval gate, durable pause-resume (already used for 24h approval gates in `assimilate-pdfs`, `mail-triage-plan`).
- `LiteLLM` (self-hostable, OpenAI-compatible, 100+ models, fallback/circuit-breaker/budget)
  is the off-the-shelf shape of this. We don't adopt it wholesale — **the op-engine is our
  gateway** — but a LiteLLM (or bare Ollama) endpoint on elk-newt is a fine *local serving
  backend* that appears to the op-engine as one more sink.

**Consequence:** governance, cancellation, checkpointing, tracing, and OTel span attribution
(all built into `runInline`/`runDurable`) come free for every vendor the moment it's a sink.

## 2. Hardware reality & the feasibility envelope

elk-newt = Intel NUC11 **i5-1145G7 (4C/8T Tiger Lake)**, **Iris Xe 80EU iGPU (no CUDA)**,
≤64GB DDR4 (fitted TBC, ≥32GB target), NVMe+SATA ZFS, 2.5GbE, KVM/libvirt, TB4. Single box.

**Honest reversal to flag:** the metal plan explicitly says *"don't chase GPU inference"*
(v2 addendum) — but that was scoped to Immich CLIP/face ML being CPU-bound. **Quantized
small-LLM serving is a different workload** and the 2026 evidence says it's viable:

| Workload | Feasible on elk-newt? | Evidence |
|---|---|---|
| 7–8B LLM Q4, **async/batch** | ✅ Yes | llama.cpp Vulkan / IPEX-LLM (Intel SYCL) → double-digit tok/s on Iris Xe; CPU-only 6–12× slower |
| 7–8B LLM Q4, **interactive** | ⚠️ Marginal | ~10–20 tok/s (Phi-4-mini class); OK for short, not for long synthesis |
| **Embeddings** (BGE-M3 / Qwen3-Emb-0.6B) | ✅ Strong | CPU-friendly; BGE-M3 (568M, MIT, dense+sparse+multivector, 8k ctx) is the private-RAG default |
| **Reranker** (ms-marco-MiniLM / BGE-reranker-v2-m3) | ✅ Strong | CPU prototyping fine; sux has **no reranker today** — pure upside |
| **OCR** (PaddleOCR CPU / Surya-VLM iGPU) | ✅ Strong | Self-host now matches/beats Google DocAI & AWS Textract; PaddleOCR-VL-1.5 94.5% OmniDocBench |
| **Whisper** (voice fn) | ✅ Yes | CPU/iGPU workable for async |
| **70B+ / DeepSeek-V3 671B** | ❌ No | Needs 8×H100 (~$12–22k/mo). Only 7B distills fit. |

**Design consequence:** the on-prem tier is for **embeddings, reranking, OCR, and
async/batch LLM** — not real-time frontier synthesis. Interactive high-stakes synthesis
stays on the edge (Workers-AI) or a frontier API. This is a capability tier, not a frontier
replacement, and the box is a **single point of failure behind home internet** — every
on-prem path must degrade gracefully to Workers-AI / API when the box is down.

## 3. The tier lattice — levels × stages × algorithms

Three orthogonal axes, all expressible in the op-tree:

**Levels (where compute physically lives):**
| Tier | Processor | Trust | Latency | Use |
|---|---|---|---|---|
| T0 | elk-newt self-hosted | highest (our HW) | slow/med | PHI, async, batch, embeddings, OCR, rerank |
| T1 | Workers-AI (`llama-3.2-3b`, bge) | **first-party** (our CF account) | edge-fast | default interactive, always-on |
| T2 | Claude / OpenAI / DeepSeek API | contractual | fast | hard synthesis, verify |
| T3 | free/consumer (OpenRouter free) | none | varies | public/code only |

**Stages (of a pipeline):** retrieve → rank → synthesize → verify. Assign a tier *per stage* —
retrieve with embeddings (T0/T1), rerank on T0, synthesize tiered-by-difficulty, verify with a
decorrelated vendor via `race` (T2). This is the RouteLLM cascade (~95% GPT-4 quality at 14%
strong-model calls) generalized to physical tiers.

**Algorithms (old→new school escalation ladder):**
`regex/parser/rules → embeddings+kNN → reranker → small LLM (T0/T1) → frontier LLM (T2)`.
Use the cheapest rung that clears the quality bar; escalate on low confidence. sux **already
has this shape** in `_mail_triage` (rules → LLM-on-ambiguous → embedding-kNN vote) and its
`scrape → render → unlocker` fetch ladder — generalize it.

## 4. Access & consent model (revised — 6-axis granularity)

Supersedes the companion spec's coarse `personal + consent`. A **trust lattice**: processors
have tiers (T0→T3 above), data has sensitivity classes, and consent raises the ceiling
per-scope along **six axes**:

1. **Data domain** — `secret` · `health/PHI` · `legal-privileged` · `financial` · `personal-general` · `internal` · `public` (finer than one "personal").
2. **Vendor + jurisdiction** — e.g. allow OpenAI/Claude but **not DeepSeek** for personal data (China data residency); allow DeepSeek for public/code where it's cheapest. This axis is *why* granularity matters.
3. **Purpose** — verify / synthesize / OCR / offload / index.
4. **Duration** — once / session / N-hours / standing; TTL'd, revocable.
5. **Direction** — send-content-out vs model-writes-back-to-vault (a *separate* confirm; mirrors the existing `mychart-reconcile` "LLM drafts → vault note only, never auto-send" rule).
6. **Default-deny + provenance** — class inherits as the **max over `pipe`/`batch` sources**; unclassified denies.

**Default ceilings (no consent needed):**
- `secret` → T0 only, and **never to any LLM** (redact first).
- `health/PHI`, `legal-privileged` → **T0 default**; T1 (Workers-AI, first-party) allowed; T2/T3 require explicit per-scope consent.
- `financial`, `personal-general` → T0/T1 default; T2 with consent.
- `internal` → T0/T1/T2. `public` → any tier.

**The on-prem tier is what makes this livable:** once elk-newt runs OCR + embeddings + a
small LLM, **most personal/PHI work routes to T0 and never touches the consent path at all.**
Consent becomes the exception (frontier synthesis, cross-vendor verify), not the rule — the
opposite of the companion spec, where every personal LLM call needed a gate.

Storage/enforcement: extend `preferences` with a `vendor_consent` scope (KV, per-`login`,
TTL'd); interactive grant via an `ask`-gate; every T2/T3 egress emits a **content-free** Loki
audit line (vendor, class, grant-id, bytes, redacted) so "zero unconsented egress" is provable.
Retro-fix the two existing un-audited egress points first (see §6).

## 5. Event / loop / batch — org-wide paradigms → where compute lives

A recurring trio across the whole fabric; each maps to a tier:

- **Event (edge, T1, fast):** GitHub PR webhooks (live), mail/JMAP arrival, calendar, Home-Assistant events, suxrouter presence/WAN events → trigger op-graphs on the Worker.
- **Loop (cron/self-heal, T0 or T1):** `/loop`, sux `CRON_JOBS` (`cron-heartbeat.ts:21`), metal `autoUpgrade` GitOps, `suxwatch` → reconciliation loops.
- **Batch (on-prem, T0, heavy async):** the `batch` fn, durable Workflows, mail backfills, `vectorize_backfill`, consolidations → **offload to elk-newt** where latency is irrelevant.

Principle: **events stay on the always-on edge; batch/loops with real compute move to the box.**
The sux durable Workflows (`assimilate-pdfs`, `mychart-pull`, the `*-consolidate-plan`s,
`vectorize_backfill`, `briefing`, `life_wiki`, `infer_nudge`) are all latency-insensitive and
mostly PERSONAL/PHI — a near-perfect T0 offload set.

## 6. Sux-wide container/VPC leverage (beyond tokens — the offload menu)

Grounded in the actual inventory. Each is a container/VM on elk-newt (quadlet-nix or libvirt,
per metal's decided strategy), appearing to sux as a sink/source.

**6.1 Self-hosted CI runners (lowest risk, ship first).**
Everything is `ubuntu-latest` today; zero self-hosted. Best wins:
- **Nix closure builds** — metal `ci.yml` builds the *full elk-newt system closure* on every
  PR (fights the 10GB Actions-cache limit + disk-freeing hacks); nix builds `flake check` +
  `ci-image`. A self-hosted runner with a **persistent `/nix/store`** rebuilds only changed
  derivations — and **elk-newt is literally the machine metal's CI builds for** (native
  self-build). The `suxos` Cachix cache and `ghcr.io/suxos/ci-base` image already exist as the
  sharing layer.
- **Critical nuance:** self-hosting recovers only the **runner-minute** half of cost. The
  Anthropic-subscription half (issue-build/security-review/fixer agents) is **unaffected** —
  and it's what `budget-governor.yml` actually tracks (as a runner-minute *proxy*; moving jobs
  off hosted runners would decouple that proxy from GitHub billing). So target the **non-Claude
  Nix/npm builders** first, not the agent jobs.
- **Security (hard requirement):** `pull_request` CI builders execute untrusted fork code. Run
  runners **ephemeral** (GitHub's March-2026 recommendation, `--ephemeral`, fresh libvirt VM
  per job, auto-destroy), **private-repos-only**, in **runner groups**, with an `isTrusted`
  author gate (the org already hardened the "#193 decoy-PR" class). Never a persistent runner
  on the NUC for public PRs.

**6.1a Build/compute plane (cloud) vs data plane (home) — cache-first.**
The biggest minute-saving lever is **not runner location — it's a warm binary cache.** A
self-hosted **Attic** makes *every* runner (GitHub-hosted, cloud, or metal) pull pre-built
derivations instead of rebuilding, cutting minutes on the Nix/OpenWrt jobs without moving
anything. Do the cache first; the runner second. Then split the planes:
- **Cloud VPC ephemeral runners for the heavy non-Claude builds** — Nix closures, OpenWrt
  ImageBuilder (`suxrouter/image/build-asu.sh`), npm+wrangler. Cheap, reliable, burstable,
  persistent `/nix/store` + local Attic, ephemeral machine per job (secure for fork PRs).
- **Keep elk-newt for the private *data* plane** (OCR/embeddings/PHI/AI), **not** CI of
  untrusted code — this **removes the fork-PR-on-the-SACRED-home-network risk from §6.1
  entirely**. Home box = private data; cloud VPC = build/compute.
- **OpenWrt is not Nix** — its ImageBuilder is a container, wanting a persistent Docker-layer +
  downloaded-package cache, not Attic. Same principle, different cache.
- Cost caveat unchanged: moving *Claude-agent* jobs to any self-hosted runner saves
  runner-minutes but **not** the Anthropic subscription — prioritize the pure-build jobs.

**6.1b Compression — compress once, at the smartest layer (no double-compression).**
Attic/Cachix already zstd-compress NAR content; ZFS `compression=zstd` on the same dataset then
tries to recompress already-compressed blobs. ZFS's zstd **early-abort** (tries LZ4, then
zstd-1; if a block won't shrink ≥12.5% it stores it raw) means that second pass yields
**near-zero extra space** for a small wasted-CPU cost — not double *savings*, just redundant
work. Rule:
- **Attic/Cachix blob dataset → `compression=off` (or `lz4`).** Attic already does content-
  defined chunking + global cross-NAR dedup then zstd per chunk — that dedup is the real win and
  beats stacking ZFS-zstd on top.
- **Build box `/nix/store` → `compression=zstd` ON.** The live store is uncompressed, cross-file-
  redundant data — a genuine ZFS-zstd win (metal `disko.nix` already zstd's `rpool`; carve the
  cache blobs onto their own `off`/`lz4` dataset).
- Cross-cutting with §5's token-packing and sux's existing KV `GZIP_MARKER` compression: one
  deliberate compression layer per boundary, never stacked.

**6.2 Model gateway (Ollama / LiteLLM) as `caps.models` sinks.**
Serve Qwen3-8B / Gemma3-4B / a DeepSeek-R1-7B-distill via Ollama (IPEX-LLM patched for Iris Xe).
Wire as a new `llm()` tier behind a flag. **Start with the async/PERSONAL sites** where latency
is irrelevant and privacy is the point: `_briefing`, `_infer_nudge`, `_assimilate`,
`_mychart_reconcile` draft, `oracle` distill/redistill (background). Leave interactive
`recall`/`advise` on T1/T2 until measured.

**6.3 Self-hosted OCR — replace Mistral (retro-fix an existing leak).**
`_ocr.ts` ships bytes to **Mistral (third-party)** and has **no private PDF path** — `_assimilate`
already *refuses* it for `phi`-tagged material because OCR requires minting a **public `/s/<uuid>`
handle**. A PaddleOCR/Surya container on elk-newt gives a **private, on-prem OCR path for PHI**
(passport/license/insurance via `_document_radar`, health scans via `_scan_ingest`/`study`),
closing the leak and unblocking PHI assimilation. High-value, clearly-scoped.

**6.4 Embeddings + reranker + vector DB.**
sux uses Workers-AI `bge-base` (768-dim) + Vectorize `sux-corpus` + KV-cosine fallback, and
**has no reranker**. On elk-newt: BGE-M3 (dense+sparse hybrid) embeddings + a reranker
(two-stage retrieval) + optionally Qdrant. Wins: **retrieval quality** (rerank is pure upside
for `recall`/oracle `_answer`) and **PHI embeddings computed on-prem**. Caveat: interactive
query embeds add a box round-trip vs the edge — keep query-path on T1, move **index-build/
`vectorize_backfill`** (background, batched, PERSONAL) to T0.

**6.5 Browser render — a natural fit (infra already half-there).**
`render`/portal-scrape use Cloudflare Browser Run + paid unlocker/CapSolver fallback, and sux
**already routes egress through a self-hosted Tailscale residential proxy** (`proxy.ts`). A
Playwright/Chromium container on elk-newt (already the pre-installed browser story) on that same
tailnet could serve the render tier and cut paid-unlocker calls — and the tailnet is also the
cleanest answer to §7's connectivity gap.

**6.6 Durable/batch offload + the homelab integrations.**
Move heavy async (consolidations, backfills, timeline builds) to T0; the Worker orchestrates and
holds the durable state. And the homelab services the metal plan already lists (Immich,
Home-Assistant, Syncthing, + Paperless/Nextcloud-class) become the **self-hosted replacements**
the integration layer wraps — each a source/sink in the same op graph, under the same consent model.

## 7. Connectivity — the unbuilt prerequisite

**There is no Worker→box path today.** The Workers are Cloudflare-native; elk-newt is
**egress-only** via cloudflared tunnel. For sux (edge) to call an elk-newt model/OCR/rerank
service, one of:

- **A. Tailscale on elk-newt (recommended).** sux already uses a Tailscale proxy node
  (`proxy.ts`) and the router runs Tailscale — put the box on the same tailnet and the Worker
  reaches it as a tailnet origin. Lowest new surface, reuses proven infra, no public exposure.
- **B. cloudflared tunnel ingress + Access service-token.** Add the box's service as a tunnel
  hostname; Worker `fetch()`s it with a service-token. Matches the box's planned ingress shape
  but exposes an (Access-gated) hostname.
- **C. Cloudflare Workers VPC / Hyperdrive.** Heavier; only if a persistent DB (Qdrant/Postgres)
  on the box needs pooled Worker access.

**Non-negotiable:** every T0 call is `race`/fallback-guarded against T1 so a box outage (home
power/internet — and the **SACRED gateway invariant**: nothing on elk-newt may destabilize home
internet) degrades to Workers-AI, never a hard failure.

## 8. Old-school vs new-school AI — the decision framework

When each wins (the crisp version):

**Old-school (deterministic: regex, parsers, rules, math) wins when:**
- Output is structured/verifiable (dates, IDs, Luhn-checked cards, amounts) — `redact.ts`, `entities.ts`, `_document_radar` expiry scan already do this right.
- The class set is fixed and stable, and errors must be auditable/reproducible.
- Latency/cost must be ~zero and it runs everywhere (edge, CI, offline).

**Embeddings (middle-school: kNN, clustering, cosine) win when:**
- Semantic similarity/dedup/routing over a fixed corpus (`_mail_triage` filing-history vote, `_infer_drift` centroid distance) — no generation needed.
- You want a cheap classifier/router *before* spending an LLM call (the cascade gate).

**New-school (LLM) wins when:**
- Open-ended synthesis, ambiguous natural language, or a novel few-shot task (`recall`/`advise`/`briefing` synthesis, person-NER #1204 that regex can't do).
- Messy input → structured output in one pass (VLM-OCR, `study` insight cards).

**Concrete reclassification candidates in sux (audit output):**
- `classify.ts` — pure LLM zero-shot for *any* labels, **no rules/embedding tier** (unlike the exemplary `_mail_triage`). For a fixed label set, an embedding-kNN classifier is cheaper and more consistent → add a cascade gate.
- `_mail_triage.ts:302` — an LLM call to emit one SPAM/NOT_SPAM word (8 tokens); a logistic/embedding classifier handles binary. Mitigated (fires only on the ambiguous residue) but a T0 embedding-classifier removes even that.
- Keep `translate` on m2m100 (correct old/new split — seq2seq, no instruction surface).

**Meta-rule:** default to the lowest rung; let an LLM touch only the ambiguous remainder;
make the escalation explicit and logged. `_mail_triage`'s three-tier design is the reference.

## 9. Risks & guardrails
- **SPOF / SACRED invariant** — single box behind home internet; every T0 path fallback-guarded to T1; nothing on elk-newt may touch DNS/DHCP/routing/firewall of owl-tegu.
- **Model quality ceiling** — small models hallucinate more; keep them to classify/distill/draft tiers, never unverified high-stakes synthesis. `race`-verify PHI-affecting outputs.
- **Self-hosted-runner security** — ephemeral, private-only, `isTrusted`-gated, Harden-Runner egress audit; never run public-fork PRs on the NUC.
- **Jurisdiction** — DeepSeek (China) gated off personal data by the §4 vendor axis.
- **Maintenance burden** — a self-hosted model/OCR/vector stack is real ops; GitOps + rollback (metal already has this) is the mitigation. Don't self-host what an API does cheaply enough unless privacy or volume justifies it (break-even for budget APIs is ~50–100M tokens/mo).
- **Build-vs-buy time** — sequence so each phase delivers standalone value even if later phases stall.

## 10. Phased roadmap (value-early, de-risked)

- **Phase 0 — connectivity + consent foundation.** Tailscale on elk-newt (§7A); the 6-axis consent model + audit + retro-fix the Mistral-OCR and any un-gated egress. Prereq for all T0/T2 work; unblocks nothing user-facing alone but is small.
- **Phase 1 — warm cache + cloud build plane (no AI).** Stand up a self-hosted **Attic** first (cuts minutes on *every* runner), then **cloud VPC ephemeral runners** for the heavy non-Claude builds (Nix closures, OpenWrt ImageBuilder, npm+wrangler), private-repo + `isTrusted`-gated. Keep untrusted-code CI off the home box. Immediate action-minute savings, near-zero risk. (Compression per §6.1b: one layer per boundary.)
- **Phase 2 — on-prem OCR.** PaddleOCR/Surya container; route `_ocr.ts` PHI paths to it; unblock PHI assimilation. Clear scope, closes a real leak.
- **Phase 3 — on-prem embeddings + reranker.** BGE-M3 + reranker for index-build/`vectorize_backfill` (background); add reranking to `recall`/oracle. Retrieval-quality win + PHI on-prem.
- **Phase 4 — the T0 small-model tier.** Ollama (IPEX-LLM) as a `caps.models` sink; route async/PERSONAL `llm()` sites (`_briefing`, `_infer_nudge`, `_assimilate`, oracle distill).
- **Phase 5 — cross-vendor verify + DeepSeek cost tier.** `race`/quorum for PHI-affecting synthesis; add DeepSeek as a cheap T2 (public/consented only). CI adversarial-review stage.
- **Phase 6 — old/new-school reclassification.** `classify.ts` cascade gate; embedding-classifier for the mail-triage binary; sweep for other LLM-where-classical-suffices.

Each phase is independently shippable and gate-passing.

## 11. Open decisions for Colin
1. **Revisit "don't chase GPU inference"?** — the plan declined it for Immich ML; small-LLM/OCR/embeddings on Iris Xe is a different, viable workload. Approve the T0 AI substrate direction?
2. **Connectivity: Tailscale (A) vs tunnel-ingress (B)** for Worker↔box.
2b. **Build plane: cloud VPC vs elk-newt** — recommend cloud (ephemeral, isolated from home net) for CI, home box for private data only. Approve the split, and pick a host (Hetzner/Fly/spot)? And a self-hosted **Attic** location (cheap always-on cloud node)?
3. **RAM commitment** — a T0 model + OCR + embeddings + vector DB + homelab wants ≥32GB, realistically 64GB. Confirm fitted amount / budget.
4. **DeepSeek** — allow as a cheap T2 for public/code work, with the vendor-axis gate keeping it off personal data? Or exclude entirely?
5. **Consent-domain granularity** — the 5 data domains in §4, or finer (per-provider health portals, per-matter legal)?
