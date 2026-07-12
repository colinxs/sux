---
title: Chunk 02 — smart-guards generalized (execution-plan chunk 3)
branch: feat/smart-guards
status: design-first (generalize an EXISTING substrate, not greenfield)
depends_on: [01]
---

# Goal
Make stage-by-default the *uniform* behavior for every irreversible / outward act,
driven off the registry annotations (not a hand-list), with a `!`/force override,
plus an agent-side conscience pass (sentiment-pause + typo/recipient/attachment lint).
Reversible acts auto-run.

# CRITICAL context — the substrate ALREADY EXISTS on `main` (do not reinvent)
- `sux/src/stage.ts` ships `stage()`, `commit()`, and `staged(env, kind, {stage,
  commit_token, force}, payload, preview, mutate)` — a full stage→commit→force
  mechanism with commit-token + payload-hash binding.
- `sux/src/mail-mcp.ts` already routes mail writes through `staged()` (line ~196).
- `sux/src/fns/_jmap.ts` ships `enforceGates(calls, allowSend, allowDestroy)`.
- #44 added the registry `surface`/annotation fields.
**So this chunk is "generalize + default-on," NOT "invent a gate."** Read `stage.ts`
and every current `staged()` caller FIRST.

# The actual work
1. **Default-on, annotation-driven:** today `staged()` is opt-in (`stage:true`).
   Flip it so any fn the registry annotates irreversible/outward is staged BY DEFAULT
   and requires `!`/`force:true` to commit in one shot. Un-annotated → fail closed
   (guarded), never auto.
2. **Audit coverage:** find every irreversible/outward verb (mail send, Mode-B
   writes via `writeFull`/`operateFull`, masked/cal/contact deletes) and confirm
   each routes through `staged()`/`enforceGates`. Wire any that don't.
3. **Conscience lint (agent-side, advisory):** recipient sanity, obvious typos,
   attachment mismatch, sentiment-pause on hot language — a shared helper the
   outward verbs surface in their stage preview. Distinct from the server-side gate.

# Acceptance
- `npm test && npm run type-check` green; docs + index in sync.
- Behavior: an annotated-irreversible verb with no `!` returns a stage preview +
  commit token; with `!`/force it commits; a reversible verb is unaffected.
- **Regression guard:** add a fn annotated irreversible in a test and assert it is
  auto-staged with NO per-verb wiring (proves it's annotation-driven, not hand-listed).

# Then
Security-adjacent → **PR** (not straight merge). `/code-review ultra`.

# Gotchas
- Do NOT build a second staging path parallel to `stage.ts` — extend it.
- Fail closed: unannotated ⇒ guarded.
- Server-side gate (enforcing) ≠ agent-side conscience lint (advisory) — keep separate.
