---
name: shrink-attachments
description: "A recipe that offloads big email attachments to Dropbox and leaves a light note behind — mail_search → export → compress/convert → files_batch_put, over the sux connectors. Prompt-only, no scheduler; runs only when the user asks."
status: reference
cluster: operations
type: recipe
tags: [sux, operations, recipe, mail, files]
updated: 2026-07-10
related: ["[[enterprise-ops]]", "[[files]]", "[[digital-life-spine]]"]
---

# shrink-attachments — get big attachments out of the mailbox

A worked recipe, not a cron. It reclaims mailbox space by moving large attachments
into Dropbox and replacing them in your notes with a light handle. Every byte moves
**server-side** (the model never carries the file); every step is one of the sux
connectors' verbs. **Nothing here runs on a schedule** — wiring an unattended sweep
against a live mailbox is a decision only you make, so this stays a recipe you invoke.

> **Prerequisites:** `FASTMAIL_TOKEN` (mail), the app-folder Dropbox (`DROPBOX_*`), and
> — if you want the offload to land in a specific whole-Dropbox folder rather than the
> app workspace — `DROPBOX_FULL_*`. Absent any of these, the matching step reports
> `not_configured` and the recipe stops cleanly rather than half-running.

## The loop

1. **Find the heavy mail.** `mail_search` for messages with large attachments
   (e.g. `has:attachment larger:5M`, oldest first). You get message + attachment
   handles (ids, names, sizes) — **never the bytes**.
2. **Confirm the set.** Show the user the candidate list (sender, subject, date,
   attachment name + size, total reclaimable). Do not proceed on a vague "handle my
   attachments" — surface the actual items and get a yes. This is the one gate.
3. **Export server-side.** For each confirmed attachment, pull its blob via the mail
   connector's attachment/blob download (`jmap` `Blob/get` / the raw conduit) — the
   Worker fetches it, the bytes never transit the model.
4. **Transform (optional).** Route by type through the content-op fns, server-side:
   images → `image_convert` / `compress`; scanned PDFs → `pdf` (linearize) or `ocr`
   (add a text layer); leave already-small or already-compressed blobs untouched.
5. **Store, idempotently.** `files_batch_put` writes the (transformed) blobs to a
   deterministic path — `Attachments/<YYYY>/<from>-<subject>-<name>` — in ONE call.
   The batch is idempotent (same path + content is skipped), so a re-run after a
   partial failure converges instead of duplicating. Each returns a shareable link.
6. **Leave a light note.** `vault_batch_append` drops a line into the relevant note
   (or the daily note): `- 📎 <name> (<size>) → <dropbox link>` — so the file is
   findable without living in the mailbox. Also idempotent.
7. **Detach — only on explicit go.** Removing the attachment from the original message
   is destructive to that mail; do it only when the user confirms *after* seeing the
   offload succeed, via the mail connector's update path. Default is **keep the mail,
   add the note** — the safe, reversible outcome.

## Why it's safe

- **Zero bytes through context** — search returns handles, transforms run on the edge,
  writes take handles (the [[files]] §0 rule).
- **Recoverable by default** — the mail is kept unless you explicitly detach; Dropbox
  keeps version history; vault appends are git-reverts.
- **Idempotent** — the batch verbs ride the KV ledger, so re-running after a hiccup
  never double-writes.
- **No autonomy** — one confirmation before the offload, another before any detach, and
  no scheduler. It does nothing until you ask it to.
