---
title: Chunk 06 — render: finish cf-first ladder + retire mac
branch: feat/render-cf-ladder
status: ready (mostly already on main — this finishes + inverts + hardens)
depends_on: []   # parallelizable with everything
---

# Goal
cf-residential is the primary render backend everywhere, with a **paid
residential-unlocker** rung (Bright Data / Zyte / Oxylabs) for the sites cf can't
crack, and the **mac node retired** to a dormant option. Runs parallel to all chunks.

# CRITICAL context — most of this ALREADY LANDED; verify before building
- `fix/retail-render` is **merged** (`b87ff19` "Amazon cf-first + deadline-safe
  fallback") and `feat/amazon-cf-fallback` is **fully merged** (`git cherry` shows
  all 5 commits in main). So the cf-render helper + mac→cf fallback already exist.
- **BUT the state is inconsistent:** `sux/src/fns/amazon.ts` does cf-FIRST in code
  (lines ~176-177) while its own header comment (lines ~10-11) still says "the mac
  backend is PRIMARY." And the shared `retailRender` helper + the other retailers
  (homedepot/lowes/ace/winco) may still be mac-primary. **Read the actual code first.**

# The actual work
1. **Finish the inversion:** make cf-first the default in `retailRender` and every
   retailer (amazon already is), mac as a dormant non-default fallback. Fix the
   stale/contradictory `amazon.ts` header comment.
2. **Paid-unlocker rung:** add an env-gated (`UNLOCKER_*` secret, fail closed when
   unset) escalation rung for Home Depot (Akamai hard-wall — the one cf can't crack)
   and Costco (flaky soft-block). Stub the integration; wire one provider.
3. **Salvage the security fix:** cherry-pick `b363f00` (HMAC ts-freshness, replay
   block) from the unmerged `fix/render-unify-secfresh`. Skip `48c7969` (route mac
   through shared client — low value post-retire). Close #43 after.
4. **Retire mac:** keep the path as a dormant, non-default backend. One confirmation
   test first (bring mac up, `render` Home Depot `backend:mac + solve`, record it),
   then swap the ladder's mac rung for the unlocker regardless of the result.

# Acceptance
- `npm test && npm run type-check` green; docs + index in sync; dry-run ok.
- Behavior: default render path is cf for ALL retailers; HD/Costco escalate to the
  unlocker rung (or fail cleanly if `UNLOCKER_*` unset); mac is reachable only via
  explicit `backend:mac`; HMAC stale-timestamp is rejected (replay test).
- No stale "mac is PRIMARY" comments remain.

# Then
Merge+deploy the cf-first inversion + HMAC security bit (fix/security lane). The
paid-unlocker integration is a feature → PR when a real HD caller needs it.

# Gotchas
- Walmart: cf for READS only (PerimeterX blocks cart/interactive) — don't route
  interactive through cf.
- Don't hard-delete the mac path; demote it (reversible).
- Verify each retailer's current backend order in code before "inverting" — some are
  already cf-first and don't need touching.
