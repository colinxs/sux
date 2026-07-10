---
title: Namespace Architecture
status: designed
cluster: namespaces
type: concept
tags: [sux, namespaces, designed]
updated: 2026-07-09
related: ["[[oauth-gate]]", "[[connector-surface-policy]]", "[[handle-discipline]]", "[[unblocked-gated-law]]", "[[Namespaces-MOC]]"]
---

# Namespace Architecture

**Source:** [[three-mcps]]

The corrected shape of the whole system: **one Worker, one OAuth flow, N connector namespaces**, each exposed as its own `/<domain>/mcp` endpoint with its own Claude Code plugin. `/mcp` is the universal, stateless query/compute plane — web search, retrieval, the [[verb-algebra]] — holding no durable state so it can run anywhere. `/vault/mcp` is the built, shipping personal-notes store (`vault-mcp.ts`, nine `vault_*` tools over the `obsidian` fn's git backend). `/mail/mcp` and `/files/mcp` are the planned stateful stores for Fastmail and blob/file storage respectively.

All namespaces sit behind the same [[oauth-gate]] (`workers-oauth-provider`), so adding a namespace costs zero new public surface and zero new infrastructure — it appears as a new connector, not a new deployment. This is a correction of an earlier draft that proposed three separate Workers and a parallel verb vocabulary per namespace; the real, adopted architecture is one Worker splitting by route, established at commit 220ed15.

Each namespace inherits the same cross-cutting laws rather than reinventing them: [[handle-discipline]] (references, not payloads) and [[unblocked-gated-law]] (unblocked where git can undo, gated where the world can't) both apply uniformly across `/vault/mcp`, `/mail/mcp`, and `/files/mcp`. How a namespace's connector actually gets surfaced to a given client is a separate concern, governed by [[connector-surface-policy]].
