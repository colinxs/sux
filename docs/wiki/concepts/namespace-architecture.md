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

The shape of the whole system: **one Worker, one OAuth flow, one advertised connector.** Everything — the universal query/compute plane and the personal-data stores alike — is served from a single `/mcp` front door (the `sux` plugin). The universal side is web search, retrieval, the [[verb-algebra]] — stateless, holding no durable state so it can run anywhere. The personal side is three stateful stores, all **live**: the git-backed notes vault (`vault_*` tools over the `obsidian` fn's git backend), Fastmail over JMAP (`mail_*` plus `cal_*`/`contact_*`), and Dropbox blobs (`files_*`). Each namespace is reached by its verb prefix on the one connector — plus `recall` and the `fn` escape — not a separate endpoint.

The whole surface sits behind the same [[oauth-gate]] (`workers-oauth-provider`), so a namespace costs zero new public surface and zero new infrastructure — it is a set of front-door verbs, not a new deployment. This corrects two earlier drafts: the first proposed three separate Workers with a parallel verb vocabulary per namespace; the second (commit 220ed15) split one Worker by route into per-domain connectors (`/vault/mcp`, `/mail/mcp`, `/files/mcp`), each with its own plugin. The adopted architecture retired those per-domain connectors back into the single `/mcp` front door — their paths still route and stay OAuth-authorized for back-compat, but no plugin ships them and they are hidden from the default discovery manifest (`?all=1` still lists them).

Each namespace inherits the same cross-cutting laws rather than reinventing them: [[handle-discipline]] (references, not payloads) and [[unblocked-gated-law]] (unblocked where git can undo, gated where the world can't) both apply uniformly across the `vault_`, `mail_`, and `files_` verbs. How the connector actually gets surfaced to a given client is a separate concern, governed by [[connector-surface-policy]].
