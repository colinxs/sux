---
title: Improvement backlog — top 10 (2026-07-11)
status: designed
cluster: meta
type: backlog
summary: "The single ranked top-10 highest-value improvements synthesized from the session's audit backlog, de-duplicated and with in-flight work excluded; each tagged SAFE (auto-deployable) vs UNSAFE (needs review), rough effort, and any in-flight dependency."
tags: [sux, meta, backlog]
updated: 2026-07-19 (4th pass — #10 confirmed blocked on suxlib, #1080)
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
| 2 | ~~Pre-commit hook runs `gen:index`~~ — DONE (`scripts/hooks/pre-commit` stages only `index.ts`) | best-practices (A1) | SAFE | S | none |
| 3 | ~~Remove `winco`~~ — DONE (already removed) | debloat (S1) | SAFE | S | none |
| 4 | Fold `packCsv` into `_convert.toCsv` (fixes CSV formula-injection) | debloat (2A) | **SAFE** | S–M | after converter wave (`csv.ts`) |
| 5 | ~~Stage irreversible JMAP send/destroy behind the email-conscience + tone gate~~ — DONE (`stage.ts` STAGE_KINDS + `conscience()`, landed with mail-cal) | intent (C1/C4/C5) | SAFE | M | none |
| 6 | Unify the 3 destructive-confirm DSLs into one path | best-practices (D1) | **UNSAFE** | M | after mail-cal + vault land |
| 7 | ~~Remove `geo_fetch`~~ — DONE (folded into proxy `x-exit-geo`) | debloat (S2) | SAFE | S–M | none |
| 8 | ~~Document `GITHUB_TOKEN` scope~~ — DONE (secrets.md ⇄ keys.md reconciled) | best-practices (C1) | SAFE | S | none |
| 9 | ~~Route Workers-AI through AI Gateway~~ — WIRED (#1060): every `env.AI.run()` call site passes `aiGatewayOptions(env)`, dormant behind the out-of-band `AI_GATEWAY_ID` secret until a human creates the gateway and sets it | best-practices (E1) | SAFE | M | none |
| 10 | Enable `noUncheckedIndexedAccess` + add a lint gate (staged) | best-practices (F) | **UNSAFE** | L | **blocked** — see rationale |

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
5. **Email-conscience staging** — ~~the single highest-value *safety* item: the gate
   is advisory until send/destroy sit behind it~~. **Re-verified 2026-07-15: DONE.**
   `stage.ts`'s `STAGE_KINDS.mail_send = { irreversible: true }` (landed in df303aa,
   2026-07-11, same day as the audit that flagged this) means `mail_send` auto-stages
   by default — a preview + `commit_token`/`force:true` is required before anything
   sends, and `staged()` attaches `conscience()`'s tone/recipient/attachment/phishing
   advisory notes to that same mandatory preview (`stage.ts:161`). The gate itself
   (staging) is load-bearing/code-enforced, not advisory; `conscience()` remains an
   advisory *lint* by design (it surfaces notes, it doesn't independently veto), but
   it can no longer be bypassed — it rides inside the enforced stage/commit step on
   every guarded mail verb (`mail_send`, `mail_mailbox_delete`, `mail_vacation`,
   `contact_delete`, …). Separately, `_jmap.ts`'s `enforceGates` hard-throws on the
   raw `jmap` conduit unless `allow_send`/`allow_destroy` is explicit — defense in
   depth for anyone bypassing the ergonomic verbs. No remaining gap.
6. **Unify destructive-confirm DSLs** — three parallel confirm dialects are the root
   cause that made #5 fragile; one path would still reduce duplication even though
   #5 itself is done. Waits on mail-cal + vault since it edits their confirm code.
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
    **Blocked (confirmed 2026-07-19, #1080):** flipping the flag in `sux/tsconfig.json`
    surfaces not just the 1,571 errors across 247 files in `sux/src`, but 92 more
    inside `../suxlib`'s own `.ts` sources (e.g. `suxlib/src/op/spec.ts`,
    `suxlib/src/domain/transform.ts`, `suxlib/src/runtime/inline.ts`) — the `file:`
    dependency's raw sources are pulled into the same `tsc` program and checked
    under sux's `compilerOptions` (`skipLibCheck` only exempts `.d.ts`, and there's
    no per-directory staging: `compilerOptions` is one global block covering all of
    `src/**/*.ts`). This isn't a sandbox artifact: `.github/workflows/ci.yml`'s own
    suxlib step (`git clone --depth 1 --branch main .../SuxOS/suxlib.git ../suxlib`)
    clones the same raw `.ts` source real CI type-checks against, not a prebuilt
    `.d.ts` package — so real CI would hit the identical 92 errors, not just this
    sandbox. A sux-only staged rollout can't go green until suxlib gets its own
    `noUncheckedIndexedAccess` fix landed first (a separate repo/PR — `../suxlib` is
    read-only from a sux bot-build sandbox, see `CLAUDE.md`'s known-gotcha log).
    Don't re-attempt #1078 until that lands.

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
