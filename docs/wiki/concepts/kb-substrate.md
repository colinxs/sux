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

`_kb.ts` v3, the shared storage layer both `teach`/`ask` and `style`/`edit` write knowledge bases through. Keys are kind-scoped — `sux:kb:knowledge:<topic>` versus `sux:kb:voice:<name>`, built by `kbKey(kind, name)` — so kind is **structural**, encoded in the key itself, not a value field a caller could spoof. A flat `sux:kb:<name>` namespace would let one kind's write path silently clobber the other's record (a `teach(topic:"colin")` overwriting a voice profile named "colin"); scoping the key closes that off entirely, for free, before either consumer ships.

The core types are `KbRecord` (per-topic record: `distilled` text, `sources[]`, goal/counts), `KbSource` (per-source provenance: locator, trust tier, content hash, fetch/check timestamps), `KbKind` (`"knowledge" | "voice"`), and `KbTrust` (`"inline" | "obsidian" | "web"`, ordered by how much an answer should lean on a claim). Consolidation is rolling, not batch: each pass folds not-yet-folded sources oldest-first into a single `distilled` field under a monotone accumulation guarantee — a source is never evicted before its knowledge has actually reached `distilled`.

Every claim traceable to a source carries a stable `[S#]` citation label, minted once at admission and never reused even after eviction. The posture toward untrusted content is hostile-by-construction: fencing stops instruction-following, not semantic poisoning, and trust tiers plus report-not-assert framing manage the residual risk rather than closing it. `teach-ask` owns the file and the `knowledge` kind; [[style-edit]] owns the `voice` kind on the same substrate.
