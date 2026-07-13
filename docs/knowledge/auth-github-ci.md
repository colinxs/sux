# Auth, MCP surface, and GitHub/CI machinery

Durable reference so future sessions don't re-fetch. Ground truth: `sux/src/*.ts`,
`.github/workflows/*.yml`, `CLAUDE.md`, and memory `autonomous-pipeline-lessons` (#9–11).
Last verified 2026-07-12.

---

## 1. MCP OAuth — how the Worker gates `/mcp`

The Worker is wrapped by **`@cloudflare/workers-oauth-provider`**. The provider is
instantiated lazily (`getOAuthProvider()` in `sux/src/index.ts:429`) with:

- `apiRoute: CONNECTOR_PATHS` — the paths that require a bearer token (from
  `connectors.ts`; currently just `["/mcp"]`).
- `apiHandler: rtServer` — the MCP server that runs **after** the auth gate.
- `defaultHandler: GitHubHandler` — everything else (`/authorize`, `/callback`,
  `/health`), served **before** the gate.

### The GitHub-login gate (`sux/src/github-handler.ts`)

Flow: MCP client hits `/authorize` → approval dialog (CSRF-protected, cookie-remembered
per client) → redirect to GitHub OAuth (`scope=read:user`) → `/callback` exchanges the
code for a GitHub access token → **`isAllowedLogin(login, ALLOWED_GITHUB_LOGIN)`** rejects
any GitHub user not on the allowlist with a 403 → on success
`OAUTH_PROVIDER.completeAuthorization` mints the MCP token, storing `{accessToken, email,
login, name}` as `Props`.

Environment / secrets (managed via `wrangler secret put`, NOT in `wrangler.jsonc`):

| Var | Role |
| --- | --- |
| `OAUTH_PROVIDER` | Binding to the workers-oauth-provider `OAuthHelpers` (issues/validates MCP tokens). |
| `OAUTH_KV` | KV namespace: OAuth state (`oauth:state:*`), approved-client records, token store; also health-cache + heartbeats + fn-cache. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | The GitHub OAuth App used as the login IdP for the gate. |
| `COOKIE_ENCRYPTION_KEY` | Signs/encrypts the "approved client" cookie (`workers-oauth-utils.ts`) so the approval dialog isn't re-shown each time. |
| `ALLOWED_GITHUB_LOGIN` | Comma-separated allowlist of GitHub logins. Empty ⇒ nobody passes the gate. The single authZ check. |

Note: `GITHUB_TOKEN` in `github-auth.ts` is **unrelated** — it's an optional PAT attached
only to outbound fetches of GitHub-owned hosts (raises 60→5000/hr) and is host-scoped so it
can't leak to arbitrary origins. Not part of the login gate.

### `/health` (unauthenticated, `defaultHandler`, before the gate)

Served to anonymous visitors, so `redactPublicHealth()` strips the residential proxy's exit
IP/geo/org and the node's Tailscale hostname/IPs before rendering. Cached 60s in
`OAUTH_KV` (`sux:health:public`) to cap anonymous probe floods. `?format=json` for JSON;
returns 200 when healthy, 503 when degraded. The daily `health.yml` smoke-checks that an
**unauthenticated `/mcp` request returns 401** — 401 is the healthy signal (gate enforcing).

### The connector model (`sux/src/connectors.ts`)

One `/mcp` front door. `CONNECTORS` is the single source of truth that feeds the OAuth
`apiRoute` list, the `GET /mcp/connectors` discovery manifest, and the marketplace
drift-check. The old per-domain connectors (`/vault/mcp`, `/mail/mcp`, `/files/mcp`) are
**retired** — those capabilities now live on the one door as `vault_`/`mail_`/`files_`
verbs. Add a namespace to the `CONNECTORS` array and it routes + self-describes in one edit.

---

## 2. GitHub API + Actions used by the pipeline

- **`actions/create-github-app-token@v3.2.0`** — mints a **`SUX_BOT` GitHub App** token
  (`app/sux1241`) from `SUX_BOT_APP_ID` + `SUX_BOT_PRIVATE_KEY`. Used by every workflow that
  **pushes or arms auto-merge** (`claude.yml`, `claude-autofix.yml`, `pr-auto-update.yml`,
  `pr-drain.yml`, `automerge.yml`, `budget-guard.yml`). Reason in §3.
- **`actions/github-script@v7`** — REST calls for the upsert-a-tracking-issue pattern
  (`deploy.yml`, `health.yml`, `pr-watch.yml`, `budget-guard.yml`).
- **`gh` CLI + `jq`** — read-only PR classification and `gh pr merge --auto`,
  `gh pr update-branch`, `gh pr edit --add-label`, label/comment mutations.
- **`cloudflare/wrangler-action@v4`** — the actual prod deploy (`CLOUDFLARE_API_TOKEN` +
  `CLOUDFLARE_ACCOUNT_ID`).
- **GitHub REST billing API** — `budget-guard.yml` reads used Actions minutes.
- **Repo variable `ACTIONS_BUDGET_PAUSED`** — race-free brake flag the discretionary
  workflows gate their `if:` on.
- **Native GitHub auto-merge** — the pipeline only *enables* it; GitHub merges once branch
  protection is satisfied. Merge method: squash.

---

## 3. `anthropics/claude-code-action@v1` — critical operational knowledge

Used by `claude.yml` (mention + review), `claude-autofix.yml` (CI-failure fixer), and
`security-review.yml` (gating security reviewer).

### Action outputs (from `action.yml`, verified)

| Output | Meaning |
| --- | --- |
| `structured_output` | JSON string of all structured fields **when `--json-schema` is in `claude_args`**. Read via `fromJSON(steps.<id>.outputs.structured_output).<field>`. **cwd-independent** — the correct way to get a machine verdict. |
| `execution_file` | Path to the Claude Code execution log file. |
| `branch_name` | Branch the action created for this run. |
| `github_token` | The token the action used (App token if available). |
| `session_id` | Claude Code session id (usable with `--resume`). |

Key inputs: `prompt`, `claude_args` (passes flags straight to the CLI:
`--max-turns`, `--model`, `--json-schema`, `--allowedTools`), `anthropic_api_key`,
`github_token`, `trigger_phrase`. Inert until `ANTHROPIC_API_KEY` is set (every workflow has
a preflight `go=false` skip). `ENABLE_PROMPT_CACHING_1H` is a Claude-Code **env passthrough**
(1-hour prompt-cache TTL), set on the step's `env:`, not a named action input.

### Gotchas (the load-bearing ones — memory `autonomous-pipeline-lessons`)

1. **Self-skips on any PR that edits a workflow file (#11).** The action's OIDC→app-token
   exchange requires the workflow file be **byte-identical to the default branch**
   (anti-exfiltration). On a workflow-editing PR the model **never runs** (~7s, no turns), so
   the PR can never self-certify security-review in CI → **workflow PRs need a human merge**
   (remove `hold` / admin-merge past the red check). By design. Corollary: **consolidate
   workflow changes into as few PRs as possible** — one reviewed hardening PR beats four
   self-skipping ones.

2. **`GITHUB_TOKEN` pushes don't trigger CI (#9).** "Events triggered by the GITHUB_TOKEN
   will not create a new workflow run" (except `workflow_dispatch`/`repository_dispatch`) —
   anti-recursion. So a bot push/rebase/merge attributed to `GITHUB_TOKEN` never re-fires
   `ci`/`security-review`, the required checks stay missing, and the queue stalls looking
   green (diagnosis tell: a PR with only 1 check present while `main` requires 4). **Fix:
   push with the `SUX_BOT` App token** (`create-github-app-token`) — it looks like a user
   push and fires CI. Must be applied to **all** pushers (autofix, mention, auto-update,
   drain, automerge).

3. **A written verdict FILE is cwd-fragile (#10).** `claude-code-action` runs Claude in a
   sandbox cwd ≠ `$GITHUB_WORKSPACE`, so a model-written `.sec-verdict.json` landed where the
   gate couldn't find it → the security net read "no verdict" for weeks, silently
   advisory-passing PRs unreviewed. **Get the verdict from the `structured_output` step
   output via `--json-schema`, not a file.** Meta-lesson: periodically confirm a gate emits a
   real PASS/FAIL, not just a green check. *(Note: `security-review.yml` currently still uses
   the file-write + blast-radius-gated fail-closed pattern; migrating it to `structured_output`
   is the standing fix.)*

Sources: [claude-code-action action.yml](https://github.com/anthropics/claude-code-action) ·
[GITHUB_TOKEN recursion prevention](https://docs.github.com/en/actions/concepts/security/github_token) ·
[Triggering a workflow](https://docs.github.com/actions/using-workflows/triggering-a-workflow)

---

## 4. The CI gate set + the pipeline workflows

### Required checks (branch protection, `main`, `strict=true`)

`CLAUDE.md` + `ci.yml` (job name **"Type-check & build"**). All must pass:

1. `npm run type-check` (`tsc --noEmit`)
2. `npm test` (`vitest run`)
3. `npm run check:node` — node deploy blob in sync with `server.mjs`
4. `npm run gen:index` → `git diff --exit-code sux/src/fns/index.ts` (fn index in sync; the
   one generated file that IS committed — the Worker imports it)
5. `wrangler deploy --dry-run` (bundles/config deployable)

`strict=true` means a PR must be **up-to-date with `main`** to merge — hence the
auto-update limb (`pr-auto-update.yml`). Branch protection also requires the
`security-review` check. Losing branch protection (e.g. going private without Pro, #4)
silently disarms the whole "green gates the merge" safety — re-verify after any visibility
change.

### Workflow map

| Workflow | Trigger | Purpose | Gotcha |
| --- | --- | --- | --- |
| `ci.yml` | push, pull_request (all branches) | The 5 required checks (job "Type-check & build"). | Concurrency cancels in-progress per ref. |
| `deploy.yml` | push to `main`, workflow_dispatch | Re-runs the CI floor, then `wrangler deploy` to prod. Opens/updates a tracking issue on failure. | `main` auto-deploys — every merge is a release. Does NOT touch secrets. |
| `claude.yml` | issue/PR/review comment (`@claude`), PR opened/ready | Mention bot (can push fixes) + a `/code-review` pass on non-draft PRs. | Trusted authors only (public repo); pushes with SUX_BOT token so CI fires; gated on `ACTIONS_BUDGET_PAUSED`. |
| `security-review.yml` | pull_request opened/synchronize/reopened/ready | Opus security review; **hard-blocks** merge on high/critical by applying `hold` + exit 1. Distinct check name `security-review`. | Self-skips on workflow-editing PRs (#11) → those need human merge. Missing-verdict handling is blast-radius-gated (workflows/auth/secrets ⇒ fail-closed). |
| `claude-autofix.yml` | workflow_run (CI) completed=failure | Reads the CI failure and pushes a fix to the PR branch; native auto-merge lands it if green. | Safe PR classes only; `MAX_ATTEMPTS` cap then `needs-human`; RCE guard = same-repo trusted authors only; SUX_BOT push. |
| `automerge.yml` | pull_request_target (opened/…/labeled/edited) | Enables **native** auto-merge (squash) on the safe hands-off subset. Only enables, never force-merges. | Uses `pull_request_target` but never checks out PR code; trusted authors only (+ `self-improve`-labelled bot PRs); features/`hold`/`!` excluded. Enables with App token. |
| `pr-auto-update.yml` | push, schedule (`17 */2 * * *`), dispatch | `gh pr update-branch` on armed-but-BEHIND PRs so the strict-mode queue self-drains. | Pushes to PR branch only (can't self-loop on push:main); SUX_BOT token. |
| `pr-drain.yml` | schedule (`37 6 * * *`), dispatch | Close-stale (`self-improve`/`needs-human` idle > 14d) + reconcile (arm auto-merge on eligible-but-unarmed green PRs). | No checkout; `hold`/`keep` opt-out; every mutation `|| true`; SUX_BOT token. |
| `pr-watch.yml` | schedule (`23 */6 * * *`), dispatch | **Read-only** stuck-PR detector → one rolling "Stuck PRs" tracking issue. | Never merges/mutates a PR. |
| `budget-guard.yml` | schedule (hourly), dispatch | Pauses ONLY discretionary spenders (`claude.yml`, `claude-autofix.yml`) when used Actions minutes cross `BUDGET=2500` (resume < 2400). | Never touches safety/deploy gates; no-op if billing read fails; sets `ACTIONS_BUDGET_PAUSED` + `gh workflow disable`. |
| `health.yml` | schedule (`17 9 * * *`), dispatch | Daily regression canary (tests) + live smoke (`/mcp` must 401). Opens/updates a tracking issue on failure. | 401 is the healthy response (gate enforcing). |
| `audit.yml` | push, pull_request, schedule (`0 7 * * 1`) | `npm audit` fail on high/critical CVEs + CycloneDX SBOM artifact. | Registry/network failure ⇒ advisory (`::warning::`), not red. |
| `secret-scan.yml` | push, pull_request | gitleaks; fails the build on a committed secret. Allowlist in `.gitleaks.toml`. | A gitleaks *action* crash ("Resource not accessible by integration") is a token-perms issue, NOT a leak (#5); comment/upload side-channels disabled. |
| `skill-sync.yml` | schedule (`0 14 * * 1`), dispatch, pull_request | Enforces skill/plugin/fn-reference sync (`check-skill-sync.mjs`); fix job re-mirrors + opens a `bot/docs-update` PR. | Offline, no secrets; FUNCTIONS.md is gitignored so only the mirrored plugin skill can drift. |

Autonomy policy (memory `sux-deploy-autonomy-policy`): fixes merge+deploy autonomously;
features/security land as PRs a human arms; safe types = `fix|security|perf|refactor|chore|
docs|test|build|ci|revert` or labels `automerge|bug|security|chore-safe`.
