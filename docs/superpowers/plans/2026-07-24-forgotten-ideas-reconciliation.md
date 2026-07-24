# Forgotten-Ideas Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile every item in `SuxOS/sux#1252` (a needs-Colin rollup invisible to `#1420`'s doc-based survey) against verified live code/issue state — close what's done, refile what's genuinely open, gate what needs Colin's own judgment, sequence `#419` against metal's real build, and cross-link everything so the next big reconciliation can find it.

**Architecture:** Pure GitHub bookkeeping via `gh` CLI. No code changes, no repo checkouts beyond issue/PR operations. Leaf issues (fresh, narrowly-scoped successors) are filed first so their real numbers exist; the aggregating issue (1.2-Y) and the cross-link comments are filed last, once every real number is known — this avoids dangling references.

**Tech Stack:** `gh` CLI only (`gh issue create`, `gh issue comment`, `gh issue close`, `gh issue view`).

## Global Constraints

- Every `gh issue create` is preceded by a duplicate check (`gh issue list --search "<exact title>"`) so re-running this plan after a partial failure never double-files.
- No issue in the "needs Colin personally" set (`#1136`/`#1117` successors) may carry a `dispatch`-eligible label (no `building`, no auto-pickup label) — only `needs-human`.
- `#1103`'s successor is explicitly annotated as NOT dispatchable to the autonomous pipeline (cross-repo access limitation), so a build session doesn't waste a slot on it.
- Every fresh issue's body states, in its own first paragraph, what already shipped vs. what remains — never assume the reader re-derives this from a linked rollup.
- All work happens via `gh` against `SuxOS/sux` and `SuxOS/metal` — no local git commits, no branches, no PRs (this is issue-tracker state only).

---

### Task 1: File `#1035` successor — cal_semantic (Part B of #1033)

**Interfaces:**
- Produces: a new issue number, call it `$ISSUE_1035` — referenced by Task 17.

- [ ] **Step 1: Check for an existing duplicate**

```bash
gh issue list -R SuxOS/sux --search "cal_semantic Part B" --state all --json number,title
```
Expected: only the original `#1035` and `#1037`/`#1142` (different scopes) — no prior successor.

- [ ] **Step 2: File the issue**

```bash
gh issue create -R SuxOS/sux --title "Build cal_semantic — Part B of #1033 (contacts Part A shipped)" --body "$(cat <<'EOF'
Successor to #1035 (closed, folded into rollup #1252). Part A of #1033 (contact_semantic)
shipped 2026-07-21 via #1036 — `_contact_semantic.ts` exists, wired into `recall.ts`'s
`fromContacts` and `_cross_semantic.ts`'s `CrossDomainItem` union. Part B (calendar) was
never built: no `_cal_semantic.ts` file exists, `_cross_semantic.ts`'s domain union has no
calendar member, and `recall.ts`'s `fromCalendar` is still a plain window-scan + keyword-stem
filter with no semantic/embedding leg.

**Architecture note for whoever picks this up:** since #1035 was written, a unified
Vectorize-based retrieval index shipped (`_vectorize.ts`, v5 keystone #1290, provisioned
2026-07-22) whose `VecDomain` union is `vault|mail|files|contacts|oracle|assim|phi|advise` —
no calendar. Target that namespace pattern for the new calendar index rather than a
standalone KV-cosine `_cal_semantic.ts` — don't build the KV-cosine version #1035 originally
specified.

**Scope:** wire calendar into the Vectorize namespace, extend `_cross_semantic.ts`'s
`CrossDomainItem` union to include calendar + a `calendarToCrossItems` mapper, wire
`recall.ts`'s `fromCalendar` to the new semantic leg, wire `vault_cross_link_plan.ts` +
`op-engine/caps.ts` for calendar cross-linking.

**Not the same as:** #1086 (calendar self-conflict detector) or #1288 (contact timeline) —
different capabilities, don't merge scope.

Effort: large — needs a dedicated session, not a batch build slot (5 prior batch attempts
bounced on exactly this).
EOF
)" --label "effort:large"
```
Expected output: a URL like `https://github.com/SuxOS/sux/issues/NNNN` — record `NNNN` as `$ISSUE_1035`.

- [ ] **Step 3: Verify it was created correctly**

```bash
gh issue view "$ISSUE_1035" -R SuxOS/sux --json title,state,labels --jq '{title,state,labels:[.labels[].name]}'
```
Expected: `{"title":"Build cal_semantic — Part B of #1033 (contacts Part A shipped)","state":"OPEN","labels":["effort:large"]}`

---

### Task 2: File `#1086` successor — calendar self-conflict detector

**Interfaces:**
- Produces: `$ISSUE_1086` — referenced by Task 17.

- [ ] **Step 1: Check for duplicates**

```bash
gh issue list -R SuxOS/sux --search "calendar self-conflict detector" --state all --json number,title
```
Expected: only the original `#1086`.

- [ ] **Step 2: File the issue**

```bash
gh issue create -R SuxOS/sux --title "Build calendar self-conflict detector + double-booking resolution plan" --body "$(cat <<'EOF'
Successor to #1086 (closed, folded into rollup #1252 — 4 prior batch-build attempts all
bounced on "genuinely multi-file new-subsystem work, not a single-PR batch fit," never
rejected on merits). Verified still fully unbuilt on `origin/main` (2026-07-24):
`_caldav.ts` has zero ATTENDEE/ORGANIZER parsing, `_agenda.ts`'s `EventRef` type still has
no attendee field (its own code comment still reads "Calendar co-attendance is left for a
future pass"), no `detectCalendarConflictDrops` function exists, and `op-engine/registry.ts`
+`caps.ts` have zero calendar-conflict op tree.

**Scope (unchanged from original #1086):**
1. Parse ATTENDEE/ORGANIZER in `sux/src/fns/_caldav.ts`, widen `EventRef`.
2. A pure `detectCalendarConflictDrops(events)` in `_agenda.ts`.
3. A `calendar-conflict-plan` op tree + sink in `op-engine/caps.ts` and `registry.ts`.

Effort: large — needs a dedicated session, not a batch build slot.
EOF
)" --label "effort:large"
```
Expected: a new issue URL — record as `$ISSUE_1086`.

