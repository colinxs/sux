---
title: sux design review — 2026-07-11
status: superseded
cluster: meta
type: review
summary: "Adversarial 9-agent review snapshot. The 'Changes' checklist is now fully shipped — the render.ts renderViaMac path-unify and the mail_schedule de-dupe have both landed. The 'Needs Colin' judgment calls are still open decisions."
tags: [sux, meta, review]
updated: 2026-07-12
---

# sux design review — 2026-07-11

_Adversarial synthesis over 4 code-review dimensions + 4 web-research topics (9 agents). Verdict-first; skepticism cuts toward NOT churning._

> **Status (2026-07-12): superseded — do not re-fix from this checklist.** Nearly every item under **Changes** has since landed in code (failWith taxonomy, tool annotations, cal_update/task_update/task_complete, vault read-time sha, bounded CalDAV time-range, per-request `_egress`, UTF-8 octet folding, parseICal component-stack rewrite, ingest R2 fallthrough, Amazon cf-first mac-render fallback). **Both remaining Changes items have since landed (DONE):** the render.ts `renderViaMac` path-unify now routes through the shared breaker-aware `macRender` (`fns/render.ts:19`, with an explicit comment about not drifting from a second hand-rolled mac client), and the `mail_schedule` duplicate is gone — scheduling is standardized on `mail_send`'s `send_at` (held via FUTURERELEASE), listed by `mail_scheduled`, cancelled by `mail_unschedule`. The **Needs Colin** section below is a set of open judgment calls, not shipped work — leave it as decisions to make.

## Verdict

We are building the right thing, and most of the architecture should be left alone — the skepticism here cuts toward *not* churning. Across all four code dimensions and all four research topics the verdict is consistent: sux's spine (handle-discipline, batch/pipe server-side reduce, stateless + KV/R2/git, mac-first retail ordering, the JMAP raw conduit, Mode A/B Dropbox split with the Mode-B write firewall, quarantined read-only recall) is not just sound but ahead of most published MCP servers, and the research explicitly warns against the tempting rewrites (no broad Durable Object, no JMAP SDK, no ical.js, do NOT make retail cf-first). What remains is a tight set of real fixes — two genuine correctness bugs (the retail mac→cf fallback is unreachable on a hung node; the CalDAV iCal parser corrupts any non-UTC/aliased event) plus mechanical coherence passes (route the taxonomy through the namespaces, add tool annotations, unify the guard story) — and a smaller set of genuine judgment calls that are Colin's, headlined by two: the inverted risk posture where mail_send (the one irreversible verb) runs unguarded by default, and whether to finally ship the ~10-verb front door as the advertised surface with the ~90 leaves deferred. Land the fixes green one at a time; treat the verb-surface and mail_send-default questions as deliberate decisions, not drto-do items.

## Changes (clear wins — land green, one at a time)

### [HIGH/small] Cap the mac render leg below the 60s fn deadline so the cf fallback can actually run. Retail callers pass timeout_ms:55000 (amazon.ts:181) and macRender extends that to ~70000ms, but withDeadline RESOLVES a timeout at FN_DEADLINE_MS=60_000 (index.ts:42,53-59) and abandons the run — so a hung/asleep mac node trips the 60s deadline 10s before mac aborts, and cf (the entire point of retailRender) never executes. Lower retail timeout_ms to ~35-40s or clamp macRender to leave ~18s cf headroom; add a test that a never-resolving mac fetch still yields a cf result within FN_DEADLINE_MS.

**Why:** The fallback only helps on a FAST mac failure (already the cheap case) and is silently dead on the exact failure it exists for. Highest-severity real bug found.

**Evidence:** `index.ts:42,53-59; amazon.ts:176-182; retail-render.ts (mac-then-cf sequential)`

### [HIGH/medium] Replace the flat parseICal with a ~30-line tokenizer that maintains a BEGIN/END component stack (capture props only at VEVENT/VTODO depth, skip VALARM/VTIMEZONE) and preserves the parameter segment. Today _caldav.ts:167-186 flattens every line into the parent by last-write-wins and truncates the property name at the first ';' — so a VALARM DESCRIPTION overwrites the event's, and DTSTART;TZID=... / DTSTART;VALUE=DATE lose their zone and all-day flag. Surface normalized start/end + all_day + zone. Both code-review and JMAP/CalDAV research flagged this independently.

