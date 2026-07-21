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
- **If a referenced file/symbol is STILL missing after rebasing onto `origin/main`, check
  `gh pr list --state open` before concluding the issue is stale** — a suxbot audit issue can be
  filed against a concurrent builder's still-OPEN (unmerged) PR, not just a just-merged one (e.g.
  #788/#794 both named `_agenda_reply.ts`/`_learning.ts`'s `insights` action from PR #787's
  then-unmerged `bot/issue-build-29614608666` branch). That issue isn't buildable yet regardless
  of rebasing — drop it back to the queue; it'll resolve itself (or need re-filing) once the
  other PR actually merges.
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
- **Bare `npx vitest run <path>` silently misbehaves in this repo** — the include glob and
  the `cloudflare:workers` alias (needed because `op-engine/durable.ts`'s `OpWorkflow` value-
  imports it, and `index.ts` re-exports `OpWorkflow`, pulling it into almost every test file's
  import graph) both live in `sux/vitest.config.ts`, which only `npm test`/`npm run ci` pass
  automatically. A bare invocation either reports "No test files found" (wrong cwd/glob) or
  `Cannot find package 'cloudflare:workers'` (no alias) — neither means the code is broken.
  For an ad hoc single-file run use `npx vitest run --config sux/vitest.config.ts <path>`.
- **A JMAP per-call error (e.g. `Email/changes`'s `cannotCalculateChanges` when `sinceState`
  has aged out server-side) comes back as a normal `["error", {type,...}, callId]` entry
  INSIDE `methodResponses`** — `fns/jmap.ts`'s `jmap.run`/`_jmap.ts`'s `runBatch` only throw
  for a REQUEST-level failure (auth, rate limit, transport); per-call errors are silent unless
  the caller checks that callId's response for `mr[0] === "error"`. Code that assumes any
  JMAP problem throws will silently treat an error response as an empty/absent result instead
  of the specific failure it is — see `_mail_semantic.ts`'s `methodResult()` for the check
  (used to fall back from an incremental `Email/changes` diff to a full rebuild on exactly
  this error).
- **suxlib's `reconcile` op-tree node collapses `Handle[]` → ONE `Handle`, and `Handle` itself
  (`{r2Key,sha256,type,size,producedAt?}`) carries no room for extra metadata** — fine for
  assimilate-pdfs' single-master-document use, but any per-item/per-cluster merge whose SINK
  needs to know where each merged result goes (a target path, a cluster id) can't route that
  through a top-level `reconcile` node without losing it on the way through. Call suxlib's
  `runReconcile()` directly INSIDE a leaf instead (leaves get `caps.store` too) and return the
  metadata alongside the resolved text — see `op-engine/_vault_consolidate_plan.ts`'s
  `proposeMerge` (#735).
- **`study`'s pdf-from-path branch (`study.ts`'s `extractDocText`) only reads a Dropbox path
  through Mode B (whole-account, `DROPBOX_FULL_*`) — never through Mode A (the app-folder
  `dropbox` fn), even though Mode A is the credential most features actually have configured.**
  Don't assume `study({source:"/some/app-folder/path.pdf", kind:"pdf"})` works just because
  `hasDropbox(env)` is true; it needs `hasDropboxFull(env)`. To study a file that only lives in
  the App folder without adding a second credential, mint a Mode A shared link (`dropbox.ts`'s
  exported `sharedLink`, forced to a raw download with `?dl=1`) and hand study that http(s) URL
  instead — see `_learning_folder.ts`'s `runLearningFolderSync` (#433).
