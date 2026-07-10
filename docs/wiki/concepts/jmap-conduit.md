---
title: JMAP Conduit
status: designed
cluster: namespaces
type: concept
tags: [sux, namespaces, designed]
updated: 2026-07-09
related: ["[[mail]]", "[[jmap]]", "[[unblocked-gated-law]]", "[[handle-discipline]]", "[[Namespaces-MOC]]"]
---

# JMAP Conduit

**Source:** [[jmap]]

One generic `jmap` verb: a typed conduit that forwards raw JMAP batches to a JMAP endpoint (Fastmail today), adding only the five things an edge proxy is uniquely positioned to add — injected auth, cached Session discovery, transparent limit-safe batching/pagination, mutation gates, and composability with the sux [[verb-algebra]]. It curates nothing and translates nothing; it forwards method names, so the full JMAP surface — Email, Mailbox, Thread, Identity, EmailSubmission, VacationResponse, Contacts, Calendars, and Fastmail's MaskedEmail extension — is reachable through one fn rather than a bespoke wrapper per resource type.

The caller sends either a full JMAP `calls` batch (`{using, methodCalls:[[method,args,callId],...]}`) or a `method`/`args` shorthand for the common single-call case. Session state is cached in KV to avoid a discovery round-trip on every call. Reads are `cacheable:false` by design — the platform's 24h stale-grace would silently defeat any short ttl, and caching would persist decrypted mail bodies plus Session PII into shared KV.

Mutation gates `allow_send` and `allow_destroy` apply the [[unblocked-gated-law]]: `Email/set{destroy}` permanently expunges rather than moving to Trash, so it is gated exactly like any other irreversible action. `_jmap.ts` factors out the session/batching/limit-handling engine specifically so the ergonomic verbs `mail` owns are cheap to build directly on top, without re-deriving JMAP plumbing. See [[handle-discipline]] for how large payloads (attachments) move through this conduit as references rather than inline bytes.
