---
title: Oracle Supersession
status: designed
cluster: knowledge
type: concept
tags: [sux, knowledge, designed]
updated: 2026-07-09
related: ["[[kb-substrate]]", "[[teach-ask]]", "[[six-verb-lifecycle]]", "[[sux-verbs]]", "[[enterprise-ops]]"]
---

# Oracle Supersession

**Source:** [[teach-ask]]

A tracked history of which layer holds the "read crown" — the cross-store synthesis-and-cite authority — as the design evolves, so readers of the corpus trust the right document rather than the first one they find.

Layer one, **shipped**: the `oracle` fn (learn -> cache in KV -> answer), framed by [[sux-verbs]] as sux's cross-store read crown — find, synthesize, cite, never mutate. Layer two, **planned**: [[teach-ask]] deletes `oracle` outright and replaces it with two verbs, `teach` (which builds and maintains a knowledge base) and `ask` (a pure reader over it), both riding the [[kb-substrate]] instead of `oracle`'s ad hoc KV shape — carrying forward its distillation responsibility rather than leaving a third copy of that logic. Layer three, **further out**: [[three-mcps]] reframes `ask` again, this time as a Claude-side SKILL that orchestrates primitive vault/mail tools directly, rather than a server-side verb at all.

Net effect: `oracle` is legacy the moment `teach`/`ask` ship, and the read layer's center of gravity is moving client-side over time, not staying put in the Worker. This same layering shows up in [[six-verb-lifecycle]], where the `retrieve` verb undergoes an identical framing shift from server verb to Claude-side skill, and in [[enterprise-ops]], which inherits whichever layer is current rather than pinning to `oracle`.
