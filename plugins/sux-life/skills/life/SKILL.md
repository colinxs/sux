---
name: life
description: The digital-life memory system over the sux vault + mail connectors — capture a thought in seconds, remember durable facts/people/decisions, recall across notes + mail + files + the web with citations, organize the inbox into a linked knowledge graph, and consolidate over time. Use whenever the user wants to save something to remember ("note this", "remember that…", "capture this"), asks what they know / what they decided / when something happened ("what do I know about X", "remind me…", "did I ever…"), wants to organize/triage their notes or mail, or wants their life/knowledge tied together. Git is the undo, so writes are unblocked.
---

# life — your memory, organized

A memory system for a real life, built on the sux connectors. The stores are
already there; this skill is the **discipline** that turns them into a second
brain. Six verbs, one loop: **capture → triage → link → retrieve → consolidate**,
plus **remember** for the things that must never be lost.

> **The safety model:** every vault write is a git commit, so nothing is ever
> truly destroyed — `git revert` is the undo. That means you should **write
> freely and unblocked**: capture now, tidy later. The only gated act is
> deleting (needs `confirm:true`) and sending mail. When in doubt, save it.

## The stores (what you're writing to)

| Store | Connector | Tools |
|---|---|---|
| **Notes / knowledge** | `/vault/mcp` (sux-vault) | `vault_capture`, `vault_daily_append`, `vault_daily_read`, `vault_write`, `vault_append`, `vault_edit`, `vault_read`, `vault_list`, `vault_delete` |
| **Mail / calendar / contacts** | `/mail/mcp` (sux-mail) | `mail_search`, `mail_read`, `mail_thread`, `mail_send`, `mail_draft`, `mail_archive`, `mail_masked`, and raw `jmap` (calendars/contacts) |
| **Web + capture + recall** | `/mcp` (sux-router) | `search`, `ingest` (url/text/query → vault note), `oracle` (learn-then-answer KB), `scrape`/`readability` |
| **Files** | Dropbox / R2 | `dropbox`, `store` (blobs; the vault holds the *note*, files hold the *bytes*) |

If a store isn't connected, say so plainly and use what is — never fail silently.

## Vault conventions (so the graph stays navigable)

- **PARA folders:** `Projects/` (active, deadline'd) · `Areas/` (ongoing
  responsibilities) · `Resources/` (topics/reference) · `Archive/` (done). Raw
  intake lands in `Inbox/`; daily jots in `Daily/YYYY-MM-DD.md`.
- **MOCs** (Maps of Content): a hub note per area (`Areas/Health.md`) that links
  its notes with `[[wikilinks]]`. Navigation is MOC → note → linked note, not
  folder-diving.
- **Small typed frontmatter** on durable notes. Memories use the memory contract:

  ```yaml
  ---
  title: <human title>
  metadata:
    node_type: memory          # marks a durable, remember-worthy fact
    type: person | decision | fact | event | preference | credential-ref | health
    created: 2026-07-10
    originSessionId: <this session, if known>
  tags: [<area>, ...]
  ---
  ```

## The six verbs

### 1 · capture — get it out of your head in <10s
**Trigger:** "note this", "capture", "jot", "add to today", a link/quote/thought to keep.
- A quick thought/task → **`vault_daily_append`** (`- <thought>` or `- [ ] <task>`). Zero ceremony; it's in today's note.
- A URL or a block of text worth keeping → **`vault_capture`** (`url` | `text` | `query`) → a provenance-stamped note in `Inbox/`. Add `summarize:true` for long pages. Never overwrites.
- Don't classify yet. Capture is cheap and lossy-proof; triage happens later.

### 2 · remember — a durable fact that must survive
**Trigger:** "remember that…", a person, a decision, a password *location*, a health detail, a preference.
- Write a small typed note with the **memory frontmatter** (above) via **`vault_write`**, filed under the right PARA area (a person → `Areas/People/<Name>.md`; a decision → the relevant project/area).
- One fact per note when it's load-bearing; append related facts to an existing person/topic note with **`vault_append`**/**`vault_edit`**.
- Link it into its MOC (verb 3) so it's findable, and **never store raw secrets** — store where a credential lives (`node_type: memory`, `type: credential-ref`), not the secret itself.
- **Two flavors:** *quick* (`vault_daily_append` a `remember:` line — fast, unstructured) vs *durable* (a typed frontmatter note — findable forever). Prefer durable for anything you'd be upset to lose.

