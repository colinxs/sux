# Merge queue — the collated-merge model

Status: **built, not yet enabled.** This PR lands the workflow changes that make the
GitHub-native merge queue *safe to turn on*. Enabling it (branch protection / ruleset)
is a separate, verified step — see [Enabling the queue](#enabling-the-queue). Until then
the pipeline behaves exactly as before.

Ground truth: `.github/workflows/*.yml`, `docs/knowledge/auth-github-ci.md`, `CLAUDE.md`.

---

## Why

The old model was **4 bots each racing to land on `main`**: every eligible PR armed native
auto-merge, and because branch protection is `strict=true` (a PR must be up-to-date with
`main` to merge) each merge flipped every other PR `BEHIND`, forcing a rebase-treadmill
(`pr-auto-update.yml`) to re-push and re-run CI. Each merge is also a **release**:
`deploy.yml` fires on every push to `main`, so N merges = N full prod deploys, N racing
rebases, and a thundering-herd of CI reruns.

The **merge queue** replaces that with one collator:

- PRs are *added to a queue* instead of merged directly. GitHub forms a **merge group** —
  a speculative `gh-readonly-queue/main/...` branch containing one or more queued PRs
  rebased onto the current queue head — runs the required checks there, and merges the
  whole group in one shot when green.
- **Batching N PRs → 1 merge → 1 push to `main` → 1 deploy.** This is the whole point:
  it collapses N deploys into one and eliminates the rebase treadmill (the queue does the
  rebasing itself, against the queue head, so PRs no longer need to be up-to-date with
  `main` before queueing).

---

## The load-bearing invariant: required checks MUST run on `merge_group`

> **Every workflow that produces a branch-protection required check must ALSO trigger
> `on: merge_group`, or the queue freezes forever.**

The queue validates the required checks on the speculative `gh-readonly-queue/...` ref via
the `merge_group` event. A required context that is **never reported** on that ref stays
pending and the merge **fails / the queue stalls** ([GitHub: managing a merge queue]).
(Contrast: a job that IS triggered on `merge_group` but *skips* via a job-level `if:`
reports `Success` — a skip auto-passes and does not stall. We still prefer an explicit
run-and-pass for security-review so the check means something.)

The check **context name is the job `name`** and is identical across `pull_request` and
`merge_group` runs — so branch protection matching (which is purely by name) is satisfied
by the merge_group run with no context-string drift.

### The 4 required checks and where they come from

| Required check (context) | Workflow | Job | `merge_group` handling |
| --- | --- | --- | --- |
| **Type-check & build** | `ci.yml` | `check` | Runs fully on merge_group (no author gate). |
| **gitleaks** | `secret-scan.yml` | `gitleaks` | Runs fully on merge_group. |
| **npm audit & SBOM** | `audit.yml` | `audit` | Runs fully on merge_group. |
| **security-review** | `security-review.yml` | `security-review` | **Passthrough** — see below. |

All four now carry `on: merge_group`. Each byte-identical context name was preserved.

**`push` excludes the queue branches.** `ci.yml`, `secret-scan.yml`, and `audit.yml` also
trigger on bare `push` with `concurrency: cancel-in-progress: true` keyed on `github.ref`.
The queue's `gh-readonly-queue/**` branch creation fires a `push` on the *same ref* as the
`merge_group` event — they would share the concurrency group and **cancel each other**, and
a cancelled required check stalls the queue. So the `push` trigger now
`branches-ignore: ["gh-readonly-queue/**"]`; only the `merge_group` event drives CI on the
speculative ref.

**security-review is a passthrough on `merge_group`.** The opus security review is a
**PR-stage** gate: a high/critical finding applies the `hold` label, which makes the PR
ineligible for auto-merge, so it never enters the queue. By the time a PR is queued it has
already been reviewed, and the merge_group ref carries no PR to review. So on `merge_group`
the job short-circuits to a green no-op step (the required `security-review` context reports
`Success`) instead of re-running — and re-paying for — opus. It runs the real review only on
`pull_request`.

---

## Workflow changes in this PR

- **`ci.yml`, `secret-scan.yml`, `audit.yml`** — added `on: merge_group`; `push` now ignores
  `gh-readonly-queue/**` (collision fix above).
- **`security-review.yml`** — added `on: merge_group` + a `merge_group` passthrough step;
  the real review is gated to `pull_request`. Concurrency group falls back to the merge
  group head SHA when there's no PR number.
- **`automerge.yml`** — unchanged eligibility gating and SUX_BOT App-token pattern.
  `gh pr merge --auto --squash` now **enqueues** the PR under the queue (the method is the
  queue's; `--squash` is a harmless no-op kept for the queue-off case). The branch-protection
  assertion now reads **both** classic protection and repository **rulesets** (union), so a
  queue enabled via a ruleset doesn't make the gates look "unreadable" and jam auto-merge.
- **`pr-auto-update.yml`** — **retired** (`git rm`). The queue rebases against the queue head
  itself, so the strict-mode rebase-treadmill is obsolete.
- **`pr-drain.yml`** — kept. Close-stale is orthogonal (retained unchanged); reconcile still
  arms eligible-but-unarmed green PRs (now: enqueues them). Header updated (no longer refers to
  the retired auto-update workflow).
- **`pr-watch.yml`** — kept, but **no longer flags `BEHIND main`** as stuck: under the queue a
  PR being behind `main` is expected (the queue rebases it), so that classification was pure
  false-positive noise. Failing-check and idle-green-not-armed detection are retained.

---

## Enabling the queue

**Not done in this PR — this is the freeze-risk switch, applied separately after the workflow
changes above are on `main` and verified.** Do NOT enable the queue before the `merge_group`
triggers are merged, or the very first queued PR stalls.

The queue's merge method should be **squash** (the repo squash-merges today), and the queue's
required checks must be **exactly** the 4 contexts above — each of which now runs on
`merge_group`.

### Option A — repository ruleset (recommended, `gh api`)

```bash
gh api --method POST /repos/SuxOS/sux/rulesets --input - <<'JSON'
{
  "name": "main-merge-queue",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [
    {
      "type": "merge_queue",
      "parameters": {
        "merge_method": "SQUASH",
        "grouping_strategy": "ALLGREEN",
        "max_entries_to_build": 5,
        "min_entries_to_merge": 1,
        "min_entries_to_merge_wait_minutes": 5,
        "max_entries_to_merge": 5,
        "check_response_timeout_minutes": 60
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "Type-check & build" },
          { "context": "security-review" },
          { "context": "gitleaks" },
          { "context": "npm audit & SBOM" }
        ]
      }
    }
  ]
}
JSON
```

`merge_queue` parameters (enum values are UPPERCASE):

- **`merge_method`** — `SQUASH` (matches the repo's current behavior).
- **`grouping_strategy`** — `ALLGREEN` (every PR in a group must pass individually) vs
  `HEADGREEN` (only the group head must pass). Use `ALLGREEN` — a green batch shouldn't be
  merged if a member is red.
- **`max_entries_to_build`** — how many speculative `merge_group` builds run concurrently.
- **`min_entries_to_merge` + `min_entries_to_merge_wait_minutes`** — wait up to N minutes to
  accumulate the minimum group, then merge with fewer.
- **`max_entries_to_merge`** — max PRs merged together in one group (**the batch size**).
- **`check_response_timeout_minutes`** — how long the queue waits for a required check to
  report before treating it as failed. Keep ≥ the slowest required check (security-review is
  opus, up to ~20 min) → `60` is safe.

### Batching recommendation

Batching is the entire payoff (N PRs → 1 deploy). Recommended starting point:

- **`min_entries_to_merge: 1`**, **`min_entries_to_merge_wait_minutes: 5`** — never wedge a
  lone urgent fix waiting for company, but give a 5-minute window for PRs to collate when the
  queue is busy.
- **`max_entries_to_merge: 5`** — cap the batch so one flaky PR can't invalidate a huge group
  (ALLGREEN re-runs the group without the offender). Given this repo's PR volume, 3–5 is the
  sweet spot; raise it only if the queue is regularly full.
- **`max_entries_to_build: 5`** — bounded speculative parallelism (also bounds Actions
  minutes, which `budget-guard.yml` watches).

### Option B — classic branch protection UI

Settings → Branches → branch protection rule for `main` → check **"Require merge queue"** →
set **Merge method = Squash and merge**, **Build concurrency**, **Min/Max group size**, **Wait
time to build a merge group**, **Check timeout**, and grouping ("Only merge non-failing pull
requests" = ALLGREEN). Under **"Require status checks to pass before merging"**, ensure the 4
contexts above are listed by name. (Merge-queue checks validate on the `gh-readonly-queue` ref,
so those workflows must trigger `on: merge_group` — done in this PR.)

### After enabling — verify, don't assume

1. Open a trivial `chore:`/`docs:` PR, let automerge arm it, confirm it is **added to the
   queue** (not merged directly) and that all 4 checks report on the `gh-readonly-queue/...`
   ref.
2. Confirm it merges and `deploy.yml` fires once.
3. Only then trust the queue with real batches. If the first PR stalls with checks stuck
   "Expected/Pending" on the merge group, a required context is missing its `merge_group`
   trigger — fix that before proceeding.

[GitHub: managing a merge queue]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
