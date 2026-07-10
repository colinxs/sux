---
title: Use sux from your phone
status: reference
cluster: infrastructure
type: reference
summary: "How to add the sux connectors (sux / vault / mail / files) to claude.ai on your phone, what's live right now, and the memory workflow to drive it."
tags: [sux, mobile, connectors, reference]
updated: 2026-07-10
related: ["[[token-setup]]", "[[keys]]", "[[digital-life-spine]]", "[[connector-surface-policy]]"]
---

# Use sux from your phone

Everything runs on one OAuth-gated Cloudflare Worker (`https://sux.colinxs.workers.dev`).
To use it from the **claude.ai app on your phone**, add each connector once. They log
in with your GitHub account (the same gate as everywhere else).

## Add the connectors (claude.ai app → Settings → Connectors)

**Settings → Connectors → Add custom connector** → paste the URL → **Connect** → approve
the GitHub login in the browser sheet. Repeat per connector:

| Connector | URL | What it gives you |
|---|---|---|
| **sux** | `https://sux.colinxs.workers.dev/mcp` | web search, scrape/render, research, documents, transforms, capture, storage (92 tools) |
| **vault** | `https://sux.colinxs.workers.dev/vault/mcp` | your Obsidian notes — read/write/edit/capture + daily notes |
| **mail** | `https://sux.colinxs.workers.dev/mail/mcp` | Fastmail — search/read/thread/**send**/draft/archive/masked-email + raw `jmap` |
| **files** | `https://sux.colinxs.workers.dev/files/mcp` | Dropbox app-folder — list/read/write/upload/share |

> After adding or updating a connector, if the tools don't appear, toggle the connector
> off/on (the client caches the tool list).

## What's LIVE right now

- **sux** — fully live (search, fetch, research, transforms, etc.).
- **vault** — live (git-backed Obsidian store; every write is a revertible commit).
- **mail** — **live with full scope**: read, search, thread, **send**, draft, archive,
  move, masked-email, contacts (`FASTMAIL_TOKEN` set 2026-07-10).
- **files** — **live**: list/read/write/upload/share over the app-folder Dropbox (PKCE, no secret).

Not yet wired (need a token — see [[token-setup]] + run `./scripts/set-secrets.sh`):
tasks (Todoist), health (Epic/Apple), and the dormant retail/social APIs.

## Drive it: the memory workflow

Install the **`sux-life`** skill (the "second brain" over these connectors) — or just
ask in plain language. The six moves:

- **Capture** — "note this / remember this / add to today" → lands in your vault Inbox or daily note in seconds.
- **Remember** — "remember that Dr. Chen is my oncologist, Tuesdays" → a durable, typed, linked memory note.
- **Recall** — "what do I know about my treatment plan?" / "find that email about X" → searches vault + mail + files + web, **cited**.
- **Triage / consolidate** — "clear my inbox" / "organize my notes" → weave captures into the knowledge graph; merge, link, prune. Git is the undo.

Example phone moments:
- *"Search my mail for the billing thread from Bozeman Health and summarize it."* → mail_search → mail_read → summary.
- *"Draft a reply to my sister with the update, don't send."* → gather + mail_draft.
- *"Capture this article to read later."* → vault capture, provenance-stamped.
- *"What did I decide about the egress ladder?"* → vault recall with citations.

## Notes
- **Send is real** — `mail_send` dispatches immediately and files the copy in Sent. There's
  no undo on a sent email, so review drafts before sending.
- **Nothing here is destructive without a gate** — `vault_delete` needs `confirm:true`;
  `mail` won't permanently destroy without `allow_destroy`; `files_delete` needs `confirm`.
- **Privacy** — mail bodies are never cached; the Worker reads live via JMAP state tokens.