**Why:** Any event that isn't pure-UTC and reminder-free is silently mis-parsed — wrong times and ambiguous all-day values reach the caller. Correctness bug on real Fastmail data; current tests only cover the clean ASCII/UTC path.

**Evidence:** `_caldav.ts:167-186 (parseICal), consumed mail-mcp.ts:124-130; _caldav.test.ts:15-41`

### [MEDIUM/medium] Route the obvious error buckets in mail/files/vault through failWith (registry.ts:171): not_configured for every scope/credential gate (mail-mcp.ts:91, files-mcp.ts:60), not_found for missing id/path (mail-mcp.ts:319), bad_input for missing-required-field guards. All three namespace files currently contain zero failWith calls — confirmed — while 22 base fns use the taxonomy.

**Why:** The entire personal-data surface emits uncoded free-text errors, so Grafana grouping and typed consumers see nothing for exactly the coded cases the FAIL_CODES taxonomy was built for. Mechanical, closes a coherence gap.

**Evidence:** `registry.ts:157-171; grep failWith = 0 in all three namespace files (verified)`

### [MEDIUM/small] Add MCP tool annotations (readOnlyHint / destructiveHint / idempotentHint / openWorldHint) via toolList — a grep confirms sux ships none. Tag search/fetch/extract/oracle/recall read-only (+ openWorldHint for web-reaching ones), and store/ingest/media/vault-write/mail_send destructive+non-idempotent.

**Why:** Free client-side guardrails with zero server logic: Claude Code runs readOnlyHint tools concurrently at ~2x dispatch and drives confirm prompts from destructiveHint. Today that behavior lives only in prose. Low-effort, uniform decoration.

**Evidence:** `grep *Hint = 0 across sux/src (verified); registry.ts:188 toolList`

### [MEDIUM/small] On a dropboxPut failure in ingest, fall through to putBlob(R2) instead of returning fail(up.error). Today the R2 twin is reached only when Dropbox is UNCONFIGURED (config-time), so a token revocation or Dropbox 5xx loses the whole capture even though R2 would accept the bytes. Stamp placement 'r2 (Dropbox upload failed)'.

**Why:** Keeps captures durable through Dropbox outages/token lapses — the note still lands with a resolvable blob link. Small, self-contained resilience win.

**Evidence:** `ingest.ts:146-158, 12-13`

### [MEDIUM/medium] Add cal_update, task_complete, and task_update. Calendar has only list/events/create/delete and tasks only list/create, versus full-CRUD contacts (mail-mcp.ts:588-693). task_complete (mark a VTODO done) is the single most common task action and is absent; editing an event today means delete+recreate or dropping to the raw caldav hatch.

**Why:** The missing high-frequency verbs push ordinary edits onto the raw escape hatch, undercutting the whole ergonomic layer.

**Evidence:** `mail-mcp.ts:695-808 (no cal_update/task_update/task_complete); contrast contact_update mail-mcp.ts:647`

### [MEDIUM/small] Thread the sha captured at read time through vault_edit/vault_patch into vaultPut and PUT with THAT sha, so a concurrent modification yields a 409 ('note changed, re-read' or retry) instead of a silent overwrite. vaultPut re-fetches HEAD-at-write (obsidian.ts:119-124) so GitHub's optimistic-concurrency check is defeated by construction and the read-time sha the transform was based on is discarded (vault-mcp.ts:250-262).

**Why:** Silent lost-update is the wrong failure mode for a store whose selling point is 'history is the undo.' Closes the window with a primitive GitHub already provides — no DO needed. (Single-user lowers frequency, not the badness of the failure.)

**Evidence:** `obsidian.ts:119-127; vault-mcp.ts:250-262`

