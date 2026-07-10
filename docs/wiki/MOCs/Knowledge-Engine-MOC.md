---
title: Knowledge Engine
status: reference
cluster: knowledge
type: moc
summary: "Turning sources into knowledge — the active six-verb lifecycle vs the parked server-side KB engine (teach/ask, style/edit)."
tags: [sux, knowledge, moc]
updated: 2026-07-09
---

# Knowledge Engine MOC

Turning sources into durable, retrievable knowledge. This cluster straddles the
[[SUX]] pivot: the **operating conventions** over the vault are `designed` and
active, while the ambitious **server-side KB engine** (`teach`/`ask`,
`style`/`edit`) was explored to high polish and then `parked` when the read/write
layers moved client-side.

## Active — conventions over the vault

- [[six-verb-lifecycle]] — capture / triage / link / retrieve / consolidate / remember
- [[knowledge-core]] — the decisions-only spec for the personal knowledge store
- [[vault-stack]] — the store those conventions run on

## Where the read layer went

- [[oracle-supersession]] — the `oracle` → `teach`/`ask` → Claude-side-skill chain (read this before trusting any one layer)

## Parked — the server-side KB engine

Kept for the design ideas (kind-scoped keys, injection posture, monotone
consolidation), not on the build path.

- [[kb-substrate]] — the `_kb.ts` v3 substrate (knowledge + voice kinds)
- [[teach-ask]] — `teach` writes / `ask` reads over a per-topic KB
- [[style-edit]] — `style` learns a voice / `edit` rewrites to it

See the [[Parked-Retrieval-MOC]] for the sibling parked corpus and the [[ROADMAP]]
for how these once fit one program.
