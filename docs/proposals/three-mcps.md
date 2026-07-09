# Three MCP namespaces — vault · mail · sux

**Corrected 2026-07-09 after reading the branch.** The earlier draft proposed 3 separate workers and a parallel verb vocabulary; both were wrong. The real architecture is Colin's (commit 220ed15) and the vault namespace is already built (`sux/src/vault-mcp.ts`). This doc now reflects reality.

## Architecture — one Worker, N connector namespaces

> "one Worker + one OAuth + N connector namespaces; `sux/mcp` = universal capabilities, each personal domain = its own `/<domain>/mcp` endpoint + its own plugin." — commit 220ed15

| Endpoint | Domain | Plugin | Status |
|---|---|---|---|
| `/mcp` | **sux** — universal web search + utilities (non-personal) | sux-router | live |
| `/vault/mcp` | **vault** — personal Obsidian store | sux-vault | **built** (`vault-mcp.ts`) |
| `/mail/mcp` | **mail** — Fastmail full JMAP | sux-mail | planned |

All behind the same `workers-oauth-provider` flow, so each appears as its own connector in claude.ai with zero new public surface / zero new infra. Plugins auto-register connectors in **Claude Code**; the claude.ai web/mobile app still needs a manual connector add.

**Transports for the vault** (both first-class, different endpoints — not one router):
- **Cloud** = `/vault/mcp`, git store (`colinxs/vault`, every write a revertible commit, KV-cached). Works with no box awake. This is v1.
- **Local/desktop** = the live vault (Local REST API) via the **mcp-gate** wrapper on the tailnet — used where git can't serve (full-text search: GitHub code search is dead on private repos).
- **Tier-2** = a `vpc` backend (CF Workers VPC → live vault privately) is the planned path to give the *cloud* endpoint live-vault search too. See [[workers-vpc-vault-path]].

---

## `vault` MCP — the built surface (git, cloud, v1)

Nine tools (`vault-mcp.ts`), all dispatching through the `obsidian` fn's git backend. Prior art: `jimprosser/obsidian-web-mcp` (confirm-gated delete, daily verbs, tight schemas — kept; its OAuth/atomic-write/path-guard machinery — not re-implemented, we have our own).

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

This is the **note tier + capture + daily** — the primitives. It's done and shippable.

---

## What's actually missing (the real gap)

The primitives are built. What is NOT yet built, and where my earlier "verbs" belong:

**As tools (server-side), the genuine additions:**
- `vault_search` — full-text/structured search. Deferred: needs the live host (git code-search is dead on private repos), lands with the tier-2 `vpc` backend. The one primitive still missing.

**As SKILLS (Claude-side, not server tools) — this is the correction to my earlier design:**
The lifecycle and the oracle are **skills that orchestrate the tools above**, per the core decision (two skills). They are NOT vault-MCP verbs:
- **capture / remember skill** — cheap intake (`vault_capture`) + durable memory-typed facts (a `vault_write` with the memory frontmatter contract, indexed into a MOC).
- **organize / consolidate skill** — triage the Inbox, wire notes into MOCs, heal orphans (`vault_list`+`read`+`edit`+`write`); periodic GC.
- **ask (the oracle)** — the retrieval ladder (MOC → search → read → semantic → link-follow → cite). A Claude behavior over the tools, not a server verb.

So the corrected model: **vault MCP = primitive tools; the knowledge lifecycle + oracle = skills.** The built `vault-mcp.ts` already got this right (tools are primitives); my earlier draft wrongly promoted skills to server verbs.

---

## `mail` MCP — planned (`/mail/mcp`, sux-mail plugin)

Full JMAP per [[jmap.md]]: `mail` (ergonomic: search/read/send/draft/archive/label/masked) + `jmap` (raw full-protocol escape hatch). Token as worker secret; send/destroy gated; `cacheable:false`. Same namespace pattern as vault.

## `sux` MCP — the universal endpoint (`/mcp`)

Web search + fetch + utilities (the non-personal capabilities). Already live.

## Composition

No namespace calls another; Claude composes. `vault_capture` from a `mail` read; `ask` fans vault + mail + sux and cites per source.

---

## Plan (corrected)

1. **vault primitives — DONE.** `vault_*` CRUD + capture + daily are built and shippable.
2. **`vault_search`** — add with the tier-2 `vpc` backend (or lean on the mcp-gate live path on desktop meanwhile).
3. **The two skills** — capture/remember + organize/consolidate, orchestrating the vault tools. (The paused "fun part.")
4. **`ask`** — the oracle skill (retrieval ladder + citations).
5. **`/mail/mcp`** — the sux-mail plugin + JMAP tools; wire into capture + ask.

The vault namespace is real and usable today; the work left is the search primitive + the skills + the mail namespace.