### [MEDIUM/medium] Bound the CalDAV REPORT with a <c:time-range start=... end=...> (default e.g. now..+90d, caller-overridable) and bound the multistatus body read. reportObjects (_caldav.ts:189-204) currently issues a time-agnostic query pulling every VEVENT/VTODO ever and buffers the whole body via resp.text(), risking the 60s deadline / output ceiling on a multi-year calendar.

**Why:** Unbounded pull on a real calendar is a latent deadline/output-ceiling hazard. Bounding the window is the cheap, non-controversial half (recurrence expansion is the needsColin half).

**Evidence:** `_caldav.ts:189-204, 45-47; mail-mcp.ts:709-722, 770-783`

### [MEDIUM/small] Stop parking per-request context on the shared env object: env._egress = { ctx, reqId } (index.ts:206) is a single per-isolate reference, so two concurrent tools/call requests overwrite each other — smartFetch tags egress-audit lines with the wrong reqId and may call ctx.waitUntil on a completed request's ExecutionContext (proxy.ts:332, grafana.ts:108). Thread the egress object explicitly (it's already an arg down most of smartFetch) or hang it off the per-request ctx.

**Why:** Textbook 'module/global mutable state breaks in the Workers isolate model,' on the hot path. Impact is observability-only today, but the fix is mechanical. Fold routeTally (proxy.ts:259) onto the same per-request object while here.

**Evidence:** `index.ts:206; proxy.ts:259,332; grafana.ts:108`

### [MEDIUM/medium] Unify the two mac render paths: have render.ts backend:mac call the shared breaker-aware macRender instead of its drifted private renderViaMac (render.ts:34-74), which uses different timeout constants (10000/70000 vs 15000/80000) and never consults or updates macBreaker. Map screenshot/pdf base64 delivery on top; delete renderViaMac.

**Why:** Two code paths to the same service with divergent resilience: a hung node hit via `render` won't trip the breaker the retail path relies on, and an open breaker won't fast-fail a `render` call.

**Evidence:** `render.ts:12-13,34-74; mac-render.ts:56-79,93-122`

### [LOW/small] Drop mail_schedule (or keep it only as a documented alias) and standardize on mail_send's send_at. It's a thin wrapper calling draftOrSend({...a, send_at: a.sendAt}) — identical behavior — but exposes the arg as sendAt vs send_at, a param-name mismatch between two tools for one capability. Verified at mail-mcp.ts:426-430.

**Why:** Duplicate retail-of-a-capability with an inconsistent param name violates the one-clear-path guidance and the bidirectional-naming house rule.

**Evidence:** `mail-mcp.ts:403,417,426-430 (verified)`

### [LOW/small] Fix icalLine folding to count UTF-8 octets at 75 (RFC 5545 §3.1) and never split a multibyte sequence / surrogate pair; today it slices at fixed 73/72 UTF-16 code units (_caldav.ts:96-107). Also broaden the entity decode to add &quot; and numeric &#nn; refs (_caldav.ts:201).

**Why:** Real corruption of accented/emoji SUMMARY/LOCATION on encode; Fastmail's leniency hides it but it's a genuine bug. Small.

**Evidence:** `_caldav.ts:96-107, 201`

### [LOW/small] Coherence/doc pass: fix the stale scopeProbe comment (it says calendars is hardcoded false but the code correctly DERIVES it from the live Session — _jmap.ts:132-147, so it lights up automatically when Fastmail ships jmap:calendars); note the deliberate vault raw-hatch omission and the intentional jmap/dropbox double-mount in header comments; and rename the worst non-bidirectional handles (voice→restyle) or tighten their one-line summaries.

**Why:** Cheap correctness-of-intent fixes: the stale comment invites a future reader to 'correct' forward-compat back to a hardcoded false, and the naming drift is the one place the ~95-fn surface violates the stated house rule.

**Evidence:** `_jmap.ts:132-147; vault-mcp.ts (no raw tool); FUNCTIONS.md:113,135,147,162`

## Needs Colin (judgment calls)

### mail_send — the one truly irreversible verb — runs unguarded by default while reversible vault/files deletes are confirm-gated. Should the default require a stage/confirm step?

