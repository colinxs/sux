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

**Source:** [`.claude-plugin/marketplace.json`](../../../.claude-plugin/marketplace.json), [`plugins/sux-router/`](../../../plugins/sux-router/), [`plugins/sux-life/`](../../../plugins/sux-life/), [`sux/src/connectors.ts`](../../../sux/src/connectors.ts)

The `sux` marketplace ships two plugins today, but only **one connector**. `sux-router` installs that connector (`/mcp`) plus the `sux` routing skill: web search, scraping/rendering, papers, shopping, documents, transforms, pipe/batch composition — AND the personal namespaces, reached through `vault_`/`mail_`/`files_`/`cal_`/`contact_` verbs (plus `recall` and the `fn` escape). `sux-life` is a skill-only plugin — the digital-life memory layer — that rides `sux-router`'s front door and ships no connector of its own. The design once split personal data onto separate per-domain connectors (`/vault/mcp`, `/mail/mcp`, `/files/mcp`, each its own plugin); those were **retired into the single `/mcp` front door**. Their paths still route and stay OAuth-authorized for back-compat (see [[oauth-gate]]), but no plugin ships them and they are hidden from the default discovery manifest — one Worker, one OAuth, one advertised connector. Distribution differs by client: in Claude Code the local marketplace is used directly; in Cowork/Desktop/cloud clients a synced remote connector is used instead, and `enabledPlugins` is deliberately left empty in either case.
