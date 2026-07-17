# sux#228 — remaining six workstreams (W3/W4/W5/W6/W7/W8)

Status: approved · 2026-07-17

## 1. Context

sux#228 ("sux → personal agent: perceive → decide → propose → gated-act → learn") tracks
generalizing sux's existing fail-closed autonomy substrate (`staged()`/commit gate,
conscience-lint, dormant→suggest→armed ladder, `autonomy_status`) into one proposal kernel
plus proactive senses. Phase 0 (the kernel) is done:

- **W1 — proposal kernel** (merged #230): `propose()` + queue + `proposals` fn
  (list/approve/reject/snooze).
- **W2 — agenda loop** (merged #232): `_agenda.ts` cron sense→rank→propose.

This spec covers the six remaining workstreams. Every one of them is a **new sense feeding
the existing queue, or a consumer of its approvals** — none of them touch the kernel.

## 2. Research findings folded in

- **MyChart is further along than the epic body implies.** A single-org FHIR pull already
  shipped (PR #342, merged 2026-07-14) — `sux/src/fns/mychart.ts` + tests, plus a PHI-store
  security fence (#613). A **multi-org + durable-pull redesign is fully specced and merged as
  docs** (PR #654, `docs/superpowers/specs/2026-07-16-mychart-multiorg-durable-pull-design.md`)
  with an exact build order (Part A: multi-org registry/routes; Part B: durable pull via the
  op-engine `caps.health` effect) — just not implemented yet. W6 is "finish the existing plan,"
  not "design from scratch."
- **`_agenda.ts` does not yet consume real MyChart data** — today it only keyword-sniffs email
  subject lines for phrases like "mychart"/"new results" (`MEDICAL_MSG_CUE` regex). Wiring
  actual FHIR results into the agenda is part of W6's remaining scope.
- **The mac-render backend this epic's W6 originally assumed (`render:mac` auth ladder) was
  deleted this cycle** (sux#742, part of the v2.1 release surgery). Not relevant now that
  MyChart auths via FHIR/OAuth directly, not browser automation — flagging so no future
  session re-proposes browser-based MyChart auth.
- **The next-arc §4 mechanical rule** (`docs/design/2026-07-16-suxos-vx-next-arc.md`) currently
  reads: drain green + opus-tier headroom 88% idle (798/900) → **"scale the unit of autonomous
  work,"** naming sux#228 as the test case. This spec is that arc materializing, ahead of the
  formal 7-day gate reading (the gate governs the *next* capability arc pick, not ad-hoc epic
  work already in flight).

## 3. Workstreams

### W4 — spam classifier [S]
Add a spam category to the existing rule-based `classifyMessage`. Workers-AI
`llama-3.2-3b-instruct` fires only on ambiguous cases (cost control — matches the existing
`summarize.ts` best-effort-tier pattern). Output is a classification label; actual triage
action stays inside `mail_triage`'s existing reversible-only contract. No new gate.

### W3 — email backlog cleanup [S–M]
Extend `mail_triage` to sweep the existing backlog using the W4 signal. Reversible-only
(archive/label, never delete) — already `mail_triage`'s standing contract. No new gate.

### W5 — notes/knowledge into agenda [S]
Wire `consolidate` + `weekly_recall` findings into `_agenda.ts` as proposals (e.g. "3 orphan
notes on X" surfaces as a proposal, not an auto-action). Read-only sense. No new gate.

### W7 — Monarch financial signals [S–M]
Bill-due / unusual-charge / low-balance detectors. **Read-only — sux never moves money**
(unconditional). Surfaces as proposals only. No new gate beyond the existing read-only
credential scope.

### W6 — MyChart: finish the existing spec [M–L]
Execute the already-merged build order from PR #654, unchanged:
- **Part A** — multi-org registry + per-org KV keys + routes + `org` param + Bearer-gated
  connect flow + cron loop. Single-org behavior preserved as the default. Ships as its own PR.
- **Part B** — durable pull: `caps.health` effect on the op-engine, `phi/` sink target,
  `mychart-pull` op dispatched to `OP_WORKFLOW`, new `PullResult` shape with a first-class
  `errors`/`status` map (closes the silent-partial-completeness gap). Ships as its own PR.
- **New scope beyond #654**: wire real FHIR pull results into `_agenda.ts` as proposals
  (replacing/augmenting the current email-keyword-only sense).

Gate: the OAuth `connect` flow is already user-initiated per-org (you click login) — that
*is* the human gate. No new gate needed.

### W8 — approval→learning loop [M]
Approvals/rejections tune proposal ranking + `preferences`. Hard constraint carried over
unchanged from the epic: **`autonomy_status` only ever suggests arming a loop, never
self-arms.** Sequenced last — it needs approval/rejection history from the other five
workstreams to have anything to learn from; this is a data dependency, not a design gate.

## 4. Build order / dispatch

W4, W3, W5, W7, W6 have no interdependency — dispatch in parallel via the pipeline
(collate-build loop). W8 is sequenced last (data dependency on the others, not a blocker).
Each workstream ships as its own PR per repo convention (small, independently
mergeable/revertable — matches how the kernel itself was built).

## 5. Explicitly out of scope

- The proposal kernel itself (W1/W2) — done, not touched.
- Any change to sux's hard financial rule (read-only, never moves money) — W7 does not
  relax this.
- Browser-automation MyChart auth — superseded by the existing FHIR/OAuth path; do not
  revisit given mac-render's removal.
