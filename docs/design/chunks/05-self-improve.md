---
title: Chunk 05 — self-improvement loop (execution-plan chunk 6)
branch: feat/self-improve
status: design-first, PR-only
depends_on: [04]   # mail-triage establishes the idempotent/logged/bulk-undo cron pattern this reuses
---

# Goal
A recurring design-review cron that consumes `issue`/`suggest` feedback → builds
findings green → **auto-merge+deploy** fixes/refactors/cleanup, **PR** features (if
high-value), **always-PR** anything security. Kill-switch + rate cap. Because it
self-deploys, the loop itself ships **PR-only** for Colin to approve.

# Context (self-contained)
The capstone loop. Rides everything below it: the learning-substrate store (feedback
+ learned prefs), the smart-guards chunk (what's auto-mergeable vs PR-only, driven
off registry annotations), the mail-triage chunk's cron pattern (idempotent,
cost-bounded, logged, bulk-undo).

# Design first
- **Feedback intake:** `issue`/`suggest` verbs write to the learning store; the loop
  reads new ones (last-seen idempotent).
- **Build findings:** spawn the fix, run the gates, open the change.
- **Merge policy (drive off annotations):** fix/refactor/cleanup → auto-merge+deploy;
  feature (high-value) → PR; security → PR always. Encode the classifier, don't hand-gate.
- **Safety:** kill-switch (a flag that halts the loop), rate cap (N changes/day),
  everything logged + revertable. First runs review-only.

# Scope
- A cron trigger, the loop fn, reuse the learning store + the smart-guards
  merge-policy classifier. Touches CI/deploy — tread carefully.

# Acceptance
- `npm test && npm run type-check` green; docs + index in sync; dry-run ok.
- Behavior (dry): reads feedback, produces a change with gates green, routes it to
  the right lane (auto vs PR) by annotation, respects kill-switch + rate cap.

# Then
**PR-only** — never auto-merge the thing that auto-merges. Colin approves the loop.

# Gotchas
- The loop must not be able to disable its own kill-switch or raise its own rate cap.
- Security-lane changes are ALWAYS PR, no exceptions, even if the classifier is unsure.
- Keep `main` green: a red auto-merge is the one unrecoverable failure — gate on CI hard.
