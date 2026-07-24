---
status: designed
date: 2026-07-24
summary: "Reconciles SuxOS/sux#1252 (an issue-only rollup invisible to #1420's doc-based survey) against live code state, closes what's done, refiles what's genuinely open, gates 3 items needing Colin's own judgment, sequences #419 against metal's actual build, and defines the handoff to autonomous execution."
---

# Forgotten-ideas reconciliation — design

## Root cause

`SuxOS/sux#1420` ("1.2-X arc," 2026-07-23) surveyed `/superpowers:brainstorming` design
docs across 8 repos and calls itself the current source of truth for "what's next." Its
survey method — grepping design-doc files — structurally cannot see an issue-only rollup.
`SuxOS/sux#1252` ("Needs-Colin queue," 2026-07-22, OPEN) folded 24 previously-scoped work
items as unchecked checkboxes under the convention "closed issue is the spec, reopen when
picked up." #1420 references zero of them (confirmed by grep of its full body). The
highest-value casualty: `SuxOS/sux#419` — a Colin-approved (2026-07-17), fully-designed
(`docs/proposals/vpc-hosting.md`, status: designed) plan to stop the Mac from serving the
live Obsidian vault — already survived one false-completion (PR #767 claimed "Closes #419"
without touching the code), got reopened once, then quietly parked in #1252 and never
resurfaced.

This design reconciles every item in #1252 against **live** code/issue state (verified this
session via direct `gh`/grep checks and a 16-agent verification workflow, not trusted from
the rollup's own two-day-old text), and fixes the process gap so the next big reconciliation
doesn't repeat this.

## Non-goals

- Not re-running a full org-wide design-doc survey (#1420 already did that; scope here is
  exactly the #1252 rollup + its one trigger, #419).
- Not building anything. This is bookkeeping (issue close/refile/label) plus a design for
  what the autonomous pipeline should build next — no code changes in this spec.
- Not second-guessing #1420's own three pillars — this is a parallel gap-fill, not a
  competing arc.

## Verified disposition (input to this design, not re-derived here)

Full evidence trail lives in this session's transcript (a 16-agent verification workflow,
each with live `gh`/code-grep evidence). Summary:

**Close, no action** — already shipped or explicitly declined:
`#1046` (stage()/STAGE_KINDS unification — shipped, `sux/sux/src/stage.ts` + 6 call sites),
`#920` (subrequest ledger — explicitly declined by Colin's 2026-07-23 placement-fabric
design), `#1188` (editor stack — shipped via `dotfiles`+`nix`; only a documented 2-command
vim-mode switch remains).

**Genuinely open, refile as fresh scoped issues** — all repeatedly bounced by the
autonomous build loop as "too large for a batch slot," never rejected on merits:
`#1035` (cal_semantic — target the newer `_vectorize.ts` namespace pattern, not a standalone
KV-cosine file), `#1086` (calendar self-conflict detector), `#880` (durable multi-round
scheduling negotiator), `#1099` (research scout), `#1062` (Monarch audit — **rewrite**:
Monarch is retired, `lunchmoney.ts` is live; its native `/recurring_items` likely shrinks
scope), `#998` (actionable Web Push), `#1184` (narrowed to W1 voice-register harvest only —
W2–W4 shipped via #1207/#1232/#1209/#1239), `#1185` (narrowed to Part A: unlocker escalation
+ #1103 + the README rewrite — MyChart half shipped via #1221/#1247/#1255; **the README has
been falsely marked complete twice already, #743 and #761** — call this out explicitly in
the new issue so a third silent no-op can't happen unnoticed), `#1187` (narrowed to Parts
1/2/4 — Part 3 shipped as #1276), `#1103` (residential-proxy fetch guard contract — **flag
as NOT autonomous-pipeline-dispatchable**, needs a session with both `sux` and `suxrouter`
checked out), `#1078` (noUncheckedIndexedAccess — blocked on `suxlib#326`'s TS-version
decision; file both, sequenced together).

**Needs Colin personally — never auto-dispatchable:**
`#1136` (auto-dispatch durable "plan" ops on cron — the bot's own drop-comment flagged this
arms proactive LLM behavior over PHI/vault/contacts with automerge and no human-review
gate), `#1117` (`growth` fn — composes a therapy-tier authority gate with a self-model;
prerequisites built, but the fn itself needs a personal zero-trust scoping/consent pass),
and `#1062`'s financial-data angle as a secondary flag (confirm comfort with the rewritten
Lunch-Money-based scope before dispatch).

