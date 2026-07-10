---
title: Six-Verb Lifecycle
status: designed
cluster: knowledge
type: concept
tags: [sux, knowledge, designed]
updated: 2026-07-09
related: ["[[vault-stack]]", "[[knowledge-core]]", "[[oracle-supersession]]", "[[domains]]", "[[Knowledge-Engine-MOC]]"]
---

# Six-Verb Lifecycle

**Source:** [[knowledge-core]]

The operating verb set for knowledge work over the vault: **capture / triage / link / retrieve / consolidate / remember.** These are CONVENTIONS layered on top of the existing vault store operations, not new storage or a parallel index — `capture` appends to `Inbox/`, `triage` classifies and promotes or discards, `link` wires `[[wikilinks]]` into the right MOC and heals orphans, `retrieve` answers a query via an agentic composition ladder (MOC index -> keyword/structured -> whole-note read -> link-follow -> semantic fallback) with `[[note#heading]]` citations, `consolidate` runs a periodic GC pass that merges overlaps and re-fits MOCs to budget, and `remember` writes one durable fact per file under the memory frontmatter contract.

The shape is deliberately a linear write pipeline (`capture -> triage -> link`) plus an always-available read path (`retrieve`) plus a separate scheduled maintenance loop (`consolidate`) — keeping capture cheap and consolidation coherent as two distinct concerns is the point of the split, not an accident.

This lifecycle is reused twice: [[domains]] maps it onto the wider set of personal data spokes (mail, notes, tasks) as their common triage/capture shape, and [[enterprise-ops]] adopts the same six verbs for org-facing knowledge work. [[three-mcps]] later reframes the read half (`retrieve`) as a Claude-side SKILL that orchestrates primitive vault tools, rather than a server-side verb — see [[oracle-supersession]] for how that reframing plays out for the read crown specifically.