**Options:** (a) Keep the fast path (stage/commit_token stay optional) and just document mail_send as intentionally one-shot — honors the 'move fast, git/CI/review are the guardrails' ethos. (b) Make stage the DEFAULT for mail_send (opt out with an explicit immediate flag), so a single model call can't dispatch outbound mail. (c) Require confirm only when the send is parameterized by untrusted-derived content (e.g. recall output), direct otherwise.

**Recommendation:** Lean (b) for the interactive surface: stage-by-default on the single verb with no undo is one extra round-trip of cheap insurance, and it fixes the inverted risk posture where the most consequential action has the weakest default. BUT the real containment is credential scope, not a model-settable boolean — so pair it with (c)'s spirit for background/scheduler sweeps, where a narrowly-scoped send credential is the boundary and stage-and-notify already degrades gracefully. Your call on how much friction the interactive path tolerates.

### Should sux ship the ~10-verb front door as the ADVERTISED tools/list surface, with the ~90 leaves marked defer_loading (discoverable via Tool Search, not preloaded)? Today registry.ts advertises all ~95 leaves.

**Options:** (a) Ship verbs as the primary advertised set now + defer_loading the leaves — the field's single loudest tool-design rule is 'too many tools confuses selection.' (b) Keep the flat ~95-leaf surface. (c) Interim: advertise verbs + keep leaves visible but prefix-namespaced (shop_amazon, fetch_render) since bare collision-prone names (shop/render/store) compound the verb-vs-leaf name collision.

**Recommendation:** (a) is where the research says the field would land, and it's the payoff the whole verb design was for — but it's a real product-direction commit and larger effort, so it's yours to sequence. Gate it behind a task-based eval harness (see inspiration) so you can prove the 95→10 consolidation actually improves agent success before making it the default surface.

### shop vs product_search and search vs web_search are near-duplicate entry points whose names don't tell a reader which one fans out (bidirectional-naming violation).

**Options:** (a) Collapse each pair into one verb with an optional retailers[]/engines[] (omit = fan-out/merge, one value = router). (b) Keep separate but rename to encode the difference (shop_store vs shop_all, search_kagi vs search_all).

**Recommendation:** (a) — one verb with an optional breadth arg is the cleaner mental model and removes the synonym collision entirely. This is naturally part of the verb-front-door decision above; do them together.

### The stage→commit token consume is a KV read-then-delete with no compare-and-set, so two concurrent commits of the same token can double-spend — for mail_send that's a user-visible double-send, not a metrics blip.

**Options:** (a) Accept it — the window is tiny and single-user traffic rarely collides. (b) Wrap the mutate() in the existing ledger.markIfNew keyed by commit_token — narrows the window cheaply but markIfNew is itself non-atomic. (c) A single tiny Durable Object as the atomic commit-token/idempotency store (true single-threaded CAS), off the hot read path, touched only at mutation commit — the research names this as one of only two places a DO clearly earns its keep in sux.

**Recommendation:** (b) now for send-class verbs (cheap, uses code you already have), and reserve (c) for if/when send or Mode-B-destructive volume grows enough that a rare double-send is unacceptable. A double contact_delete is harmless-idempotent; a double mail_send is not — so scope any hardening to the genuinely irreversible verbs only. Low urgency.

### CalDAV sync is a full download every read. Adopt incremental sync (RFC 6578 sync-collection / DAV:sync-token, with ctag+calendar-multiget fallback) now, or defer behind the bounded-window fix?

**Options:** (a) Implement sync-collection now — the research calls it the single highest-value _caldav.ts change; Fastmail supports it, and it naturally yields deletion tombstones. (b) Ship only the bounded time-range window (see changes) now and defer full incremental sync until a large calendar actually strains the budget.

**Recommendation:** (b) first. The bounded window removes the immediate deadline hazard for a fraction of the effort; full sync-collection is the right eventual design but is premature optimization for a single-user calendar today. Revisit when the window bound proves insufficient.

### Mode B files_operate promises whole-corpus operations ('find all pdfs about X, merge, replace originals'). A 100-file sweep structurally cannot complete within one Worker invocation (6-connection ceiling + 60s deadline) and loses all partials on timeout. Back it with a Cloudflare Workflow?

