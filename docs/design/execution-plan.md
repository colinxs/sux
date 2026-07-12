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

## ▶ RESUME HERE (session handoff, 2026-07-11)
**State:** `main` @ `37de621`, deployed (`d5c76e20`), **1417 tests green**. Chunk-1 core LIVE (#45 files-vault, #46 infra, #47 mail/caldav merged+deployed). Working tree clean.

**Open PRs (chunk-1 remnants):**
- **#44 `fix/registry-surface-selfdescribe`** — the `surface` field + tool annotations + `sux` self-describe root verb. FOUNDATIONAL for chunk 2. Action: `git fetch` its branch, rebase onto `main`, resolve (conflicts are docs/index regen), merge+deploy. Keep.
- **#43 `fix/render-unify-secfresh`** — RECONSIDER given the retire-mac verdict. Keep only the security bit (render_server.py HMAC ts-freshness). The "unify mac paths" is low-value now; the real render work = **cf-first ladder + paid-residential-unlocker rung** (Bright Data/Zyte) for Home Depot's Akamai wall, mac demoted to dormant option. Do that as its own render chunk, not this PR as-is. Likely close #43, salvage the ts-freshness commit.

**Next actions (ultracode, maximally parallel, serial chunks per this doc):**
1. Land #44 (rebase+merge+deploy) — unblocks the front door.
2. **Chunk 2** front-door + one connector (needs #44's `surface` field): consolidate shop/search/fetch/research/media behind ~12 front verbs + `fn` escape + `sux` self-describe; retire mail/vault/files namespace connectors (keep routes dormant).
3. **Chunk 3** smart-guards generalized (stage-by-default + `!`/force + sentiment/typo, all irreversible verbs).
4. **Chunk 4** stateless-learning substrate (learned-prefs KV + vault write-hooks + embeddings/kNN via Workers AI) — FOLD IN the C1/C2 fan-out time-budget fix (batch/pipe/operateFull → `Date.now()` elapsed check → partial return `{truncated:true}`).
5. **Chunk 5** `mail_triage` bot (cron, autonomy-on/reversible-only/confidence-gated/logged+undo, digest→daily note).
6. **Chunk 6** self-improvement loop (recurring review → auto-deploy fixes/refactors/cleanup, PR features, PR the loop itself).
+ render chunk: cf-first ladder + paid-unlocker rung; retire mac node.

Config locked: daily-note channel · all 6 chunks · smart model routing (rules→Workers-AI embeddings→frontier) · merge+deploy fixes, PR features+security · keep main green, no cred/secret touching unattended.
