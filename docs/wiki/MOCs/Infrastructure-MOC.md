---
title: Infrastructure
status: reference
cluster: infrastructure
type: moc
summary: "The shipped substrate every fn stands on — OAuth gate, fn registry, cache, fetch ladder, mcp-gate — plus the designed VPC vault hosting."
tags: [sux, infrastructure, moc]
updated: 2026-07-09
---

# Infrastructure MOC

What every function and namespace stands on — the dispatch, egress, cache, gate,
and hosting substrate. Most of this is `shipped`; the hosting evolution is
`designed`.

## The request path (shipped)

A `tools/call` flows: [[oauth-gate]] → [[fn-registry]] → [[content-addressed-cache]]
→ [[fetch-ladder]] → the open web.

- [[oauth-gate]] — one GitHub OAuth provider, single-user, one advertised `/mcp` connector (+ dormant back-compat routes)
- [[fn-registry]] — the `Fn` contract, failure taxonomy, and hot-path dispatch rails
- [[content-addressed-cache]] — KV cache, single-flight, stale-while-revalidate
- [[fetch-ladder]] — residential egress rungs and the bot-detection war
- [[two-hard-facts]] — the 60s deadline + 24h stale-grace that shape every verb's honesty contract
- [[architecture]] — the whole shipped topology in diagrams
- [[ARCHITECTURE|Architecture reference]] — the canonical, exhaustive how-sux-works reference (request lifecycle, subsystems, data model, design laws)

## Local gateway (shipped)

- [[mcp-gate]] — the Mac-side tiered gateway fronting live local MCP servers

## Vault hosting (designed)

Where the live vault should run so it isn't tied to a sleeping laptop.

- [[vpc-hosting]] — self-hosting the vault over Cloudflare Workers VPC (three tiers, phases A–E)
- [[vault-backends-matrix]] — the backend the VPC path unlocks

## Platform upgrades (parked)

- [[platform-upgrades]] — proactivity / durable execution / identity verbs (explored, parked by the [[SUX]] pivot)
