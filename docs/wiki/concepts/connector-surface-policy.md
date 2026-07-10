---
title: Connector Surface Policy
status: shipped
cluster: namespaces
type: concept
tags: [sux, namespaces, shipped]
updated: 2026-07-09
related: ["[[namespace-architecture]]", "[[oauth-gate]]", "[[vault-stack]]", "[[three-mcps]]", "[[Namespaces-MOC]]"]
---

# Connector Surface Policy

**Source:** [`.claude-plugin/marketplace.json`](../../../.claude-plugin/marketplace.json), [`plugins/sux-router/`](../../../plugins/sux-router/), [`plugins/sux-vault/`](../../../plugins/sux-vault/)

The `sux` marketplace ships two plugins today, each pinned to one endpoint on the same Worker. `sux-router` is the UNIVERSAL connector (`/mcp`): web search, scraping/rendering, papers, shopping, documents, transforms, pipe/batch composition — deliberately domain-agnostic. `sux-vault` is the PERSONAL connector (`/vault/mcp`): the 9 `vault_*` tools over the git-backed knowledge store (see [[vault-stack]]). The split is deliberate policy, not accident: the universal `/mcp` surface stays non-personal so it's safe to point any client at, while personal data lives on separate per-domain namespaces — `/vault/mcp` shipped, `/mail/mcp` and `/files/mcp` planned. Both plugins ride the same [[oauth-gate]] and the same `apiRoute` array, so adding a namespace costs a new path and a new plugin manifest, not new auth infrastructure — one Worker, one OAuth, N connector namespaces. Distribution differs by client: in Claude Code the local marketplace is used directly; in Cowork/Desktop/cloud clients a synced remote connector is used instead, and `enabledPlugins` is deliberately left empty in either case.
