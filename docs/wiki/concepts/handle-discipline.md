---
title: Handle Discipline
status: designed
cluster: namespaces
type: concept
tags: [sux, namespaces, designed]
updated: 2026-07-09
related: ["[[records-envelope]]", "[[namespace-architecture]]", "[[mail]]", "[[files]]", "[[enterprise-ops]]"]
---

# Handle Discipline

**Source:** [[sux-verbs]]

The LOCKED cross-cutting rule that shapes every store-facing verb in the sux design: **references, not payloads.** A verb that finds or lists never returns bodies — it returns handles: `/s/<uuid>` blob ids, urls, git blob shas, vault paths, message-ids. The full note body, PDF bytes, or email content transits context only when a caller explicitly reads exactly one of them.

The mirror rule holds on the write side: a verb that stores or transforms accepts a handle and moves the actual bytes server-side (Worker-side, or on the live box) — the model never sees the large payload pass through it. And every list-producing verb is required to have a server-side **batch** form, so a caller can act on a hundred items in a handful of calls rather than a hundred round-trips.

The slogan that captures the payoff: **"100 items = a few calls, zero bytes in context."** This rule predates and is independent of any single backend's implementation details — it is locked by [[vault-backends]] for the notes store, and independently locked by [[mail]] and [[files]] for their own stateful stores, making it the one convention all three personal-data namespaces share under [[namespace-architecture]]. Every verb built on the [[records-envelope]] is expected to carry handles as record fields, never inlined bytes.
