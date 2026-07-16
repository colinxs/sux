# CLAUDE.md — working in sux-mcp

sux is a Cloudflare Worker MCP server behind one `/mcp` front door (a suite of composable fns — see `sux/FUNCTIONS.md` / call `sux()` for the live inventory) + personal-data namespaces (vault/mail/files) reached as front verbs (`vault_`/`mail_`/`files_`) on that same connector. The former per-domain `/<domain>/mcp` connectors are retired — their routes stay dormant for back-compat, dispatched by the front verbs. Deep architecture lives in `docs/knowledge/patterns-and-conventions.md`; this file is **how we work**, not what we're building. Universal cross-project rules live in `~/.claude/CLAUDE.md`.

Guiding principle: **git is the undo, CI is the gate, review is the net** — so we move fast and unblocked, and lean on those three instead of asking permission.

## Git & branches

- **Never commit to `main`.** `main` auto-deploys to production (`.github/workflows/deploy.yml` on push). Treat every merge as a release; `main` must always be green.
- **Branch per logical change**: `<type>/<slug>` — `feat/…`, `fix/…`, `docs/…`, `chore/…`. One workstream per branch (mirrors one-change-per-cycle).
- **Commits**: Conventional Commits with scope — `feat(vault-mcp): …`, `fix(ci): …`, `docs(vpc-hosting): …`. Granular (one logical step each), well-described. End every commit with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Update a branch by rebasing onto `main`** (`git rebase main`) — never merge `main` back in. Keeps branch history linear.
- **Integrate via PR, merge-commit** with a curated title (`Merge #NN: <what + why>`) to preserve the reviewed step-by-step history. Squash only a trivial single-change PR. PR bodies end with:
  `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
- **Before merging anything substantial: run `/code-review ultra`** (the multi-agent branch/PR review). Findings-fix rounds before merge are the norm here, not the exception.
- Push when SSH/1Password is locked: `git -c credential.helper='!gh auth git-credential' push https://github.com/SuxOS/sux.git HEAD:<branch>`.
- **Sweep the branch/worktree backlog** with `npm run branches` (report-only) — parallel runs pile up merged branches and stale worktrees. Add `--prune` (`bash scripts/branch-sweep.sh --prune`) to delete the fully-merged ones and their worktrees; it uses `git branch -d`, so unmerged/superseded branches are always kept for you to judge.

## CI gates — don't break these (`.github/workflows/ci.yml`)

All must pass:

1. `npm run type-check` — `tsc --noEmit`
2. `npm test` — `vitest run`
3. `npm run check:node` — node deploy blob in sync
4. `npm run gen:index` → **`sux/src/fns/index.ts` must be committed** (fn index in sync)
5. `wrangler deploy --dry-run`

**`sux/src/fns/index.ts` is the one generated file we still commit** — the Worker
`import`s it (observability.ts + registry.test.ts), so it must exist at build/test
time. **After adding/removing a fn: run `npm run gen:index` and commit `index.ts`.**
The pre-commit hook does this for you and stages it; hand-editing it fails CI.

**The pure-generated docs are NOT committed anymore** — `sux/FUNCTIONS.md` and
`llms.txt` are gitignored and regenerated on demand (`npm run docs`, `npm run wiki`).
Nothing imports them: `/llms.txt` is served live from the registry, and FUNCTIONS.md
is a human/skill reference. Don't try to commit them (committing them made every
concurrent PR collide — that's why we stopped). The hybrid wiki MOCs
(`docs/wiki/MOCs/*`) stay tracked; refresh them with `npm run wiki` when you curate
the wiki. Run `npm run ci` locally before pushing — mirrors the full CI gate
(type-check, test, check:node, gen:index drift, wrangler dry-run) in one command.

## Sessions — separate, not shared

- **One Claude session per branch/workstream.** Mixing unrelated work in one long session bloats context and forces summarization (it will silently degrade). When you switch domains (vault → mail → files), start a fresh session on the new branch.
- **Continuity lives in memory + this file, not in the session.** Push durable decisions to Claude memory as you make them; a fresh session then loses nothing.
- **Fan out with subagents/workflows, not parallel human sessions.** For exploration, design tournaments, or bulk edits, spawn agents/`Workflow` inside the one session rather than juggling several.
- Long-running work (workflows, scheduled sweeps) is fine detached in the background.

## Model & settings

- **Opus 4.8 — design, architecture, codegen, adversarial review.** High/max reasoning effort for design + verify + hard bugs; medium for routine.
- **`/fast` (fast-mode Opus)** for tight edit→run loops — same model, faster output, no quality drop.
- **Sonnet — mechanical/bulk fan-out** (grounding reads, scaffolding, formatting). In workflows: `ground` stage → Sonnet/medium, `design`+`verify`+synthesis → Opus/high. Keep the judgment on Opus, the legwork on Sonnet.
- **Permissions: `bypassPermissions` is the default here** (`.claude/settings.local.json`) — deliberate, because git + the CI gates + `/code-review ultra` are the real guardrails. Keep it; don't add prompt friction.

## Known gotcha

- **Stale `.claude/worktrees/*` silently break `git checkout <branch>`** — it no-ops if that
  branch is held by another worktree, and a following rebase/push then operates on the WRONG
  branch. Drain/rebase PRs from a **detached scratch worktree** (`git worktree add --detach
  $SCRATCH origin/<br>` → rebase → `push HEAD:<br>`), never a plain checkout.
- **When a code-audit finding hinges on the exact contents of a regex or other
  code containing non-printable/control characters, verify with `od -c`/`cat -A`
  (or execute the code against the claimed-failing input) before filing or
  fixing** — a copy-pasted quote can silently drop bytes like `\x7f`, making a
  correct range read as two literal characters (see #587/#574).
- **The retired `/vault|mail|files/mcp` connectors have NO route left in
  `index.ts` at all** — front verbs dispatch straight into
  `VAULT_TOOLS`/`MAIL_TOOLS`/`FILES_TOOLS` via `fns/_namespace.ts`, bypassing
  `handleVaultRpc`/`handleMailRpc`/`handleFilesRpc` entirely. Those three
  JSON-RPC-shell functions are dead in production; they're kept only as the
  test harness their own `*-mcp.test.ts` files use to exercise the tool
  tables' real behavior (see #596). Don't assume a "dormant back-compat
  route" exists anywhere for them.

## House style

- No trailing/inline comments explaining the obvious; comment *why*, not *what*.
- Bidirectional naming (a reader can go name→behavior and behavior→name).
- Match surrounding code's idiom, comment density, and structure.
- One change per cycle; land it green before starting the next.
