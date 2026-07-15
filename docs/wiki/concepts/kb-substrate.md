---
title: KB Substrate
status: parked
cluster: knowledge
type: concept
tags: [sux, knowledge, parked]
updated: 2026-07-09
related: ["[[teach-ask]]", "[[style-edit]]", "[[oracle-supersession]]", "[[Knowledge-Engine-MOC]]"]
---

# KB Substrate

**Source:** [[teach-ask]]

> **Reality check (2026-07-14, external-research pass):** the 2026 reference architecture for temporal/evolving memory is a **temporal knowledge graph** — Zep's **Graphiti** models fact validity windows (became-true / superseded-by), matching this substrate's supersession framing, and leads temporal-reasoning benchmarks (LongMemEval ~63.8% vs Mem0 ~49.0%; Mem0 is vector-first, graph only in its Pro tier). But Graphiti is Neo4j-backed, too heavy for a stateless Worker — so the open question for un-parking isn't "adopt Graphiti" but whether this per-topic KV design should borrow Graphiti's *temporal-validity* modeling without the graph DB, and whether Cloudflare's own "Agent Memory" primitive fits better. Sources: [Mem0 vs Zep](https://vectorize.io/articles/mem0-vs-zep), [Graphiti temporal-KG paper](https://arxiv.org/html/2501.13956v1).

`_kb.ts` v3, the shared storage layer both `teach`/`ask` and `style`/`edit` write knowledge bases through. Keys are kind-scoped — `sux:kb:knowledge:<topic>` versus `sux:kb:voice:<name>`, built by `kbKey(kind, name)` — so kind is **structural**, encoded in the key itself, not a value field a caller could spoof. A flat `sux:kb:<name>` namespace would let one kind's write path silently clobber the other's record (a `teach(topic:"colin")` overwriting a voice profile named "colin"); scoping the key closes that off entirely, for free, before either consumer ships.

The core types are `KbRecord` (per-topic record: `distilled` text, `sources[]`, goal/counts), `KbSource` (per-source provenance: locator, trust tier, content hash, fetch/check timestamps), `KbKind` (`"knowledge" | "voice"`), and `KbTrust` (`"inline" | "obsidian" | "web"`, ordered by how much an answer should lean on a claim). Consolidation is rolling, not batch: each pass folds not-yet-folded sources oldest-first into a single `distilled` field under a monotone accumulation guarantee — a source is never evicted before its knowledge has actually reached `distilled`.

Every claim traceable to a source carries a stable `[S#]` citation label, minted once at admission and never reused even after eviction. The posture toward untrusted content is hostile-by-construction: fencing stops instruction-following, not semantic poisoning, and trust tiers plus report-not-assert framing manage the residual risk rather than closing it. `teach-ask` owns the file and the `knowledge` kind; [[style-edit]] owns the `voice` kind on the same substrate.
