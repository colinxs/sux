---
title: files — the blob namespace
status: shipped
cluster: namespaces
type: proposal
summary: "The files blob namespace — unblocked App-folder workspace (Mode A) + gated in-place corpus ops (Mode B); files_operate moves zero bytes through the model."
tags: [sux, namespaces, designed]
updated: 2026-07-09
---

# files — the blob namespace: a synced workspace + operations over the whole corpus

> **⚠️ Superseded framing — point-in-time design record.** This doc designs files as its own connector (`/files/mcp`) and plugin (`sux-files`), the "fourth endpoint" alongside `/vault/mcp` and `/mail/mcp`. That per-domain-connector split was later **retired into the single `/mcp` front door**: the `files_*` verbs (Mode A + gated Mode B) and the raw `dropbox`/`store` fns now ship on the one `sux` connector, no separate `/files/mcp` connector or `sux-files` plugin. The Mode A/B design below is live and accurate; read the endpoint/plugin packaging as history. Current shape: [[namespace-architecture]] / [[connector-surface-policy]].

**The problem, stated once:** Colin wants "personalized cloud file storage and search" — but two structurally different things wear that one name, and conflating them is the trap every file connector falls into. There is the **workspace** Colin and Claude actively share (deliverables, exchange, a drop-a-file inbox — small, bidirectional, safe to leave unblocked), and there is the **corpus** — the whole Dropbox account and the local disk — which must be *operated on in place*, never mirrored wholesale into the workspace. Colin's refinement is the whole design in one sentence:

> "We do NOT sync all files. Bidirectional blobs in the Apps folder. OPERATIONS over the rest of the files. Example: find all the pdfs about foobar and merge them, replacing the original."

So this doc specs **two modes under one `files` namespace**, kept rigorously apart because their safety models are opposites, and grounds both in the blob machinery that already ships (`dropbox` fn, `store` fn, `ingest` fn, and the content-op fns `pdf`/`ocr`/`extract`/`image_convert`/`compress`/`pack`).

Companion to [three-mcps.md](three-mcps.md) (the one-Worker/N-namespaces architecture), [domains.md](domains.md) §2-dropbox (the App-folder-scope law and the whole-Dropbox split it anticipates), and [knowledge-core.md](knowledge-core.md) (the vault is the hub — files holds bytes, not facts). Nothing here reopens those; this adds the blob spoke as its own connector.

---

## 0. The one rule that shapes every verb — references, not payloads

**Colin LOCKED, applies to every verb below.** A blob namespace that moves bytes through the model is a blob namespace that can do ten items, not a hundred. So the invariant:

- A verb that **finds / lists** returns **HANDLES** (Dropbox paths, `rev` content-versions, `/s/<uuid>` store URLs, public shared links, download-link URLs) **+ light metadata** (name, size, mtime, content-type) — **never the bytes or the full body**. The sole exception is a caller explicitly reading **one** item (`files_read`, or `files_get` on a small file).
- A verb that **stores / transforms** **accepts a handle** and does the fetch / move / merge / write **server-side on the Worker**, so the payload never transits context. `files_put` takes a URL and pulls it; `files_operate` takes a search spec (or a list of handles) and does search→fetch→transform→write-back entirely edge-side, returning only a report of handles.
- Every list-producing verb has a **BATCH form** that takes a **list of references** and fans out server-side in one call, extending the existing `batch` / `batch_fetch` machinery (`batch` already does map + `reduce_with` a tool over the mapped outputs — `files_operate` is literally `reduce_with:{tool:'pdf',operation:'merge'}` over a searched list, see §5). 100 files = a few calls, zero bytes in context.

This is what lets the two skills do bulk agentically. Every verb table below states, per verb, **the handle it returns / accepts and its batch form.**

---

## 1. Architecture — a third connector namespace on the same Worker

Exactly the pattern [three-mcps.md](three-mcps.md) already runs for `vault` and plans for `mail`: **one Worker, one OAuth, N connector namespaces.** `files` is the fourth endpoint, not a fourth server.

