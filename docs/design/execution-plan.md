---
title: sux — execution plan (the one big plan, live)
status: executing
---

# Execution plan — serial chunks, each internally parallel, land green + deploy before next

Anchored to `north-star.md`. Mode: **maximally deployed, maximally secure, minimally PR-staged,
bounded deadline.** Autonomy granted. Guardrails: keep `main` green; never touch creds/secrets or
irreversible real-account acts unattended; reversible-only for anything auto-applied.

## Config (locked with Colin)
- **Notification channel:** append to the vault **Daily/<date>.md** — a `sux` section: did / suggests / questions / undo handles.
- **Depth:** all 6 chunks.
- **Models — smart router:** each task routed cheapest-sufficient → rules → **Workers-AI embeddings** (classification/similarity/tone, edge, private, learns from labels via kNN) → **frontier API** (hard low-volume synthesis: onboard/therapy). Data stays local unless the task truly needs the frontier; frontier egress minimized + fenced.
- **Deploy policy:** merge+deploy fixes/refactors/cleanup; **PR** new features (build if high-value) + anything security-risky.
- **Refused/held (security):** remote-exec shell (not built; at most allowlisted file-ops, PR-only); tailnet-only render migration (PR; only HMAC ts-freshness ships); no secret rotation.

## Chunks
1. **Design-review fixes** — ultra-flow `w31ugd57p`: 5 parallel clusters (infra-resilience #46, render-unify+HMAC-freshness #43, registry-surface+`sux`-verb #44, files-vault #45, mail-caldav) + live bot-detection + design-review-round-2. Verify each verdict → merge safe → deploy.
2. **Front-door + one connector** — consolidate shop/search/fetch/research/media; `surface` field hides leaves behind ~12 front verbs + `fn` escape; `sux` root verb self-describes (mobile-safe); **retire** mail/vault/files namespace connectors + plugins (keep routes dormant). Deploy.
3. **Smart-guards generalized** — stage-by-default + `!`/force override on ALL irreversible/outward acts (send, deletes, Mode-B writes, masked/cal/contact deletes); reversible-only auto; agent-side sentiment-pause + typo/recipient/attachment lint (pre-send conscience). Deploy.
4. **Stateless-learning substrate** — learned-prefs store (KV) + vault-KB write-hooks (save-on-search, save-on-learn) + embeddings store + kNN classify; `recall` reads it back. The vector/labeled set IS the learned model. Deploy.
5. **`mail_triage` bot** — cron: pull new mail (last-seen idempotent) → smart-router classify (embeddings+kNN over learned categories) → **autonomy ON, reversible-only** (label/move/junk-teach, never delete), **confidence-gated** (uncertain → suggest), fully **logged + bulk-undo**, first cycle reviewable, cost-bounded. Digest → daily note. Deploy live.
6. **Self-improvement loop** — recurring design-review cron consumes `issue`/`suggest` feedback → builds findings green → **auto-merge+deploy fixes/refactors/cleanup**, **PR features (if high-value)**, always-PR security. Kill-switch + rate cap. Self-deploying ⇒ PR the loop itself for Colin.

## Don't-forget connective tissue (the sins-of-omission list)
Digest channel (ch.4/5) · learned-prefs store designed FIRST (ch.4) · correction→learning + bulk-undo (ch.5) · idempotent+cost-bounded cron (ch.5) · identity resolution across mail/contacts/calendar (ch.4) · bulk-work > 60s → Queues/Workflows (ch.4/5, else silent truncation).

## Pruned as cruft (not building)
Algebra substrate, un-parked verb program, uw directory, unused per-store scrapers, speculative front-verbs without a caller. Flagship `onboard` (self-model + therapy synthesis) = capstone, PR-only.

## Chunk-1 research verdicts (2026-07-11, workflow w31ugd57p)
- **RETIRE the mac node (data-grounded):** it was 502 all session (offline SPOF, 0/6 sites). cf-residential cleanly serves Amazon(search URLs, not homepage)/Lowe's/Ace/Walmart(catalog reads). Costco = flaky soft-block (retry→structured fn). **Home Depot = Akamai hard "Access Denied" — the one cf can't crack.** Policy: cf-first everywhere; escalation rung for HD/Costco = **paid residential-unlocker API** (Bright Data/Zyte/Oxylabs) on cf-failure, NOT a home Mac. Walmart: cf for reads only (PerimeterX blocks cart/interactive). One confirmation test before physical decommission (bring mac up, render HD backend:mac+solve) — but swap the ladder's mac rung for a paid unlocker regardless.
- **Design-review round 2 — the unifying gap (C1/C2 HIGH):** batch/pipe/operateFull have COUNT caps but NO time budget → on the 60s deadline `withDeadline` abandons the run with ZERO partials (and operateFull can silently commit an unknown subset of Mode-B mutations then report only a timeout). Cheap fix (~20 lines/site): a `Date.now()-started` check in each fan-out loop → stop dispatching ~50s, return collected partials `{truncated:true, reason:"time"}`. Defer the full env._budget ledger + Workflows until a real caller strains them. → folds into chunk 4 (fan-in/out) — the one primitive that also fixes the subrequest-ceiling gap.

## ▶ RESUME HERE (session handoff, 2026-07-12 — full branch/workflow reconciliation)
**State:** `main` @ `650828c` (**#44 merged** — `surface` field + annotations + `sux` root verb, chunk-2 foundation). **1428 tests green**, type-check + docs/index in sync. Chunk-1 core LIVE (#44/#45/#46/#47). Verify #44's deploy went green.

> **Per-session chunk briefs live in [`chunks/`](chunks/README.md)** — one
> self-contained file per branch/session, sized to load into a fresh context with
> `CLAUDE.md` + memory. The ledger + forward plan below is the map; a chunk file is
> the territory for one session. Start a chunk: checkout its branch, read its one file, go.

**In flight this session:** branch `fix/fanout-time-budget` (uncommitted, green) — the C1/C2 fan-out time-budget fix, **3 of 4 sites done**: `pool()` takes a `deadline`, `batch`/`batch_fetch`/`pipe` stop dispatching at `FANOUT_BUDGET_MS` (50s < 60s hard deadline) and return `{truncated:true, reason:"time"}`. **GAP: `operateFull` (the scariest site — silent partial Mode-B mutations) still has an unbounded apply for-loop.** Finish that site, then commit + PR (this is chunk 00).

### Branch ledger (reconciled against `main` @ 650828c)
**Merged / dead — safe to delete (local + remote):** `fix/files-vault` `fix/infra-resilience` `fix/mail-caldav` `fix/registry-surface-selfdescribe` `fix/retail-render` `fix/parsing` `fix/resource` `fix/security2` `feat/digital-life-spine` `feat/fastmail-integration` `feat/int-sweep` `feat/mcp-gate` `feat/obsidian-store-ops` `feat/sux-vault-plugin` `docs/knowledge-core` `docs/unpark-verbs-plan` `claude/sux-mychart-*`; all `worktree-wf_*` (stale #32 workflow worktrees); local aliases `as33`(=ultra-sweep) `as38`(=files-operate) `as39`(=obsidian-search) `as40`(=amazon-cf) `pr31` `pr46` `alg37`(=algebra) `uw36`(=uw-dir).

**Superseded — content already on `main` via a DIFFERENT patch (verified by `git cherry` + symbol-on-main grep) — close PR, delete branch:**
- **`chore/ultra-sweep`** — the earlier plan called this a 17-commit "salvage pile"; a `git cherry` + symbol audit shows **all 17 commits' content is already on `main`** (mail reply/forward, FUTURERELEASE send + list/cancel, `mail_move`, HTML bodies, jmap fixes, ebay self-heal, csv escape, recall-remote, citekeys, files Mode-B reject, scrape clamp, `batch_fetch` OOM bound, `_oauth`/`_dropbox-core`/`errMsg` refactors, `localshop.ts` deletion). **Nothing to salvage.** The `batch_fetch` OOM commit was the supposed overlap with `fix/fanout-time-budget` — it's already merged, so there is no reconcile.
- **`feat/amazon-cf-fallback`** — all 5 commits `-` in `git cherry` (merged; `main` is already partly cf-first via `fix/retail-render`). See the render chunk.
- `feat/files-operate-transform` — `transformFull` + `files_transform` tool already on `main` (`_dropbox-full.ts` + `files-mcp.ts`).
- `feat/obsidian-structured-search` — `vault_query`/`vault_patch`/JsonLogic already on `main` (`vault-graph.ts` + `vault-mcp.ts`).

**Pruned as cruft (per §"Pruned as cruft") — close:** `docs/unpark-algebra-plan`, `docs/uw-directory-fn-plan`.

**LIVE unmerged work (`git cherry`-confirmed genuinely new):**
- **`feat/front-door`** (3 commits, all `+`, 0 behind `main`) — ~13 front verbs + `fn` escape (leaves hidden but reachable) + two hardening fixes (weighted-cost through `fn`; Unicode-obfuscation bypass). `main`'s registry `surface` field is dormant metadata until this lands. **→ chunk 01.**
- **`fix/render-unify-secfresh`** (#43, both commits `+`) — only `b363f00` (HMAC ts-freshness, replay block) is worth keeping; the mac-shared-client refactor is low-value post-retire-mac. **→ salvaged inside the render chunk (06)**, then close #43.

**Saved workflows (superseded, do NOT re-run as-is):** `ground-finish-it-all` / `finish-remaining-sux-work` / `ground-backlog` — premise (algebra substrate + un-parked verbs + uw dir + the deferred obsidian/files legs) was **reversed**: now either *pruned as cruft* or *already shipped*. Provenance only. The `ultra-sweep` workflow's output = the now-superseded `chore/ultra-sweep` branch.

> **Note on the sins-of-omission list (line 28):** "bulk-work > 60s → Queues/Workflows" is deliberately **deferred**, not orphaned — the fanout-time-budget chunk ships the interim partial-return; the full Queues/Workflows primitive is built inside the learning-substrate chunk only *if* a real caller strains the 60s deadline.

### Forward plan (per-session chunks live in [`chunks/`](chunks/README.md); land green + deploy before the next)
- **00 fanout-time-budget** (in flight): add the deadline check to `operateFull`'s apply loop (applied-so-far + `{truncated:true}`, never abandon a mutation-set silently). Finish, commit, PR, merge+deploy.
- **01 front door** *(independent — can run in parallel)*: land `feat/front-door`; retire mail/vault/files namespace connectors (routes stay dormant). Establishes the `surface` field as load-bearing.
- **02 smart-guards**: **generalize the EXISTING `stage.ts` `staged()`/`enforceGates` substrate** to default-on + annotation-driven across all irreversible/outward verbs; add agent-side conscience lint. (Not greenfield — the gate already exists.)
- **03 learning-substrate**: learned-prefs KV + vault write-hooks + embeddings/kNN via Workers AI; extend `recall`. Owns the deferred Queues/Workflows decision.
- **04 mail_triage bot**: cron, autonomy-on/reversible-only/confidence-gated/logged+undo, digest→daily note.
- **05 self-improvement loop**: recurring review → auto-deploy fixes/refactors/cleanup, PR features, PR the loop itself.
- **06 render cf-first ladder** *(independent — can run in parallel)*: finish the cf-first inversion for all retailers (amazon already is), add the paid-unlocker rung for HD/Costco, salvage `b363f00`, retire mac to dormant.
- **07 branch cleanup**: delete the merged/superseded/cruft branches (content-verified), after the render chunk salvages `b363f00`.

Config locked: daily-note channel · all 6 chunks · smart model routing (rules→Workers-AI embeddings→frontier) · merge+deploy fixes, PR features+security · keep main green, no cred/secret touching unattended.
