---
title: Proactive-inference + nudge layer — private online learning over your own life
status: reference — build gated-dormant, PR-only, inference edge-private
source: design 2026-07-12 (Target case + contextual integrity + FTC health-app + GDPR Art.22; builds on learning-substrate-tech / automations-architecture / health-integrations)
---

**Thesis.** Give sux the "Target-knew-I-was-pregnant" *capability* — infer life-events and
evolving preferences from behavior — while inverting all three things that made Target creepy:
the inference is **the user's own** (over their data, not a broker's), surfaced **only to the
user** (never egressed to a third party), and armed **per-domain by consent** (never covert).
No training: the accumulated embedding/signal set **is** the model. Smart, not complex.

## 1. Technique — incremental inference, no training
The substrate already exists (learning-substrate-tech): `bge-m3` embeddings + brute-force cosine
kNN in KV, and `recall`'s server-side fan-out over mail/files/vault. Add a thin **online** layer:
- **Signal log (append-only, per domain).** Each new item (email, file, calendar event, health
  daily-rollup) is embedded once and appended to `kv:infer:<domain>:signals` with `{ts, vec,
  redacted_snippet, source_tag}`. Incremental by construction — no batch retrain, ever.
- **Detectors are arithmetic, not ML** (keep it simple):
  - **Centroid drift** — cosine distance between the recent-window centroid (14d) and the trailing
    baseline centroid (60d); a cluster pulling away = an *emerging topic*. Unsupervised, so we
    never pre-enumerate life-events.
  - **Trend / anomaly on scalars** — rolling mean + EWMA/z-score over health rollups or per-cluster
    counts (e.g. resting-HR up over 2 weeks; "12 emails about X in 14d vs 0 in the prior 60").
- **Rules-then-LLM ladder** (automations-architecture): a candidate must first clear a deterministic
  threshold (count / z / drift) computed **at the edge**. Only survivors escalate to a **single**
  Workers-AI call whose job is *phrasing only* — turn the structured candidate + redacted snippets
  into "I noticed X → suggest Y." The *fact* is computed on-edge; the LLM never decides, never
  diagnoses, never sees raw PII.
- **Inference recipes are DATA, not code** — `{domain, signal-query, detector, threshold,
  suggestion-template, sensitivity-tier}`. A new life-event = add a recipe; unsupervised drift
  catches the rest.

## 2. Nudge surface — the daily-note digest
Inferences ride the existing quiet channel (execution-plan): the `sux` section of **Daily/<date>.md**.
- **suggests** — "I noticed <plain evidence> — want me to <gentle action>?" **questions** — a yes/no
  that would confirm/kill an inference ("Are you planning travel in August?").
- **Explainable by construction** — each nudge carries its **why-trail**: the source-tagged signals
  that fired it (`[mail:…]`, `[cal:…]`, `[health:…]`, like `recall`) + the recipe name.
- **Dismissable + correctable** — inline controls: `dismiss` (one-off), `not-useful` (raises the
  recipe threshold / logs a negative example), `never-for-this` (per-domain suppress-list), `yes`
  (confirms → the recipe can promote). Every correction is itself a signal → the learning loop.
- **High-signal (principle 4)** — ≤1 inference nudge/domain/day, a confidence floor, dedupe by
  inference-id, and a cooldown so a dismissed inference can't re-fire. A nudge must earn the interrupt.

## 3. HARD GUARDRAILS (the core) — every gate fail-closed
Any missing precondition ⇒ no inference, no nudge.
- [ ] **Inference is edge-local.** Embedding, drift/anomaly, kNN all run in the Worker on Workers-AI.
      **Raw personal data NEVER egresses to a frontier LLM.** The only model touch is the final
      phrasing call, which gets **redacted, minimal snippets only**, fenced as untrusted data (the
      `llm()` `<<<DATA>>>` discipline). Health uses on-edge Workers-AI only.
- [ ] **Strictly opt-in per domain.** Each domain (mail-patterns / purchases / calendar / files /
      **health**) is OFF until explicitly armed. Health arms **independently and last**. The arm-flag
      lives in a binding the inference loop has **no write credential to** (mirrors the self-improve
      kill-switch) — sux cannot arm itself.
- [ ] **Explainable + forgettable.** Every nudge shows its evidence trail (right-to-explanation by
      construction). The user can delete any *signal*, any *inference*, or purge a domain's whole
      signal-log; deletion **cascades** — no inference outlives its evidence (GDPR erasure).
- [ ] **Suggest-only, zero egress, zero third-party flow.** The layer writes **only** to the user's
      own daily note. It has **no** capability to email, purchase, share, or create a standing rule
      off an inference. The inference stays in the context it was derived from and flows to no one
      but the user (contextual integrity). *This is the exact Target failure mode, structurally
      removed.*
- [ ] **Health = signals, NEVER diagnosis (the hard line).** sux may surface an *observation*
      ("resting HR up ~8bpm over 2 weeks; sleep down") and at most suggest **"consider discussing
      this with a clinician."** It must **never** name a condition, infer a diagnosis (no "you may be
      pregnant / diabetic / depressed"), give personalized medical or treatment advice, or triage a
      crisis. A **deny-list of diagnostic/condition language** guards the health phrasing path; the
      health prompt is constrained to *observation + "discuss with a clinician"* (+ a static
      crisis-resource pointer for mental-health-adjacent signals). No health values in URLs/logs
      (health-integrations). sux is wellness-signal, not a medical device.
- [ ] **Suggest-only warm-up.** First N cycles per domain **log what they would say** for human audit
      before a single line reaches the daily note (mirrors mail_triage's first-cycle review).

## 4. First slice — smallest safe, ships gated-dormant
**ONE domain, non-health, reversible, read-only:** *emerging-topic* over vault+mail.
- Cron: embed last-14d signals → centroid-drift vs 60d baseline → if a cluster clears threshold,
  write **one** line under **suggests** ("A lot about <topic> lately — start a note/project for it?")
  with the why-trail + dismiss / never controls.
- No health, no diagnosis, no LLM decisioning (phrasing only), no egress, no auto-action.
- Ships behind `INFER_ARM` **unset ⇒ dormant**; suggest-only warm-up on first cycles.
- Goal: prove the full loop — *signal-log → edge detect → digest nudge → correction tunes the
  recipe* — end-to-end on the lowest-stakes domain **before health is ever wired**.

## Safety preconditions (arming checklist — fold into the build PR)
1. Inference path grep-verified **egress-free**; only the redacted phrasing call touches a model.
2. Per-domain arm-flag in a **write-isolated** binding; default unset ⇒ dormant, fail-closed.
3. Evidence-trail + signal/inference **deletion (cascading)** implemented before any nudge ships.
4. Health domain: deny-list active, prompt constrained to observation + "discuss with a clinician",
   armed **separately and last**, no health values in logs/URLs.
5. Suggest-only warm-up (log-what-it-would-say) precedes any live daily-note write per domain.
6. Rate cap + confidence floor + dedupe/cooldown enforced (high-signal, low-noise).

Refs: Target case — forbes.com/sites/kashmirhill/2012/02/16/how-target-figured-out-a-teen-girl-was-pregnant-before-her-father-did/ ·
contextual integrity — researchgate.net/publication/228198982_Privacy_As_Contextual_Integrity ·
FTC mobile-health apps — ftc.gov/business-guidance/resources/mobile-health-apps-interactive-tool ·
GDPR Art.22 / right-to-explanation — arxiv.org/pdf/1711.00399 (counterfactual explanations & the GDPR) ·
substrate — developers.cloudflare.com/workers-ai/models/bge-m3/