### 3 · link — wire it into the graph
After a capture/remember, spend one cheap step making it findable:
- Add `[[wikilinks]]` from the new note to the people/projects/topics it touches.
- Add a line to the relevant **MOC** (`vault_edit` the hub note) so it's reachable by navigation, not just search.
- Orphan check: a note with no inbound links is a note you'll never find again.

### 4 · retrieve — recall, with citations (the "remember when I forget")
**Trigger:** "what do I know about X", "what did I decide", "when did I…", "did I ever…", "find that email about…".
Climb the ladder; stop as soon as you can answer, and **cite every source**:
```
MOC / index  →  search  →  read the whole note  →  follow [[links]] / thread  →  synthesize + cite
```
- **Vault:** `vault_list` the area / `vault_read` the MOC → read candidate notes → follow wikilinks.
- **Mail:** `mail_search` (query/from/date) → `mail_read` the hit → `mail_thread` for the conversation.
- **Web (fill gaps):** `search` → `readability`/`ingest` the top source.
- **KB shortcut:** for a topic you've taught before, `oracle` (`problem:` …, `topic:` …) answers from the distilled base first.
- **Two depths:** *fast* = vault-only (notes you wrote) for "what did I decide/note". *deep* = vault + mail + files + web, cross-referenced, for "everything about X". Say which you ran.
- **Write-back:** when recall surfaces something worth keeping, capture it (verb 1) so the next recall is cheaper.

### 5 · triage — turn the Inbox into knowledge
**Trigger:** "organize my notes", "clear my inbox", periodic tidy.
- `vault_list Inbox` → for each note: promote to its PARA home (`vault_write` the tidied note, or `vault_edit` + move), add frontmatter, link into a MOC (verb 3), then archive/remove the raw capture.
- Mail triage: `mail_search unread` → for each, capture what matters (`vault_capture text:` the gist, or draft a reply), then `mail_archive`.
- Batch it; report what moved where. Never delete a capture without confirming its content landed somewhere durable.

### 6 · consolidate — keep the graph healthy over time
**Trigger:** "consolidate", a weekly/periodic pass, the graph feels messy.
- **Merge duplicates:** two notes on the same person/topic → fold into one, `vault_edit` the survivor, `vault_delete confirm:true` the dupe (git keeps it).
- **Heal orphans:** notes with no inbound links → link them into a MOC or archive them.
- **Refresh MOCs:** ensure each area's hub lists its current notes.
- **Prune stale:** move done `Projects/` to `Archive/`. Summarize long-running threads into a single durable memory.
- Do it in small, reviewable batches; git is the audit log.

## Worked flows

- **"Remember Dr. Chen is my oncologist, appointments are Tuesdays."**
  → `vault_write Areas/People/Dr Chen.md` with memory frontmatter (`type: person`, tags `[health]`), body with the facts → `vault_edit Areas/Health.md` to add `[[Dr Chen]]` to the MOC.
- **"What do I know about my treatment plan?"** (deep recall)
  → `vault_read Areas/Health.md` (MOC) → read linked notes → `mail_search "treatment"` → `mail_read` the key thread → synthesize with citations (note paths + email subjects/dates).
- **"Capture this article for later."** → `vault_capture url:<…> summarize:true` → later, triage from `Inbox/` into `Resources/`.
- **"Draft a note to my sister with the update."** → gather via retrieve → `mail_draft to:[…]` (never `mail_send` without the user's go-ahead).

## Rules

- **Write unblocked, delete carefully.** Capture/remember freely; only `vault_delete` and `mail_send`/destroy are gated. Git reverts any write.
- **Cite on recall.** Every retrieved claim carries its source (note path + heading, or email subject + date). No un-sourced "I think you said…".
- **Handle discipline.** List/search return references; read one thing at a time. Don't dump whole mailboxes/folders into context.
- **Never store raw secrets** in the vault — store where they live, not the value.
- **When a store is missing, say so** and use the rest; don't pretend.
