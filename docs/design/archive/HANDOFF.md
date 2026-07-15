---
title: Session handoff
status: meta
cluster: meta
type: handoff
summary: "Rolling single-file session handoff (git history holds prior versions); current content is mostly ephemeral or superseded."
tags: [sux, meta, meta]
updated: 2026-07-09
---

# Session handoff — sux-router / plugin / sync automation (2026-07-08)

Context dump from the Claude Code session that built the router skill, plugin
marketplace, and sync workflows, then merged the engine stack. Written for the
next session to pick up mid-plan. Branch: `claude/router-skill-profile-snippet-ci3yic`
(restarted from `main` @ fd11f34).

## State as of handoff

**Merged to main (all today):**
- PR #11 — `.claude/skills/sux-router/SKILL.md` (78-tool router skill, written
  from the then-live server's schemas), `docs/claude-profile-snippet.md`,
  plugin marketplace (`.claude-plugin/marketplace.json` → `plugins/sux-router/`,
  validates clean; install: `/plugin marketplace add colinxs/sux`),
  `scripts/check-skill-sync.mjs` + `docs/sux-tools.txt` snapshot,
  workflows `skill-sync.yml` (weekly drift issue) + `docs-update.yml` (weekly
  regeneration PR).
- PR #10 — brought up to date with sux-engine (conflicts resolved in
  `metadata.ts`/`select.ts` in favor of engine's `resolveHref`/`splitSelectorList`;
  verified locally: 951/951 tests, type-check, `check:node` all green), then
  squash-merged into sux-engine.
- PR #6 — the engine (core + sux split, 262 files) merged into main with a
  merge commit. Deploy run for it: https://github.com/colinxs/sux/actions/runs/28911484574
  (was pending at handoff — VERIFY it went green and the `sux` worker deployed).
- Dependabot #1/#2/#3/#5 — `@dependabot rebase` commented on all four after the
  engine merge. NOT yet merged.

## Findings the next session needs

1. **`SUX_MCP_TOKEN` 401**: repo secrets `SUX_MCP_URL`/`SUX_MCP_TOKEN` are set,
   but the worker's `/mcp` is gated by `workers-oauth-provider` (see
   `sux/src/index.ts` → `getOAuthProvider`); it only accepts tokens minted by
   its own OAuth flow, so any static secret gets
   `401 {"error":"invalid_token"}` on `initialize`. Both scheduled workflows'
   live steps fail until fixed.
2. **The server code is now IN this repo**, so the sync machinery doesn't need
   the live server at all: `sux/FUNCTIONS.md` is generated from `sux/src/fns/*.ts`
   by `npm run docs` (`sux/scripts/gen-docs.mjs`). Source-derived sync (no
   secrets) is the better design.
3. **FUNCTIONS.md is stale on main**: it lists a `sux` fn that no longer exists
   in `sux/src/fns/` and misses `obsidian` (which exists). `ls sux/src/fns/*.ts`
   (excluding tests/`_*` helpers) is truth; regenerate with `npm run docs`
   (was about to run when session was interrupted).
4. **Two overlapping skills on main**: engine's `.claude/skills/sux/SKILL.md`
   (68 lines; header says "50 composable functions" — stale, it's 78; points at
   `sux/FUNCTIONS.md`) and mine `.claude/skills/sux-router/SKILL.md` (138 lines,
   richer routing: fetch-escalation ladder, composition patterns, worked
   examples). Tool-name sets: engine source vs my `docs/sux-tools.txt` snapshot
   differ only by `obsidian` (in snapshot + src, missing from stale FUNCTIONS.md)
   and `sux` (in stale FUNCTIONS.md only). So the sux-router content is accurate
   for the engine.
5. Engine also brought `.github/workflows/health.yml` and its own README under
   `sux/`; root README still documents the kagi-mcp core plus my sections
   (routing helpers, CI/CD list).

## Agreed plan (user-approved, in progress)

User asked (last three messages): "how to get valid SUX_MCP_TOKEN; merge sux
and sux-router skill (and associated workflows); check dependabot merges and
merge if green; make sure plugin is shipping all skills."