**Options:** (a) Back bulk Mode B with a Workflow (durable step-persisted execution, resume-across-deadline, compensation for partial failure) and keep the single-call path for small N. (b) Keep single-call and cap the advertised batch size honestly. Separately, for the INDEPENDENT-item half (batch_fetch, ingest sweeps), a Queue + the existing ledger as idempotent consumer is simpler than a Workflow.

**Recommendation:** (a) before Mode-B write ever leaves dormant status and ships the 100-file promise — the research calls this the textbook Workflows use case, and sux has the idempotency substrate (ledger) but no async execution substrate, which is the real gap. Not urgent while DROPBOX_FULL_* is unset, but it's a prerequisite for that promise being real.

### recall defends against injection only at SYNTHESIS time, but ingest writes web/email content INTO the vault and recall reads it back every session — so a poisoned captured page becomes a persistent memory (OWASP ASI06). Add capture-time trust tiering + sanitization?

**Options:** (a) Formalize ingest→Inbox/ as a trust tier: demote or exclude Inbox-/web-origin notes in recall relative to hand-authored notes until a human promotes them, and sanitize instruction-like patterns in the synthesis VIEW (not the stored file). (b) Add trust-weighted retrieval (vault > mail > files > web) + a lightweight injection-pattern pre-screen on gathered material + provenance stamping (ai-summary vs verbatim) on ingest's compress pass. (c) Defer — accept single-layer synthesis-time defense for now.

**Recommendation:** Do the cheap, high-leverage subset of (a)+(b): provenance-stamp ingest's AI-summarized notes so a distilled hallucination is never read back as a primary fact, and attach a per-source trust label so the synthesizer prefers higher-trust sources on conflict. Full trust-weighted ranking and a classifier pre-screen are a larger design expansion — worth it eventually, but scope the first pass to provenance + source labels.

## Already right (leave alone)

