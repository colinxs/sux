---
title: Use sux from your phone
status: reference
cluster: infrastructure
type: reference
summary: "How to add the one sux connector to claude.ai on your phone, what's live right now (vault/mail/files all behind it), and the memory workflow to drive it."
tags: [sux, mobile, connectors, reference]
updated: 2026-07-10
related: ["[[token-setup]]", "[[keys]]", "[[digital-life-spine]]", "[[connector-surface-policy]]"]
---

# Use sux from your phone

Everything runs on one OAuth-gated Cloudflare Worker (`https://sux.colinxs.workers.dev`).
To use it from the **claude.ai app on your phone**, add the **one** sux connector once. It
logs in with your GitHub account (the same gate as everywhere else). Vault, mail, and files
all live behind that single front door — there are no separate per-domain connectors to add.

## Add the connector (claude.ai app → Settings → Connectors)

**Settings → Connectors → Add custom connector** → paste the URL → **Connect** → approve
the GitHub login in the browser sheet:

| Connector | URL | What it gives you |
|---|---|---|
| **sux** | `https://sux.colinxs.workers.dev/mcp` | everything: web search, scrape/render, research, documents, transforms, capture, storage — PLUS your personal vault/mail/files via the `vault_`/`mail_`/`files_`/`cal_`/`contact_` verbs (+ `recall`, + the `fn` escape) |

> The former per-domain connectors (`/vault/mcp`, `/mail/mcp`, `/files/mcp`) are retired into
> this one front door. Their routes still resolve for back-compat, but you don't add them —
> the personal tools ride the single `/mcp` connector as front-door verbs.

> After adding or updating the connector, if the tools don't appear, toggle it
> off/on (the client caches the tool list).

## What's LIVE right now

All on the one `/mcp` connector:

- **universal** — fully live (search, fetch, research, transforms, etc.).
- **vault** (`vault_*`) — live (git-backed Obsidian store; every write is a revertible commit).
- **mail** (`mail_*`, `cal_*`, `contact_*`, raw `jmap`) — **live with full scope**: read, search,
  thread, **send**, draft, archive, move, masked-email, contacts (`FASTMAIL_TOKEN` set 2026-07-10).
- **files** (`files_*`) — **live**: list/read/write/upload/share over the app-folder Dropbox (PKCE, no secret).

Not yet wired (need a token — see [[token-setup]] + run `./scripts/set-secrets.sh`):
tasks (Todoist), health (Epic/Apple), and the dormant retail/social APIs.

## Drive it: the memory workflow

Install the **`sux` plugin** — it bundles the **`life`** memory skill (the "second
brain" over these connectors) — or just ask in plain language. The six moves:

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
