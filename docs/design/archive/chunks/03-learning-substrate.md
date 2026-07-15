---
title: Chunk 03 — stateless-learning substrate (execution-plan chunk 4)
branch: feat/learning-substrate
status: design-first
depends_on: [02]   # smart-guards; the learning writes need the same reversible/undo discipline
---

# Goal
The substrate later chunks learn on: a learned-prefs store (KV) + vault-KB
write-hooks (save-on-search, save-on-learn) + an embeddings store + kNN classify;
`recall` reads it back. **The vector/labeled set IS the learned model** — no training.

# Context (self-contained)
Smart-router policy: route each task cheapest-sufficient → rules → Workers-AI
embeddings (classification/similarity/tone, edge, private, learns via kNN over
labels) → frontier API only for hard low-volume synthesis. This chunk builds the
store + the embeddings/kNN path so the mail-triage and self-improve chunks have
something to classify against. `recall` already prefers the remote vault backend
on `main` (`sux/src/fns/recall.ts`) — extend it, don't rebuild it.

# Design first (write the mini-design into the PR before coding)
- **Learned-prefs store (KV):** schema for a labeled example (input, label, source,
  timestamp, undo handle). Design this FIRST — both this chunk and the self-improve
  chunk write to it.
- **Vault write-hooks:** save-on-search + save-on-learn append to the vault KB
  without a separate call. Idempotent (last-seen), cost-bounded.
- **Embeddings + kNN:** Workers AI embeddings; store vectors; classify by kNN over
  the labeled set. No model artifact — the set is the model.
- **`recall`:** extend it to read the store back (prefs + KB + nearest examples).
- **Identity resolution** across mail/contacts/calendar — a person key the store
  indexes on. (Scoped item; may warrant its own follow-up PR if it balloons.)

# Owns the "bulk-work > 60s" decision
The fan-out time-budget interim fix lives in the fanout-time-budget chunk. IF a real
caller here strains the 60s deadline on genuinely-large fan-in/out (embeddings over
a big set), THIS is where the Queues/Workflows primitive gets built. Until then it
stays explicitly deferred — don't build it speculatively.

# Scope
- KV binding (add to `sux/wrangler.jsonc`), a `_kb.ts`/`_prefs.ts` substrate,
  an embeddings helper over Workers AI, `recall` extended to read it.

# Acceptance
- `npm test && npm run type-check` green; docs + index in sync; dry-run ok.
- Behavior: save-on-search writes a labeled example; `recall` returns it + nearest
  neighbors; classify returns a label + confidence from kNN.
- Data stays edge/private unless a task truly needs the frontier.

# Then
Deploy (substrate, reversible). Unblocks the mail-triage chunk.

# Gotchas
- Bound cost: embeddings calls are metered; cache + batch.
- Everything written here needs a bulk-undo handle (the mail-triage + self-improve
  chunks rely on it).
