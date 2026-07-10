---
title: Parked Retrieval & Algebra
status: reference
cluster: retrieval
type: moc
summary: "The high-polish web-retrieval + data-algebra corpus the SUX pivot took off the build path; kept for the ideas, not being built."
tags: [sux, retrieval, algebra, moc]
updated: 2026-07-09
---

# Parked Retrieval & Algebra MOC

> **Status: parked.** These docs are a high-polish design program — hardened
> across 13 rounds of adversarial refinement ([[ITERATION-LOG]]) under one
> coherent [[ROADMAP]] — that the [[SUX]] pivot took **off the build path**. The
> pivot reframed the knowledge store as the core and parked the standalone
> web-retrieval engine and its data algebra. Kept here for the ideas; not being
> built. Don't mistake polish for active.

## The data algebra (the shared spine)

- [[algebra]] — combinators over a `records[]` contract
- [[records-envelope]] — the `{records, meta}` contract itself
- [[verb-algebra]] — `map`/`filter`/`reduce`/`augment`, pure vs effectful
- [[fanout]] — the parallel-retrieval primitive
- [[filter-dsl]] — the string WHERE-DSL

## The retrieval verbs

- [[search]] — one unified retrieval verb over web/research/social/retail backends
- [[shop]] — cross-retailer price-comparison engine
- [[travel]] — API-first flights/hotels/attractions/visa dossier

## Program-level context

- [[ROADMAP]] — the coherence anchor (owner table + frozen interfaces + build order)
- [[ITERATION-LOG]] — the 104-improvement refinement history
- [[platform-upgrades]] — the infra these verbs were to stand on (also parked)

## Why it's still here

The algebra ideas ([[records-envelope]], [[handle-discipline]], the 60s/24h
[[two-hard-facts]]) outlived the program — several are load-bearing in the active
[[Namespaces-MOC]] work. If a retrieval workload ever justifies it, this is a
ready-to-build spec; until then it stays parked.