- Handle discipline (list/search return refs, exactly one deliberate byte-read per namespace: mail_read/files_read/vault_read; attachments via CAS handle or blobId, never round-tripped through context) — the research says this is ahead of most published servers. Leave it.
- batch (map + server-side reduce) and pipe ({{prev}} compose) combinators ARE the code-execution-with-MCP thesis moved server-side — a genuine differentiator. Keep, don't dilute.
- All-stateless dispatch on KV/R2/git is the correct default for a single-user gateway; the research is explicit that a broad Durable Object would add a serialization bottleneck for zero coordination benefit. Do NOT add a DO to the request path.
- mac-first + cf-fallback ordering for retail is correct (mac owns the PerimeterX gesture cf structurally can't replicate); Walmart correctly opts out of cf entirely; the general `render` fn correctly defaults cf-first. Two deliberate defaults — do NOT make retail cf-first.
- The JMAP raw conduit (forward byte-exact methodCalls, add only auth + Session discovery + using-derivation + gates) is idiomatic, not an anti-pattern — do NOT adopt a JMAP client SDK. Session lifecycle, over-declare-and-union `using`, back-reference-aware write gate, and anchor+dedup pagination are all robustly correct.
- Keeping calendars on CalDAV (not JMAP) is forced and correct for 2025-26 — JMAP-for-Calendars is still an IETF draft; _caldav.ts is the only viable transport, not legacy debt.
- Contacts use the modern ContactCard/JSCard (RFC 9610/9553) and prefer Fastmail's advertised contacts URN — forward-compatible. Keep.
- Dropbox token lifecycle (confidential + PKCE, expires_in-60 cache, 401 re-mint) and the Mode A app-folder / Mode B dormant-credential split with the write firewall (dry_run-default, protected-prefix deny-list, rev-conditioning, /.sux-trash backup, temporary non-public links) is textbook least-privilege + reversibility — a story most personal-agent stacks lack.
- R2 content-addressed store (sha256 dedupe, /s/<uuid> KV→R2 short-circuit) and the mac circuit breaker are sound resilience primitives. Keep.
- Metrics: best-effort KV sharding with honest comments that RMW can lose increments and a DO is the real fix, while the durable metric of record is the structured log line shipped to Loki — correctly demoted to best-effort, no DO warranted. The writeSeq/routeTally/single-flight in-isolate best-effort behaviors are self-documented and fine as-is.
- The idempotency ledger's non-atomic markIfNew is deliberately sound for idempotent sweeps (rare double-process tolerated; degrades to always-new with no KV). Module singletons (oauthProvider, inflight) are legitimate per-isolate caches, not correctness-bearing shared state.
- Hot-path rails: withDeadline resolves-not-rejects and always clears its timer, checkArgs bounds depth before stringify, SSRF + CR/LF guards are hard refusals surviving the proxy→direct fallback, and rate-limiting uses the native binding not a module counter. Well-built.
- Delete posture is conservative and coherent: no permanent mail delete exists at all; vault_delete and files_delete hard-require confirm:true. Correct.
- recall implements the safe half of the dual-LLM / CaMeL pattern — a quarantined, tool-less synthesizer that only sees fenced untrusted data and can never act. Its read-only design (never writes output back) sidesteps the Mem0 hallucination-recirculation anti-pattern, and Promise.allSettled per-source isolation + a user-visible status map is a real tamper-evidence/blast-radius win. Do NOT let recall grow the ability to act.
- The honest framing of allow_send/allow_destroy as 'accidental-misuse guards, NOT an injection boundary — use a read-only token for real containment' is exactly the right mental model and matches field consensus that injection is architecturally unsolvable. Lean into credential-scoping as the boundary.
- Universal summarize/save/fresh dispatch flags generalize Anthropic's concise/detailed response_format across every tool uniformly — a stronger design than per-tool opt-in. oracle as a consolidated cross-store workflow tool with a citation handle shape is the 'build tools around workflows' pattern done right. Keep both.

## Inspiration (from research)

- Add a task-based eval harness over the verb surface (Anthropic's behavioral method: generate realistic multi-tool-call tasks, run them in agentic loops, paste transcripts back into Claude to find where the surface misleads the agent). sux measures whether functions are CORRECT (selftest, adversarial design review) but not whether an agent PICKS the right verb and succeeds in few calls — this is how you'd validate the 95→10 consolidation actually helps before committing to it.
- Use MCP Resources (not just tools) for vault MOC/index notes and named blob handles, so the human can deterministically seed context BEFORE a turn instead of the model round-tripping to fetch it — the tools-vs-resources division the ecosystem now emphasizes; today only vault-mcp even answers resources/list.
- Add an append-only forensic audit log of every side-effecting call (send, destroy, Mode B write) — OWASP ASI06's fifth layer. ledger.ts is idempotency-only (TTL'd, not a durable record of what was done). This turns 'git is the undo' into 'git + an auditable trail is the undo' and pairs naturally with the annotations/destructiveHint work.
- Make fine-grained, resolvable citations the recall output shape: [mail:<emailId>] not subjects, [web:<url>] not a collapsed '[web]', and char/line spans for vault/files excerpts — so every claim round-trips back to its exact source (evidence-tracing research). fromWeb already has the URLs; this is mostly plumbing.
- Read the JMAP submission capability (maxDelayedSend) before attempting a scheduled send and clamp/validate holdFor, returning 'this account allows scheduling up to N days out' instead of an opaque notCreated. sessionDump already exposes it (_jmap.ts:118-128) — no verb consumes it yet.
- Route Todoist add_many/complete_many through the Sync API commands batch (one request, temp-id + uuid) instead of N concurrent REST v2 POSTs — removes the burst-429 risk and connection fan-out, and REST v2 is on Todoist's deprecation path toward the unified v1 API. Low urgency at single-user volume, but idiomatic.
- Treat least-privilege / read-only tokens as the DEFAULT credential posture and write-scoped credentials (FASTMAIL send scope, DROPBOX_FULL_* write) as the deliberate exception — put containment in the credential layer where prompt injection can't reach it, since the model-settable boolean gates are theater against injection by the field's own consensus.
- Prefer RFC 6578 sync-collection over ctag+etag if/when incremental CalDAV sync is adopted — it returns only changed/deleted hrefs plus a token and naturally yields deletion tombstones, which a ctag/etag diff must infer.