| Endpoint | Domain | Plugin | Backing |
|---|---|---|---|
| `/mcp` | **sux** — universal web + compute | sux-router | the 89-fn engine |
| `/vault/mcp` | **vault** — Obsidian notes (facts) | sux-vault | `obsidian` fn (git) |
| `/mail/mcp` | **mail** — Fastmail JMAP | sux-mail | `jmap` fn |
| **`/files/mcp`** | **files** — blobs (bytes) | **sux-files** | **`dropbox` + `store` fns (Mode A); a full-scope Dropbox credential + the content-op fns (Mode B)** |

Wiring is byte-identical to the vault's (`sux/src/index.ts` already routes `/vault/mcp` → `handleVaultRpc`; add `/files/mcp` → `handleFilesRpc`, and `"/files/mcp"` to the OAuth provider's `apiRoute` array). A new `sux/src/files-mcp.ts` mirrors `vault-mcp.ts`'s stateless protocol shell (initialize / tools/list / tools/call, all state in the store). The plugin (`plugins/sux-files/.claude-plugin/plugin.json`) is a copy of `sux-vault`'s manifest pointing at `/files/mcp`. Zero new public surface, zero new infra.

**Why its own connector and not more `sux` tools:** the same reason vault is separate — a focused namespace keeps the blob verbs from cluttering the universal surface, and (load-bearing here) it lets Mode B's whole-account credential live behind a connector Colin adds *deliberately*, distinct from the always-on `sux` one.

---

## 2. The two modes — opposite safety models, one namespace

The modes differ on exactly one axis, and it is the axis [domains.md](domains.md) §1 made law: **unblocked where the scope wall (or an undo) protects you; gated where it doesn't.**

