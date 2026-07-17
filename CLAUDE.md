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
- **A bot-build's starting branch can already be behind `origin/main`** — other builders'
  PRs land while yours is queued/running, and an issue can reference a file a just-merged PR
  added (e.g. #712 needed #708/#710's `_vault_semantic.ts`, absent from the branch's own base).
  `git fetch origin main && git rebase origin/main` before assuming a referenced file/symbol
  is missing or the issue is stale — it's often just that your branch hasn't caught up yet.
- **When a code-audit finding hinges on the exact contents of a regex or other
  code containing non-printable/control characters, verify with `od -c`/`cat -A`
  (or execute the code against the claimed-failing input) before filing or
  fixing** — a copy-pasted quote can silently drop bytes like `\x7f`, making a
  correct range read as two literal characters (see #587/#574).
- **`package.json`'s `"@suxos/lib": "file:../suxlib"` needs a private sibling repo
  (`SuxOS/suxlib`) checked out at `../suxlib` — real CI mints a repo-scoped App
  token for it (`.github/workflows/ci.yml`), but a bot-build sandbox's default git
  identity often can't clone it, so `npm run type-check`/`npm test`/`npm run ci`
  fail on `Cannot find module '@suxos/lib'` for reasons that have nothing to do
  with the diff (confirmed identical on a clean `main` checkout — this is what
  sank 4 straight auto-build attempts on #642/#643 before the cause was found).
  Check `git log -- package.json` for when `@suxos/lib` entries were added — if a
  sandbox's `../suxlib` is missing/broken, that's the likely reason, not the code
  under test. Workaround for local verification only (never commit it): stub
  `../suxlib` with a loose `any`-typed re-export of everything importers pull from
  `@suxos/lib` (`grep -rn '@suxos/lib'` for the current export surface) so
  unrelated files resolve; diff `npm test`'s failure set against the same stub on
  a clean `main` to prove your change adds nothing new, then trust real CI (which
  has the actual library) for those files' real behavior.
- **Cloudflare Workflows' `step.waitForEvent` has no typed/distinguishable error
  for "the wait timed out"** vs. any other rejection (transport error, dropped
  RPC) — even Cloudflare's own docs just wrap the whole call in one blanket
  try/catch. Code that treats *every* caught error as a timeout (e.g. to proceed
  past a human-approval pause) fails OPEN on real failures, not just timeouts
  (#682). `sux/src/op-engine/durable.ts`'s `isWaitForEventTimeout` sniffs
  `error.name`/`.message` for a timeout-shaped string as the least-bad available
  signal — reuse that heuristic rather than re-deriving it.
- **A bot-build sandbox's `../suxlib` git remote is READ-only**, even though it's
  cloned with an embedded `x-access-token` that looks like it could push — `git push`
  there 403s ("Write access to repository not granted"). An issue phrased as "a
  future build with suxlib write access should do X" is not buildable by an
  automated session today; don't spend gate/turn budget implementing the suxlib-side
  half only to find you can't land it — check `git push` (or just try it early)
  before doing real work there, and drop the issue back to the queue instead.
- **A feature that needs a NEW Cloudflare resource** (a Vectorize index, D1
  database, extra R2 bucket/Queue, …) **beyond what's already bound in
  `wrangler.jsonc` isn't buildable in one bot-build session** — provisioning it
  needs a real `wrangler <resource> create` against the account, which a sandbox
  has no credentials for; don't assume an adjacent primitive (e.g. `_embed.ts`'s
  Workers-AI `embed()`/`cosine()`, used by `#701`'s `vault_semantic` gap) means
  the rest is a small lift. Recognize effort-`L` issues of this shape early and
  drop them back to the queue rather than half-building them.
- **Correction to the bullet above's example: `vault_semantic` (#701/#708) turned out
  buildable with zero new resources** — `_source.ts`/`_examples.ts` already prove the
  brute-force-KV-cosine pattern needs only the existing `AI` + `OAUTH_KV` bindings; #701
  was closed on a mistaken premise and rebuilt in #708. The general principle (a feature
  needing a genuinely NEW Cloudflare resource isn't buildable in one session) still
  holds — just verify the "needs Vectorize/D1/etc." premise before trusting it, don't
  take a prior closing note at face value. Separately: Workers-AI's `bge-base-en-v1.5`
  hard-caps a single `embed()`/`AI.run` call at **100 texts** (undocumented in this repo
  before #708) — any call site batching an unbounded chunk count (e.g. a long document)
  must slice into ≤100-sized batches or the call errors; see `_vault_semantic.ts`'s
  `embedBatched()` for the shape.
- **A durable op's leaf (`op(name, fn, opts)`) only ever receives `caps` (store/llm/clock/
  sinks) — never `env`**, because `op-engine/registry.ts`'s factories are typed `() => Op`
  (zero args, by design — see that file's replay-determinism note). A leaf that needs a
  binding outside `caps` (mail/JMAP, KV, any other RtEnv secret) can't reach it directly.
  Two ways around it, both used by `mail-triage-plan` (#718): do the env-needing fetch in the
  CALLING fn before `run` even starts and pass the result in as the op's `input` (see
  `mail_triage_plan.ts`), or add a new `caps.sinks[name]` target in `caps.ts`'s `makeSinks(env)`
  — which DOES close over `env` already — for an env-needing terminal write (see `caps.ts`'s
  `mailLabelsSink`). Don't widen the `Caps` type itself for this; it's defined in `@suxos/lib`,
  a separate read-only-in-sandbox repo (see the `../suxlib` gotcha above).

## House style

- No trailing/inline comments explaining the obvious; comment *why*, not *what*.
- Bidirectional naming (a reader can go name→behavior and behavior→name).
- Match surrounding code's idiom, comment density, and structure.
- One change per cycle; land it green before starting the next.