1. **CI token**: add a narrowly-scoped static bearer to `sux/src/index.ts`
   default `fetch`: if path `/mcp` and `Authorization: Bearer` matches
   `env.SUX_CI_TOKEN` (timing-safe compare, fail closed when unset), serve ONLY
   `initialize` / `notifications/*` / `tools/list` (never `tools/call`),
   bypassing the OAuth provider; everything else falls through to OAuth as
   today. Add unit tests next to `sux/src/index.test.ts` style. Then:
   `npm run secret:sux -- SUX_CI_TOKEN` (value: `openssl rand -hex 32`) and set
   the same value as repo secret `SUX_MCP_TOKEN`. `SUX_MCP_URL` = the sux
   worker's `/mcp` URL.
   (Even with source-derived sync below, this keeps an optional live
   deployment-matches-main probe possible.)
2. **Merge skills into one** canonical `.claude/skills/sux/SKILL.md` (name `sux`
   matches the connector; delete `.claude/skills/sux-router/`). Base = engine
   skill's accurate framing (FUNCTIONS.md pointer, `npm run docs` note); merge
   in sux-router's routing depth (escalation ladder scrape→render→render mac,
   composition `pipe`/`batch`/`as:"url"`, research/shopping overlap rules,
   worked examples, failure/fallback). Fix the "50 functions" → 78. Verify every
   fn name in regenerated FUNCTIONS.md is mentioned in the merged skill (the
   check script does this).
3. **Merge the workflows**: fold `docs-update.yml` into `skill-sync.yml` (delete
   docs-update.yml). New design, source-derived, no secrets required:
   - check mode (PRs touching skills/fns/script + weekly): `npm run docs`
     must produce no diff (stale FUNCTIONS.md fails), every fn name mentioned in
     the skill, plugin `skills/` dir mirrors `.claude/skills/` exactly.
   - fix mode (schedule/dispatch): regenerate + sync, open/refresh PR on
     `bot/docs-update` (needs "Allow GitHub Actions to create and approve pull
     requests", already documented in README).
   - Rewrite `scripts/check-skill-sync.mjs` accordingly (drop the MCP client or
     keep it behind an optional `--live` flag using SUX_MCP_URL/TOKEN).
   - Delete `docs/sux-tools.txt` (FUNCTIONS.md is the source of truth now);
     `docs/TOOLS.md` was never committed — drop the concept, FUNCTIONS.md is
     the reference. Update README sections that mention these files.
4. **Plugin ships ALL skills**: `plugins/sux-router/skills/` must mirror all of
   `.claude/skills/` (after step 2 that's the single `sux` skill; the sync
   script should copy the whole dir, not one file). Keep plugin name
   `sux-router` (marketplace `sux`) to avoid churn; update plugin.json/
   marketplace.json descriptions to mention it ships the `sux` skill.
5. **Dependabot** (#1 setup-node 6, #2 checkout 7, #3 wrangler-action 4,
   #5 vitest 4.1.10): after their rebases, check CI green → merge; if
   conflicted/red, report. Note engine rewrote package.json and my workflows
   still pin checkout@v4/setup-node@v4 — the actions bumps only touch workflow
   files and should be safe.

## Verification commands (all were green pre-handoff on the merged tree)

```
npm ci
npm run type-check
npm test               # core + sux suites (was 951 passing)
npm run check:node     # deploy-blob drift check
npm run docs && git diff --exit-code sux/FUNCTIONS.md   # will FAIL until regenerated (finding 3)
node scripts/check-skill-sync.mjs --offline
claude plugin validate .
```

## Loose ends / don'ts

- Session's scheduled self-check-in trigger was deleted; PR #11 unsubscribed on
  merge. No pending automation from the old session.
- Deploy of engine to Cloudflare + the `kagi-mcp` core worker deploy behavior:
  root `deploy.yml` deploys the CORE (`wrangler.jsonc` name `kagi-mcp`); the
  sux engine deploys via `npm run deploy:sux` (`sux/wrangler.jsonc`, worker
  name `sux`) — CHECK whether deploy.yml was updated by the engine PR to deploy
  both; if not, the sux worker may still be hand-deployed (that would also
  explain the old live/repo drift).
- Don't reopen merged PRs #6/#10/#11; new work goes through fresh PRs from
  `claude/router-skill-profile-snippet-ci3yic`.

## Related

- [[Home]]
- [[connector-surface-policy]]