- [ ] **Step 3: Verify**

```bash
gh issue view "$ISSUE_1086" -R SuxOS/sux --json state --jq '.state'
```
Expected: `OPEN`

---

### Task 3: File `#880` successor — durable multi-round scheduling negotiator

**Interfaces:**
- Produces: `$ISSUE_880` — referenced by Task 17.

- [ ] **Step 1: Check for duplicates**

```bash
gh issue list -R SuxOS/sux --search "scheduling negotiator waitForEvent" --state all --json number,title
```
Expected: only the original `#880`.

- [ ] **Step 2: File the issue**

```bash
gh issue create -R SuxOS/sux --title "Build durable multi-round scheduling negotiator (op-engine waitForEvent extension)" --body "$(cat <<'EOF'
Successor to #880 (closed, folded into rollup #1252 — 15 prior batch attempts all dropped
it as effort:large/unbuildable, none shipped code). Verified still fully unbuilt on
`origin/main` (2026-07-24): `durable.ts:241` has exactly one `waitForEvent` call site (the
single human-approval "ask" pause, unchanged); `suxlib/src/op/types.ts`'s Op tag union still
only has `{tag:'ask'}` — no new pause-kind was ever added; no negotiator/meeting/schedule fn
exists in `sux/src/fns/`.

**Distinct from:** `_agenda_reply.ts`/`_agenda_ask.ts`, which correlate replies via
In-Reply-To only for Colin's OWN replies to his own digest — this issue is about a
Workflow that emails a THIRD PARTY back-and-forth to lock a meeting time.

**Scope (unchanged from original #880):** a new `waitForEvent` pause-kind in `durable.ts`
correlating a third party's threaded email reply to a paused Workflow instance, plus a
multi-round negotiation state machine and accept/decline/counter parsing.

Effort: large, likely needs Opus-tier reasoning for the negotiation state machine — route to
a dedicated design/build session, not a low-tier batch slot.
EOF
)" --label "effort:large"
```
Expected: a new issue URL — record as `$ISSUE_880`.

- [ ] **Step 3: Verify**

```bash
gh issue view "$ISSUE_880" -R SuxOS/sux --json state --jq '.state'
```
Expected: `OPEN`

---

### Task 4: File `#1099` successor — research scout

**Interfaces:**
- Produces: `$ISSUE_1099` — referenced by Task 17.

- [ ] **Step 1: Check for duplicates**

```bash
gh issue list -R SuxOS/sux --search "research scout centroid-drift" --state all --json number,title
```
Expected: only the original `#1099`.

- [ ] **Step 2: File the issue**

```bash
gh issue create -R SuxOS/sux --title "Build research scout — close the loop from infer's centroid-drift to research connectors" --body "$(cat <<'EOF'
Successor to #1099 (closed, folded into rollup #1252 — 3 separate autonomous builder
sessions picked this up and dropped it each time as "needs a dedicated session, not a batch
slot," the 3rd applying needs-human to stop further churn). Verified still fully unbuilt on
`origin/main` (2026-07-24): zero hits anywhere in the repo for `research_suggestion`,
`RESEARCH_SCOUT_ENABLED`, or query-derivation from `whyTrail`; `stage.ts`'s `STAGE_KINDS`
has no research_suggestion entry; `_infer_drift.ts`/`_infer_nudge.ts` never fan out
externally.

**Scope (unchanged from original #1099):** a `research_suggestion` proposal kind, gated
behind a `RESEARCH_SCOUT_ENABLED` flag, deriving a query from `infer`'s centroid-drift
`whyTrail` and fanning out to `arxiv`/`pubmed`/`tavily`/`web_search`.

Effort: large — needs a dedicated design-and-build session.
EOF
)" --label "effort:large"
```
Expected: a new issue URL — record as `$ISSUE_1099`.

- [ ] **Step 3: Verify**

```bash
gh issue view "$ISSUE_1099" -R SuxOS/sux --json state --jq '.state'
```
Expected: `OPEN`

---

### Task 5: File `#1062` successor — recurring-commitment audit, rewritten for Lunch Money

**Interfaces:**
- Produces: `$ISSUE_1062` — referenced by Task 17.

- [ ] **Step 1: Check for duplicates**

