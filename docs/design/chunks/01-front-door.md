---
title: Chunk 01 — front door (execution-plan chunk 2)
branch: feat/front-door
status: ready (branch exists, 3 commits, 0 behind main, all genuinely unmerged)
depends_on: []   # independent of chunk 00 — touches the registry/verb surface, not the fan-out loop; can land in parallel
---

# Goal
One self-describing connector surface: ~13 front verbs cover shop/search/fetch/
research/media, the ~95 leaf fns are hidden but reachable through an `fn` escape
hatch, and the `sux` root verb self-describes (mobile-safe). Retire the separate
mail/vault/files namespace connectors + plugins (keep the routes dormant, not deleted).

# Context (self-contained)
Builds on #44 (already on `main`): the registry's `surface` field + tool
annotations + `sux` root verb. This chunk consumes that field to collapse the
tool list a client sees.

# The branch already has (3 commits, sitting on top of main)
- `7af4f05` feat: ~13 front verbs + `fn` escape; leaves hidden but reachable.
- `8ee0b23` fix: charge the real leaf's weighted cost through the `fn` escape.
- `bbb96c8` fix: close a Unicode-obfuscation cost/cache bypass in the `fn` escape.

# Steps
1. `git checkout feat/front-door`; it's 0 behind `main` but rebase-check anyway
   after chunk 00 lands (`git rebase main`).
2. Re-read the three commits; confirm the front-verb set matches the current fn
   inventory (a fn added since the branch was cut must be reachable via `fn`).
3. Retire the mail/vault/files namespace connectors: keep the routes registered
   but drop them from the advertised connector/plugin surface (dormant, reversible).
4. `npm run gen:index && npm run docs` — commit the regen.

# Acceptance
- `npm test && npm run type-check` green; docs + index in sync.
- `wrangler deploy --dry-run` passes.
- Behavior: a fresh MCP client sees ~13 front verbs + `sux` + `fn`, NOT all 95;
  every leaf is still callable via `fn`, and `fn` charges the leaf's real cost.
- Security: the Unicode-obfuscation bypass test stays green.

# Then
`/code-review ultra` (front door is the whole external surface — review hard),
merge+deploy. Unblocks chunks 03–06 riding on the consolidated surface.

# Gotchas
- `fn` escape is a cost/cache bypass vector — the two fix commits exist for a
  reason; don't regress them.
- "Retire" ≠ delete. Namespace routes stay live for direct callers.
- **Contract for every later chunk that adds a verb** (mail-triage, etc.): a new fn
  MUST set the registry `surface` field (`"front"` or `"leaf"`). Leaves stay
  reachable via `fn`, but an unannotated verb defaults ambiguously — this chunk
  establishes that the field is now load-bearing, not dormant metadata.
