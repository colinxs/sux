---
title: Enterprise ops — cross-store write/act
status: designed
cluster: operations
type: proposal
summary: "The cross-store WRITE/ACT layer (mirror of oracle's read) — pass-by-reference + batch verbs + Claude-Code scheduler + skills; heavy operate substrate deferred."
tags: [sux, operations, designed]
updated: 2026-07-09
---

# Enterprise search & operations — the cross-store WRITE / ACT layer

**Status:** proposal · **Scope:** the cross-cutting operations layer that ties the four
namespaces (**sux · vault · files · mail**) into one write/act algebra
**Grounds on:** `docs/proposals/sux-verbs.md`, `docs/proposals/vault-backends.md`,
`docs/proposals/files.md`, `docs/proposals/mail.md` — the **only** verb designs cited here.
**Companion:** the READ half is already built — sux `oracle` (server-side fan-out across
vault + files + mail + web, cite per source). This doc is its WRITE/ACT mirror and does
**not** redesign it.

---

## 0. Framing — agentic-first, substrate deferred

The four namespaces already expose a complete verb surface. The cross-cutting layer that
turns them into *operations* is **not a new server component** — it is realized, in order,
by four mechanisms that already exist or are cheap to add:

1. **Pass-by-reference verbs** — `find`-class verbs return **handles**; `store`/`transform`-class
   verbs **accept handles** and move the bytes **server-side**. Payloads never transit model
   context. (The locked rule in all four designs: *references, not payloads*.)
2. **Batch verbs** — a *list* of handles fanned out server-side in **one call** (built on sux
   `batch` / `batch_fetch`, mail `mail_batch`, files `files_operate`). Bulk becomes a few calls,
   not hundreds.
3. **The Claude Code scheduler** — `create_scheduled_task` runs a **scheduled model session**
   (cron) with no user machine attended. The morning-sweep pattern (§5).
4. **Agentic skills** — recipes that orchestrate the namespace verbs (§3).

Because (1)–(3) hold, **agentic composition covers essentially every workflow below.** The
server-side `operate` / `pipeline` *substrate* — a co-located streaming executor — is
**deferred**. It is designed last (§7), as a known future, built only when a real workload
trips one of three explicit triggers.

### The one rule that makes it cheap

Every verb obeys the shared handle discipline:

- **find/list** → returns handles + light metadata (urls · blob-ids · vault paths · message-ids
  · blobIds · task-ids · event-ids), **never** bytes or full bodies. A body crosses into context
  only when a caller reads exactly **one** record.
- **store/transform** → accepts a handle and does the fetch/move/write **server-side**.
- every list-producing verb has a **batch form** taking a *list* of handles.

The oracle is the READ specialization of exactly this discipline. Everything below is the
WRITE/ACT specialization.

### Verb legend (what is cited)

Only verbs from the four designs are used. New batch forms the workflows require are marked
**⚑FLAG** and named in §4.

| namespace | verbs cited here |
|---|---|
| **sux** | `search` · `fetch`(=`batch_fetch`) · `extract` · `transform`(ops `summarize`/`classify`/`compress`/`redact`) · `media`(ops `pdf`/`image_convert`) · `store`(backends `r2`/`dropbox`/`ingest`) · `oracle` · `batch` · `pipe` |
| **vault** | `vault_search` · `vault_read` · `vault_write` · `vault_append` · `vault_edit` · `vault_delete` · `vault_daily_append` · `vault_capture` · `todoist`(`add`/`update`/`complete`/`reschedule`) · `task_sync` |
| **files** | `files_search` · `files_read` · `files_list` · `files_put` · `files_move` · `files_operate` |
| **mail** | `mail_search` · `mail_read` · `mail_batch` · `jmap download as:store` · `create_event`/`update_event`/`delete_event` (JMAP `CalendarEvent/set` via the `jmap` escape hatch) |

---

## 1. The realization ladder (how each workflow is powered)

```
   ┌── (1) PASS-BY-REFERENCE ──┐   handles cross context; bytes move store→store server-side
   │   find→handle  store←handle │
   ├── (2) BATCH ──────────────┤   one call fans N handles server-side  (batch / mail_batch / files_operate)
   ├── (3) SCHEDULER ──────────┤   a cron'd model session; unattended (create_scheduled_task)
   └── (4) SKILLS ─────────────┘   recipes that sequence the namespace verbs
                                       (server-side OPERATE substrate — DEFERRED, §7)
```

