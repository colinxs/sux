---
title: Connector Surface Policy
status: shipped
cluster: namespaces
type: concept
tags: [sux, namespaces, shipped]
updated: 2026-07-12
related: ["[[namespace-architecture]]", "[[oauth-gate]]", "[[vault-stack]]", "[[three-mcps]]", "[[Namespaces-MOC]]"]
---

# Connector Surface Policy

**Source:** [`.claude-plugin/marketplace.json`](../../../.claude-plugin/marketplace.json), [`plugins/sux/`](../../../plugins/sux/), [`sux/src/connectors.ts`](../../../sux/src/connectors.ts)

The `sux` marketplace ships **one plugin** and **one connector**. The `sux` plugin installs that connector (`/mcp`) plus **both** skills: the `sux` routing skill (web search, scraping/rendering, papers, shopping, documents, transforms, pipe/batch composition — AND the personal namespaces, reached through `vault_`/`mail_`/`files_`/`cal_`/`contact_` verbs, plus `recall` and the `fn` escape) and the `life` memory skill — the digital-life second brain (capture, remember, recall with citations, triage, consolidate) — which rides the same front door and ships no connector of its own. The design once split personal data onto separate per-domain connectors (`/vault/mcp`, `/mail/mcp`, `/files/mcp`, each its own plugin) and briefly a second skill-only `sux-life` plugin; those were **collapsed into the single `sux` plugin and its one `/mcp` front door**. The per-domain paths still route and stay OAuth-authorized for back-compat (see [[oauth-gate]]), but no plugin ships them and they are hidden from the default discovery manifest — one Worker, one OAuth, one advertised connector, one plugin. Distribution differs by client: in Claude Code the local marketplace is used directly; in Cowork/Desktop/cloud clients a synced remote connector is used instead, and `enabledPlugins` is deliberately left empty in either case.
