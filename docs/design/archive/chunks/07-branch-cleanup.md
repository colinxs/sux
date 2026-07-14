---
title: Chunk 07 — branch cleanup (housekeeping)
branch: none (operates on refs)
status: do anytime (but salvage the render chunk's b363f00 BEFORE deleting its source)
depends_on: []
---

# Goal
Delete the dead / merged / superseded branches so the branch list reflects reality.
Verify each is truly gone-into-main (by CONTENT, not just merge-base) before deleting.

# The content-vs-containment lesson (why this list changed)
`git log main..<branch>` showing "N ahead" does NOT mean N commits of unmerged
*work* — the content may have been reimplemented and merged via a different PR, with
different SHAs. **Use `git cherry -v main <branch>`**: a `+` is a patch not in main;
BUT even a `+` can be already-shipped as a feature via a different patch — so also
grep the feature symbol on main. `chore/ultra-sweep` (17 "ahead") turned out 100%
superseded this way.

# Merged / dead — delete local + remote
`fix/files-vault` `fix/infra-resilience` `fix/mail-caldav`
`fix/registry-surface-selfdescribe` `fix/retail-render` `fix/parsing` `fix/resource`
`fix/security2` `feat/digital-life-spine` `feat/fastmail-integration` `feat/int-sweep`
`feat/mcp-gate` `feat/obsidian-store-ops` `feat/sux-vault-plugin` `docs/knowledge-core`
`docs/unpark-verbs-plan` `claude/sux-mychart-integration-4lr46s`
Local-only junk: all `worktree-wf_*`, `as33` `as38` `as39` `as40` `pr31` `pr46`
`alg37` `uw36` (dupes/aliases of the above or of superseded branches).

# Superseded — content already on main by a DIFFERENT patch — close PR, delete
- `chore/ultra-sweep` — **`git cherry` + symbol-grep confirm all 17 commits' content
  is on main** (mail reply/forward, FUTURERELEASE send, mail_move, HTML bodies, jmap
  fixes, ebay self-heal, csv escape, recall-remote, citekeys, files Mode-B reject,
  scrape clamp, batch_fetch OOM bound, `_oauth`/`_dropbox-core`/`errMsg` refactors,
  localshop deletion — every one present). Nothing to salvage.
- `feat/amazon-cf-fallback` — all 5 commits `-` in `git cherry` (merged). See render chunk.
- `feat/files-operate-transform` — `transformFull` + `files_transform` tool on main.
- `feat/obsidian-structured-search` — `vault_query`/`vault_patch`/JsonLogic on main.

# Pruned as cruft (per execution-plan §"Pruned as cruft") — close
`docs/unpark-algebra-plan`, `docs/uw-directory-fn-plan` (+ local `alg37`, `uw36`).

# KEEP (genuinely unmerged — see chunks)
- `fix/fanout-time-budget` — fanout chunk (in progress).
- `feat/front-door` — front-door chunk (`git cherry`: all 3 commits `+`, genuinely new).
- `fix/render-unify-secfresh` — DON'T delete until the render chunk cherry-picks
  `b363f00` (HMAC ts-freshness); then close #43.

# Steps
1. Land the render chunk's `b363f00` salvage FIRST (only live thing on a to-delete branch).
2. `git branch -d <merged>` (`-D` for superseded/cruft after confirming content on main).
3. `git push origin --delete <branch>` for the remote refs.
4. `git worktree prune`; delete `worktree-wf_*` refs.

# Gotchas
- Do NOT delete `fix/render-unify-secfresh` before its security commit is salvaged.
- Confirm-then-delete by CONTENT: `git cherry` + symbol-on-main grep, never the name alone.
