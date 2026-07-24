# Next-Arc Brainstorm Seed — Capabilities on the Self-Hosted Substrate

Status: seed / continuation handoff · Date: 2026-07-23
**This is a starting point for a *fresh* session/arc — not a plan.** Per sux's one-session-per-
workstream rule, open a new session on this doc and continue brainstorming from here.

## Where the previous arc left off

The **substrate arc** (`2026-07-23-self-hosted-compute-and-model-tiering.md` +
`-implementation-plan.md` + `-cross-vendor-token-optimization-spec.md`, all on PR #1443)
designed: on-prem compute (elk-newt), model/vendor tiering (T0 on-prem / T1 Workers-AI /
T2 frontier API / T3 free), a 6-axis consent + egress gate, a cloud build plane + Attic cache,
and — critically — **Phase 0.5, the glue spine**: one governed capability/sink taxonomy,
at-rest sensitivity classification, cross-tier content-addressed cache, per-tier observability,
an eval harness, and a graceful-degradation contract.

**That arc builds the machine. This arc builds what the machine makes possible** — the "features
you can only build because of the tight integration layer." They were deliberately deferred so
the substrate lands coherent first.

## Candidate capabilities to brainstorm (each: what · why-only-possible-now · substrate deps · open Qs)

1. **Persistent store + knowledge graph on the box.** Retire the brute-force KV-cosine cores for
   **Qdrant**; add a relational store for structured personal facts (financial/health/timeline
   that KV can't model); stand up a **graph store** to back the vault's knowledge graph — the
   natural home for the deferred person-NER (`entities.ts` → #1204) and cross-domain linking.
   *Deps:* 0.5b at-rest classification, 0.5c cross-tier CAS, box connectivity.
   *Open:* graph engine choice; how it relates to the Obsidian vault-as-graph; migration from
   Vectorize/KV; does the Worker query it live (latency) or only async?

2. **Multimodal recall.** Immich (planned on the box) CLIP image embeddings + **Whisper**
   transcription (the `voice` fn's real home) feed the *same* recall/knowledge graph — recall
   over photos and voice memos, not just text. *Deps:* Phase 3 embeddings, box media services.
   *Open:* unify multimodal vectors in one index vs per-modality; privacy of face recognition.

3. **A personal on-prem model (LoRA / fine-tune) — the north star.** Fine-tune a small model on
   the vault + `preferences` writing-style spec + `voice`, on hardware the data never leaves;
   overnight batch the Worker could never run. The thing no siloed product can do.
   *Deps:* Phase 4 model tier, at-rest classification, eval harness (to know it helps).
   *Open:* iGPU fine-tune feasibility (may need CPU/overnight or a cloud burst on public-only
   data); continual vs periodic retrain; eval to prove lift over the base model.

4. **An always-on event agent.** The Worker is request-driven and crons are coarse; a persistent
   daemon on the box reacts in *real time* to events — mail arrival, calendar, presence, and
   **Home Assistant as both a source and an action sink** (HA events trigger op-graphs;
   op-graphs actuate HA). The event/loop/batch paradigm made concrete. *Deps:* 0.5a taxonomy
   (actions as governed sinks), box connectivity, HA (planned). *Open:* daemon vs op-engine
   durable; how actuation consent works (direction axis of §4); ambient-feature scope.

5. **Adjacent self-hosted replacements (ride the same plane).** Paperless-ngx / Nextcloud
   (Dropbox/Office replacement → feeds `files`/`ingest`, on-prem OCR already there); **SearXNG**
   (private meta-search node for the `search` fan); a **control-plane UI in `suxdash`** (consent
   grants, egress-audit stream, per-tier health + cost — the arc's cockpit).
   *Deps:* build plane, 0.5d observability. *Open:* which replacements earn their keep vs which
   stay third-party; suxdash scope.

## Cross-cutting questions for the next arc
- Which capability is the **wedge** (highest value ÷ effort, given the substrate)? Candidates: the graph store (1) or the always-on agent (4).
- What must the **spine (0.5)** expose that these capabilities need but the substrate arc didn't anticipate? (Feed corrections back into 0.5's interface before it sets.)
- Where does the **eval harness (0.5e)** need extending to score these (multimodal, personalization)?
- The SACRED gateway invariant + SPOF constraints still bind every box-resident capability.

## Continue here
Open a fresh session on this doc. Suggested first move: pick the wedge capability, write it up as
its own scoping doc against the real code (the substrate docs give the integration points), and
feed any interface gaps back into Phase 0.5 before it's implemented.
