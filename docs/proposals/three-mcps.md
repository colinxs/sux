---
title: Three MCP namespaces
status: shipped
cluster: namespaces
type: proposal
summary: "One Worker, N per-domain /mcp connectors — vault, mail, and files all shipped + live; the lifecycle + oracle (recall) are Claude-side skills / a server verb."
tags: [sux, namespaces, shipped]
updated: 2026-07-09
---

# Three MCP namespaces — vault · mail · sux

**Corrected 2026-07-09 after reading the branch.** The earlier draft proposed 3 separate workers and a parallel verb vocabulary; both were wrong. The real architecture is Colin's (commit 220ed15) and the vault namespace is already built (`sux/src/vault-mcp.ts`). This doc now reflects reality.

## Architecture — one Worker, N connector namespaces

> "one Worker + one OAuth + N connector namespaces; `sux/mcp` = universal capabilities, each personal domain = its own `/<domain>/mcp` endpoint + its own plugin." — commit 220ed15

| Endpoint | Domain | Plugin | Status |
|---|---|---|---|
| `/mcp` | **sux** — universal web search + utilities (non-personal) | sux-router | live |
| `/vault/mcp` | **vault** — personal Obsidian store | sux-vault | **live** (`vault-mcp.ts`) |
| `/mail/mcp` | **mail** — Fastmail full JMAP | sux-mail | **live** (`mail-mcp.ts` + raw `jmap`) |
| `/files/mcp` | **files** — Dropbox blobs (Mode A + gated Mode B) | sux-files | **live** (`files-mcp.ts` + raw `dropbox`) |

All behind the same `workers-oauth-provider` flow, so each appears as its own connector in claude.ai with zero new public surface / zero new infra. Plugins auto-register connectors in **Claude Code**; the claude.ai web/mobile app still needs a manual connector add.

**Transports for the vault** (both first-class, different endpoints — not one router):
- **Cloud** = `/vault/mcp`, git store (`colinxs/vault`, every write a revertible commit, KV-cached). Works with no box awake. This is v1.
- **Local/desktop** = the live vault (Local REST API) via the **mcp-gate** wrapper on the tailnet — used where git can't serve (full-text search: GitHub code search is dead on private repos).
- **Tier-2** = a `vpc` backend (CF Workers VPC → live vault privately) is the planned path to give the *cloud* endpoint live-vault search too. See [[workers-vpc-vault-path]].

---

## `vault` MCP — the built surface (git, cloud, v1)

Fourteen tools (`vault-mcp.ts`), all over the git backend — the `obsidian` fn's store for CRUD, plus a KV-cached vault-graph scan (`vault-graph.ts`) for the backlinks/query/tags/patch tier. Prior art: `jimprosser/obsidian-web-mcp` (confirm-gated delete, daily verbs, tight schemas — kept; its OAuth/atomic-write/path-guard machinery — not re-implemented, we have our own).

| tool | contract |
|---|---|
| `vault_read` | read a note by path |
| `vault_list` | list notes, optional folder |
| `vault_write` | create/overwrite (every write a commit) |
| `vault_append` | append, create if absent |
| `vault_edit` | surgical find/replace, must match exactly once unless `all` |
| `vault_delete` | delete, **requires `confirm:true`** (git keeps it recoverable) |
| `vault_capture` | url \| text \| query → `Inbox/` with provenance frontmatter (via the `ingest` fn); optional summarize/compress; never overwrites |
| `vault_daily_read` | read today's daily note |
| `vault_daily_append` | append to today's daily (the quick task/jot surface) |
| `vault_batch_append` | idempotent fan-out append to MANY notes in one call; `dry_run` previews |
| `vault_backlinks` | notes that `[[link]]` to a target (resolves wikilinks by basename) |
| `vault_query` | find notes by **frontmatter** — simple field/value or a JsonLogic-lite `filter` (and/or/not, ==,!=,>,<,>=,<=, in); NOT full-text |
| `vault_patch` | structural edit — target exactly one of `heading` / `block` / `frontmatter_field` (replace/append/prepend) |
| `vault_tags` | tag index — list notes for a tag (frontmatter ∪ inline `#tags`), or enumerate all tags with counts |

