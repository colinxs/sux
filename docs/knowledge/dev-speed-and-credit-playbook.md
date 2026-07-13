---
title: Dev speed & credit playbook
status: active
---

# Dev speed & credit playbook — sux-mcp

Concrete, repo-grounded rules for developing FAST and CHEAP here. Cached so it's reused
instead of re-derived each session. See also `CLAUDE.md` (workflow rules),
`docs/autonomous-pipeline.md` (async PR pipeline), and
`docs/knowledge/llm-models-cost-and-caching.md` (model pricing/caching mechanics, if present)
for the deeper cost model this playbook applies.

## Fast local dev loop

Commands, from `package.json`, ordered fast → slow:

| Command | Speed | When |
|---|---|---|
| `npx vitest run sux/src/fns/<name>.test.ts --config sux/vitest.config.ts` | fastest | iterating on one fn — targeted file, not the whole suite |
| `npm run type-check` (`tsc --noEmit`) | fast | after any signature/type change, before running tests |
| `npm test` (`vitest run --config sux/vitest.config.ts`) | slower | before pushing — full suite is a CI gate |
| `npm run check:node` | fast (script, no build) | only touched `sux/node/**` — verifies the embedded base64 blob matches `server.mjs` |
| `npm run gen:index` | fast | **only after adding/removing a fn** in `sux/src/fns/` — regenerates `sux/src/fns/index.ts`, which must be committed (CI gate 4) |
| `npx wrangler deploy --dry-run --config sux/wrangler.jsonc` | slowest local check | last local step before push — validates bundling/config without deploying |