- **`worker-configuration.d.ts` (generated by `wrangler types`/`npm run cf-typegen`) types ECDH
  `deriveBits`'s algorithm field as `$public`, not `public`** — a C++ `public`-keyword-collision
  artifact of workerd's type generator, not the real runtime shape. The JS-visible property, per
  the WebCrypto spec and every browser/Node implementation, is still `public`; cast past the
  generated type (`{name:"ECDH", public: otherKey} as unknown as SubtleCryptoDeriveKeyAlgorithm`)
  rather than emit `$public` at runtime, which no real implementation recognizes. Also: don't
  regenerate `worker-configuration.d.ts` from inside a bot-build sandbox and commit it — this
  environment lacks whatever local secret files (`.dev.vars` etc.) the last real generation had,
  so a fresh `wrangler types` run silently DROPS fields like `TS_OAUTH_CLIENT_ID`/`DROPBOX_FULL_*`
  from `Env` instead of adding to it (#219/#220). Add a new binding's type directly to `RtEnv` in
  `registry.ts` instead (`R2Bucket`'s hand-rolled override is the existing precedent for this).
- **A prior bot-build attempt on an issue can leave a complete, well-reasoned implementation
  sitting on an orphaned commit** (a PR that got closed rather than merged, e.g. because gates
  failed for an unrelated reason like the `../suxlib` sandbox gotcha above) — `git log --all
  --oneline | grep -i <keyword>` before rebuilding an issue from scratch. If found, `git show
  <sha> -- <path>` to read the diff; reuse whatever part still applies cleanly and adapt/drop
  whatever's since been superseded by other merged work (#749 found #747+#749's prior combined
  attempt this way — #747's half had since landed differently, but #749's `_learning.ts`/ranking
  half was untouched and reusable as-is).
- **`docs/knowledge/patterns-and-conventions.md` contains one literal NUL byte** (§6's compression
  section illustrates the KV `GZIP_MARKER` prefix as the raw byte, not the text "0x00") — `file`
  reports the whole doc as "data", and a plain `grep`/`grep -n` over it silently returns ZERO
  matches for anything, even unrelated terms, with no error. Don't take that as "this isn't
  documented here"; use `grep -a` against this specific file (confirmed while building #803).
- **`fns/obsidian.ts`'s `readVaultIndexBlob`/`writeVaultIndexBlob` are a SINGLE KV key per vault
  repo+branch (`cache:vault:git:{repo}@{branch}:index`), single-owned by `vault-mcp.ts`'s
  `scanVault`/`buildVaultIndex` (the derived {path,fm,tags,links,...} scan behind backlinks/
  query/tags — and now `portal.ts`, #824). A new consumer that also needs the whole-vault
  derived scan should import `vault-mcp.ts`'s exported `scanVault`/`VaultRecord` rather than
  writing its own differently-shaped blob through those two functions directly — two shapes
  fighting over the same key thrash the cache (each write invalidates the other's `version`
  check) instead of sharing the one already-built index.
- **Before building a "self-model"/"what does sux know about my life" capability, check
  `fns/_life_wiki.ts`/`fns/life_wiki.ts` first** — it already fans `recall` inward across
  vault/files/mail/learned into a synthesized profile (People/Health/Projects/Timeline/
  Interests) and writes it as vault notes, dormant behind `LIFE_WIKI_ENABLED`. A filename
  grep for `onboard`/`profile`/`self_model` (as #836's audit did) won't surface it. `onboard`
  (#836) is a DIFFERENT, deliberately separate capability — interactive/user-invoked with a
  gap-fill question loop, writing into the REAL vault (not life_wiki's regenerable sandbox)
  — but reuses the same underlying `recall.gatherRecall` fan-out; check both before adding a
  third overlapping synthesis path.
- **`imessage.ts`'s `messages` action returns messages in ASCENDING (oldest-first) order** —
  `imessage-service/imessage_server.py`'s `h_messages` queries chat.db `ORDER BY m.date DESC`
  (for the `LIMIT`) then calls `messages.reverse()` before returning, undocumented in either
  file. A consumer wanting the THREAD'S LATEST message (e.g. `_agenda.ts`'s `unanswered_text`
  detector, #849) must read the LAST array element, not the first.
- **A PR stuck with `security-review` (or `skill-sync`) failing isn't necessarily a real
  finding** — both are reusable workflows checked out from `SuxOS/.github` (see
  `.github/workflows/security-review.yml`'s `uses: SuxOS/.github/.github/workflows/
  security-review.yml@main`), and as of 2026-07-18 that repo 404s ("Repository not
  found") for both `gh api repos/SuxOS/.github` and the CI runner's own checkout step —
  confirmed on PR #870's failing run. That's an org-level infra outage, not a code
  problem in this repo, and it fails EVERY PR's security-review/skill-sync check the
  same way, not just one. Don't spend a build session trying to "fix" the finding by
  editing the PR's diff; check the failing job's raw log (`gh run view <id> --log-failed`)
  for a bare git-checkout 404 before assuming there's a real security issue to address,
  and drop chained issues that depend on the stuck PR merging (e.g. #865-#867 depending
  on #864's #870) back to the queue until a maintainer restores `SuxOS/.github` or the
  branch protection rule is adjusted.
- **An issue whose body says "depends on #N" and whose fix is "teach the dispatcher/
  queue to check that" (e.g. #869) isn't buildable from inside this repo** — the
  batch dispatcher that hands issues to bot-build sessions is external tooling, not
  code that lives in `sux/`; a grep for `dispatch` here only turns up unrelated MCP
  tool-call dispatch (`dispatch-guards.ts`). Verify the dependency's own state instead
  (`gh issue view #N --json state`) and drop the dependent issue back to the queue if
  it isn't merged yet, same as the `#865-#867` case above.
- **A closed issue's `COMPLETED` state doesn't guarantee the described work actually
  shipped** — a batch-build PR's body lists `Closes #n` for its whole original batch,
  and if one issue gets silently REDUCE-dropped without the drop being carved out of
  that list, merging still auto-closes it as done. Confirmed on #419 (VPC-hosted live
  vault): closed 2026-07-17 by PR #767's "drain low-priority backlog", but #767's diff
  only touches `_learning_folder.ts`/`dropbox.ts`/`tavily.ts`/`find_similar.ts` — no
  `vpc`/`cloudflared`/Workers-VPC code exists anywhere in `sux/src`. Before trusting a
  closed issue as done — especially one that once needed `needs-human`/`effort:large`
  — check that its closing PR's file list (`gh pr view <n> --json files`) actually
  touches the area the issue describes, not just that its state is CLOSED.
- **An issue-build PR can get auto-closed unmerged by an external "production-driver
  reconcile" process for going DIRTY (conflicting with `main`) while its issue(s) sit
  claimed (`building`) with no open PR — a "zombie claim-jam"** — this doesn't mean the
  underlying commit was broken. Confirmed on #765 (agenda inbound-reply loop): two
  separate attempts (orphaned commits `55e5e14`, then a fresher `e9f2487`) both shipped
  complete, tested implementations, and both PRs (#787, then #936) got closed by this
  reconcile rather than merged. `e9f2487` still `git cherry-pick`s cleanly onto current
  `origin/main` with zero conflicts. Before reimplementing an issue like this from
  scratch, check whether the latest orphaned attempt still applies cleanly — it usually
  does, since the DIRTY state is a timing artifact of `main` moving during the queue
  wait, not a real conflict with the change itself.
- **`imessage_server.py`'s `is_from_me` (surfaced as `imessage.ts`'s `from_me`) is an
  Apple-ID-account property, not a "which physical device" property** — if the Mac
  running `imessage-service` and Colin's phone are signed into the SAME Apple ID (the
  common case, since it's Colin's own devices), a message Colin sends from his phone
  syncs to the Mac's chat.db as `from_me: true`, identical to one the Mac itself sent.
  A self-chat (texting your own number) is therefore ALL `from_me: true` on both ends.
  `_imessage_reply.ts`'s inbound-command gate (#897) assumes a DEDICATED automation
  handle/number for the control channel and requires `from_me: false` (a message
  actually received from a trusted contact) — it will never fire for commands sent from
  a same-Apple-ID self-chat. Any future feature reading `from_me` to mean "the other
  person" should confirm which topology applies before trusting it.
- **An audit issue that says "X (fixed for #N in this PR)" describes code that landed
  in #N's OWN build session, not necessarily this branch's `HEAD`** — if #N is still
  open/`building` (unmerged), the referenced fix doesn't exist here yet, and the audit
  issue isn't buildable as an EXPAND pick until #N actually merges. Confirmed on #968
  (references `_cross_semantic.ts`'s pair cap "fixed for #959") and #969 (references
  `_infer.ts`'s `purgeInferDomain` cascade "fixed for #953") while both #959/#953 were
  still open/`building` with no landed fix on `origin/main` — skip issues like this
  rather than reimplement the prerequisite fix yourself just to unblock them.
- **The exact same original issue pair can be dispatched to two different concurrent
  build sessions** — confirmed 2026-07-19: this session and `bot/issue-build-29673247498`
  (merged as PR #970 moments before this one) were both independently handed `[869, 880]`
  as their starting batch, reached the identical drop decision for the identical reasons,
  and both then expanded into small backlog issues. Before spending a turn re-deriving a
  drop decision, `gh pr list --state open --search "<issue-number>"` (or check recently
  merged PRs) for a sibling session that already resolved the same batch — reuse its
  reasoning instead of re-deriving it from scratch.
- **#920 (per-request subrequest ledger / `env._budget`) has been independently dropped
  by 5 consecutive build sessions as of 2026-07-19, every time for the same reason: it's
  labeled `effort:large` and its own issue text says "genuinely large, not downscoped."**
  Don't spend a turn re-reading and re-deriving this — `gh issue view 920 --json comments`
  shows the prior drop notes. It needs a dedicated design+implementation session (likely
  opus-escalated per its effort label), not another batch-queue retry; if it keeps
  recurring in future batches unbuilt, that's a signal for a maintainer to route it
  differently rather than for another session to attempt it piecemeal.
- **An issue can have MULTIPLE orphaned-but-complete prior attempts, not just one** — #948
  (cross-domain-link cron sweep) had two independent, fully-tested implementations sitting
  on orphaned commits (`56aa5f5` via closed PR #958, `93492ee` via closed PR #957, both
  closed unmerged ~10s apart by the same concurrent-dispatch pattern as the #920 note
  above) before this session's build. `git cherry-pick -n <sha>` the more complete/recent
  one directly (only `cron-heartbeat.ts`'s `CRON_JOBS` array needed a manual merge against
  jobs added since) rather than reimplementing from the issue text — much faster and
  proven-tested.
- **When an issue has already been dropped several times in a row for the SAME unchanged
  reason (an `effort:large` self-description, or a fix that lives entirely outside this
  repo), self-apply the `needs-human` label rather than dropping it yet again** — a comment
  alone doesn't stop the automated batch dispatcher from re-claiming it, but `needs-human`
  does (it's already one of the standard EXPAND-exclusion labels). Confirmed 2026-07-19:
  #920 (`env._budget` ledger) hit its 6th consecutive same-reason drop and #977 (stuck-PR
  watcher) turned out to be unbuildable for a NEW reason — its actual bug lives in the
  reusable workflow file inside the external `SuxOS/.github` repo (`pr-watch.yml`, pulled in
  via `uses: SuxOS/.github/.github/workflows/pr-watch.yml@main`), not anywhere in `sux/`, so
  no amount of re-reading this repo's code will ever turn up a fix. Both got `needs-human`
  applied directly rather than left to keep churning the queue.
- **An issue whose actual ask is "re-file this as its own tracking issue" (an audit issue
  auditing another issue/PR's scope, not the code itself) has no code diff as its deliverable
  — the deliverable IS `gh issue create`.** Confirmed on #984 (asking to split MyChart's
  still-unbuilt Part A+B off from #891 once #891's detector-wiring half shipped): there was
  nothing to change in `sux/src`, so the build step was filing issue #986 with the scoped
  Part A+B description, then marking #984 `built` in the disposition (its `Closes #984` on
  the PR is earned by the new issue existing, not by a commit). Don't mistake "no diff for
  this issue" for "unbuildable" — check whether the issue's own text is asking for an
  out-of-band action before dropping it.
- **Fastmail's ContactCard (`contact_search`/`contact_get`, see `mail-mcp.ts`'s
  `shapeContact`) exposes no starred/important/favorite field** — only id/name/company/
  emails/phones. An issue that assumes "fan `contact.search` for important/starred
  people" (e.g. #930's original sketch) can't be built as literally described; the
  nearest buildable proxy is "the people you actually talk to" via an existing signal
  stream (iMessage threads, mail senders), not a contact-importance flag. Confirmed
  while building #930's relationship-decay detector, which fell back to reusing
  `_agenda.ts`'s existing `TextThreadRef` (iMessage) population instead.
- **An auto-filed "sux production deploy failed" issue (opened by `.github/workflows/
  deploy.yml`'s failure handler) isn't necessarily a real code regression** — #956's linked
  run failed on `git clone https://github.com/SuxOS/suxlib.git` returning "Repository not
  found", the same transient-external-repo-404 shape already known for `SuxOS/.github` above,
  just hitting the deploy workflow's own suxlib checkout step instead. Every `deploy.yml` run
  since (`gh run list --workflow=deploy.yml`) succeeded. Before treating one of these as
  something to fix, check whether later deploy runs already went green — if so it was a
  momentary outage, not a bug in the merged commit.
- **After #1004's fix, `INFER_ARM_FILES`/domain `"files"` in `_infer.ts` has ZERO production
  call sites** — `ingest.ts`'s vault-note write now correctly tags its signal domain `"vault"`
  (that write always lands as a markdown note in the git-backed vault, never Dropbox). Arming
  `INFER_ARM_FILES` today is a genuine no-op, not a latent bug to chase; a real Dropbox-files
  signal feed needs a NEW call site (e.g. in `files.ts`/`dropbox.ts`) before that arm does
  anything.
- **#986's Part A (MyChart multi-org registry — `MYCHART_ORGS`, per-org KV keys/PHI paths,
  `/mychart/connect?org=`) is DONE and merged** (commit `22622f7`, PR #991) — `mychart.ts` on
  `main` already has it. Part B (durable pull on the op-engine: a new `caps.health` effect, a
  `mychart-pull` op, `StepConfig` threading through `interpretDurable`, `wrangler.jsonc`
  subrequest limits) is still entirely unbuilt and is `effort:large` in its own right; the
  design doc's own build order (§7) treats it as a separate PR after Part A. Don't re-verify
  Part A's state from scratch (`git grep MYCHART_ORGS origin/main` settles it in one call) —
  go straight to scoping Part B alone, and expect it to need its own dedicated session per the
  `effort:large` precedent (see the `#920` gotcha above), not a batch slot alongside other work.
- **A `building`-labeled issue can already be fully shipped on `main`** if the PR that built it
  skipped/lost its disposition record — PR #1010's body literally says "Related to #1008 (not
  auto-closed — no disposition record, please verify)" for both #1008 and #1009, yet its diff
  (`git show b3f70b3 --stat`) fully implements both. Before building an open, `building`-labeled
  issue, `git log --all --oneline | grep -i <keyword>` (per the orphaned-commit gotcha above) —
  it may turn up a MERGED commit, not just an orphaned one. Drop it with `"superseded": true` in
  the disposition so it closes instead of getting rebuilt.
- **An issue whose auto-build comment thread just says "couldn't get the gates green" (no
  detail) can hide a specific, checkable cause** — `gh run view <run-id> --log` (or `--json
  jobs`) on the linked run often shows the real reason before you re-attempt blindly. Confirmed
  on #1046 (unify `confirm:true` delete gates onto `staged()`): all 6 prior attempts' linked
  runs showed the identical `Action failed with error: Claude execution failed: Reached maximum
  number of turns (90)` — the session ran out of turn budget mid-build, not a design/gate
  problem — which combined with its own `effort:large` label was enough to apply `needs-human`
  immediately (per the `#920` precedent above) instead of attempting a 7th identical-shaped
  retry. Also: the issue's own premise can be partly stale even when the label says otherwise —
  #1046 named calendar's `delete`/`task_delete` as still gated by a bare `confirm:true`, but
  `fns/calendar.ts` only dispatches into `mail-mcp.ts`'s `cal_delete`, which already routes
  through `staged()`/`STAGE_KINDS` (added earlier for mail/contact/cal/task) — only the doc
  string in `calendar.ts` was stale, not the actual gate.
- **A suxlib type-shape change can break more call sites than an audit issue names** — #1069
  named `sink.fanout("r2", "vault")` → `sink.fanout(["r2", "vault"])` at its two literal call
  sites, but suxlib's `SinkFanoutTarget = string | {name, opts?}` union also broke
  `op-engine/durable.ts`'s `interpretDurable`'s `"sink"` case, which indexed `caps.sinks[t]`
  by the whole target instead of extracting `t.name` — a downstream CONSUMER of the type, not
  a call site of the changed function, invisible to a grep for `sink.fanout`. When a suxlib
  signature/type changes, `npm run type-check` after the named fix (not just editing the named
  lines) is what catches the rest — don't assume the issue's file list is exhaustive.
- **#1078 (enable `noUncheckedIndexedAccess`) is blocked, not just large** — flipping it in
  `sux/tsconfig.json` surfaces 92 errors inside `../suxlib`'s own `.ts` sources too (the `file:`
  dep's raw sources share sux's one global `compilerOptions` block; `skipLibCheck` only exempts
  `.d.ts`), and `.github/workflows/ci.yml` clones that same raw `.ts` source for real CI — so
  this isn't a sandbox artifact skip-able by trusting real CI. Don't re-attempt #1078 until
  suxlib gets its own fix landed first (separate repo/PR — `../suxlib` is read-only here). See
  `docs/design/improvement-backlog.md` item #10 (#1080).
- **A test asserting a literal `"Daily/YYYY-MM-DD.md"` string against code that calls
  `vaultToday()`/`new Date()` is a date bomb — it passes only until real wall-clock time rolls
  past that hardcoded day, then fails for EVERY branch/PR, not just the one that happens to run
  it that day.** Confirmed on `_infer_nudge.test.ts`'s digest-block test, which hardcoded
  `Daily/2026-07-19.md` and started failing on real CI + every sandbox `npm test` run once the
  date ticked over to 2026-07-20 (#1085's build hit this while working an unrelated issue). Fix
  pattern: compute the expected path the same way the code under test does (`` `Daily/${vaultToday("UTC")}.md` ``),
  never a literal date string. If a gate fails on a test unrelated to your diff, `git stash` and
  re-run on a clean checkout before assuming it's pre-existing-and-ignorable — if it's a date
  bomb like this one, it blocks every PR today and is worth fixing inline rather than reporting
  as unrelated noise.
- **`_capped_kv_log.ts`'s `update(mutate)` (added for #1090) skips its `save()` call when
  `mutate` returns the EXACT SAME array reference it was given — that's the deliberate no-op
  signal for "nothing changed, don't write." A `mutate` that edits the array IN PLACE and
  returns that same reference (e.g. `items.unshift(x); return items;`) therefore silently never
  persists, which is exactly why `push()` itself builds a new array (`[...entries, ...items]`)
  instead of mutating and returning `items`. Any new `update()`/`push()` caller must return a
  fresh array whenever a write should actually happen — only hand back the original reference
  for the genuine "no change" case (see `_infer.ts`'s delete/purge paths for the pattern).

- **`gh api repos/SuxOS/.github` 404s from inside a bot-build sandbox even when the repo/action
  is fine** — that token just lacks visibility into the private hub repo. Before assuming a
  reusable workflow/action (`SuxOS/.github/.github/{workflows,actions}/*`) doesn't exist or
  guessing its input names, check `/home/runner/work/_actions/SuxOS/.github/main/` — the
  runner's local Actions cache from checking out this very job's own reusable-workflow refs
  already has a full local checkout of the hub repo, `action.yml`s included. Confirmed while
  building #1105 (converting `deploy.yml`/`health.yml`'s hand-rolled tracking-issue upserts onto
  the hub's `upsert-tracking-issue` composite action) — reading its `action.yml` there gave the
  exact input names (`title`/`body`/`github-token`/`mode`/`update-mode`/`labels`) instead of
  guessing blind.
- **An audit issue asking to "re-file the real bugs behind N historic empty self-improve
  merges" needs each one re-verified against CURRENT `main`, not trusted from the original
  report** — of the 8 bugs audited for #1119, 6 turned out already resolved by unrelated
  later work (mail_sieve_backfill's 50-cap by #684/#931, ingest{url}'s 0-byte binary fetch by
  #505's `smartFetch` fallback, vault_delete's confirm gate by #1054's stage() rebuild, amazon's
  mac-render 502 by #742 dropping the mac tier entirely, and — notably — BOTH #1114's and
  #1020's "binary uploads need a way to mint a ref without inlining base64" ask, already
  solved by #910's `POST /s/up` raw-bytes upload door, which merged 2026-07-18, *before*
  either of those two stub PRs merged empty on 2026-07-19/20) and one (#477's vault
  write-path-arg) never reproduced against the code even at filing time. Only the remaining 2
  (#1120, #1121) were genuinely still live. Don't blindly re-open all N as fresh issues —
  check each claim's current file:line first, since a lot of drive-by self-improve reports
  get overtaken by unrelated feature work before anyone re-audits them.

- **`automerge.yml`'s real eligibility rule (since its 2026-07-15 rewrite) is just "not draft &&
  not labelled `hold`"** — the older safe-type-title/eligible-label taxonomy some in-repo
  comments still describe is gone from the actual reusable workflow (verify against the local
  hub checkout, `/home/runner/work/_actions/SuxOS/.github/main/.github/workflows/automerge.yml`,
  not stale comments). Any code that opens a PR in this repo and assumes WITHHOLDING an
  "eligible" label (e.g. `automerge`) is enough to keep it from merging is wrong — only the
  `hold` label actually blocks native auto-merge; everything else auto-merges the instant
  required checks go green. This bit `_self_improve.ts`'s stub PRs hard: their initial commit
  is tree-identical to `main`, so CI passes trivially and instantly, and 8/8 checked
  self-improve merges on `main` turned out to be empty no-ops — the described fix never
  actually landed (#1116). Any future PR-opening automation must explicitly apply `hold`
  itself if the PR isn't meant to auto-merge yet.

- **`ocr.ts`'s `ocr` fn only accepts an image (`url`/`image` → Workers-AI vision) — it has no PDF
  path.** A feature ingesting scanned personal documents (passport, license, a PDF scan) can't
  just point everything at `ocr`; a PDF needs `study.ts`'s `extractDocText` (or a Mode-A shared-
  link + `study` pdf-kind path, per the Dropbox-Mode-A/B gotcha above) instead. `_document_radar.ts`
  (#1148) scoped its first cut to images only for exactly this reason — PDF ingestion is a
  distinct follow-up, not an oversight.

- **A bot-build sandbox's `gh api repos/SuxOS/suxlib` / a fresh `git clone`/`git ls-remote`
  against suxlib 404s ("Repository not found") — the sandbox's `gh`/`GH_TOKEN` has zero
  visibility into suxlib, same as the `SuxOS/.github` gotcha above — but the sandbox's
  PRE-CLONED `../suxlib` checkout (used for `npm ci`/type-check/test) carries its OWN
  embedded `x-access-token` remote with real read access: `git -C ../suxlib fetch origin
  main && git rev-parse origin/main` resolves suxlib's actual current tip SHA even though
  `gh api`/a fresh clone can't. This is how #1149's suxlib pin (`.suxlib-ref`, read by
  `ci.yml`/`deploy.yml`/`e2e-mcp.yml`'s clone steps) got seeded with a real SHA instead of
  a `main` sentinel — check `../suxlib`'s own remote before assuming a suxlib ref is
  unresolvable from inside a sandbox.
- **The `../suxlib` sandbox gotcha above ("Cannot find module") isn't the only shape this
  takes — a sandbox's `../suxlib` checkout can also resolve fine but sit at a DIFFERENT
  commit than what real CI clones fresh at run time, producing real-looking but sandbox-only
  type/runtime errors.** Confirmed while building #1071: this session's `../suxlib` had
  `sink.fanout`'s signature as `(targets: SinkFanoutTarget[], opts?)` (a single array arg),
  which made `registry.ts`'s existing `sink.fanout("r2", "vault")` call (two bare strings)
  fail `tsc` AND made `sux/src/op-engine/tracer.test.ts`'s inline run throw `node.targets.map
  is not a function` at runtime — yet `gh run view <latest-main-run-id> --log` showed real
  CI's OWN fresh `git clone --branch main` of suxlib, run minutes later, passing `tsc` and
  `npm test` cleanly on the identical sux commit. Same verification as the missing-module
  case applies: reproduce on a clean `main` checkout first (here, `git stash` and re-run) — if
  the failure is identical before your diff, it's the sandbox's suxlib pin, not your change or
  a real `main` break, no matter how specific/real the error looks. Don't hand-fix the sux-side
  call site to match your sandbox's suxlib shape; it'd likely just break it again against
  real CI's actual (possibly older, possibly newer) suxlib.

## House style

- No trailing/inline comments explaining the obvious; comment *why*, not *what*.
- Bidirectional naming (a reader can go name→behavior and behavior→name).
- Match surrounding code's idiom, comment density, and structure.
- One change per cycle; land it green before starting the next.

## Converting a bare `confirm:true` delete onto `stage()`/`STAGE_KINDS` (#1046 series)

- `stage()`'s KV-backed `commit()` (and `stage()` itself) can genuinely THROW (bad/expired/
  mismatched `commit_token`) — a `raw:true` fn's `run()` calling `staged()` must wrap that
  call in its own try/catch (or already have an outer one covering it, like `dropbox.ts`/
  `todoist.ts`) and turn the throw into `fail(...)`. `kv_delete.ts` didn't, and `fuzz.test.ts`
  (which feeds every fn garbage `commit_token`s) caught it immediately (#1051) — the
  "fns never throw" invariant applies here same as anywhere else.
- `ok()` (from `registry.ts`) takes a STRING, not an object — a converted fn returning
  `staged()`'s `StageResult` must `ok(oj(stageResult))`, not `ok(stageResult)` directly.

## sux's `/mcp` transport is fully stateless — no session, only OAuth `login`

- `index.ts`'s `handleRpc` implements NO `Mcp-Session-Id` / Durable-Object session — every
  request (`initialize`, `tools/call`, ...) is handled independently with zero correlation
  between them. The ONE identity signal present on every single request is the OAuth-
  authenticated `login` (`ctx.props?.login`, set by `OAuthProvider` before `rtServer.fetch`
  runs). A feature that needs to remember something about "this connection" across requests
  (client capabilities, a multi-step flow, per-client rate limiting, ...) has to key off
  `login` — there is no session id, and `tools/call` never resends `initialize`'s params
  (`clientInfo`, `capabilities`), so those are only ever visible at the one `initialize` call
  site. `login` is threaded onto `RtEnv._egress.login` (`proxy.ts`'s `EgressContext`) for this
  purpose (#1143's client-UI-capability negotiation in `fns/_ui.ts` is the first consumer) —
  reuse that field rather than re-deriving the `ctx as ExecutionContext & {props?: Props}`
  cast at a new call site. Known imprecision: two different client apps authenticated under
  the same GitHub login collide (last `initialize` wins for both) — accepted as the best
  signal this architecture offers, not a bug to "fix" without adding real session infra.

- **An `effort:large` issue previously dropped under the "#920 precedent" (needs a dedicated
  session, not a batch slot) deserves a fresh look when it's the ONLY issue in the current
  batch** — that precedent is about an `effort:large` issue losing to sibling issues competing
  for the same turn/time budget, not about the work being inherently unbuildable in one
  session. #1144 (scalar trend/anomaly detector, dispatched solo after an earlier batched
  attempt dropped it for exactly that reason) built clean well under budget once it had the
  whole session to itself — a new sibling module, a second nudge-recipe path, cron wiring, and
  tests. Re-check the batch's actual issue count before reflexively re-dropping.

- **`op-engine/durable.ts`'s `interpretDurable` only maps `LeafOpts.retries`/`SinkOpts.retries`
  onto `step.do`'s `WorkflowStepConfig` (#1071) — `heavy`/`memo` still have no durable
  equivalent.** suxlib's inline interpreter (`control/governor.ts`'s `runGoverned`) implements
  `heavy` as a second concurrency gate and `memo` as a `caps.cache` short-circuit; Cloudflare
  Workflows has no built-in primitive for either, so a durable op declaring them silently gets
  neither (no error) — same class of gap the retries fix closed, just not mapped yet. A leaf
  authored assuming heavy-concurrency or memo parity between inline and durable runtimes will
  be wrong until `caps.governors`/`caps.cache` get threaded into `makeCaps` for the durable
  path (`op-engine/caps.ts`) and `interpretDurable` calls `runGoverned` (or an equivalent)
  instead of the bare `node.fn(input, caps)` it calls today.
