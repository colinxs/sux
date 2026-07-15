---
title: Chunk 04 — mail_triage bot (execution-plan chunk 5)
branch: feat/mail-triage
status: design-first
depends_on: [03]   # learning-substrate (classify) — transitively also smart-guards via 03→02
---

# Goal
A cron bot: pull new mail (last-seen idempotent) → smart-router classify
(embeddings + kNN over the learned categories from the learning-substrate chunk) →
act with **autonomy ON, reversible-only** (label / move / junk-teach, **never
delete**), **confidence-gated** (uncertain → suggest, don't act), fully **logged +
bulk-undo**, first cycle reviewable, cost-bounded. Digest → the daily note.

# Context (self-contained)
First real autonomous loop. Rides the learning-substrate (classify) and the
smart-guards chunk (reversible-only auto path + the existing `staged()` gate).
The mail *verbs* it uses (mail_move, junk-teach, labels) already exist on `main`
(`sux/src/mail-mcp.ts`, `_jmap.ts`) — this chunk orchestrates them, doesn't build them.
Notification channel = append a `sux` section to the vault `Daily/<date>.md`
(did / suggests / questions / undo handles).

# Design first
- **Idempotent pull:** store last-seen; never reprocess. Cron cadence + cost cap.
- **Classify:** embeddings+kNN over learned categories; return label + confidence.
- **Act, gated:** high-confidence + reversible → act (label/move/junk-teach);
  low-confidence → suggest in the digest, no action.
- **Log + bulk-undo:** every action carries an undo handle; a single bulk-undo
  reverts a cycle. First cycle ships suggest-only (surface, don't act).
- **Digest:** append to `Daily/<date>.md` — did / suggests / questions / undo.
- **Surface field:** the new `mail_triage` fn must set the registry `surface` field
  (contract established by the front-door chunk).

# Scope
- A cron trigger (`sux/wrangler.jsonc` cron), a `mail_triage` fn, reuse the
  learning-substrate classify + the smart-guards reversible-auto path, vault
  daily-note writer.

# Acceptance
- `npm test && npm run type-check` green; docs + index in sync; dry-run ok.
- Behavior (dry/first-cycle): classifies new mail, writes a digest with undo
  handles, takes NO irreversible action, respects the confidence gate + cost cap.
- Bulk-undo reverts a cycle cleanly.

# Then
Deploy live (this is the point). **PR** it (autonomous + outward-adjacent).

# Gotchas
- NEVER delete — label/move/junk-teach only. Delete stays human.
- First cycle reviewable: ship suggest-only, flip to acting after Colin sees one.
- Cost-bounded cron or it runs away.