Tight-loop recipe while writing/fixing a single fn:
1. `npx vitest run sux/src/fns/<name>.test.ts --config sux/vitest.config.ts` — repeat until green.
2. `npm run type-check` once the shape settles.
3. Only when done: `npm test` (full suite) + `npm run type-check` (CLAUDE.md's stated pre-push bar), then `npm run gen:index` if you added/removed a fn, then `wrangler deploy --dry-run`.

**Skip stale worktrees when running broad vitest/tsc**: `.claude/worktrees/*` are full
repo checkouts (parallel Claude runs leave many behind — see `npm run branches`). `vitest.config.ts`'s
`include` is scoped to `sux/src/**/*.test.ts` + `sux/node/**/*.test.ts` under the *current*
root, so a plain `npm test` from the main tree won't slurp them in — but if you ever run a
raw `tsc`/`grep`/`find` across the repo root, add `--exclude '**/.claude/worktrees/**'`
(or `-not -path '*/.claude/worktrees/*'` for find) or you'll burn time/tokens scanning
dozens of duplicate trees.

`npm run docs` / `npm run wiki` regenerate `FUNCTIONS.md`/`llms.txt` — these are gitignored,
generated on demand, and **not committed** (committing them caused every concurrent PR to
collide). Don't run them speculatively; run when you actually need the human-readable
output or are curating `docs/wiki/MOCs/*`.

## Credit-saving tactics

- **Model-tier the agent fleet** (CLAUDE.md's Model & settings section): Opus for
  design/architecture/codegen/adversarial-review (high/max effort); Sonnet for
  mechanical/bulk fan-out (grounding reads, scaffolding, formatting, targeted test runs).
  In multi-stage workflows: `ground` → Sonnet/medium, `design`+`verify`+synthesis →
  Opus/high. Don't reach for Opus to run a grep or format a file.
- **Prompt caching**: structure long-lived context (this file, CLAUDE.md, architecture
  docs) at the front of a prompt/system block so it's cache-hit across turns rather than
  re-tokenized. Don't re-paste large docs inline when a file reference will do.
- **Batch API** for non-interactive, latency-insensitive bulk work (e.g. classifying/
  labeling many items) — cheaper than sync calls when nothing is waiting on the result
  turn-by-turn.
- **Free web search paths**: use `kagi_session`/DDG-backed search in the `sux` fn surface
  over metered Kagi API calls when the query doesn't need Kagi-specific ranking — check
  `docs/knowledge/search-and-research.md` for which search fn is unmetered before reaching
  for a paid one.
- **The content-addressed KV cache**: repeated identical fn calls (same fn + same args)
  hit cache instead of re-executing — free the second time. Caveat: fn-to-fn chaining
  (one fn calling another internally) can bypass the outer cache layer, so don't assume a
  cached wrapper makes an internal chain free too — check the actual call path.
- **Don't re-fetch docs**: `docs/knowledge/*.md` exists precisely so recurring
  facts (cost model, search routing, Cloudflare/infra specifics) are read once and reused,
  not re-derived via web search or trial-and-error every session. Check there first.

## Parallelism patterns

- **Background agents vs a Workflow**: spawn a background `Agent` for a single bounded
  research/edit task with a clear return value. Reach for a `Workflow` (multi-stage,
  ground→design→verify) when the task has real staging where different stages want
  different models/effort — don't build a Workflow for something one agent call covers.
- **Worktree isolation for parallel git-mutating agents**: any agent that edits files and
  commits/pushes needs its own worktree (`.claude/worktrees/*`, `EnterWorktree`/
  `ExitWorktree`) — **one actor per git tree**. Concurrent writers sharing a tree corrupt
  each other's uncommitted state.
- **Report-only agents skip worktrees**: agents that only read/research/analyze and
  return content (no file mutation) can run directly against the main tree in parallel —
  no isolation needed since there's nothing to conflict.
- **Report-then-assemble**: for a job split across several parallel report-only agents
  (e.g. "audit every fn in `sux/src/fns/`"), have each return findings as text/data, then
  do the actual file edit yourself (or in one final agent) once — avoids N agents racing
  to write the same file.

## Pipeline speed

- **What unblocks CI fast**: pushes made with a GitHub App token (not a personal token)
  reliably fire the `ci.yml` workflow; a personal-token push can silently not trigger
  Actions in some repo configs — if CI doesn't start after a push, check the token used.
- **Workflow-edit PRs self-skip**: a PR that only touches `.github/workflows/**` doesn't
  get the usual bot auto-review/autofix treatment (those act on workflow-independent
  code) — expect to hand-merge workflow changes after a human look, not wait for the bot
  to close the loop.
- **Consolidate workflow changes**: batch `.github/workflows/*.yml` edits into one PR
  rather than several small ones — each workflow-touching PR needs the same manual
  attention, so spreading them out multiplies the manual-review tax for no benefit.
- **Drain mechanics**: per `docs/autonomous-pipeline.md`, safe-type PRs (`fix|security|
  perf|refactor|chore|docs|test|build|ci|revert` titles, or `automerge`/`bug`/`security`/
  `chore-safe` labels) auto-merge on green with no human step — lean on this for
  reversible work instead of manually merging. `feat:`/breaking/`hold`-labeled PRs always
  wait for a human; don't expect those to drain themselves.

## Anti-patterns to avoid

- **Committed generated artifacts causing merge treadmills**: `FUNCTIONS.md`/`llms.txt`
  were removed from git for exactly this reason — every concurrent PR touching them
  collided on the same generated diff. `sux/src/fns/index.ts` is the one deliberate
  exception (the Worker imports it at runtime) — regenerate it with `npm run gen:index`
  right before committing, don't hand-edit it, and don't add more generated files to git
  without the same justification.
- **Blind `git add -A` during rebase/parallel work**: with multiple worktrees and
  agents live, `git add -A` can stage unrelated stale files from a half-finished parallel
  change. Stage specific paths.
- **Re-fetching docs**: hitting the web or re-deriving facts already captured in
  `docs/knowledge/*.md` wastes both time and tokens — read the cached doc first, update it
  if stale, don't silently re-research past it.
- **Using Opus for mechanical work**: grepping, formatting, scaffolding, or running a
  known command doesn't need high-effort Opus reasoning — route it to Sonnet or do it
  directly with a tool call.
- **Un-verified claims**: don't report a fix/feature as working from reading code alone —
  reproduce against live ground truth (run the test, hit the deployed endpoint, check the
  actual log) before asserting success. This is the recurring sux blind spot — see
  `docs/design/session-knowledge.md`.