**Hygiene batch, low narrative value, mechanical, no gating needed:**
`#1234` (npm audit: sharp CVE), `#1174` (suxlib proto-guard), `#1177` (op-engine race
handler), `#977`/`#1026`/`#1213`/`#869`/`#1124` (pipeline hygiene: stuck-PR watcher,
disposition visibility, router backlog, out-of-order assignment, stale self-improve stubs).
The rollup's own `MONARCH_TOKEN not provisioned` line is moot now that Monarch is retired.

## Design

### 1. New tracking issue: `SuxOS/sux` "1.2-Y: reconciled gap-fill (post-1.2-X sweep miss)"

Supersedes `#1252` using its own established convention (closed issue = the durable index;
each folded line stays a full spec at its own link). Body includes:
- One line stating the root cause (issue-only rollups are invisible to a doc-grep survey)
  and pointing at `#1252` and `#419` as the concrete instance.
- The disposition table above, each line linking to its real issue (existing, closed-cited,
  or freshly filed).
- An explicit cross-link to `#1420`, in both directions — I add one comment on `#1420`
  itself pointing here. **This is the actual recurrence fix**: not a smarter sweep, a
  breadcrumb the next sweep can follow even using the exact same (doc-only) method.

`#1252` gets closed with a comment pointing to the new issue, mirroring how `#1420` itself
superseded `#1192`.

### 2. Per-item mechanics

Straight GitHub bookkeeping, done directly (no code, low risk, fully reversible via `gh`):
- Comment-and-leave-closed for the 3 already-done items, citing the shipped evidence.
- File fresh issues for the 10 genuinely-open items (the narrowed ones get bodies that
  state what already shipped vs. what remains, so a future reader doesn't re-discover it).
- File `#1136`/`#1117` (and flag `#1062`) with the **`needs-human` label** — already the
  load-bearing convention keeping `#419` and others out of the auto-build loop since
  2026-07-22 — plus a body stating the specific stakes up front (PHI/no-review-gate;
  self-model/therapy-tier consent), so a human skimming the label alone still gets the why.
- File one combined "pipeline hygiene" issue for the 8 mechanical items, dispatch-ready.

### 3. `#419` sequencing against metal's actual build

Metal's real current state (verified live this session): only `modules/core.nix` exists
(SSH, ZFS scrub/trim). `#1420` Pillar 1 already has a tracked, dependency-ordered cut for
other self-hosted services (`metal-homelab-services-vm`, `SuxOS/metal#4`, depends on
`metal-ingress-sux-compute` #3, which depends on `metal-secrets-plane-land` PR#16). File
`#419`'s rebuild as a new metal cut, `metal-obsidian-headless-vault`, positioned alongside
`#4` in Pillar 1 with the same real prerequisite (secrets-plane-land) — not a new
dependency chain, just slotted into the one that's already moving. Don't reopen `#419`
itself (avoids re-triggering its false-completion history); the new metal issue references
it as the full spec, same pattern as the rollup.

### 4. Handoff to autonomous execution

Two different things happen next, deliberately kept separate:
- **This session does the bookkeeping** (steps 1–3 above) directly via `gh` — mechanical,
  reversible, no code, well within normal working authority.
- **The autonomous pipeline builds the code** for every freshly-filed, correctly-scoped,
  ungated issue, via the existing `dispatch`/three-loop mechanism already building `#1420`'s
  cuts. Gated issues (`needs-human`) structurally can't enter that loop. `#1103` is filed
  but explicitly annotated as non-dispatchable (needs a session with both repos checked
  out) so nobody wastes a build attempt on it.

## Testing / verification

No code to test. Verification is: `#1252` closed and its 24 lines all resolve to either a
"done, cited" comment or a live successor issue; the 3 gated issues carry `needs-human`;
`#1420` carries the cross-link comment; the new metal issue exists and cross-references
`#1420` Pillar 1's dependency chain. A future session (or the next big reconciliation
sweep) can confirm all of this by reading `#1420`'s comments alone, without re-deriving any
of it.