```bash
gh issue list -R SuxOS/sux --search "recurring commitment audit lunchmoney" --state all --json number,title
```
Expected: no prior hits (original #1062 was Monarch-scoped, different title).

- [ ] **Step 2: File the issue**

```bash
gh issue create -R SuxOS/sux --title "Build durable recurring-commitment audit plan — retarget from Monarch (retired) to Lunch Money" --body "$(cat <<'EOF'
Successor to #1062 (closed, folded into rollup #1252 — 3 prior batch attempts each
explicitly noted "deferred, not superseded — still real, valuable, unbuilt work").

**Premise update, not in the original issue:** Monarch was fully retired (commit cab638c0,
PR #1333, "retire Monarch") — `monarch.ts` is gone, `MONARCH_TOKEN` no longer exists in the
codebase. `sux/src/fns/lunchmoney.ts` is now the live financial-data source. #1062's stated
blocking dependency ("depends on MONARCH_TOKEN being provisioned") is moot. A smaller,
already-shipped sibling (`detectMonarchDrops`'s subscription_creep entry in `_agenda.ts`,
via #1059/#1067) does exact-string merchant grouping and price-creep flagging only — no
fuzzy clustering, no mail cross-reference, no cancellation draft, not an op-engine durable
plan. This issue is the remaining, larger scope.

**Scope, rewritten:** a `lunchmoney_recurring_audit_plan` op-engine durable plan module.
Lunch Money's own `/recurring_items` endpoint (already exposed via `lunchmoney.ts`'s
`op:'recurring'` call, returning payee/amount/cadence) likely obsoletes the original
fuzzy-clustering step entirely — check this FIRST before building any clustering logic.
Remaining scope: price-creep/forgotten-subscription flags on top of that native data,
`_mail_semantic.ts` cross-reference to find signup/cancellation emails, and a `staged()`
cancellation-email draft.

**Needs-human note:** this touches real financial data and drafts real cancellation
emails (staged, not sent) — confirm Colin's comfort with the rewritten Lunch-Money-based
scope before this is dispatched to an autonomous build.

Effort: large.
EOF
)" --label "effort:large,needs-human"
```
Expected: a new issue URL — record as `$ISSUE_1062`.

- [ ] **Step 3: Verify the needs-human label landed**

```bash
gh issue view "$ISSUE_1062" -R SuxOS/sux --json labels --jq '[.labels[].name]'
```
Expected: `["effort:large","needs-human"]`

---

### Task 6: File `#998` successor — actionable Web Push

**Interfaces:**
- Produces: `$ISSUE_998` — referenced by Task 17.

- [ ] **Step 1: Check for duplicates**

```bash
gh issue list -R SuxOS/sux --search "actionable web push tap-to-approve" --state all --json number,title
```
Expected: only the original `#998`.

- [ ] **Step 2: File the issue**

```bash
gh issue create -R SuxOS/sux --title "Build actionable Web Push — tap-to-approve/reject/snooze from the lock screen" --body "$(cat <<'EOF'
Successor to #998 (closed, folded into rollup #1252 — 3 batch attempts dropped it as
effort:large, self-applied needs-human). Verified still fully unbuilt on `origin/main`
(2026-07-24): `webpush.ts`/`_webpush.ts` unchanged — `send` still takes only title/body, no
actions/data payload; zero hits repo-wide for `notificationclick`, a service worker, or any
signed proposal-callback-token primitive. Two adjacent shipped issues (#811, #1367) only
extend plain-text `notify()` call sites — neither adds action buttons, click handling, or a
callback token.

**Scope (unchanged from original #998):** a signed callback token, a service worker
handling `notificationclick`, and a `notify()` schema change carrying actions + a proposal
reference, so a proposal can be approved/rejected/snoozed directly from a push notification.
Pairs with `suxdash#1190`.

Effort: large — proven net-new-infra work (callback token + service worker + schema
change), not a batch-queue retry candidate.
EOF
)" --label "effort:large"
```
Expected: a new issue URL — record as `$ISSUE_998`.

- [ ] **Step 3: Verify**

```bash
gh issue view "$ISSUE_998" -R SuxOS/sux --json state --jq '.state'
```
Expected: `OPEN`

---

### Task 7: File `#1184` W1 successor + correct the false "shipped" claim on `#1202`

**Interfaces:**
- Produces: `$ISSUE_1184W1` — referenced by Task 17.
- Consumes: none.

- [ ] **Step 1: Check for duplicates**

```bash
gh issue list -R SuxOS/sux --search "voice register harvest auto-select" --state all --json number,title
```
Expected: no prior hits.

- [ ] **Step 2: File the issue**

```bash
gh issue create -R SuxOS/sux --title "Build voice-register harvest + auto-select (#1184 W1 — the only unshipped workstream)" --body "$(cat <<'EOF'
Successor to #1184's W1 workstream only. #1184 was a 4-workstream epic (closed, folded into
roadmap rollup #1192); W2 (comms-framework lenses, #1207), W3 (oracle-as-retrieval, #1232),
and W4 (three-sink ingestion, #1209 + #1239) all SHIPPED and are verified live in code —
do not reopen those. Only W1 never got its own build issue and remains genuinely unbuilt:
no `harvest` action exists on `preferences.ts` (still only learn|get|forget|list|reset), no
`_voice_harvest.ts` file, no `selectRegister`/`used_register` anywhere in `sux/src`, and no
seeded register taxonomy (professional/warm/stronk/brief) exists as code or KV seed.

**Scope:** harvest a voice register from Colin's real prior writing (not a canned style
string), auto-select the register by context, and have `voice.ts` return which register it
used (`used_register`) for feedback/learning purposes — per #1184's original framing of
this as "the real gap."

Effort: large.
EOF
)" --label "effort:large"
```
Expected: a new issue URL — record as `$ISSUE_1184W1`.

- [ ] **Step 3: Verify**

```bash
gh issue view "$ISSUE_1184W1" -R SuxOS/sux --json state --jq '.state'
```
Expected: `OPEN`

- [ ] **Step 4: Correct the false completion claim on `#1202`**

