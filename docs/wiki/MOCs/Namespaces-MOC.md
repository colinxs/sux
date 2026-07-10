---
title: Namespaces
status: reference
cluster: namespaces
type: moc
summary: "The active build path — the personal-data connectors (vault shipped; mail, files designed) + the cross-store write/act layer."
tags: [sux, namespaces, moc]
updated: 2026-07-09
---

# Namespaces MOC

The **active build path.** sux is one Worker exposing the universal `/mcp` query
plane plus a growing set of personal-data stores, each its own
`/<domain>/mcp` connector behind the shared [[oauth-gate]]. The organizing idea
is [[namespace-architecture]]; the two cross-cutting laws are
[[handle-discipline]] (references, not payloads) and the [[unblocked-gated-law]]
(unblocked where git can undo, gated where the world can't).

## The architecture

- [[namespace-architecture]] — one Worker, one OAuth, N connectors
- [[connector-surface-policy]] — why `/mcp` stays non-personal and personal data gets its own namespaces
- [[three-mcps]] — the namespace map (vault · mail · sux), corrected to built reality
- [[sux-verbs]] — the universal `/mcp` surface as ten front-door verbs + `batch`/`pipe`
- [[domains]] — the nine personal-data domains mapped onto the hub
- [[handle-discipline]] · [[unblocked-gated-law]] — the two invariants every namespace obeys

## vault — shipped ✅

The git-backed knowledge store, live today on `/vault/mcp`.

- [[vault-stack]] — how `obsidian` + `ingest` + `dropbox` + `vault-mcp` compose (the code)
- [[vault-backends-matrix]] — the four backends (git / vpc / obsidian / local-git) and git-as-the-bus
- [[vault-backends]] — the full backend + task-sync + citation design
- [[six-verb-lifecycle]] — the capture→remember conventions layered over the store

## mail — designed

Fastmail over JMAP.

- [[jmap-conduit]] — the raw `jmap` conduit verb
- [[jmap]] — the full JMAP protocol as one verb
- [[mail]] — the dozen ergonomic `mail_*` verbs on top

## files — designed

The blob namespace: a synced workspace + gated corpus operations.

- [[files]] — Mode A (unblocked App-folder workspace) + Mode B (gated in-place ops)

## Cross-store write / act

- [[enterprise-ops]] — the WRITE mirror of the read layer: batch verbs + scheduler + skills
- [[oracle-supersession]] — where the cross-store READ layer went

## Health (draft)

- [[mychart]] — MyChart / Epic FHIR + Apple Health (separate proposal, PR #31)