| | **Mode A — bidirectional blobs** | **Mode B — operations over the corpus** |
|---|---|---|
| **Reach** | `/Apps/sux/` only (+ R2) | the **whole** Dropbox account (and, later, local disk) |
| **Sync** | real two-way sync to every device | **none** — operate in place, nothing mirrored |
| **Credential** | App-folder token (the `dropbox` fn's existing secret) | a **separate full-scope** Dropbox credential (§7) |
| **Safety model** | the **scope is the wall** — the token *structurally cannot* see outside `/Apps/sux/` → Claude fully unblocked, no gates, exactly like vault writes | the wall is **gone** → the **read/write firewall** (read verbs can't mutate; write verbs plan→confirm→mutate→report) |
| **Undo** | Dropbox version history + R2 immutability | Dropbox version history + a **pre-op backup** the operate verb writes itself (§6) |
| **Verbs** | `files_put` · `files_get` · `files_list` · `files_delete` · `files_move` · `files_share` | `files_search` · `files_read` · `files_operate` |

> **Shipped verb names** (`files-mcp.ts`): the provisional `files_put`/`files_get` used throughout this doc landed split by input shape — **`files_write`** (text body) + **`files_upload`** (bytes/handle: URL, `/s/<uuid>`, or Dropbox path, fetched server-side) for the write side, and **`files_read`** for the single-read. `files_batch_put` is the batch form; `files_list`/`files_delete`/`files_move`/`files_share`/`files_search`/`files_operate`/`files_transform` kept their names. Read `files_put`→`files_write`/`files_upload` and `files_get`→`files_read` below.

The split is not a nicety — it is the [domains.md](domains.md) §2-dropbox call made concrete: *"The broad whole-Dropbox reach stays for the rare 'find that file'; the sux app-folder fn never needs that scope."* Mode A **is** that app-folder fn, promoted to first-class verbs. Mode B **is** that broad reach, given the firewall it requires.

---

## 3. MODE A — the synced workspace (`/Apps/sux/`, unblocked)

The space sux and Claude actively read and write: deliverables land here and sync to every device Colin owns; anything he drops in becomes visible to capture. This is the [domains.md](domains.md) "human-facing exchange" — a **human-writable inbox** and a **Claude-writable outbox** in one folder. It is a thin, ergonomic renaming of the existing `dropbox` fn (`put`/`get`/`list`/`delete`/`share` over `/Apps/sux/`), plus `move`, plus R2 as the machine/large-blob tier.

**Role division (unchanged from [domains.md](domains.md)):** **R2 `store` = machine-facing** (cache, artifacts, cheap and invisible, content-addressed, self-expiring handles); **Dropbox app folder = human-facing** (syncs to every device). `files_put` routes on intent: a deliverable Colin should see → Dropbox; a machine artifact or a >4 h-ephemeral blob → R2 (`ttl_seconds`). Both are handles; neither is a fact.

| verb | contract | handle returned / accepted | batch form |
|---|---|---|---|
| `files_put` | Write a blob into the workspace. Accepts **bytes** (`data` utf-8 / `base64`) **or a handle** (`source`: a URL, `/s/<uuid>` store ref, or Dropbox path) — a handle is **fetched server-side**, bytes never transit context. `mode`: `add` (default, autorename → real name returned) \| `overwrite`. `dest`: `dropbox` (default) \| `r2` (+ optional `ttl_seconds`). | **accepts** a source handle or bytes; **returns** `{ path, size, shared_link }` (Dropbox) or `{ uuid, url }` (R2) | `files_put_batch(items:[{source, path?}])` → fans out via `batch`, one call for N files |
| `files_get` | Read one workspace blob. **Metadata-first** (never buffers an oversize file into the isolate); textual extensions decode to text; **>4 MB → metadata + shared link instead of bytes** (the existing `MAX_INLINE_BYTES` guard). | **accepts** a path handle; **returns** small bytes inline, else a shared-link handle | (single-read by design; use `files_list` to enumerate) |
| `files_list` | List the workspace (folder filter, `limit:500`, cursor pagination). | **returns** `[{ path, size, modified, rev }]` — **handles + metadata, never bytes** | inherently a list; cursor-honest (never claim complete before the cursor drains) |
| `files_delete` | Delete a workspace blob (Dropbox version history keeps it recoverable → **no confirm gate**, the scope wall + undo cover it). | **accepts** a path handle | `files_delete_batch(paths:[…])` |
| `files_move` | Rename / relocate within the workspace (`files/move_v2`). | **accepts** `{ from, to }` path handles | `files_move_batch(moves:[{from,to}])` |
| `files_share` | Mint a **public "anyone with the link"** URL (reuses an existing link on 409, per the `dropbox` fn). Stated plainly because the link is public. | **accepts** a path handle; **returns** a shared-link handle | `files_share_batch(paths:[…])` → list of links |

**No gates, and why:** identical posture to vault writes — the App-folder credential *structurally cannot* escape `/Apps/sux/` ([dropbox.ts](../../sux/src/fns/dropbox.ts) lines 4–8: "the credential scope is the safety boundary and no mutation gates are needed"), and Dropbox's version history is the undo. Claude is fully unblocked here.

**Capture already feeds this folder.** The `ingest` fn's blob branch routes large/binary captures to `dropboxPut(/attachments/…)` today; `files_*` is the same folder made addressable as verbs. A file Colin drops into `/Apps/sux/` on his phone is visible to `files_list` and to the capture skill's inbox sweep — the drop-a-file inbox is real, not aspirational.

---

## 4. MODE B — operations over the whole corpus (gated, in place)

The corpus — the whole Dropbox account, and (Class B, later) local disk — is **not synced and not mirrored**. Claude reaches into it, operates, and writes back **in place**. Three verbs, and because the scope wall is gone here, they carry the read/write firewall stolen from the Dropbox plugin skills ([domains.md](domains.md) §2-dropbox ledger): **read verbs cannot mutate; the write verb plans → confirms → mutates → reports.**

| verb | contract | handle returned / accepted | batch form |
|---|---|---|---|
| `files_search` | Find across the corpus. **Filename/metadata** via Dropbox `files/search_v2` (server-side, instant); **full-text** over document contents via the index (§8) or computed on demand. Filters: `path_prefix`, `ext`, `modified_after`, `size`. **Read-only — cannot mutate.** | **returns** `[{ path, rev, size, modified, snippet? }]` — **handles + metadata + optional snippet, never full bodies** | multiple queries fan out concurrently; cursor-honest paging |
| `files_read` | Extract the text of **one** corpus file (the explicit single-read exception to §0). Routes by type: PDF→`pdf`/text layer, image→`ocr`, HTML→`extract` readability, office→`extract`. Binary with no text layer → returns a **download-link handle + metadata**, not bytes. **Read-only.** | **accepts** one path/rev handle; **returns** extracted text (or a download-link handle) | for many, use `files_search` → `files_operate` with an `extract` transform, not a fan of reads into context |
| `files_operate` | **The find→plan→apply primitive for set operations.** Takes a **find spec** (a `files_search` query) **or an explicit list of handles**, an **action** (`move`/`delete`), and runs it **server-side** over the whole set, returning **only a report of handles**. Write-intent → **plan→confirm→mutate→report** (§6). | **accepts** a find spec or list of handles; **returns** `{ matched/applied, action, targets/results }` | **this verb *is* the fan-out** — it takes the list and reduces server-side (extends `batch`'s `reduce_with`) |
| `files_transform` | **The content-transform primitive** (the merge leg of the foobar case). `op:'merge'` joins 2..20 source handles into one `dest` (raw-byte `concat`, or `pdf` render+merge via the `pdf` fn); `op:'extract'` slices ONE source by `byte_range`/`line_range` into `dest`. Bytes are fetched edge-side; the result is written back through the **same** write firewall as `files_write full:true` (§6) — dry-run by default, fence, rev-safety, `/.sux-trash` backup, output cap. | **accepts** source handles + a `dest`; **returns** `{ op, inputs:[{path,size}], output_bytes, …write-report }` | it *is* the reduce — N handles → one written file, zero bytes through context |

**What landed vs. the fuller catalog.** The shipped split is deliberate: `files_operate` owns the **set** actions (move/delete — organize + cleanup), and `files_transform` owns the **content** actions whose input shapes (`sources`/`source`/ranges) don't map onto operate's `find`/`handles`. Landed transforms compose only the primitives that exist to compose:

| transform | fn(s) | status |
|---|---|---|
| **merge** | `pdf` (`sources:[…]` merged in order) or raw-byte concat | **landed** — `files_transform op:merge` (the canonical foobar case, §5) |
| **extract (byte/line slice)** | written fresh (no fn slices an arbitrary file's bytes/lines) | **landed** — `files_transform op:extract` |
| **split** | `pdf` (`pages:'1-3,5,8-'`) | future — burst a scan into per-section PDFs |
| **compress** | `image_convert` (quality/resize) · `compress` (lossless) | future — shrink a folder of photos in place |
| **convert** | `image_convert` (png/jpeg/webp/avif) · `pdf` (anything→PDF) | future — HEIC→JPEG a camera-roll folder |
| **ocr** | `ocr` · `extract` | future — dump text sidecars for a scanned-doc folder |
| **rename / move** | Dropbox `move_v2` | **landed** — `files_operate action:move` |

The transform runs on **bytes the Worker fetched from a handle** (Dropbox `download_link` / `files/download`), never on bytes the model carried. The output is written back via the write firewall (§6). Note the merge fidelity caveat: `pdf`-mode merge always renders through the PDF pipeline, so merging non-PDF sources means "each source → PDF page(s), then concatenate," not a raw byte join — use `mode:concat` when you want the literal bytes.

---

## 5. The canonical example, end to end

> **"find all the pdfs about foobar, merge them, replace the original"**

```
files_operate({
  find:      { query: "foobar", ext: "pdf" },      // Mode B search over the whole account
  transform: { op: "merge" },                        // pdf fn, sources in mtime order
  write_back:{ policy: "replace", target: "first",   // overwrite the first/oldest match
               backup: true }                         // pre-op copies originals to /Apps/sux/.trash/
})
```

**As shipped**, this is a two-verb pipeline (the transform inputs don't fit `files_operate`'s set shape, so merge lives in `files_transform`): `files_search({query:"foobar", ext:["pdf"]})` returns the handles → `files_transform({op:"merge", sources:[…the matches…], dest:"<first match>", overwrite:true})`. `files_transform` defaults to a dry-run plan (resolved sources, sizes, would-overwrite); pass `dry_run:false` to apply. The originals move to backup with a follow-up `files_operate({action:"move", handles:[…the rest…], dest:"/…/.trash/…"})` — each step behind the §6 firewall.

**What runs, all edge-side, zero bytes in context:**
1. `files_search("foobar", ext:pdf)` → a list of `{path, rev}` **handles** (say 4 PDFs). *Read step — presented to Colin as the plan: "4 PDFs match; merge into `<first>`, moving the 4 originals to backup. Confirm?"*
2. On confirm: the Worker fetches each PDF's **bytes** from its Dropbox `download_link` (server-side), calls `pdf({ operation:"merge", sources:[…4 bytes…] })`.
3. **Backup:** the 4 originals are copied to `/Apps/sux/.trash/<date>/` (workspace = the recoverable-by-design tier) — *and* Dropbox's own version history already holds them.
4. **Write-back:** the merged PDF is written over the first match's path (`mode:update` against its `rev`, so a concurrent edit fails loudly instead of clobbering), the other 3 originals moved to `.trash/`.
5. **Report:** `{ inputs:[4 handles], output:<merged path+rev>, replaced:true, backup:'/Apps/sux/.trash/<date>/' }`. No PDF bytes ever entered context.

**Read-back-write-in-place semantics, stated precisely:**
- **Atomicity** is per-file (Dropbox has no multi-file transaction). Order: *write the new merged file first, verify, then move originals to backup, then delete stragglers.* A crash mid-way leaves the merged output plus untouched originals — recoverable, never lost.
- **Concurrency:** every write-back is `mode:update` **conditioned on the `rev`** captured at search time. If the file changed underneath, the write **fails** and the report says so — the read/write firewall's "cursor honesty" applied to content versions.
- **Idempotency:** the `pdf` merge of the same source set yields byte-identical output (deterministic), and `store`'s content-addressing means re-running dedupes. But **`replace` is not idempotent against its own output** — re-running the same operate would now find *one* merged PDF (the originals are in `.trash/`), so it is a no-op-shaped merge of one file. The find→replace is safe to retry; it converges.
- **Undo:** two layers — the pre-op `.trash/` backup (explicit, browsable, in the synced workspace) and Dropbox version history (implicit, per-file). The report hands back the backup handle so "undo that" is a `files_move` back.

**Why this is the whole point:** an agent doing this over 100 folders is 100 `files_operate` calls (or one batched call with a list), each self-contained, each moving zero bytes through the model. That is the §0 rule paying off.

---

## 6. The write-back firewall (Mode B only)

Because Mode B has no scope wall, `files_operate`'s mutating path is the one place in the whole `files` namespace that carries a gate — and it is honestly a **plan/confirm dance**, an accident guard, not an injection boundary (same framing as [jmap.md](jmap.md)'s send gates and [domains.md](domains.md) §1).

1. **Plan.** The read half (`files_search`) runs, and `files_operate` returns a **dry-run plan** by default (`apply:false`): "N files matched, here is the transform, here is what gets written / overwritten / moved, here is the backup location." No mutation yet. Read-intent skills only ever see this half — they *structurally* can't call the apply path (separate tool allowlist, per the Dropbox-plugin read/write-firewall steal).
2. **Confirm.** `apply:true` (or Colin's explicit go) crosses the line.
3. **Mutate.** Backup → write new → move/delete originals, in that recoverable order (§5), each conditioned on `rev`.
4. **Report.** Handles only: inputs, output, backup, replaced-flag, and any per-file failures (a 5-of-6 partial is reported honestly, never as success).

`replace` always implies `backup:true` unless Colin explicitly waives it; `new` (write output to a fresh path, touch nothing) needs no backup and no gate beyond the plan.

---

## 7. THE SCOPE / REACH QUESTION — how Mode B gets whole-account (and local) reach

**Mode A's credential cannot serve Mode B, by construction.** The `dropbox` fn's token is App-folder-scoped; it *structurally cannot see* anything outside `/Apps/sux/` ([dropbox.ts](../../sux/src/fns/dropbox.ts) header, [domains.md](domains.md) §2-dropbox). That is a feature for Mode A and a hard wall for Mode B. Whole-account reach needs a **second, distinct credential** — and the environment already proves two ways to get it:

**Option 1 (recommended for server-side ops) — a full-scope Dropbox credential as a second Worker secret.** Register (or re-scope) a Dropbox app with **full Dropbox access** (`files.content.read/write`, `files.metadata.read`, `sharing.*` — *not* App-folder), and store its refresh token as `DROPBOX_FULL_REFRESH_TOKEN` (+`_APP_KEY`/`_APP_SECRET`), **separate from** the App-folder secrets. Mode B verbs mint/cache short-lived tokens off *this* credential (same refresh-token machinery `dropbox.ts` already implements — KV-cached at a distinct key, 401 self-heal). **Why recommended:** it keeps `files_operate` running *server-side*, which is the only way to honor §0 — the Worker fetches bytes, merges, writes back, and zero bytes touch context. The client-side connector (Option 2) can't do server-side fan-out. The cost is the honest one: this token has no scope wall, which is *exactly* why Mode B carries the §6 firewall.
**Coexistence with the unblocked App-folder model:** the two credentials never mix. Mode A verbs only ever load the App-folder token (unblocked); Mode B verbs only ever load the full-scope token (gated). They live at different KV keys, gate differently, and are *different tools in different modes of the same connector*. The App-folder wall stays intact for the workspace precisely because Mode B never borrows it.

**Option 2 (already available today, zero new secret) — the broad claude.ai Dropbox connector.** The full Dropbox MCP connector already present in this environment (`who_am_i / search / list_folder / download_link / create_file / move / copy / delete / create_shared_link / file_preview / file requests`, any path) gives whole-account reach *right now*. In this mode `files_operate` is a **skill** that orchestrates: broad-connector `search` → sux `pdf`/`ocr`/`extract` for the transform (bytes pulled via `download_link`) → broad-connector `create_file`/`move` to write back. This ships with no Worker change at all — but it runs *client-side*, so large corpora pull handles (not bytes, still §0-safe) through the skill rather than fanning out on the edge. **Use it as the v1 path and the fallback; graduate the hot transforms to Option 1's server-side `files_operate` when volume justifies the second secret.**

**Local-disk reach is Class B and deferred.** "The rest of the files" includes local disk, which a cloud Worker cannot touch directly. Two honest paths, neither in v1: (a) **local Claude** already has native filesystem tools — Mode B operations on local files run there, no `files` MCP needed; (b) a **mac-node route** (the [domains.md](domains.md) §2-imessage pattern — path-routed endpoints on the existing Funnel'd aiohttp server, e.g. `/files/local/*`) would let the *cloud* connector reach local disk, gated identically. v1 says so plainly rather than pretending the cloud endpoint sees local files.

---

## 8. SEARCH — filename/metadata now, full-text honestly staged

Two layers, and the doc is explicit about which is server-side-instant and which is computed.

**Layer 1 — filename & metadata (ships with Mode B, server-side).** Dropbox's `files/search_v2` indexes filename, path, and (Dropbox-side, for supported types) some content already. This is instant, cursor-paginated, and covers "find that PDF called foobar" and every metadata filter (`ext`, `modified_after`, `size`, `path_prefix`). No sux-side index needed. This is `files_search`'s default and it is enough for the canonical example (`ext:pdf` + name/path match on "foobar").

**Layer 2 — full-text over document *contents* (staged).** True full-text — grep inside scanned PDFs, images, office docs — is **computed**, because the bytes live in Dropbox and the text must be extracted (`pdf` text layer / `ocr` / `extract`). Three honest tiers, now→later:

| tier | how | when | cost |
|---|---|---|---|
| **now — compute on demand** | `files_search` filename-filters to a candidate set, then `files_read` pulls each candidate's text edge-side and greps it (a future `files_transform` text-extract op would batch this) | v1 | O(candidates) extraction per query — fine for a bounded folder, not for "grep my whole Dropbox" |
| **later — KV content index** | a background sweep extracts text once and writes an inverted index / per-file text sidecar into **KV** (`files:ft:<sha>` — content-addressed, so re-indexing dedupes and a changed file re-keys); `files_search(full_text:true)` reads the index | when on-demand grep gets slow | one-time extraction per file + KV storage; incremental on change |
| **someday — vector recall** | embeddings over the extracted text (mirrors the vault's Smart-Connections trigger) | only if keyword full-text misses at scale | not v1, trigger written down |

**The honesty rule (stolen from the vault's ladder):** `files_search` states which layer answered — "matched on filename" vs "matched in content (indexed)" vs "matched in content (computed live over N candidates)" — so Colin never mistakes a fast filename hit for an exhaustive content search. Full-text is *content-addressed against the file's `rev`*: a stale index entry is detectable and skipped, same discipline as the vault's HEAD-SHA validator.

---

## 9. The boundary with vault — LOCKED (Colin)

The single most important line in this doc, because getting it wrong corrupts the knowledge store:

> **Markdown notes → vault. Blobs → files. Dropbox mirrors the vault git ONE-WAY. `files` must NOT bidirectionally own the vault notes tree.**

Made concrete:
- **`files` holds bytes, never facts.** A PDF, an image, a scan, a deliverable — these are `files`. A distilled note *about* that PDF, with provenance — that is `vault`. [domains.md](domains.md): "both blob stores hold bytes, not facts; the vault remains the only knowledge store." `files_operate` never writes a markdown note; if an operation *produces* a fact worth keeping, the **capture skill** writes the note (via `vault_capture`), linking the blob's handle. Separation of concerns: files moves bytes, vault holds meaning.
- **The Dropbox↔vault mirror is ONE-WAY and read-only from files' side.** The vault's git (`colinxs/vault`) is the source of truth ([three-mcps.md](three-mcps.md)); if a Dropbox copy of the vault tree exists (for phone viewing / iCloud-materialize), it is a **downstream mirror** — `files` may *read* it but must **never write back into it**, because a `files` write there would fork truth away from git. The `files_operate` write-back policy therefore **refuses any target path under the vault mirror** (a hard path guard, the blob analog of `badVaultPath`).
- **No overlap in the workspace, either.** `/Apps/sux/` (Mode A) is *not* the vault. Small binaries that belong *to* a note still go through `ingest` into the vault repo as attachments (`![[Attachments/…]]`, ≤1 MB) — that path is unchanged. `files` owns the *free-standing* blob workspace; `vault` owns note-attached small binaries. The size/attachment split `ingest` already implements is the seam.

---

## 10. Relationship to `dropbox` + `store` — files is the ergonomic skin, they stay primitives

`files` does not replace the `dropbox` and `store` fns — it is a **namespace of ergonomic, intent-named verbs** over them, exactly as `vault_*` is a namespace over the `obsidian` fn.

- **`store` fn** stays the raw R2 primitive (content-addressed `put`/`get`/`list`/`delete`, uuid handles, `/s/<uuid>` streaming, `ttl_seconds`). `files_put(dest:'r2')` and any machine-artifact path call it directly. Unchanged.
- **`dropbox` fn** stays the raw App-folder primitive (`put`/`get`/`list`/`delete`/`share`). Mode A verbs are thin dispatchers onto it (like `vault_read` → `obsidian.run({action:'read'})`). Unchanged — including its refresh-token/KV-cache/401-self-heal machinery, which Mode B's full-scope credential *reuses* verbatim.
- **`ingest` fn** stays capture's transport arm; its blob-routing branch already targets `/Apps/sux/` and is the seam to Mode A (§3) and to the vault boundary (§9).

So the build is **mostly wiring**: a `files-mcp.ts` protocol shell + tool table (Mode A tools dispatch to `dropbox`/`store`; Mode B tools compose `search`→content-op→write-back over the full-scope credential), a route line in `index.ts`, an `apiRoute` entry, and a `sux-files` plugin manifest. The primitives already exist and are tested.

---

## 11. Plan (phased; dependency-ordered)

**Phase 0 — Mode A, the synced workspace** *(smallest, ships first; App-folder token already configured)*
1. `files-mcp.ts` protocol shell (copy `vault-mcp.ts`); route `/files/mcp` in `index.ts`; add to OAuth `apiRoute`; `sux-files` plugin manifest.
2. Mode A tools: `files_put`/`get`/`list`/`delete`/`move`/`share` dispatching to the `dropbox` fn (+ `store` for `dest:'r2'`). `move` is the one new op on `dropbox` (`files/move_v2`) — add it as a primitive too. Batch forms via `batch`.
3. No gates (scope = wall). Ship.

**Phase 1 — Mode B read tier** *(needs the reach credential — start on Option 2, zero secret)*
4. `files_search` (filename/metadata via `files/search_v2`) + `files_read` (single-file extract via `pdf`/`ocr`/`extract`), read-only, behind the broad connector (Option 2) as a skill first, or the full-scope secret (Option 1) if added.
5. Cursor-honest paging; "which layer answered" labeling.

**Phase 2 — Mode B operate tier** *(the payoff)*
6. `files_operate` (set actions: move/rename + delete) and `files_transform` (content actions: merge N→1, extract a byte/line slice) — server-side, with the §6 plan→confirm→mutate→report firewall and the `/.sux-trash` backup. **Landed.** Remaining transforms (split/compress/convert/ocr) are future additions on the same firewall. Canonical foobar example is the acceptance test.
7. Decide Option 1 vs 2 for volume: add `DROPBOX_FULL_*` secrets if server-side fan-out is wanted.

**Phase 3 — full-text search** *(only if on-demand grep gets slow)*
8. KV content index (`files:ft:<sha>`), background extraction sweep, `files_search(full_text:true)`.

**Phase 4 — local reach** *(Class B, only if the cloud endpoint must see local disk)*
9. `/files/local/*` routes on the mac-node aiohttp server (imessage pattern), gated at parity. Until then, local Claude uses native FS tools.

**Deferred, triggers written down:** vector recall over file contents (trigger: keyword full-text misses at scale); local-disk reach from the cloud connector (trigger: a real need to operate on local files while the Mac is the only host and cloud is the caller).

---

## 12. What was stolen from whom

| Source | Lesson taken | Where it landed |
|---|---|---|
| **`store` / `dropbox` fns** | content-addressing + uuid handles; App-folder-scope-as-wall; refresh-token/KV-cache/401-self-heal | Mode A verbs; Mode B credential reuses the same machinery |
| **Dropbox plugin skills** | read/write firewall (read can't mutate; write plans→confirms→mutates→reports); explicit tool allowlists; cursor honesty; "state boundaries, don't fake them" | §6 (Mode B firewall); §7 local-reach honesty; §8 which-layer labeling |
| **vault MCP ([three-mcps.md](three-mcps.md))** | ergonomic verb namespace over a raw fn; one-Worker/N-connector; confirm-gated destructive op; stateless protocol shell | whole architecture (§1); `files_*` as skin over `dropbox`/`store` (§10) |
| **`batch` fn** | map + `reduce_with` a tool over mapped outputs; capped concurrency; per-item failure tolerance | every batch form (§0); `files_operate` = `reduce_with:{tool:'pdf',merge}` (§5) |
| **`ingest` fn** | size-based blob routing; the `/Apps/sux/` inbox seam | Mode A capture path (§3); the vault-attachment seam (§9) |
| **[domains.md](domains.md) §1 law** | unblocked where an undo/wall protects; gated where the world can't be un-done | Mode A unblocked vs Mode B gated (§2) |
| **vault ladder / consolidate** | provenance rule (blobs are cheap-to-refetch); content-addressed staleness validation | vault boundary (§9); full-text `rev`-validation (§8) |

## Related

- [[unblocked-gated-law]]
- [[handle-discipline]]
- [[vault-stack]]
- [[namespace-architecture]]
- [[Namespaces-MOC]]