`sux#1202` (the still-open v4 arc) claims "Voice registers + comms-framework lenses
shipped (#1184 W1/W2)" — true for W2, false for W1 (it conflates the pre-#1184 baseline
multi-profile KV with the harvest/auto-select gap #1184 itself flagged as new work). Leaving
this uncorrected would let a future session wrongly assume W1 is done.

```bash
gh issue comment 1202 -R SuxOS/sux --body "$(cat <<EOF
Correction (found during the 2026-07-24 forgotten-ideas reconciliation, verified against
live code): this issue's claim "Voice registers + comms-framework lenses shipped (#1184
W1/W2)" is only true for W2 (comms-framework lenses, #1207). W1 (voice-register harvest
from real writing + context-based auto-select) is NOT built — no \`harvest\` action, no
\`_voice_harvest.ts\`, no \`selectRegister\`/\`used_register\` anywhere in sux/src. That
claim conflated the pre-#1184 baseline (multi-profile KV, which did already work) with the
harvest/auto-select gap #1184 itself identified as the new work. Filed as a fresh, correctly
scoped issue: $ISSUE_1184W1.
EOF
)"
```

- [ ] **Step 5: Verify the comment landed**

```bash
gh issue view 1202 -R SuxOS/sux --json comments --jq '.comments[-1].body' | head -3
```
Expected: the correction text, starting with "Correction (found during..."

---

### Task 8: File `#1185` Part A successor, with a falsifiable acceptance check for the twice-false-completed README

**Interfaces:**
- Produces: `$ISSUE_1185A` — referenced by Task 17.

- [ ] **Step 1: Check for duplicates**

```bash
gh issue list -R SuxOS/sux --search "unlocker escalation universal render scrape" --state all --json number,title
```
Expected: no prior hits.

- [ ] **Step 2: File the issue**

```bash
gh issue create -R SuxOS/sux --title "Build universal unlocker escalation (render/scrape/get) + finally rewrite README (2 prior false completions)" --body "$(cat <<'EOF'
Successor to #1185's Part A only. Part B (MyChart 60s pull fix) fully SHIPPED via
#1178→#1221→#1247→#1255 — verified live: durable "mychart-pull" op tree in registry.ts,
cron auto-dispatch via mychartPullTick(), bounded Binary fan-out, retry-exhaustion handling.
Do not reopen the MyChart half.

Part A is NOT shipped, verified live on `origin/main` (2026-07-24): `render.ts` still calls
only `cfRender` and fails on `looksBlocked` — no unlocker escalation. `scrape.ts` has no
unlocker/render fallback at all. Unlocker escalation (`unlockerRender`) is STILL
retail-fn-only (amazon/walmart/homedepot/lowes/ace/costco) plus one internal helper, never
promoted to a universal render/scrape/get rung. No `UNLOCKER_API_URL`/`UNLOCKER_API_KEY`
secret exists.

**The README problem — read this before touching anything else.** `sux/README.md` on
`origin/main` HEAD STILL contains all the stale mac-render/CapSolver content this issue
describes (multiple sections). It has been marked COMPLETED twice without the work
happening: #761 explicitly excluded README.md from its scope, and #743 was closed by PR
#750 whose actual diff only touched `_mail_triage.ts`/`mail_triage.ts` — zero README
changes. **Do not close this issue on a "Closes #N" claim alone.** Verify with:

```bash
git show origin/main:sux/README.md | grep -ciE 'mac-render|capsolver'
```
Acceptance: this must return `0` before the README half of this issue is considered done.

**Scope:**
1. Promote unlocker escalation from retail-fn-only to a universal rung on `render`/`scrape`/`get`.
2. Provision `UNLOCKER_API_URL`/`UNLOCKER_API_KEY` (Bright Data or equivalent, human-gated secret step).
3. Rewrite `sux/README.md` to remove all stale mac-render/CapSolver content (verify via the grep above, not a diff claim).
4. A separate successor issue owns the residential-proxy source-of-truth piece (originally
   #1103) — filed in this same reconciliation batch, see the `1.2-Y` tracking issue for its
   number. Don't duplicate that scope here.

Effort: large.
EOF
)" --label "effort:large"
```
Expected: a new issue URL — record as `$ISSUE_1185A`.

- [ ] **Step 3: Verify**

```bash
gh issue view "$ISSUE_1185A" -R SuxOS/sux --json state --jq '.state'
```
Expected: `OPEN`

---

### Task 9: File `#1187` successor, narrowed to Parts 1/2/4 (Part 3 shipped as `#1276`)

**Interfaces:**
- Produces: `$ISSUE_1187` — referenced by Task 17.

- [ ] **Step 1: Check for duplicates**

```bash
gh issue list -R SuxOS/sux --search "EPUB Kindle delivery composable get pipeline" --state all --json number,title
```
Expected: no prior hits.

- [ ] **Step 2: File the issue**

```bash
gh issue create -R SuxOS/sux --title "File & ebook pipeline — Parts 1/2/4 (Part 3 already shipped as #1276)" --body "$(cat <<'EOF'
Successor to #1187, narrowed. Part 3 (PDF embedded-image shrink) SHIPPED as #1276 —
`_pdf_shrink.ts`'s `shrinkPdfImages()` is live, wired into `study.ts`'s `archiveKnowledge`
and the v5 `_assimilate.ts` spine. Do not reopen Part 3.

Parts 1/2/4 are NOT built, verified live on `origin/main` (2026-07-24):
- **Part 1** (R2-vs-Dropbox doc addendum) — no commit citing #1187 touches
  `docs/proposals/archive/files.md`.
- **Part 2** (EPUB conversion, CloudConvert, Kindle delivery) — zero hits for
  kindle/epub-convert/cloudconvert anywhere in sux beyond magic-byte detection.
  `get.ts`'s own doc comment still says "docx/epub and other binary formats have no
  converter today and are returned as-is." No `kindle-send` sink exists in
  `op-engine/caps.ts`'s sink registry.
- **Part 4** (composable `get()` pipeline param + durable `book-pipeline` op) — `get.ts`
  has no `pipeline` param today. A differently-scoped v5 arc (`_assimilate.ts`'s
  `assimilate-pdfs` durable op) partially echoes the durable-pipeline architecture but is a
  general document-ingestion spine, not this issue's EPUB/Kindle-specific composable
  `pipeline{ocr,shrink,toc,epub,deliver}` param — don't conflate the two.

Part 5 (stretch: auto-TOC) stays deprioritized/optional, as the original epic specified.

Effort: large — file as real build sub-issues per part if a builder session wants to split
further; this issue can stay as the tracking parent.
EOF
)" --label "effort:large"
```
Expected: a new issue URL — record as `$ISSUE_1187`.

- [ ] **Step 3: Verify**

```bash
gh issue view "$ISSUE_1187" -R SuxOS/sux --json state --jq '.state'
```
Expected: `OPEN`

---

### Task 10: File `#1103` successor, flagged as NOT autonomous-pipeline-dispatchable

**Interfaces:**
- Produces: `$ISSUE_1103` — referenced by Task 17 and by Task 8's body (already referenced textually).

- [ ] **Step 1: Check for duplicates**

```bash
gh issue list -R SuxOS/sux --search "suxproxy fetch source of truth" --state all --json number,title
```
Expected: only the original `#1103`.

- [ ] **Step 2: File the issue**

```bash
gh issue create -R SuxOS/sux --title "Residential-proxy fetch: one git source-of-truth across sux<->suxrouter (NOT pipeline-dispatchable)" --body "$(cat <<'EOF'
Successor to #1103 (closed, folded into rollup #1252). Verified still unresolved on both
`origin/main` HEAD (sux + suxrouter, 2026-07-24): `sux/node/openwrt/provision-node.sh`
still installs a Node runtime writing `server.mjs`; `suxrouter/recovery/manifest.json`
still tracks `/etc/sux-proxy.secret` (the CGI-model file secret) as live, and
`stage-files.sh` pulls LIVE BOX BYTES for `/srv/suxproxy` — no `services/suxproxy` path
exists in suxrouter's tracked tree at all. `.github`'s residential-egress contract schema
still has literal "TODO: fill from..." descriptions, and both repos' enforcement stub
scripts are still explicitly headed "STUB — not yet wired into CI."

**⚠️ NOT DISPATCHABLE to the autonomous pipeline as-is.** A same-day (2026-07-22) `.github`
scoping doc (closing #663) explicitly states this "requires read/write access to the sux
AND suxrouter repos, which a single-repo builder session does not have." This needs a
session with BOTH repos checked out — flag it as such if filing into any dispatch queue, or
it will bounce again for the same reason it bounced before.

**Scope (the already-scoped 3-step plan from `.github`'s 2026-07-22 enforcement doc):**
1. Pick the Node-vs-CGI runtime for `/srv/suxproxy`.
2. Make sux's `fetch.sh` the tracked git source; repoint suxrouter's manifest/stage-files
   at it instead of pulling live box bytes.
3. Fill in and CI-wire the residential-egress schema (both repos' stub scripts).

Related: filed alongside `#1185`'s successor (unlocker escalation), which lists this as one
of its 4 acceptance bullets — don't duplicate scope, this issue owns the proxy
source-of-truth piece specifically.
EOF
)" --label "effort:large"
```
Expected: a new issue URL — record as `$ISSUE_1103`.

- [ ] **Step 3: Verify**

```bash
gh issue view "$ISSUE_1103" -R SuxOS/sux --json state --jq '.state'
```
Expected: `OPEN`

---

### Task 11: File `#1078` successor + comment on `suxlib#326` sequencing them together

