# SuxOS refactor runbook (executable)

> **STATUS: DONE (2026-07-13).** The colinxs/sux → SuxOS/sux transfer, secret re-provisioning, and org-repo setup described below all completed tonight. Kept as historical record of the executed runbook — not a live instruction set. See docs/knowledge/master-plan.md for current state.

The step-by-step execution of the split described in `org-structure-and-refactor-plan.md`
(strategy). Grounded in the current `colinxs/sux` layout. Do the phases in order.

## Preconditions (all true before Phase 2 — the transfer)
- sux PR queue drained: no BEHIND/BLOCKED bot PRs, only intentional holds.
- SuxOS org secrets set (ANTHROPIC_API_KEY, SUX_BOT_APP_ID, SUX_BOT_PRIVATE_KEY), visibility all repos.
- SUX_BOT App installed on SuxOS, all repositories.
- main green and auto-deploying to suxos.net.

## The secret map (the key safety fact)
A GitHub transfer moves the repo but NOT its secrets or branch protection. Two disjoint sets:
- **GitHub Actions secrets** (only 5 — re-provision these): ANTHROPIC_API_KEY, SUX_BOT_APP_ID, SUX_BOT_PRIVATE_KEY (all three → SuxOS org secrets), plus CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (for deploy → SuxOS/sux repo secret or org secret).
- **Worker runtime secrets** (KAGI_API_KEY, FASTMAIL_*, DROPBOX_*, OBSIDIAN_*, GRAFANA_*, MONARCH_TOKEN, MAC_RENDER_*, etc.): these live in **Cloudflare** (wrangler secrets on the Worker), NOT GitHub — a GitHub transfer does not touch them. The deployed Worker keeps running unchanged.

## Current inventory (what's in colinxs/sux)
- `sux/` — the Worker: `src/` (index + fns + registry + ai + proxy + namespaces), `wrangler.jsonc` (name `sux`, OAUTH_KV, R2 `sux-mcp`, rate limiters), `grafana/`, `mac-render/`, `mcp-gate/`, `scripts/`, `docs/`.
- `sux/node/` (`server.mjs`, `openwrt/`) — REVIEW: referenced by `sux/src/proxy.ts`, so not purely dead; decide keep-vs-slim-vs-move-to-suxrouter before splitting.
- `docs/` — `design/`, `knowledge/` (this knowledge base, travels with SuxOS/sux), `wiki/`.
- `.github/workflows/` — 14 workflows (the pipeline).
- `packaging/` — distribution: `claude-code-plugin`, `desktop-extension`, `skill`. Stays with sux (or its own repo later).
- `plugins/sux` — the Claude Code plugin. Stays.
- `scripts/` — branch-sweep, gen-index, etc.

## Phase 1 — Extract SuxOS/.github (reusable pipeline) [safe, do BEFORE transfer]
1. Create the `SuxOS/.github` repo (org profile + reusable workflows).
2. Convert the shared workflows to reusable (`on: workflow_call` + inputs) in `SuxOS/.github/.github/workflows/`: the pipeline (`automerge`, `pr-auto-update`, `pr-drain`, `pr-watch`, `claude`, `claude-autofix`, `skill-sync`) plus `audit`/`health`. (The former `secret-scan.yml` and `budget-guard.yml` workflows were retired org-wide.) Keep the App-token + `--json-schema structured_output` verdict logic exactly as fixed in #178/#175.
   - **`ci` and `security-review` stay per-repo, by decision, not oversight** (#399): `ci.yml` is tightly coupled to this repo's own gate sequence (type-check, vitest, `check:node`, `gen:index` drift, `wrangler deploy --dry-run`), and `security-review.yml`'s ~170 lines of Claude-based review logic is repo-specific enough (this repo's fn registry, secrets surface, CLAUDE.md conventions) that generalizing it into a `workflow_call` with inputs would add more indirection than it saves for the two repos that would call it today. Re-evaluate if/when a third repo needs the same gate shape.
3. In each consuming repo, leave a thin caller stub that `uses: SuxOS/.github/.github/workflows/<name>.yml@main` with `secrets: inherit`. The gating stub must live per-repo (GitHub only gates a repo from its own workflows), but the logic is now shared.
4. Org secrets flow to callers via `secrets: inherit`.
5. Verify on a scratch repo: a test PR runs the reusable CI green and produces a real security verdict.

## Phase 2 — Transfer colinxs/sux → SuxOS/sux
1. Confirm preconditions. Snapshot: `gh api /repos/colinxs/sux/branches/main/protection` (to re-apply after).
2. Transfer: `gh api -X POST /repos/colinxs/sux/transfer -f new_owner=SuxOS`. PRs, issues, and redirects move with it.
3. Post-transfer fixups:
   - Re-apply branch protection on `SuxOS/sux` main: required checks `Type-check & build`, `security-review`, `npm audit & SBOM`; strict = true.
   - Add repo secrets that are NOT org-level: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (deploy). The 3 bot keys come from org secrets automatically.
   - `deploy.yml` needs no change if the CF token/account secrets resolve.
   - Update local remote: `git remote set-url origin git@github.com:SuxOS/sux.git`.
4. Verify: trivial commit → reusable CI runs → deploy → `suxos.net/mcp` returns 401 (healthy).

## Phase 3 — Connector repointing
Update the MCP connector configs (Code/CLI/Cowork/Desktop) from `sux.colinxs.workers.dev/*` to `suxos.net/*`. Both resolve during the transition, so do it deliberately, verify each surface, then retire the workers.dev references in docs.

## Phase 4 — suxrouter alignment
The router repo moved into SuxOS as `SuxOS/suxrouter` (DONE) — it inherits org secrets + the reusable pipeline via caller stubs.

## Phase 5 — Sessions + cleanup
- Spin one focused session per repo (SuxOS/sux, SuxOS/.github, SuxOS/suxrouter); this meta session tracks the whole.
- Sweep merged branches + stale worktrees (`npm run branches --prune`).
- Repoint the scheduled tasks (`sux-continuous-audit`, `sux-knowledge-refresh`) to `SuxOS/sux`.

## Rollback (per phase)
- Phase 1 is additive — keep the inline workflows until the reusable callers are verified green, then delete the inline copies.
- Phase 2 transfer is reversible (transfer back to colinxs). The Worker keeps running throughout (runtime secrets are CF-side, untouched).
- Phase 3 is config — revert connectors to workers.dev.

## Top risks
- **Branch protection lost on transfer** → re-apply immediately, or auto-merge could land a red PR (the going-private incident, again).
- **Reusable-workflow secret flow** → confirm `secrets: inherit` actually delivers the org secrets to the caller before deleting the inline workflows.
- **`sux/node` review** → it is referenced by `proxy.ts`; do not blind-delete when slimming the repo.
