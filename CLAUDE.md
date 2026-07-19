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

## House style

- No trailing/inline comments explaining the obvious; comment *why*, not *what*.
- Bidirectional naming (a reader can go name→behavior and behavior→name).
- Match surrounding code's idiom, comment density, and structure.
- One change per cycle; land it green before starting the next.