**Interfaces:**
- Produces: `$ISSUE_1078` — referenced by Task 17.

- [ ] **Step 1: Check for duplicates**

```bash
gh issue list -R SuxOS/sux --search "noUncheckedIndexedAccess" --state all --json number,title
```
Expected: only the original `#1078` and its investigation sibling `#1080`.

- [ ] **Step 2: File the issue**

```bash
gh issue create -R SuxOS/sux --title "Enable noUncheckedIndexedAccess — blocked on suxlib#326 (TS version convergence)" --body "$(cat <<'EOF'
Successor to #1078 (closed, folded into rollup #1252). `tsconfig.json` has no
`noUncheckedIndexedAccess` entry today — never flipped. Not decided against: 5 batch
attempts confirmed a genuine cross-repo blocker, not just size — flipping the flag surfaces
92 errors inside `../suxlib`'s raw `.ts` sources (compiled under sux's single global
compilerOptions block; `skipLibCheck` only exempts `.d.ts`, and real CI clones the same raw
suxlib source), so a sux-only PR can never go green. That investigation is tracked as
`#1080` (closed COMPLETED as an investigation, not a fix).

**Real blocker:** `SuxOS/suxlib#326` — TS 7.0.2 (sux) vs TS 5.6/verbatimModuleSyntax
(suxlib). suxlib#326 was independently dropped by 6 batches as "structurally unfixable from
a suxlib-only session," labeled needs-human, folded into suxlib's own roadmap rollup #435.

**Sequencing:** this issue and `suxlib#326` must be resolved together — reopen both, don't
re-attempt #1078 until suxlib#326's TS-version decision (bump suxlib to TS 7.0.2 + sux's
ES2022/verbatimModuleSyntax, or hold sux back on 5.6) is made.

See also `sux/CLAUDE.md:422-428`: "Don't re-attempt #1078 until suxlib gets its own fix
landed first" — this issue supersedes that instruction's target (the old #1078), point it
at this issue instead once filed.
EOF
)" --label "effort:medium"
gh issue comment 326 -R SuxOS/suxlib --body "$(cat <<EOF
Cross-linking from the 2026-07-24 forgotten-ideas reconciliation: sux's
noUncheckedIndexedAccess rollout (successor to sux#1078: sux#$ISSUE_1078) is blocked on
whatever gets decided here. Both issues should be resolved together — the TS-version
convergence this issue names is the real blocker, not a suxlib-side bug to fix in isolation.
EOF
)"
```
Expected: a new sux issue URL — record as `$ISSUE_1078`. The suxlib comment should post without error.

- [ ] **Step 3: Verify both landed**

```bash
gh issue view "$ISSUE_1078" -R SuxOS/sux --json state --jq '.state'
gh issue view 326 -R SuxOS/suxlib --json comments --jq '.comments[-1].body' | head -2
```
Expected: `OPEN`, then the cross-link comment text.

---

### Task 12: File `#1136` as needs-human — auto-dispatch durable "plan" ops

**Interfaces:**
- Produces: `$ISSUE_1136` — referenced by Task 17.

- [ ] **Step 1: Check for duplicates**

```bash
gh issue list -R SuxOS/sux --search "auto-dispatch durable plan ops cron" --state all --json number,title
```
Expected: only the original `#1136`.

- [ ] **Step 2: File the issue with needs-human, no dispatch-eligible label**

```bash
gh issue create -R SuxOS/sux --title "[NEEDS COLIN] Auto-dispatch remaining durable 'plan' ops on cron — arms proactive LLM action over PHI/vault/contacts" --body "$(cat <<'EOF'
Successor to #1136 (closed, folded into rollup #1252). Verified still fully unbuilt on
`origin/main` (2026-07-24): only `mail_triage_plan` is cron-auto-dispatched (via
`mailTriagePlanTick`, index.ts:1212); `vault_consolidate_plan`, `contact_consolidate_plan`,
`files_consolidate_plan`, `mychart_reconcile_plan`, `vault_cross_link_plan` are all still
pull-only — `registry.ts:832`'s own comment still literally reads "manual
vault_cross_link_plan call (the durable, human-approved 'Related' block append)."

**⚠️ THIS NEEDS COLIN'S EXPLICIT SIGN-OFF, NOT A BATCH BUILD.** suxbot's own drop-comment
from 2026-07-20 says it plainly: this "would newly activate proactive fetch+LLM-draft
behavior over PHI (MyChart outreach), vault content, contacts, and Dropbox files that today
only runs on explicit human request... needs a dedicated session with deliberate
design/sign-off." `automerge.yml` merges without human review — so if this were ever
auto-dispatched and auto-merged, five new autonomous LLM-drafting behaviors over
PHI-adjacent data would go live with zero review gate.

**Before anyone builds this (bot or human), Colin needs to decide:**
1. Which of the 5 remaining plan ops actually get auto-dispatched (all of them, or a subset?).
2. What cadence/staggering (same tier as their read-only detector siblings, or slower?).
3. Whether a human-review gate should exist on the FIRST auto-merge of each, even if
   `automerge.yml` doesn't normally require one.
4. Subrequest budget impact of 5 more cron-dispatched fan-outs.

**Scope once approved:** generalize `mailTriagePlanTick`'s gate→dedup→start pattern
(index.ts:669/724) into a shared helper, wire one auto-start call per remaining plan op
onto the approved cadence.
EOF
)" --label "needs-human"
```
Expected: a new issue URL, labeled only `needs-human` (no `dispatch`/`building` label) — record as `$ISSUE_1136`.

