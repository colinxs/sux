---
title: Autonomous PR pipeline
status: active
---

# Autonomous PR pipeline

The point: **you (or Claude in chat) push a branch and open a PR; GitHub-side
automation finishes it** — fixes red CI, resolves conflicts, reviews, and merges when
green — fully async. Chat stays for *ideas and building until confident*, not babysitting.

## The flow

```
idea → build until confident → push branch → open PR
                                               │
              ┌────────────────────────────────┤ (all async, on GitHub)
              ▼                ▼                ▼
        CI runs          Claude review    (if red) Claude autofix
     (required gate)     on open          pushes a fix → CI re-runs
              │                                │
              └──────────► green ◄─────────────┘
                             │
                    native auto-merge fires  →  main  →  auto-deploy
```

## Safety floor (already configured on the repo)

- **Branch protection on `main`**: the `Type-check & build` CI check must be green and
  changes must go through a PR. **Nothing red can reach the auto-deploying branch.**
  (0 required human approvals — the gate is CI, not a person. `enforce_admins` off, so
  you can always hand-merge in an emergency.)
- **Native auto-merge** + **auto-delete merged branches** enabled.
- Merge method: **squash** (bot PRs are small, single-purpose fixes).

## What auto-merges vs. what waits for you

Eligible (auto-merges when green) — any of:
- conventional-commit **safe-type title**: `fix| security| perf| refactor| chore| docs| test| build| ci| revert`
- or a label: `automerge` · `bug` · `security` · `chore-safe`

**Never auto-merged** (a human decides): `feat:` titles, the `feature` label, a breaking
`!` title, or anything labelled `hold`. Security-*risky* changes: label `feature`/`hold`.

## Issue routing before a builder ever sees it

An issue titled `consider:` or whose body says "needs a design decision"/"not implementing
blind"/"needs a design pass" is a request for a **design-decision doc**, not code — dispatching
it to the code-shipping builder lane risks either a wasted batch (the builder correctly
refuses to implement blind) or, worse, a speculative infra migration shipped without the
design pass the issue explicitly asked for. Pre-route these to a design-decision deliverable
(a doc under `docs/design/`) or label them `needs-human`, the same way #219/#220 were, before
they reach a builder.

Same treatment for an issue whose only remaining action is **credential provisioning** —
registering an external API key/account or setting a production `wrangler secret put` — since
neither is achievable from an unattended build session (no external account access, no
secrets-store access). Left as plain `bug`/`enhancement`, it gets silently re-picked-up and
re-fails every cycle instead of surfacing once. Label it `needs-human` at triage/fixer time (or
self-label and stop if a builder rediscovers it), the same way #328/#329/#419/#533 were.

A security-audit run and a fix PR for the same finding can land concurrently against slightly
different snapshots of `main` — #567/#568 described a CalDAV SSRF credential leak and a
batch(tool:pipe) rate-limit bypass that were already fixed and test-covered by the same-day
merge of #479, and the issue-filing step never re-diffed against current `main` before opening
them (both issues even claimed "independently re-verified by direct read" — the re-verify read
the pre-merge snapshot). Any audit-to-issue pipeline should re-check a finding against current
`main` (or the merged-PR list) immediately before filing, not just at audit time, so builders
stop re-discovering and re-closing already-fixed issues (#585). A builder that hits one mid-batch
should drop it as redundant/superseded and say so explicitly, rather than re-implementing the fix.

## The workflows

| File | Trigger | Does |
|---|---|---|
| `automerge.yml` | PR opened/labeled/ready | enables native auto-merge on eligible PRs (never force-merges) |
| `claude-autofix.yml` | CI **fails** on a PR | Claude reads the failure, pushes a fix; capped at **4 attempts** then tags `needs-human` |
| `claude.yml` | `@claude` mention · PR opened | responds to mentions; `/code-review` pass on open |

Guardrails: `--max-turns` per run, `concurrency: cancel-in-progress`, cheaper model
(Sonnet) for fixes / Opus for review, and the attempt cap. The autofix bot won't touch
secrets, weaken tests, or edit unrelated code (it's told not to).

## Rate discipline (the PR-*producing* side — self-improve bot)

The sux-Worker self-improve loop (`SELF_IMPROVE_*`) is what opens autonomous PRs. Its caps:
**≤ 5 open bot PRs**, **≤ 10 commits/day**, batched into meaningful chunks. Kill-switch:
`SELF_IMPROVE_KILL`. Security/features are never auto-merged even when it's armed.

## Kill switches

- Per-PR: add the **`hold`** label.
- Whole pipeline: disable the workflow in the Actions tab, or set branch protection
  stricter.
- Self-improve bot: set `SELF_IMPROVE_KILL`.

## One-time activation (needs you — I can't set secrets)

1. **Install the Claude GitHub App**: <https://github.com/apps/claude> → install on `colinxs/sux`.
2. **Add the API key secret**: `gh secret set ANTHROPIC_API_KEY` (from console.anthropic.com).
   Until this is set, the Claude workflows are **inert** (they skip cleanly); `automerge.yml`
   already works without it.

Residual risk on an auto-deploying `main`: a semantic bug that passes all 1587 tests +
`wrangler dry-run` could merge and deploy. Mitigations: the full gate suite is the wall,
health checks catch regressions, and **git is the undo** (revert → auto-redeploy). Tighten
to a merge queue or a required human approval if you ever want a harder stop.