The three killer workflows below are decomposed **only** into (1)+(2)+(4), with (3) marking the
one that runs unattended. No step needs the deferred substrate.

---

## 2. Three killer workflows, decomposed

Legend inside each table: **⇢handle** = returns a handle (no bytes), **⇠handle** = accepts a
handle (bytes move server-side), **⧉batch** = collapses N round-trips into one call.

---

### 2.1 "Find all the attachments in mail, shrink them, and save to Dropbox."

| # | verb | namespace | handle / batch behavior |
|---|---|---|---|
| 1 | `mail_search` (`hasAttachment:true`, window) | mail | ⇢**handles**: `{messageId, blobId, name, size, type}` per attachment — **never the bytes**. Server-side `Email/query`; one query returns N. ⧉ inherently batched. |
| 2 | `jmap download as:store` per `blobId` | mail | ⇠**blobId** → streams the attachment **mail-server → R2/Dropbox server-side**, ⇢**blob-id**. Bytes never touch context. ⧉ **FLAG `mail_attachments`** — a *batch* attachment export (list of blobIds → list of store blob-ids). Native JMAP back-refs (`mail_batch`) cover method calls, **not** the binary `Blob/download` endpoint. |
| 3 | `transform op:compress` (docs) · `media op:image_convert` (images) | sux | ⇠**blob-id** → shrinks server-side, ⇢**blob-id**. ⧉ `batch(transform/media, over=[blob-ids])` collapses N shrinks into one call. **map** = shrink each; **filter** = only items over a size threshold. |
| 4 | `files_put` → `/Apps/sux/…` (Mode A) | files | ⇠**blob-id** → writes to Dropbox server-side, ⇢**path**. ⧉ **FLAG `files_batch_put`** — a batch put (list of blob-ids → list of paths). Files today names only `files_operate` (a *reduce*), not a fan-out put. **human-confirm before the bulk write.** |

**Pass-by-reference wins:** at no step do attachment bytes enter context. `mail_search`
returns blobIds; `jmap download as:store` moves bytes mail→store; `transform`/`media` read and
write blob-ids; `files_put` reads a blob-id. Context sees **only handles + counts**.

**Batch collapse:** steps 2–4 are three fan-outs. With `mail_attachments`, `batch(transform)`,
and `files_batch_put`, a 200-attachment mailbox is **three calls, not 600**.

**Map / filter / reduce:** `filter` = `hasAttachment` + size > threshold (skip tiny inline
images); `map` = shrink; **no reduce** (pure fan-out).

**Idempotency:** derive the Dropbox path deterministically from the blobId
(`/Apps/sux/attachments/{msgId}-{name}`) so a re-run overwrites the same path and **converges**;
keep a KV ledger `attach:done:{blobId}` to skip already-shrunk items.

**Scheduler:** on-demand by default; can be scheduled as a periodic mailbox-hygiene sweep.

---

### 2.2 "Find any missed tasks or events in my email from the past 30 days and add them to vault / calendar / Todoist." — **RUNS UNDER THE SCHEDULER (morning sweep)**

| # | verb | namespace | handle / batch behavior |
|---|---|---|---|
| 1 | `mail_search` (`after:-30d`, paginated) | mail | ⇢**handles** + **SearchSnippet** per message. **References + snippets only.** Cursor pages the 30-day window. ⧉ one server-side query per page. |
| 2 | `transform op:classify` / `op:summarize` over snippets/bodies | sux | ⧉ `batch(transform classify, over=[messages])` → compact JSON `{isTask, isEvent, title, due, time}` per message. This is the **map**; full bodies never transit context (classify runs server-side on the message handle; only the small verdict returns). Ambiguous items → `mail_read` **one** body. |
| 3 | *(model reviews the compact candidate list)* | — | **human-confirm** the extracted task/event set before any write (bulk write to 3 systems). |
| 4a | `vault_daily_append` / `vault_append` `- [ ] … ^t-id` | vault | ⇠**path + line**, writes server-side. Auto-creates today's daily. Mints `vault_task_id`. ⧉ **FLAG `vault_batch_append`**. |
| 4b | `todoist add` | vault | ⇢`todoist_task_id`. ⧉ native batch (`add` is batchable per design). |
| 4c | `create_event` (JMAP `CalendarEvent/set`, timed items only) | mail | ⇢`event_id`. ⧉ **native JMAP batch** — one `CalendarEvent/set` creates N events. |
| 5 | `task_sync` reconciler owns the id-map | vault | writes `task:map:{vault_task_id}` (⇄`todoist`⇄`event`), stamps origin/epoch (§6). |

