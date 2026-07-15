---
title: Execution chunks — one file per session/branch
status: index
updated: 2026-07-12
---

# Chunks — self-contained work packets

Each file here is **one session's worth of work on one branch**, sized to load
into a fresh context alongside `CLAUDE.md` + Claude memory with room to spare.
The master narrative lives in [`../execution-plan.md`](../execution-plan.md); a
chunk file repeats only what its session needs, so you don't load the whole plan.

**How to run one:** start a fresh session, `git checkout` (or create) the chunk's
branch, read that one chunk file, execute, land green + PR per `CLAUDE.md`.

## Order & dependencies
`main` @ `650828c` (#44 merged + **deployed green**, verified). Serial by default,
but 01 and 06 are independent and can run in parallel with the rest.

| # | Chunk | Branch | Depends on | Status |
|---|-------|--------|-----------|--------|
| 00 | [Fan-out time budget](00-fanout-time-budget.md) | `fix/fanout-time-budget` | — | in progress (3/4 sites; `operateFull` left) |
| 01 | [Front door](01-front-door.md) | `feat/front-door` | — | ready — genuinely unmerged (3 commits) |
| 02 | [Smart-guards generalized](02-smart-guards.md) | `feat/smart-guards` | 01 | design-first (generalize existing `stage.ts`) |
| 03 | [Learning substrate](03-learning-substrate.md) | `feat/learning-substrate` | 02 | design-first |
| 04 | [mail_triage bot](04-mail-triage.md) | `feat/mail-triage` | 03 | design-first |
| 05 | [Self-improvement loop](05-self-improve.md) | `feat/self-improve` | 04 | design-first, PR-only |
| 06 | [Render: cf-first ladder](06-render-cf-ladder.md) | `feat/render-cf-ladder` | — (parallel) | ready — mostly on main; finish + harden |
| 07 | [Branch cleanup](07-branch-cleanup.md) | — | — | housekeeping, do anytime |

## What changed from the first cut (2026-07-12 reconciliation)
A `git cherry` + symbol-on-main audit corrected two stale assumptions:
- **`chore/ultra-sweep` (17 "ahead") is 100% superseded** — every commit's content
  is already on main via a different patch. The two "salvage-sweep" chunks were
  **deleted** (they'd have re-landed shipped code).
- **`feat/amazon-cf-fallback` is fully merged** and main is already partly cf-first,
  so the render chunk is *finish + invert + harden*, not "salvage a branch."
- **The guard substrate already exists** (`stage.ts` `staged()`/`enforceGates`), so
  smart-guards is *generalize + default-on*, not greenfield.

The full branch ledger + the content-vs-containment method live in
[`../execution-plan.md`](../execution-plan.md) §"Branch ledger" and chunk 07.