- [ ] **Step 3: Verify the label is correct**

```bash
gh issue view "$ISSUE_1136" -R SuxOS/sux --json labels --jq '[.labels[].name]'
```
Expected: `["needs-human"]` exactly — no other label present.

---

### Task 13: File `#1117` as needs-human — `growth` fn (therapy-tier + self-model)

**Interfaces:**
- Produces: `$ISSUE_1117` — referenced by Task 17.

- [ ] **Step 1: Check for duplicates**

```bash
gh issue list -R SuxOS/sux --search "growth fn advise onboard self-model" --state all --json number,title
```
Expected: only the original `#1117` and its predecessor `#842`.

- [ ] **Step 2: File the issue with needs-human**

```bash
gh issue create -R SuxOS/sux --title "[NEEDS COLIN] Build growth fn — composes therapy-tier authority gate with self-model (needs zero-trust scoping pass)" --body "$(cat <<'EOF'
Successor to #1117 (closed, folded into rollup #1252; predecessor #842 was the same idea,
also closed unbuilt). No `growth.ts` fn exists anywhere in `origin/main`'s `sux/src/fns/`.
Both prerequisites are live: `advise.ts`'s three-tier authority gate (lines 26-153) and
`_onboard.ts`'s DIMENSIONS self-model synthesis (line 37) — whose own header comment TODAY
still says "therapy-aligned growth" awaits "a separate zero-trust design pass before any of
that lands" (lines 26-28). The code itself confirms the gap is still open, by design.

**⚠️ THIS NEEDS COLIN PERSONALLY, not a batch build or even a design-only session without
him.** This composes a therapy-tier authority gate with a personal self-model — real
consent and scope questions (what the fn is allowed to say, what data it touches, what
"therapy-tier" authority actually means in practice) that only Colin can resolve. Three
prior bot build-loop attempts all correctly dropped it for exactly this reason rather than
building or rejecting it.

**Scope, once Colin runs the zero-trust scoping/consent pass:** compose `advise`'s
therapy-tier authority gate with `onboard`'s self-model into the `growth` fn (north-star
item #6).
EOF
)" --label "needs-human"
```
Expected: a new issue URL, labeled only `needs-human` — record as `$ISSUE_1117`.

- [ ] **Step 3: Verify the label**

```bash
gh issue view "$ISSUE_1117" -R SuxOS/sux --json labels --jq '[.labels[].name]'
```
Expected: `["needs-human"]` exactly.

---

### Task 14: File the combined pipeline-hygiene issue

**Interfaces:**
- Produces: `$ISSUE_HYGIENE` — referenced by Task 17.

- [ ] **Step 1: Check for duplicates**

