---
title: Cloudflare bindings & recall-quality decision — D1 / Queues / Durable Objects / Vectorize
status: decision
cluster: infra
type: decision
summary: "Resolves the design pass the 2026-07-13 platform-audit issues (#214 D1/Queues, #217 Durable Objects, #218 Vectorize/hybrid recall) each explicitly asked for. Decision: DEFER all four bindings — KV + brute-force cosine + the daily/5-min cron loops are correct at today's scale. Records the concrete, measurable trigger that flips each decision and the migration sketch for when it does, so the next audit re-decides on evidence instead of re-litigating from scratch."
tags: [sux, infra, cloudflare, d1, queues, durable-objects, vectorize, recall, decision]
resolves: [214, 217, 218]
updated: 2026-07-15
---

# Cloudflare bindings & recall-quality decision (2026-07)

## Why this doc exists

The 2026-07-13 platform/inspiration sweep filed three `priority:high` "consider:"
issues, each of which explicitly says it is **infra-shape work that needs a design
decision, not a bugfix — "not implementing blind"**:

- **#214** — D1 for structured data; Queues for triage fan-out.
- **#217** — Durable Objects for cron-loop state.
- **#218** — Vectorize semantic/hybrid search to upgrade `recall`.

They overlap heavily (D1's SQLite ≈ a Durable Object's SQLite ≈ #214's "structured
data" need; #218 is the narrow slice of #214's already-documented "no Vectorize below
~10k vectors" call). Deciding them together dedupes the analysis and produces one
place the *next* audit looks before re-raising the same idea.

**Decision, up front: defer all four bindings.** The current architecture — one KV
namespace (`OAUTH_KV`) plus brute-force in-Worker cosine plus the shared daily / 5-min
Cron Triggers — is the correct shape at today's scale. Each subsection below states the
*specific, measurable* condition that would flip the decision and a migration sketch for
that day, so this is a deferral with triggers, not a "no."

This is a reversible decision doc, not a code change or a binding commit. It exists so
Colin can prioritize (which the issues asked for) against grounded numbers.

## Current shape (grounded)

- **Bindings in use** (`sux/wrangler.jsonc`): `OAUTH_KV` (KV), `AI` (Workers AI, text +
  embeddings), `IMAGES`, `R2`, `BROWSER` (Browser Rendering), rate-limit bindings, and
  two Cron Triggers `["0 13 * * *", "*/5 * * * *"]`. **No D1, Queues, or Durable
  Objects.**
- **KV reach**: `OAUTH_KV` is referenced ~351× across ~106 files — OAuth state, token
  caches, cron heartbeats, the learning substrate, oracle KBs, the once-per-week
  ledgers, vault indices.
- **The autonomous loops** (`sux/src/index.ts` `maintenanceTick` +
  `sux/src/cron-heartbeat.ts` `CRON_JOBS`): `mail_triage` runs on the **5-min** cron in
  batches of `{ max: 25 }` (`mailTriageTick`, `sux/src/index.ts:591`); `weekly_recall`,
  `consolidate`, `briefing`, `agenda`, `life_wiki`, `self_improve`, and the token
  refreshes ride the **daily** 13:00 UTC cron. `weekly_recall` / `consolidate` are gated
  to once per ISO week by a KV-backed **ledger** (`sux/src/ledger.ts`, see
  `_weekly_recall.ts:15,50`) — the other six daily ticks return immediately.
- **Fail-closed everywhere**: every tick is a no-op until its `*_ENABLED` flag is set,
  and `runSubJob` (`cron-heartbeat.ts:57`) swallows a bad job so it never blocks the
  rest and stamps a `{ok,at,error?}` heartbeat for the status page.

## #214 — D1 for structured data · Queues for triage fan-out → **DEFER**

**D1.** The data the issue calls "arguably relational" (mail-triage cycles,
self-improve findings, vault/oracle indices) is today read/written by whole-key or
prefix-`list` access patterns, not by ad-hoc queries — KV serves those in one round-trip
each. Nothing in the codebase does an operation that *needs* SQL: no joins, no `WHERE …
ORDER BY … LIMIT` over a large row set, no aggregate a `list`+in-memory scan can't cover
at current cardinality. Adopting D1 now would split the single-store mental model
(`OAUTH_KV` is the one place state lives) for no query we actually run, and force a
dual-write/migration for the ~351 existing KV touchpoints or an awkward
some-here-some-there boundary.

*Flip the decision when* the consolidate feature (PR #208) needs **relational queries
over facts** — e.g. "every note asserting fact X, joined to its supersession edges,
ordered by recency" — that a KV prefix-scan can't answer without loading the whole index
into the Worker on each run. Concretely: when the note/fact index exceeds a few thousand
rows *and* consolidate's stale/duplicate detection becomes a multi-attribute query rather
than a linear scan. **Migration sketch**: add a `d1_databases` binding, move only the
consolidate fact-index into it (leave OAuth/token/heartbeat state on KV — it has no
relational shape), keep the KV index as a fallback read for one release.

**Queues.** `mail_triage` already self-bounds: `{ max: 25 }` messages per invocation on
a 5-minute cron, so a large mailbox is drained across many small ticks, not one
CPU/wall-clock-bound run. That is a poll-based checkpoint — cruder than a Queue's
per-message retry, but it does not risk the single-invocation limit the issue worries
about, because the batch cap *is* the checkpoint.

*Flip the decision when* per-message work grows expensive enough (e.g. an LLM
classification + several JMAP calls per message) that even 25/tick risks the wall-clock
budget, **or** when a partial-batch failure needs per-message retry/dead-letter rather
than "re-scan next tick." **Migration sketch**: a `queues` producer binding fed by the
triage cron, a consumer Worker doing one message per invocation with native retry —
`mail_triage` becomes the enqueuer, not the processor.

## #217 — Durable Objects for cron-loop state → **DEFER**

The three DO wins the issue names, weighed against what already exists:

1. **Mid-run resumability.** Real for `mail_triage` *only* — and it already has a
   coarse version: the `{ max: 25 }` batch cap plus the 5-min cron means an evicted run
   re-scans from the top of the *remaining* unprocessed set next tick, not from true
   zero, because triage acts on mailbox state (labels/archive), which *is* the
   checkpoint. `weekly_recall` / `consolidate` are single-shot digest writers with an
   ISO-week ledger gate — there is no meaningful mid-run state to resume; a failed run
   simply retries next tick and the ledger keeps it idempotent-per-week.
2. **Concurrent-trigger dedup.** The manual `cron_trigger` POST (`index.ts:790`) could
   race a scheduled tick. Today the once-per-week ledger already makes
   `weekly_recall`/`consolidate` idempotent per week, and `mail_triage` acts on
   reversible mailbox state, so a double-fire is at worst redundant work, not
   corruption. A DO's `blockConcurrencyWhile` would serialize this *for free* — a genuine
   but low-severity nicety, not a correctness gap.
3. **Per-loop alarms.** DO Alarms would let each loop own its cadence instead of sharing
   the two fixed cron windows. Marginal: the current cadences (5-min triage, daily rest,
   weekly ledger gate) are exactly what's wanted, and the cron approach costs nothing.

A Durable Object is a stateful, single-threaded actor — powerful, but it introduces an
availability/latency dependency and a second storage model (its SQLite) for state that
today lives happily in KV behind fail-closed, best-effort ticks. The loops are
*designed* to be stateless and restart-safe; a DO would trade that simplicity for
guarantees we don't currently need.

*Flip the decision when* (a) `mail_triage` grows per-message state that must survive an
eviction mid-batch (see the Queues trigger — these converge), **or** (b) the manual +
scheduled race becomes a real double-write hazard rather than redundant idempotent work,
**or** (c) a loop needs a cadence the two crons can't express. Note: if #214's D1 is
adopted first, a DO's built-in SQLite may satisfy *both* the structured-data need and the
loop-state need — evaluate them together at that point, don't adopt both.

## #218 — Vectorize / hybrid recall → **DEFER pending POC (with a cheaper first step)**

`recall` (`sux/src/fns/recall.ts`) fans out across vault/files/mail/web/learned/oracle/
calendar/contacts and synthesizes one cited answer. Two facts sharpen this issue:

1. **`recall` is *already* mostly lexical, not pure cosine.** `fromVault`, `fromMail`,
   `fromFiles`, `fromContacts` delegate to each backend's own **keyword/text** search
   (Obsidian search, JMAP `text` filter, Dropbox search); `fromCalendar` does a
   client-side keyword-stem match (`recall.ts` `keywords`/`keywordHit`). The *only*
   embedding-cosine path is `fromLearned` (`classifyKnn`, `_examples.ts`), and `oracle`
   inlines distilled KBs unranked. So the "pure cosine misses exact terms" failure mode
   the issue describes barely applies to today's `recall` — the exact-term half is
   already carried by the backends.
2. **The ~10k-vector threshold is a separate axis** and is already documented as *not* a
   current gap (`docs/design/archive/chunks/designs/learning-substrate-tech.md:12-16`).
   #218 rightly isolates *answer quality* from *vector count* — but at today's small
   learned/oracle sets, the quality ceiling is set by fan-out coverage and synthesis, not
   by ANN recall.

**Therefore: don't reach for Vectorize yet.** The concrete near-term win the issue points
at — catching exact-term matches cosine alone would miss — is largely already present,
and a full Vectorize migration (Workers-Paid, network round-trip, write lag, a second
index to keep in sync) buys nothing until the learned/oracle corpus is large enough that
brute-force cosine either blows the KV value cap or the in-Worker scan latency.

*The POC the issue asks for, made concrete* (do this before any Vectorize commit):
build a fixed sample of ~20 real recall questions with hand-judged expected sources, then
compare three configs on the same sample — (a) today's fan-out, (b) today's fan-out plus a
lightweight **lexical re-rank** of the gathered passages (BM25-lite over the already-
retrieved material, *no new binding*), (c) a Vectorize-backed hybrid. If (b) closes most
of the gap to (c), ship (b) and keep deferring Vectorize; the cheap lexical re-rank is an
in-`recall` change with no infra cost. Only (c) winning decisively on the sample justifies
the binding.

*Flip to Vectorize when* the learned + oracle vector set approaches ~10k (the documented
brute-force ceiling) **or** the POC shows hybrid ANN winning materially on the judged
sample. **Migration sketch**: a `vectorize` index mirroring the KV vectors, queried in
parallel with the existing lexical fan-out, results merged + reranked before synthesis —
additive to `gatherRecall`, not a rewrite.

## Revisit triggers (the one table the next audit should read)

| Issue | Binding | Ship it when… |
|---|---|---|
| #214 | **D1** | consolidate needs relational queries over a >few-thousand-row fact index that a KV prefix-scan can't answer in one Worker pass. |
| #214 | **Queues** | per-message triage work risks the wall-clock budget even at 25/tick, or partial-batch failures need per-message retry/dead-letter. |
| #217 | **Durable Objects** | `mail_triage` grows eviction-fragile per-message state, or the manual/scheduled race becomes a real double-write hazard — evaluate jointly with #214's D1 (DO SQLite can serve both). |
| #218 | **Vectorize** | learned+oracle vectors approach ~10k, or the judged-sample POC shows hybrid ANN beating a no-binding lexical re-rank materially. |

Until a row's condition is met, the current KV + brute-force + shared-cron shape is the
decision, not a stopgap.

## Cross-references

- `docs/design/archive/chunks/designs/learning-substrate-tech.md` — the embeddings +
  brute-force-cosine-in-KV storage decision this doc's #218 section extends.
- `sux/src/index.ts` (`maintenanceTick`, `mailTriageTick`, the `cron_trigger` POST) and
  `sux/src/cron-heartbeat.ts` (`CRON_JOBS`, `runSubJob`) — the loops #214/#217 concern.
- `sux/src/fns/recall.ts` — the fan-out #218 would upgrade.
