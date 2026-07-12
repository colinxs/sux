---
title: Improvement backlog — top 10 (2026-07-11)
status: designed
cluster: meta
type: backlog
summary: "The single ranked top-10 highest-value improvements synthesized from the session's audit backlog, de-duplicated and with in-flight work excluded; each tagged SAFE (auto-deployable) vs UNSAFE (needs review), rough effort, and any in-flight dependency."
tags: [sux, meta, backlog]
updated: 2026-07-11
related: ["[[session-audit-summary]]", "[[design-review-2026-07]]", "[[autonomous-pipeline]]"]
---

# Improvement backlog — top 10

The one ranked list. Synthesized from the six audits in [[session-audit-summary]],
de-duplicated across audits, and with **everything currently in flight excluded**
(self-improve/`_feedback`, mail-triage, the CI gate + auto-merge workflows,
perf-fanout `_util`/rate-limit/batch/pipe, mail-cal `_jmap`/`_caldav`/`mail-mcp`,
vault `obsidian`/`vault-mcp`, the converter wave, dropbox/storage wave2, the
event-bus `index.ts`/`wrangler.jsonc` P0, and grounded-advice).

Ranked by value density (safety + correctness + LOC/dedup leverage, with SAFE
near-term-actionable items weighted up). **SAFE** = fits the deploy/autonomy policy
for auto-merge+deploy (reversible, no new irreversible surface). **UNSAFE** = needs
Colin's per-PR review before it lands. A **dependency** means the edit touches code
an in-flight workstream owns; it can't start until that lands.

| # | Improvement | Source audit | Safe? | Effort | In-flight dependency |
|---|---|---|---|---|---|
| 1 | Share one `looksBlocked` bot-wall detector across lowes/ace/costco | debloat (2A) | **SAFE** | S | none |
| 2 | Pre-commit hook runs `gen:index` (stage `index.ts`, not just FUNCTIONS.md/wiki) | best-practices (A1) | **SAFE** | S | none |
| 3 | Remove `winco` (~300 LOC, subsumed by `places`) | debloat (S1) | **SAFE** | S | none |
| 4 | Fold `packCsv` into `_convert.toCsv` (fixes CSV formula-injection) | debloat (2A) | **SAFE** | S–M | after converter wave (`csv.ts`) |
| 5 | Stage irreversible JMAP send/destroy behind the email-conscience + tone gate | intent (C1/C4/C5) | **UNSAFE** | M | after mail-cal (`_jmap`/`mail-mcp`) |
| 6 | Unify the 3 destructive-confirm DSLs into one path | best-practices (D1) | **UNSAFE** | M | after mail-cal + vault land |
| 7 | Remove `geo_fetch` (~119 LOC); fold its streaming byte-cap into `proxy` | debloat (S2) | **SAFE** | S–M | none |
| 8 | Document `GITHUB_TOKEN` scope; reconcile secrets.md ⇄ keys.md | best-practices (C1) | **SAFE** | S | none |
| 9 | Route Workers-AI through AI Gateway (cache / observe / cost-cap) | best-practices (E1) | **UNSAFE** | M | none |
| 10 | Enable `noUncheckedIndexedAccess` + add a lint gate (staged) | best-practices (F) | **UNSAFE** | L | none |

## Rationale (why this order)

1. **`looksBlocked` share** — a real latent bug, not cleanup: the copies drifted, so
   at least one retailer mis-detects the bot-wall today. Dedup + correctness, tiny,
   no dependency → highest value density.
2. **Pre-commit `gen:index`** — the hook stages FUNCTIONS.md and the wiki but *not*
   `index.ts`, so a hand-clean commit still lands red on the `gen:index` CI gate.
   Closes a recurring red-main footgun for a few lines. Highest leverage per LOC.
3. **Remove `winco`** — 300 LOC of dead surface fully subsumed by `places`. Pure
   subtraction, SAFE, immediately shippable.
4. **`packCsv` → `_convert.toCsv`** — dedup that *also* fixes CSV formula-injection
   (a `=`/`+`/`-`/`@`-prefixed cell executing in a spreadsheet). Security-positive;
   blocked only because `csv.ts` is mid-wave.
5. **Email-conscience staging** — the single highest-value *safety* item: the gate
   is advisory until send/destroy sit behind it. Ranked below the SAFE quick-wins
   only because it's UNSAFE and blocked on mail-cal, not because it matters less.
6. **Unify destructive-confirm DSLs** — three parallel confirm dialects are the root
   cause that makes #5 possible; one path makes the conscience enforceable. Waits on
   mail-cal + vault since it edits their confirm code.
7. **Remove `geo_fetch`** — 119 LOC; its only unique value (a streaming byte-cap)
   moves into `proxy`, so nothing is lost. SAFE subtraction.
8. **`GITHUB_TOKEN` scope doc** — secrets.md and keys.md currently disagree about
   what the token is for; a reader can't tell the scope. Docs-only, SAFE, removes an
   operational trap.
9. **Workers-AI via AI Gateway** — buys caching, observability, and a cost ceiling
   on the AI leg. Real infra win, but a routing change that wants review → UNSAFE.
10. **`noUncheckedIndexedAccess` + lint gate** — the broadest correctness net here,
    but a large, churny rollout (every unchecked index access surfaces). Staged, and
    last because effort dwarfs the others.

## Below the line (tracked, not top-10)

Real but lower-value or blocked-by-DEFER — kept so nothing is lost:

- **B1 bump `compat_date`, B2 add `limits.cpu_ms`** — both edit `wrangler.jsonc`;
  fold into the event-bus P0 that already owns that file.
- **C3 add `SUX_CRON_TOKEN` to the secret-drift manifest** — SAFE, small; a good
  bundle-mate for #8.
- **D2 `op`→`action`, D3 `term`/`query`→`query`, D4 `name`→`tool`** — param-naming
  unification; medium churn across many fns, low urgency.
- **`renderViaMac`→`macRender` rename** — mechanical, cosmetic.
- **errMsg sweep (~58 files), shared `decodeEntities`, research `fetchApiJson`
  skeleton** — all DEFER: they add to `_util.ts`, which perf-fanout owns; revisit
  after that lands.
- **intent C6 obsidian-delete confirm** — DEFER, conflicts with mail-cal + vault
  in flight.
- **self-improve stub-stranding (behavioral)** — already in flight in
  `_self_improve.ts`; excluded here by design.