This is the **note tier + capture + daily + graph/query tier** — the CRUD primitives plus the backlinks / frontmatter-query / tags / structural-patch graph. It's done and live.

---

## What's actually missing (the real gap)

The primitives are built. What is NOT yet built, and where my earlier "verbs" belong:

**As tools (server-side), the genuine additions:**
- `vault_search` — **full-text** search across note bodies. Still deferred: needs the live host (git code-search is dead on private repos), lands with the tier-2 `vpc` backend. (Structured search **shipped** — `vault_query` filters by frontmatter over the vault graph; it is explicitly *not* full-text.)

**As SKILLS (Claude-side, not server tools) — this is the correction to my earlier design:**
The lifecycle and the oracle are **skills that orchestrate the tools above**, per the core decision (two skills). They are NOT vault-MCP verbs:
- **capture / remember skill** — cheap intake (`vault_capture`) + durable memory-typed facts (a `vault_write` with the memory frontmatter contract, indexed into a MOC).
- **organize / consolidate skill** — triage the Inbox, wire notes into MOCs, heal orphans (`vault_list`+`read`+`edit`+`write`); periodic GC.
- **ask (the oracle)** — the retrieval ladder (MOC → search → read → semantic → link-follow → cite). A Claude behavior over the tools, not a server verb.

So the corrected model: **vault MCP = primitive tools; the knowledge lifecycle + oracle = skills.** The built `vault-mcp.ts` already got this right (tools are primitives); my earlier draft wrongly promoted skills to server verbs.

---

## `mail` MCP — **live** (`/mail/mcp`, sux-mail plugin)

Shipped (`mail-mcp.ts`): ergonomic `mail_*` verbs — search/read/thread/mailboxes/identities, draft/send (with reply/reply-all/forward via `mode`+`reply_to`, and `send_at` scheduling), schedule/scheduled/unschedule, upload, archive/move, masked (list/create/disable/enable/delete) — plus `contact_*` (over `ContactCard`, RFC 9610) and a CalDAV `cal_*`/`task_*` subsystem, over the raw `jmap` + `caldav` escape hatches. Token as worker secret; send/destroy gated; `cacheable:false`. Same namespace pattern as vault. (`mail_vacation`/`mail_quota` exist but gate to `not_configured` — Fastmail API tokens don't grant those scopes.)

## `sux` MCP — the universal endpoint (`/mcp`)

Web search + fetch + utilities (the non-personal capabilities). Already live.

## Composition

No namespace calls another; Claude composes. `vault_capture` from a `mail` read; `ask` fans vault + mail + sux and cites per source.

---

## Plan (corrected)

1. **vault primitives — DONE.** `vault_*` CRUD + capture + daily + the graph/query tier (backlinks/query/tags/patch) are built and live.
2. **`/mail/mcp` — DONE.** The sux-mail plugin + `mail_*`/`contact_*`/`cal_*`/`task_*` verbs over the raw `jmap`+`caldav` conduits are live.
3. **`/files/mcp` — DONE.** The sux-files plugin (Mode A + gated Mode B, incl. `files_transform`) is live.
4. **`vault_search`** (full-text) — still to add, with the tier-2 `vpc` backend (or lean on the mcp-gate live path on desktop meanwhile).
5. **The two skills** — capture/remember + organize/consolidate, orchestrating the vault tools. (The paused "fun part.")
6. **`ask`** — the oracle skill (retrieval ladder + citations).

The vault, mail, and files namespaces are all live today; the work left is the full-text search primitive + the two skills + the `ask` oracle.

## Related

- [[namespace-architecture]]
- [[connector-surface-policy]]
- [[vault-stack]]
- [[mail]]
- [[Namespaces-MOC]]
