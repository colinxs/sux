---
title: Chunk 00 — fan-out time budget
branch: fix/fanout-time-budget
status: in-progress (3 of 4 sites done, uncommitted)
depends_on: []
---

# Goal
Every fan-out site stops dispatching new work before the 60s hard deadline and
returns the partials it has, flagged `{truncated:true, reason:"time"}` — instead
of `index.ts`'s `FN_DEADLINE_MS` (60s) killing a long run with **zero** output.

# Context (self-contained)
`withDeadline(name, FN_DEADLINE_MS=60_000, fn.run)` in `sux/src/index.ts` aborts a
fn.run at 60s with no partials. Wide `batch`/`pipe`/`batch_fetch`/`operateFull`
runs can exceed that. Fix = a `Date.now()` check in each fan-out loop that stops
CLAIMING new work at `FANOUT_BUDGET_MS = 50_000` (headroom to reduce/serialize).

# Done already (on this branch, uncommitted, tests green)
- `sux/src/fns/_util.ts` — `FANOUT_BUDGET_MS` const; `pool()` takes optional
  `deadline`, pre-fills a **dense** result array, workers stop claiming past it.
- `batch.ts`, `batch_fetch.ts`, `pipe.ts` — pass a deadline, map un-run slots to
  a skipped result, emit `{truncated:true, reason:"time"}`.
- Tests added in `_util.test.ts`, `pipe.test.ts`.

# Remaining work (the gap)
`sux/src/fns/_dropbox-full.ts` → `operateFull()` apply loop (`for (const p of paths)`
doing move/delete) has **no** time check — the plan's scariest case: it can
silently commit an unknown subset of Mode-B mutations then die at 60s reporting
only a timeout. Add:
1. `const deadline = Date.now() + FANOUT_BUDGET_MS` before the loop.
2. At the top of the loop: `if (Date.now() >= deadline) { truncated = true; break }`.
3. Return already reflects `applied`/`of paths.length`; ensure `truncated:true` +
   a `reason:"time"` is surfaced so the caller sees the set was not fully applied.
4. Add a test (mock `Date.now`, like `pipe.test.ts`) asserting a partial apply
   returns `truncated:true` and the applied count, not a throw.

# Acceptance
- `npm test && npm run type-check` green (run from repo root `/Users/colinxs/Code/sux-mcp`).
- `npm run gen:index && npm run docs` → no diff (nothing new registered, but run it).
- **Strong test for the scary site (not just a mocked clock):** inject a fake clock
  AND a counting move/delete stub into `operateFull`, feed N paths with the budget
  set to expire after k<N ops, assert it returns `applied === k` + `truncated:true`
  and DID NOT call the mutator for the remaining N−k (no silent over-apply, no throw).
  A bare `Date.now`-mock unit test is too weak for a partial-mutation site.

# Then
Commit the whole fix (one commit), PR, `/code-review ultra`, merge+deploy.
This is the interim fix for the "bulk-work > 60s" gap — the full Queues/Workflows
fan-in/out primitive stays deferred until a real caller strains it (see the
learning-substrate chunk).

# Gotchas
- Result array MUST stay dense (`.fill(undefined)`) — a sparse `.map`/`.filter`
  silently skips holes and the skipped items vanish from the report.
- 50s < 60s is deliberate; don't raise it to the wire.