**Pass-by-reference wins:** the model works from **search snippets + a compact classified
JSON**, not inboxes of full email. Step 2's `classify` reduces each message to a one-line
verdict server-side — the abstract-level trick applied to triage.

**Batch collapse:** step 1 = one query per page (N handles); step 2 = one `batch` over N;
4a/4b/4c each one call. A 30-day inbox becomes a handful of calls.

**Map / filter / reduce:** **map** = classify each; **filter** = keep `isTask||isEvent`;
**reduce** = de-duplicate against the id-map before writing.

**Idempotency (critical for a repeating sweep):** a KV ledger `sweep:seen:{messageId}` records
every message already turned into a task/event, so tomorrow's 7am run **never re-creates**
yesterday's items. The 3-way id-map (§6) further guarantees one task ↔ one Todoist ↔ one event.

**Human-confirm:** yes on the batch write. Under the **scheduler** (unattended), "confirm"
degrades to *stage-and-notify*: the sweep writes to a `Daily → ## Inbox (proposed)` block and
sends one summary; promotion to Todoist/calendar waits for a reply, OR (if pre-authorized) auto-
promotes and the notification is the audit trail. This is the morning-sweep pattern (§5).

---

### 2.3 "Find 100 articles about narcolepsy, save them to Dropbox and citations to vault, write a summary and add it to the vault."

| # | verb | namespace | handle / batch behavior |
|---|---|---|---|
| 1 | `search sources:["web","scholar"]` limit≈100 | sux | ⇢**100 handles** `{url, doi, title, source_id, pdf_url, snippet}` — **no paper bodies**. `merge:"dedupe"` on DOI. ⧉ one fan-out over scholarly + web. |
| 2 | `fetch(url:[…], as:"url")` = `batch_fetch` → `files_put` `/Papers/` | sux+files | ⇠**pdf_url list** → PDFs stream **web → R2 → Dropbox server-side**, ⇢**blob-ids/paths**. Zero bytes in context. ⧉ `batch_fetch` is the fan-out; **FLAG `files_batch_put`** for the store leg. |
| 3 | build `type:citation` notes under `References/{citekey}.md` via `vault_write` | vault | ⇠**scholarly handle** → note frontmatter (authors/year/doi/…) + `pdf:` = the Dropbox **handle**. ⧉ **FLAG `vault_batch_capture`** — list of scholarly handles → N citation notes + N PDFs, server-side (the vault-backends §3.4 "batch form", currently unnamed). |
| 4 | **summary** — map: `transform op:summarize` per article; reduce: synthesize | sux | **map-reduce, the key trick.** ⧉ `batch(transform summarize, over=[100 handles])` → 100 short abstracts (≤120 words each, produced **server-side** from url/blob handles). Then a single `transform op:summarize` (or `oracle`) **reduces** the 100 *abstracts* into one review. **Full bodies never transit context — only the compressed abstracts and the final synthesis do.** |
| 5 | `vault_write` `References/narcolepsy-review.md` linking `[[citekey]]` + `[[Bibliography]]` | vault | ⇠path + body. **human-confirm** the summary write (overwrite-safe: deterministic path). |

**Pass-by-reference wins:** 100 PDFs move web→Dropbox via `batch_fetch`/`files_put` with **zero
bytes in context**; the notes carry a `pdf:` *handle*, not the PDF. The vault stays light and
greppable; the blobs stay in files.

**Batch collapse:** search (≈1 call) → fetch+store (2 calls) → citation capture (1 call) →
summarize map (1 call) → reduce (1 call). **~6 calls for 100 articles.**

**The abstract-level / map-reduce trick (step 4), spelled out:**
- **map:** summarize each article *at the source* — `transform op:summarize` runs on the url/blob
  handle server-side (Kagi Universal Summarizer / Workers-AI), emitting a ≤120-word abstract.
  100 abstracts ≈ a few KB total.