```bash
gh issue list -R SuxOS/sux --search "pipeline hygiene batch npm audit race handler" --state all --json number,title
```
Expected: no prior hits (this bundles 8 originals: #1234, #1174, #1177, #977, #1026,
#1213, #869, #1124 — check each isn't independently reopened elsewhere first).

```bash
for n in 1234 1174 1177 977 1026 1213 869 1124; do gh issue view "$n" -R SuxOS/sux --json state --jq "\"#$n: \(.state)\""; done
```
Expected: all `CLOSED` (confirms none were independently reopened since the earlier check this session).

- [ ] **Step 2: File the combined issue**

```bash
gh issue create -R SuxOS/sux --title "Pipeline hygiene batch (8 items recovered from rollup #1252)" --body "$(cat <<'EOF'
Mechanical, low-narrative-value items folded out of rollup #1252 — bundled here since none
touch PHI/consent surfaces and all are dispatch-ready as-is. Verify each is still relevant
before building (2 days old as of this filing):

- **Security:** #1234 (npm audit: `sharp <0.35.0` inherits libvips CVEs, GHSA-f88m-g3jw-g9cj)
  — check if the audit workflow has already re-filed/updated this on a later run.
- **Security-adjacent:** #1174 (suxlib `canonicalize()` lacks the `__proto__`/`constructor`/
  `prototype` guard its sibling `fieldMerge` enforces).
- #1177 (op-engine needs a `race` Op handler before the suxlib pin bump lands — `cond`/
  `parallel` done in #1165, `race` untracked).
- #977 (stuck-PR watcher `pr-watch.yml` misses old open PRs with a failing required check).
- #1026 (issue-build PR opener should surface a missing disposition record more visibly).
- #1213 (Router v4 backlog: stray second ctrld process root-causing rc=247, rendering-forced
  LuCI smoke test, allowlist scoping).
- #869 (dependency-ordered issue splits can get assigned out of order to concurrent build
  sessions — teach assignment to respect "depends on #N").
- #1124 (self-improve stub PRs can sit open long enough that their underlying complaint gets
  fixed by unrelated work before anyone merges/closes them).

Dispatch-ready as a batch; no gating needed.
EOF
)" --label "effort:small"
```
Expected: a new issue URL — record as `$ISSUE_HYGIENE`.

- [ ] **Step 3: Verify**

```bash
gh issue view "$ISSUE_HYGIENE" -R SuxOS/sux --json state --jq '.state'
```
Expected: `OPEN`

---

### Task 15: File the metal cut for `#419` — `metal-obsidian-headless-vault`

**Interfaces:**
- Produces: `$ISSUE_METAL419` (in `SuxOS/metal`) — referenced by Task 17.
- Consumes: `SuxOS/metal#4` (the sibling homelab-services cut), `SuxOS/metal` PR#16
  (secrets-plane-land, the shared prerequisite) — both exist already, no action needed on
  them here beyond referencing.

- [ ] **Step 1: Check for duplicates**

```bash
gh issue list -R SuxOS/metal --search "obsidian headless vault VPC" --state all --json number,title
```
Expected: no prior hits in the metal repo (the design lives in sux's `docs/proposals/vpc-hosting.md`, referenced by sux#419, but no metal-side cut exists yet).

- [ ] **Step 2: File the issue**

```bash
gh issue create -R SuxOS/metal --title "metal-obsidian-headless-vault — VPC-hosted live Obsidian vault (retires Mac-as-server)" --body "$(cat <<'EOF'
Full spec: `SuxOS/sux#419` ("the Mac must never serve the vault — build the VPC-hosted live
vault, retire the Tailscale-Funnel Mac backend"), design locked in sux's
`docs/proposals/vpc-hosting.md` (status: designed, 2026-07-08), Colin-approved 2026-07-17.
This is the metal-side build cut for that design — #419 already survived one
false-completion (PR #767 claimed "Closes #419" without touching the code) and was
subsequently parked in sux's needs-Colin rollup (#1252) without ever getting an equivalent
metal-side cut, unlike the other Mac-dependency-retirement work in this repo's own build
plan.

**Current metal state (verified 2026-07-24):** only `modules/core.nix` exists (SSH, ZFS
scrub/trim) — nothing else has been built yet. `sux#1420`'s Pillar 1 already sequences
`metal-homelab-services-vm` (`#4`, Jellyfin/Immich/HA/Syncthing) as a tracked, dependency-
ordered cut depending on `metal-ingress-sux-compute` (`#3`), which depends on
`metal-secrets-plane-land` (PR#16). This issue should slot into that SAME dependency chain
— same prerequisite (secrets-plane-land), not a new chain.

**Scope (per `docs/proposals/vpc-hosting.md`):** run full Obsidian (not the sync-only
`obsidian-headless` CLI — that has no REST surface and doesn't replace the plugin-rich
app) headless on elk-newt, reachable from the sux Worker over Workers VPC + `cloudflared`,
retiring the public Tailscale Funnel (`mcp-gate`) that currently exposes the Mac's Local
REST API plugin. Native Obsidian Sync (already subscribed) becomes the device-convergence
layer alongside git — the Mac drops from server to synced-device-only, same tier as a
phone.

Depends on: secrets-plane-land (PR#16, shared with #4).
EOF
)" --label "effort:large"
```
Expected: a new issue URL in `SuxOS/metal` — record as `$ISSUE_METAL419`.

- [ ] **Step 3: Verify**

```bash
gh issue view "$ISSUE_METAL419" -R SuxOS/metal --json state --jq '.state'
```
Expected: `OPEN`

---

### Task 16: File the `1.2-Y` tracking issue — the successor to `#1252`

**Interfaces:**
- Consumes: `$ISSUE_1035`, `$ISSUE_1086`, `$ISSUE_880`, `$ISSUE_1099`, `$ISSUE_1062`,
  `$ISSUE_998`, `$ISSUE_1184W1`, `$ISSUE_1185A`, `$ISSUE_1187`, `$ISSUE_1103`,
  `$ISSUE_1078`, `$ISSUE_1136`, `$ISSUE_1117`, `$ISSUE_HYGIENE`, `$ISSUE_METAL419`
  (all real numbers from Tasks 1–15 — this task MUST run after all of them).
- Produces: `$ISSUE_12Y` — referenced by Tasks 17 and 18.

- [ ] **Step 1: File the tracking issue with every real number filled in**

```bash
gh issue create -R SuxOS/sux --title "1.2-Y: reconciled gap-fill (post-1.2-X sweep miss)" --body "$(cat <<EOF
#1420 ("1.2-X arc," 2026-07-23) surveyed \`/superpowers:brainstorming\` design docs across 8
repos and calls itself the current source of truth for "what's next." Its survey method —
grepping design-doc files — structurally cannot see an issue-only rollup. #1252 ("Needs-
Colin queue," 2026-07-22, now closed by this issue) folded 24 previously-scoped work items
as unchecked checkboxes; #1420 referenced only one of them correctly (#920, explicitly
declined). This issue is #1252's successor and closes the gap #1420 left — including the
highest-value casualty, sux#419 (Colin-approved VPC-hosted vault design, already survived
one false-completion, then silently parked).

**Disposition of every #1252 item, verified against live code/issue state (not trusted
from 2-day-old rollup text):**

Close, no action — already shipped or explicitly declined:
- #1046 (stage()/STAGE_KINDS unification) — shipped, verified in \`stage.ts\` + 6 call sites.
- #920 (subrequest ledger) — explicitly declined by Colin's 2026-07-23 placement-fabric design.
- #1188 (editor stack) — shipped via SuxOS/dotfiles + SuxOS/nix; only a documented 2-command
  vim-mode switch remains (see home/vscode/RECOMMENDATION.md).

Refiled as fresh, correctly-scoped issues:
- #1035 (cal_semantic) -> $ISSUE_1035
- #1086 (calendar conflict detector) -> $ISSUE_1086
- #880 (scheduling negotiator) -> $ISSUE_880
- #1099 (research scout) -> $ISSUE_1099
- #1062 (recurring-commitment audit, retargeted to Lunch Money) -> $ISSUE_1062
- #998 (actionable Web Push) -> $ISSUE_998
- #1184 (narrowed to W1 voice-register harvest; W2-W4 shipped via #1207/#1232/#1209/#1239) -> $ISSUE_1184W1
- #1185 (narrowed to Part A; MyChart half shipped via #1221/#1247/#1255) -> $ISSUE_1185A
- #1187 (narrowed to Parts 1/2/4; Part 3 shipped as #1276) -> $ISSUE_1187
- #1103 (residential-proxy source-of-truth — NOT autonomous-pipeline-dispatchable) -> $ISSUE_1103
- #1078 (noUncheckedIndexedAccess, blocked on suxlib#326) -> $ISSUE_1078

Needs Colin personally — filed \`needs-human\`, never auto-dispatchable:
- #1136 (auto-dispatch durable plan ops — arms proactive LLM action over PHI with no review gate) -> $ISSUE_1136
- #1117 (growth fn — therapy-tier authority + self-model, needs a zero-trust consent pass) -> $ISSUE_1117

Pipeline hygiene, bundled:
- #1234/#1174/#1177/#977/#1026/#1213/#869/#1124 -> $ISSUE_HYGIENE

**#419 — the original find:** sequenced as a metal cut, \`$ISSUE_METAL419\`, slotted into
#1420 Pillar 1 alongside metal#4 (same secrets-plane-land prerequisite). Not reopening #419
itself; the metal issue references it as the full spec.

**Recurrence prevention:** cross-linked into #1420 directly (see that issue's comments) so
the next big reconciliation — even using the same doc-only survey method — has a
breadcrumb to this rollup's successor.
EOF
)"
```
Expected: a new issue URL — record as `$ISSUE_12Y`.

- [ ] **Step 2: Verify every reference resolves**

```bash
gh issue view "$ISSUE_12Y" -R SuxOS/sux --json body --jq '.body' | grep -oE '#[0-9]+' | sort -u
```
Expected: every issue number referenced in the body (1046, 920, 1188, 1035, 1086, 880,
1099, 1062, 998, 1184, 1185, 1187, 1103, 1078, 1136, 1117, 1234, 1174, 1177, 977, 1026,
1213, 869, 1124, 419, 1420, 1252, plus all the `$ISSUE_*` numbers) is a real, resolvable
issue — spot-check 3 of the freshly-filed ones with `gh issue view`.

---

### Task 17: Close `#1252`, pointing to the successor

**Interfaces:**
- Consumes: `$ISSUE_12Y` from Task 16.

- [ ] **Step 1: Comment then close**

```bash
gh issue comment 1252 -R SuxOS/sux --body "Superseded by #$ISSUE_12Y — every item in this rollup has been individually reconciled against live code/issue state (2026-07-24) and either closed as done/declined, or refiled as a fresh, correctly-scoped, correctly-gated issue. See #$ISSUE_12Y for the full disposition table."
gh issue close 1252 -R SuxOS/sux --reason "not planned"
```
Expected: no error output.

- [ ] **Step 2: Verify**

```bash
gh issue view 1252 -R SuxOS/sux --json state,stateReason --jq '{state,stateReason}'
```
Expected: `{"state":"CLOSED","stateReason":"NOT_PLANNED"}`

---

### Task 18: Cross-link `#1420`

**Interfaces:**
- Consumes: `$ISSUE_12Y` from Task 16.

- [ ] **Step 1: Comment on `#1420`**

```bash
gh issue comment 1420 -R SuxOS/sux --body "$(cat <<EOF
Found during a 2026-07-24 reconciliation pass: this issue's survey method (grepping
\`/superpowers:brainstorming\` design docs across 8 repos) structurally couldn't see #1252,
an issue-only rollup that folded 24 previously-scoped work items — including #419, the
Mac-must-never-serve-the-vault design. #1252 is now closed; every item in it has been
individually reconciled against live code state and refiled as fresh, correctly-scoped
issues (or closed as done/declined). Full disposition: #$ISSUE_12Y. If this arc's own next
reconciliation runs the same doc-only survey again, check #$ISSUE_12Y first — it's the
breadcrumb this comment exists to leave.
EOF
)"
```
Expected: no error output.

- [ ] **Step 2: Verify**

```bash
gh issue view 1420 -R SuxOS/sux --json comments --jq '.comments[-1].body' | head -3
```
Expected: the cross-link comment text, starting with "Found during a 2026-07-24..."

---

### Task 19: Final verification pass

- [ ] **Step 1: Confirm `#1252` is closed and its successor exists**

```bash
gh issue view 1252 -R SuxOS/sux --json state --jq '.state'
```
Expected: `CLOSED`

- [ ] **Step 2: Confirm all 3 gated issues carry `needs-human` and nothing else**

```bash
for n in "$ISSUE_1062" "$ISSUE_1136" "$ISSUE_1117"; do
  gh issue view "$n" -R SuxOS/sux --json labels --jq "\"#$n: \([.labels[].name] | join(\",\"))\""
done
```
Expected: each line shows `needs-human` present (and for `$ISSUE_1062`, `effort:large` alongside it — that one has two labels by design, the other two should show `needs-human` alone).

- [ ] **Step 3: Confirm `#1420` and `#1252` both carry the cross-link comments**

```bash
gh issue view 1420 -R SuxOS/sux --json comments --jq '.comments[-1].body' | grep -c "reconciliation pass"
```
Expected: `1` (the cross-link comment is the last one on the issue).

- [ ] **Step 4: Confirm the metal cut exists and references `#419`**

```bash
gh issue view "$ISSUE_METAL419" -R SuxOS/metal --json body --jq '.body' | grep -c 'sux#419'
```
Expected: `1` or more.

- [ ] **Step 5: List everything filed this session for a final human-readable summary**

```bash
echo "Tracking issue: sux#$ISSUE_12Y"
echo "Metal cut: metal#$ISSUE_METAL419"
echo "Refiled: sux#$ISSUE_1035 #$ISSUE_1086 #$ISSUE_880 #$ISSUE_1099 #$ISSUE_1062 #$ISSUE_998 #$ISSUE_1184W1 #$ISSUE_1185A #$ISSUE_1187 #$ISSUE_1103 #$ISSUE_1078"
echo "Gated (needs-human): sux#$ISSUE_1136 #$ISSUE_1117 (+ #$ISSUE_1062 flagged)"
echo "Hygiene batch: sux#$ISSUE_HYGIENE"
```

No commit step in this plan — there is no code, and GitHub issue state is the durable
record. The design doc (`sux` PR#1528) is the one artifact that gets a real git commit,
already landed.
