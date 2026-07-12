---
title: The Vault Stack
status: shipped
cluster: namespaces
type: concept
tags: [sux, namespaces, shipped]
updated: 2026-07-09
related: ["[[namespace-architecture]]", "[[vault-backends-matrix]]", "[[connector-surface-policy]]", "[[six-verb-lifecycle]]", "[[Namespaces-MOC]]"]
---

# The Vault Stack

**Source:** [`sux/src/fns/obsidian.ts`](../../../sux/src/fns/obsidian.ts), [`sux/src/fns/ingest.ts`](../../../sux/src/fns/ingest.ts), [`sux/src/fns/dropbox.ts`](../../../sux/src/fns/dropbox.ts), [`sux/src/vault-mcp.ts`](../../../sux/src/vault-mcp.ts)

A git-backed Obsidian knowledge store, `OBSIDIAN_VAULT_REPO` (live: `colinxs/obsidian-vault`) — every write is a commit, so git history is the undo. `obsidian.ts` exposes three backends: `git` (default) hits the GitHub Contents API through a KV read-through cache validated against the branch HEAD sha (rechecked at most once a minute, trusted up to 10 minutes if GitHub is unreachable); `remote` wraps the LIVE vault's Obsidian Local REST API over a Tailscale Funnel (see [[mcp-gate]]) and falls back to its cached copy on fetch failure; `local` is an unwired stub, refused with an SSRF-safety message. `ingest.ts` captures exactly one of `url`/`text`/`query` into a provenance-stamped, never-overwritten note in `Inbox/`, with blob routing: attachments ≤1MB commit straight into the repo, larger (or `blobs:'dropbox'`) go to the Dropbox app folder, R2 is the fallback when Dropbox isn't configured. `dropbox.ts` is that app-folder-scoped blob store — structurally can't see anything outside `/Apps/<app>/`. `vault-mcp.ts` exposes the 9 `vault_*` tools (read/list/write/append/edit/delete/capture/daily_read/daily_append), surfaced as front-door verbs on the one `/mcp` connector (the former `/vault/mcp` route stays routed for back-compat but ships no plugin), cloud-git-only in v1 — full-text search is deferred to a live/VPC backend since GitHub code search is dead on private repos.
