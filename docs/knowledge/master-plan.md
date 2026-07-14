# SuxOS master plan — everything we ought to do

The top-level prioritized roadmap. Detailed execution lives in `org-structure-and-refactor-plan.md`
+ `refactor-runbook.md`; the forward landscape in the deep-research report (folded in when it lands).

## Decisions locked (Colin, 2026-07)
- **Personal-first.** Optimize for Colin's assistant + digital life. Build cleanly so it COULD
  generalize, but don't pay the multi-user/productization tax now. KISS.
- **Do what's worthy** across all tracks — I sequence by leverage, run parallel where safe.
- **Balanced autonomy, but MAX the free pools.** Safe fixes auto-merge+deploy; features/security
  human-gated; improvement bot daily-gated — AND spend GitHub Actions minutes + included credits to
  the hilt (aggressive-on-free, careful-on-paid).
- **Minimal repo split, grown organically.** Single-allow-all at the org level (org secrets = all
  repos, App = all repos) for ease. One repo per dev session for parallel work.

## Repo decomposition (chosen shape — minimal, grows as needed)
- **`SuxOS/sux`** — core Worker + fns + namespaces (vault/mail/files) + recall + the knowledge base. The product. [transfer `colinxs/sux`]
- **`SuxOS/.github`** — the reusable autonomous pipeline (review/fix/merge/audit) + org profile; every repo inherits via thin stubs + org secrets.
- **`SuxOS/suxrouter`** — the router, EVENTUALLY: rename/move `owl-tegu-luci` → `SuxOS/suxrouter` (coordinate with the router session; not now — it's mid-work).
- **`SuxOS/suxlib`** — HOLD. Extract a shared lib only when a SECOND TS consumer exists; today `sux` is the only one, so a lib repo would have one consumer = premature.
- `packaging/` (plugin/desktop-extension/skill) + `plugins/` — stay in `sux`; split only if they earn their own release cadence.

## Tracks (sequenced by worthiness; parallel where safe)

### A · Finish the migration (foundation — first, mostly staged) — **DONE (2026-07-13)**
1. Drain the PR queue to empty (autonomous, in progress).
2. Transfer `colinxs/sux → SuxOS/sux`; re-apply branch protection + deploy secrets (runbook).
3. Repoint the MCP connectors → `suxos.net`.
4. Extract `SuxOS/.github` reusable pipeline; thin the per-repo stubs.
5. Move `owl-tegu-luci → SuxOS/suxrouter` (coordinate router session).
6. Per-repo sessions; sweep branches/worktrees.

### B · Product (the assistant gets more useful)
- Arm the mail-automation features (labels, sensitive-guard, draft-reply) — gated-dormant, deliberate switch.
- Recall: free Kagi (`kagi_session`, needs `KAGI_SESSION`) + web-default-when-free; the fn→fn cache + `listExamples` cheap wins from the spend audit.
- `learn`/`study` (whitelisted-knowledge verb) — the learn→research→advise atom.
- Deepen the digital-life spine: Mode B write (gated), the knowledge-graph over the vault.
  - Memory decay/consolidation pass (the Track D "one bet") — **shipped, gated-dormant**: `consolidate` fn + weekly cron sweep flags stale (`last_verified`-unset/expired) and duplicate-candidate vault notes, appends a findings digest. Detection only — nothing merged/deleted/patched. Dormant unless `CONSOLIDATE_ENABLED` is set.

### C · Generalize (organic)
- The reusable pipeline as "bot-in-a-box" via `SuxOS/.github` — any repo inherits the autonomy.
- Refactor what makes sense (permission granted) — right altitude, KISS, no premature abstraction.

### D · Strategy (from deep-research — landing)
- Fold in the "where we're going" findings (2026 personal-AI landscape): what to adopt, what to avoid, the one bet. **Landed** — see `docs/design/personal-ai-landscape-2026.md`. The bet: ship a memory decay/consolidation pass on the vault knowledge-graph (Track B) before adding new recall surface area.

### E · Meta / cost
- **Observability**: Grafana billing dashboards — make "efficient" a gauge you watch (spend + free-credit-usage visible). Monarch later.
- The 11 cardinal rules (`working-agreement.md`).
- Session model: meta `suxos` + one focused session per repo.

## The one bet
The **org + migration foundation IS the bet**: it unlocks parallel per-repo development and org-inherited autonomy/secrets, which multiplies every other track. Land it, then the product + generalize tracks compound. (Sharpened by the deep-research when it lands.)