- **reduce:** feed only the abstracts into one final `summarize` (or `oracle` with
  `cite:true`, sources `["files"]`, to pin `[[citekey]]` citations). The 100 full papers are
  **never concatenated into context** — the abstracts are the compression boundary.

**Map / filter / reduce:** **filter** = `search merge:dedupe` (drop duplicate DOIs); **map** =
per-article summarize; **reduce** = synthesize + cite.

**Idempotency:** `citekey` is deterministic (`author+year`), so the PDF path
(`dropbox:/Papers/{citekey}.pdf`) and note path (`References/{citekey}.md`) are stable — a re-run
**overwrites in place and converges**, never duplicating.

**Human-confirm:** on the 100-item bulk write and on the summary note (potential overwrite).

**Scheduler:** on-demand; naturally a saved research routine if the query should re-run (e.g.
"new narcolepsy papers weekly").

---

## 3. (A) The skill surface — the recipes

Each workflow is an **agentic skill** that sequences namespace verbs. Skills are the composition
layer; they add **no new server capability** — they are the durable, re-runnable name for a verb
sequence.

| skill | wraps | key verbs | notes |
|---|---|---|---|
| **`shrink-attachments`** | §2.1 | `mail_search` → `mail_attachments` → `batch(transform/media)` → `files_batch_put` | filter by size; deterministic paths; idempotent ledger. |
| **`email-task-sweep`** | §2.2 | `mail_search` → `batch(transform classify)` → `vault_batch_append` + `todoist add` + `create_event` → `task_sync` | **scheduled** (§5); stage-and-notify; `sweep:seen` ledger. |
| **`research-harvest`** | §2.3 | `search` → `batch_fetch`+`files_batch_put` → `vault_batch_capture` → `batch(transform summarize)` → `oracle`/`summarize` → `vault_write` | map-reduce summary; deterministic citekeys. |
| **`cross-store-oracle`** *(READ, existing)* | — | `oracle` | referenced, not redesigned — the READ mirror of this layer. |

**Building-block conventions every skill inherits** (from the four designs): references-not-
payloads, batch-before-loop, human-confirm-on-bulk-write, deterministic-keys-for-idempotency,
and surgical-edit (never reprint a line — the Todoist `reschedule≠update` scar).

---

## 4. (B) The concrete batch-verb additions the workflows require

Every workflow above runs *today* except where a **batch form is missing**. Each is named here,
per namespace. These are the entire net-new surface the cross-cutting layer needs — no server
substrate.

| ⚑ new verb | namespace | signature | why the existing surface is insufficient |
|---|---|---|---|
| **`mail_attachments`** | mail | `(list of {messageId, blobId}, dest:"store"\|"dropbox") → list of blob-ids` | `mail_batch` batches JMAP **method** calls via back-references; the binary `Blob/download` endpoint is **not** a method, so N attachment downloads can't ride one Request. Needed by §2.1 step 2. Server-side, zero bytes in context. |
| **`files_batch_put`** | files | `(list of {src_handle, path}) → list of paths` | Files names `files_operate` (a *reduce* — `batch reduce_with:{pdf,merge}`) but no plain fan-out **put**. Needed by §2.1 step 4 and §2.3 step 2. **human-confirm** wrapper. Blob analog already implied by the files "batch form" column. |
| **`files_batch_move`** | files | `(list of {from, to}) → list of paths` | Same gap for the move op (files-backends flags `move` itself as new on the `dropbox` fn). Not on the critical path of the three workflows but the natural sibling; list here so the batch surface is complete. |
| **`vault_batch_append`** | vault | `(list of {path, line}) → list of block-ids` | vault-backends' per-op contract says "batch of N ops fans out server-side, one call" but **names no verb**. Needed by §2.2 step 4a (append N checkboxes) — surgical, body-preserving. |
| **`vault_batch_capture`** | vault | `(list of scholarly handles) → list of {note_path, pdf_handle}` | vault-backends §3.4 step 3 describes exactly this ("a LIST of scholarly handles → N citation notes + N PDFs, fanned out server-side") but leaves it unnamed. Needed by §2.3 step 3. Reuses `vault_capture`'s server-side fetch+write discipline. |

