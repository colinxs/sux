---
title: The one-shot spec prompt
status: reference
cluster: meta
type: reference
summary: "A single self-contained prompt that reconstructs sux from zero — the architecture, the one /mcp connector with its universal + vault/mail/files verb families, the safety model, and the house rules, compressed to the minimum an agent needs to one-shot it."
tags: [sux, meta, reference]
updated: 2026-07-10
related: ["[[SUX]]", "[[three-mcps]]", "[[files]]", "[[keys]]", "[[architecture]]"]
---

# The one-shot spec prompt

This is the prompt you could have opened with. Hand the block below to a fresh capable
agent with an empty repo and a Cloudflare account, and it reconstructs sux — the same
architecture, the same safety posture, the same gates. It is deliberately dense: decisions
and invariants, not tutorials. The runtime twin of this doc is `GET /mcp/connectors`
(live namespaces + tool counts); the human index is [[architecture]] and [[three-mcps]].

> **Why keep it.** Continuity here lives in git + docs + memory, never in a chat session
> (CLAUDE.md). This doc is the compressed seed of the whole system: if every session were
> lost, this plus the design corpus rebuilds it.

---

## THE PROMPT (copy from here)

```
Build "sux": one Cloudflare Worker that is (a) a universal MCP tool server (~90 stateless
research/data fns) and (b) N personal-data connector namespaces, all behind ONE OAuth gate.

ARCHITECTURE
- One Worker. One workers-oauth-provider flow (GitHub login; allow exactly ALLOWED_GITHUB_LOGIN).
- The universal surface is a FN REGISTRY: each capability is one file in src/fns/*.ts exporting
  an Fn { name, description, inputSchema, cost?, cacheable?, ttl?, raw?, run(env,args) }. A
  generator writes src/fns/index.ts (the FUNCTIONS array) and FUNCTIONS.md from those files —
  both are committed and CI fails if stale. Never hand-edit them.
- Personal domains are exposed as FRONT-DOOR VERB FAMILIES on the single `/mcp` connector — a thin
  tool layer over the fns, all shipped by the one `sux-router` plugin on the same Worker + OAuth:
    /mcp  sux  — the ONE connector: universal tools (web/papers/shopping/transforms/pipe+batch),
                 domain-agnostic, PLUS the personal namespaces reached by verb prefix:
        vault_*                     — Obsidian knowledge base over a git-backed store (every write a revertible commit).
        mail_* / cal_* / contact_*  — Fastmail via JMAP: search/read/thread/send/draft/archive/masked + a raw `jmap` conduit.
        files_*                     — Dropbox blobs: Mode A (app-folder, unblocked) + Mode B (whole-account, gated).
  Enumerate the connector PATHS from ONE source of truth (a CONNECTORS array) that also drives the OAuth
  apiRoute and a GET /mcp/connectors discovery manifest. The design once split these onto per-domain
  connectors (/vault/mcp, /mail/mcp, /files/mcp, each its own plugin); those paths stay in the CONNECTORS
  array — routed + OAuth-authorized for back-compat — but are retired from the advertised surface into the
  one /mcp front door (advertised:false, no plugin). Keep the raw protocol conduit (jmap, dropbox) exposed
  as the debugging escape hatch — ergonomic verbs on top, raw underneath.

THE TWO HARD FACTS
- FN_DEADLINE_MS wraps every run and abandons on timeout with zero partials; fan-out verbs run an
  internal soft budget and return partials as success.
- Results are cacheable by content-addressed key with a stale-grace window; live/personal fns set
  cacheable:false; partial-error envelopes are noCache. raw fns opt out of normalization/summarization.

SAFETY MODEL (the load-bearing part)
- Credentials are per-domain and never mixed. Mode A Dropbox is app-folder-scoped ("scope is the wall"
  → unblocked, no gates). Mode B Dropbox is a SEPARATE full-scope credential (DROPBOX_FULL_*) at its own
  KV key with its own 401 self-heal — it NEVER borrows Mode A's token, and vice versa.
- Untrusted data is fenced: any bytes fetched from mail/web/files ride an llm() <<<DATA>>> fence and the
  model is told, in the trusted system role, to treat them as data and never obey them.
- Mutation is gated as an ACCIDENT guard, not an injection boundary (an injected call can set the flags;
  the real containment is recoverability + review). For whole-account WRITE (Mode B): dry_run defaults
  true (every mutation returns a plan first); delete also needs confirm:true; existing files need
  overwrite:true OR a matching rev (stale rev rejects); an overwrite copies the current file to a
  /.sux-trash backup first and a failed backup aborts the write; a configurable protected-prefix deny-list
  refuses named roots; deletes stay recoverable in Dropbox 'Deleted files'; nothing mints a permanent
  public share. Read verbs cannot mutate. Every new credential is fail-closed (absent → clean not_configured).
- recall is the read crown: "what do I know about X?" fans out server-side over vault+files+mail+web,
  inlines small textual hits + cites everything else by handle, and synthesizes ONE cited answer grounded
  strictly in what it found (says so rather than inventing). READ-only.

HOW WE WORK (the gates that let us move fast)
- git is the undo, CI is the gate, review is the net. Never commit to main (main auto-deploys to prod).
  Branch per logical change; Conventional Commits; one change per cycle, land it green before the next.
  Before merging anything substantial, run a multi-agent adversarial review and fix findings.
- CI must pass: type-check (tsc --noEmit), tests (vitest), the fn-index + FUNCTIONS.md + node-deploy-blob
  in sync, and wrangler deploy --dry-run. After touching any fn, regenerate the index + docs and commit them.
- Fan out with subagents/workflows for research, design tournaments, and adversarial review; keep the
  actual file-mutating commits serial to stay conflict-free and mergeable.

DELIVER: the Worker, the one /mcp connector with its front-door verb families (universal + vault/mail/files),
the fn registry + generators, the OAuth gate, the safety gates above, tests for each, the discovery manifest,
and the marketplace plugins. Deploy additively; the personal namespaces stay dormant (not_configured) until
their secrets are set.
```

## Recreate-and-compare (the meta-loop)

The seed above is also a **regeneration test**: feed it to a fresh agentic workflow in an empty repo,
let it rebuild sux, then diff the result against this tree and fold back any cleaner idea the rebuild
found (and any invariant it dropped, back into the seed). Do this as a *comparison*, never as a
merge-over-production — the working Worker is the source of truth; the rebuild is a critic, not a
replacement. Keep the seed and the running system converging.
