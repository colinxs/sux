---
title: Session audit summary — 2026-07-11
status: designed
cluster: meta
type: audit
summary: "Verdict-first synthesis of one session's six audits (ultraaudit, behavioral, best-practices, debloat, intent, knowledge/reconcile): core is production-grade; the autonomy layer has gate holes and a bypassable email-conscience; debloat frees ~419 LOC and fixes 2 latent bugs."
tags: [sux, meta, audit]
updated: 2026-07-11
related: ["[[improvement-backlog]]", "[[design-review-2026-07]]", "[[vault-docs-reconciliation]]", "[[autonomous-pipeline]]"]
---

# Session audit summary — 2026-07-11

Durable capture of one session's audit sweep so the verdicts survive the session
that produced them. Six lenses ran over the same tree; this is the verdict from
each plus the decisions we locked. The **ranked, de-duplicated action list lives
in [[improvement-backlog]]** — this doc is the *why*, that doc is the *what-next*.

Reading order: verdicts (what each audit concluded) → decisions (what we settled)
→ pruning notes (what's now stale). Skepticism here cuts toward *not* churning: the
spine is sound, the fixes are a bounded set, and most of them are on the autonomy
layer, not the core.

## The one-line verdict

**Core is production-grade and ahead of most published MCP servers; the risk has
migrated up into the autonomy layer** — the CI gates, the self-improve loop, and
the email-conscience — where the guardrails are prose-deep rather than
code-enforced. Nothing in the core needs a rewrite. Everything actionable is a
tight, mostly-mechanical set of fixes.

## Verdicts by audit

### ultraaudit (adversarial, whole-tree) — **core production-grade; autonomy-layer gate holes**
The base function surface, the namespace split (vault/mail/files), and the
stateless + KV/R2/git spine hold up under adversarial reading. The genuine holes
are all *above* the core, in the self-improving / autonomous pipeline: the
security-review and auto-merge gates could be routed around, and the self-improve
loop can act before a human gate closes. Fix the gates, leave the spine.

### behavioral (does-it-do-what-it-says) — **mail reversible-airtight; self-improve stub-stranding**
Mail triage's reversible-only allow-list is genuinely airtight — every verb it can
take (label/archive/unarchive/undelete) is reversible, with no irreversible path
reachable by default. The defect is in self-improve: it can **strand a stub** —
begin a change and leave a non-functional partial behind when the loop is
interrupted, because the create and the wire-up aren't atomic.

### best-practices — **B+, no P0**
Solid engineering hygiene, no release-blocking defect. The findings are a graded
list of A/B/C/D/E/F items (pre-commit gap, compat-date drift, missing cpu limits,
secret-doc disagreement, confirm-DSL sprawl, param-naming drift, Workers-AI not
gatewayed, no `noUncheckedIndexedAccess`). All are improvements, none are fires.

### debloat — **~419 LOC removable; dedup fixes 2 latent bugs**
Two whole functions are dead weight: `winco` (~300 LOC, subsumed by `places`) and
`geo_fetch` (~119 LOC, whose only unique value — a streaming byte-cap — folds into
`proxy`). Beyond raw removal, the dedup pass is *correctness-positive*: unifying
`packCsv` into `_convert.toCsv` fixes a **CSV formula-injection**, and sharing one
`looksBlocked` bot-wall detector across lowes/ace/costco fixes a **drifted regex**
that had diverged between the copies.

### intent (what's the guardrail really doing) — **email-conscience bypassable**
The email "conscience" (the tone/consent gate meant to sit in front of outbound
mail) is **bypassable**: the irreversible JMAP verbs (send/destroy) aren't staged
behind it, so the gate is advisory rather than load-bearing. This is the
single highest-value *safety* finding, but it lands in code the mail-cal workstream
currently owns, so it's blocked behind that landing.

### knowledge / reconcile — **docs ⇄ vault seam holds; capture the ephemera**
The docs↔vault reconciliation (PR #64) is sound: two sources of truth, view-layer
unified by a zero-copy symlink mount, no cross-repo copy. The gap it surfaced is
exactly this class of artifact — session-scoped audit knowledge that would
evaporate — hence this file and [[improvement-backlog]].

## Decisions locked this session

- **Do not churn the core.** No Durable Object, no JMAP SDK, no ical.js, no
  cf-first retail. The spine stays; audits reinforce prior design-review-2026-07.
- **Risk lives in the autonomy layer, so that's where the next fixes go** — gate
  enforcement, self-improve atomicity, and the email-conscience, ahead of any
  further feature work.
- **The email-conscience must become load-bearing, not advisory** — stage the
  irreversible JMAP verbs behind it. Deferred, not dropped: it waits on mail-cal.
- **Debloat is a net-positive, not just cosmetic** — the two removals and the
  dedup ship as correctness fixes (CSV-injection, drifted bot-wall regex), not
  mere LOC-golf, so they earn priority.
- **Capture-before-loss is now a standing practice** — session audit verdicts get
  a frontmattered doc under `docs/design/` so `gen-wiki` indexes them, rather than
  living only in a session that will be summarized away.

## Pruning notes (flagged, not deleted)

Recorded here for a deliberate later pass — **do not delete in this PR**:

- **`docs/proposals/*.md` marked `status: shipped`** — `architecture.md`,
  `files.md`, `jmap.md`, `mail.md`, `three-mcps.md` are pre-build proposals whose
  content is now realized in code and described by `sux/FUNCTIONS.md`. They read as
  historical artifacts superseded by the shipped surface; candidates for an
  `archive/` move or a `status: superseded` restamp.
- **`docs/proposals/mychart.md`** — no frontmatter at all, so `gen-wiki` already
  skips it; orphaned from the index. Either add frontmatter or archive it.
- **`docs/proposals/architecture.md` vs `docs/design/architecture.md`** — two
  architecture docs with overlapping scope; reconcile to one canonical home before
  they drift.