**Already sufficient (no addition):**
- sux `batch` / `batch_fetch` / `pipe` — the general MAP+REDUCE+COMPOSE engine; every
  `batch(verb, over=[…])` above rides it.
- mail `mail_batch` — native one-Request JMAP back-references (used for batched `mail_read`).
- vault `todoist` — `add`/`update`/`complete`/`reschedule` are already batchable per design.
- calendar `create_event`/`update_event`/`delete_event` — native `CalendarEvent/set` multi-object
  batch; no wrapper needed.
- files `files_operate` — the batch **reduce** (e.g. merge N PDFs into one).

> **Naming discipline:** every ⚑ verb is a *batch form of an existing verb*, not a new capability.
> None reimplements concurrency — they delegate to the shared fan-out engine (sux `batch`, JMAP
> Request batching, Dropbox batch endpoints). This keeps the "no private reimplementations" rule.

---

## 5. (C) The scheduled-task pattern — the morning sweep

`email-task-sweep` (§2.2) is the canonical unattended job. It runs as a **scheduled model
session**, not a Worker cron — because it needs per-item **model judgment** ("is this email a
task?") that no fn encodes.

```
create_scheduled_task(
  cron:   "0 7 * * *",                     # 07:00 daily, no user machine attended
  prompt: "Run skill email-task-sweep over the last 24h of mail."
)
```

**The pattern:**
1. **Trigger** — cron fires a fresh, headless model session (Claude Code scheduler).
2. **Discover** — `mail_search(after:-24h)` → handles + snippets (one query).
3. **Judge (map)** — `batch(transform classify, over=[messages])` → compact verdicts; read one
   body only when ambiguous. Bodies never bulk-load.
4. **Dedupe (reduce)** — drop anything already in `sweep:seen:{messageId}` / the id-map.
5. **Stage-and-notify** — write proposals to `Daily/{today}.md → ## Inbox (proposed)` via
   `vault_batch_append`; send one summary. Auto-promote to Todoist/calendar only if pre-authorized
   (the notification is then the audit trail); otherwise promotion waits for a reply.
6. **Reconcile** — `task_sync` (§6) folds any promoted items into the 3-way id-map.

**Two crons, two jobs — do not conflate:**
- **the sweep (this §)** = a *scheduler model session* — judgment over email (does the model work).
- **`task_sync` (§6)** = a *Worker cron* — mechanical 3-way reconciliation with echo-suppression
  (no model, runs every ~5 min). The sweep *creates*; `task_sync` *converges*.

**Idempotency is load-bearing here** because the job repeats: the `sweep:seen` ledger + the id-map
guarantee a message is triaged once, forever.

---

## 6. (D) The 3-way task fan-out — vault + Fastmail/JMAP calendar + Todoist

This is the WRITE-side heart of the layer. It is specified in full in `vault-backends.md` Part 2;
summarized here as it is used by §2.2. **Not Google** — the calendar leg is the **Fastmail
calendar**. **[Shipped correction 2026-07-11:** it rides the **CalDAV** subsystem
(`cal_*`/`task_*` verbs over `_caldav.ts`, app-password gated), **not** a JMAP `CalendarEvent`
over the `jmap` surface — Fastmail advertises no JMAP calendars capability. Every
`create_event`/`update_event`/`delete_event` / `CalendarEvent/set` reference in this doc
(incl. the §1 namespace tables) should read as `cal_create`/`cal_delete`/`task_*` on CalDAV.]**

**A converging replica set, vault as tie-break hub** (no single writer):

```
   vault checkbox  ──┐                          ┌──  Todoist task      (task semantics)
   - [ ] … ^t-ab12   ├──  task:map:{id}  (KV) ──┤
   (canonical + ctx) ─┘   vault_id ⇄ todoist_id ⇄ event_id
                                                 └──  JMAP CalendarEvent (time-block)
```

- **id-map (server-side, never in context):** `task:map:{vault_task_id}` +
  reverse `task:byTodoist:{id}` / `task:byEvent:{id}`. The reconciler passes **ids** between legs,
  never task bodies. Listing returns `{vault_task_id, todoist_task_id, event_id, path, due,
  status}` handles.
- **stable id:** an Obsidian block-id inline tag `^t-ab12cd` on the checkbox line — survives the
  surgical `vault_edit`, found by `vault_search`.
- **echo suppression:** each map row carries `origin` + a monotone `sync_epoch`; a write the
  reconciler makes is recorded as its resulting hash. On the next poll, `current_hash ==
  last_sync_hash` ⇒ **ours, ignore**. Belt-and-suspenders markers: Todoist hidden label `sux-sync`,
  JMAP event `sux:origin` property. This is the standard *compare-against-last-written-hash* loop-
  breaker.
- **conflict rule:** last-writer-wins **by mtime, per field**; exact tie ⇒ **vault wins** (hub).
  Completion is monotone-biased (a `complete` in any leg propagates; an `uncomplete` wins only if
  strictly newer).
- **field projection:** timed checkbox → Todoist task **and** a CalendarEvent time-block;
  untimed → Todoist only. Completing in Todoist checks the vault box (`[x]` + `✅ {date}`) **and**
  deletes the calendar block.
- **verbs:** `vault_append`/`vault_edit` (checkbox), `todoist add`/`update`/`complete`/`reschedule`,
  `create_event`/`update_event`/`delete_event` (JMAP `CalendarEvent/set`). Reconciler = **`task_sync`**
  on a Worker cron (~5 min + on-write hook for instant completion). Batch: `vault_batch_append`
  (⚑§4), `todoist` native batch, `CalendarEvent/set` native batch.

**Where citations vs PDFs land (the vault/files boundary, restated for §2.3):**
- the **citation note** → **vault** (`References/{citekey}.md`, markdown, git-backed, greppable,
  the undo-able source of truth) via `vault_write` / `vault_batch_capture`.
- the **PDF blob** → **files** (`dropbox:/Papers/{citekey}.pdf`) via `batch_fetch` + `files_put`;
  linked from the note only by a `pdf:` **handle**, never embedded. Dropbox mirrors vault git
  one-way and owns blobs; it never co-owns the vault dir. The `oracle` cites by handle
  (`[[citekey]]` + doi from frontmatter) and reads a PDF only when a claim demands it — MOC-first,
  not embeddings.

---

## 7. (E) LAST — when to build the `operate` substrate

Everything above is agentic: pass-by-reference + batch verbs + the scheduler + skills. The
server-side **`operate` / `pipeline` substrate** — a co-located streaming executor that runs a
verb graph next to the stores with checkpoint/resume — is **deferred as a known future**. Build it
only when a real workload trips one of these **three triggers**:

1. **Per-item MODEL judgment over thousands of items, not reducible to a fn.** When §2.2's
   `classify` map must run over *thousands* of messages every cycle, paying model latency per item
   through the agentic loop, an `operate` node co-located with mail (JMAP) that streams judgments
   server-side beats fanning through context.
2. **Streaming reliability / idempotency at scale — checkpoint/resume over hundreds of writes.**
   When §2.3 grows from 100 to thousands of citations, or the fan-out spans flaky legs, a
   resumable pipeline (write N, checkpoint, resume on failure) is safer than a batch verb that must
   succeed or restart wholesale.
3. **Cost-critical scheduled bulk.** When a scheduled sweep's cost is dominated by moving handles
   through the model session, an `operate` graph that executes the whole recipe server-side (model
   only at the judgment leaves) collapses the per-run cost.

Until a workload hits one of these, `operate` stays on paper. The four namespaces' verbs + the five
⚑ batch additions (§4) + the scheduler are the whole layer.

---

## Appendix — coverage check (every workflow step maps to a cited verb)

| workflow | step verbs (existing) | ⚑ new (batch) |
|---|---|---|
| **2.1 shrink attachments** | `mail_search` · `jmap download as:store` · `transform`/`media` · `files_put` | `mail_attachments` · `files_batch_put` |
| **2.2 email task/event sweep** | `mail_search` · `transform classify` · `mail_read` · `vault_daily_append`/`vault_append` · `todoist add` · `create_event` · `task_sync` | `vault_batch_append` |
| **2.3 research harvest** | `search` · `fetch`/`batch_fetch` · `files_put` · `vault_write` · `transform summarize` · `oracle` | `files_batch_put` · `vault_batch_capture` |

No workflow step invents a verb outside the four designs; every gap is a **batch form** of an
existing verb, named in §4.

## Related

- [[handle-discipline]]
- [[oracle-supersession]]
- [[six-verb-lifecycle]]
- [[Namespaces-MOC]]
