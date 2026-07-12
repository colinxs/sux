---
title: Living-wiki protocol
status: reference
cluster: meta
type: reference
tags: [sux, meta, reference]
updated: 2026-07-09
---

# Living-wiki protocol

How this wiki stays true to the code and the work. A wiki rots the moment it's
hand-maintained in parallel with the thing it describes; the defense here is the
same one the repo already uses for [[Functions-MOC|FUNCTIONS.md]] and the fn
index — **derive what you can from source, and give a written loop for the rest.**

See [[wiki-conventions]] for the note/frontmatter rules this protocol assumes.

## Two audiences, two formats

Every note is written for a **human** (the prose body) and carries a terse
kernel for **Claude** (a one-line `summary:` in its frontmatter — see
[[wiki-conventions]]). The generator assembles those kernels into
[`llms.txt`](../../../llms.txt) at the repo root: the whole knowledge graph in
minimal tokens (status + one-liner + links per note, plus the compressed
function catalog). Load `llms.txt` to orient a fresh session cheaply; open
[[Home]] to read. Neither is hand-maintained in parallel — both fall out of the
notes.

## Two layers, two update mechanisms

**1. Generated layer — regenerated from source, never hand-edited.**

`scripts/gen-wiki.mjs` (run with `npm run wiki`) reads:
- `sux/FUNCTIONS.md` (itself generated from `sux/src/fns/*.ts` by `npm run docs`) → rebuilds [[Functions-MOC]]
- the `status:` / `cluster:` frontmatter of every note under `docs/` (+ `Home.md`) → rebuilds [[Status-Dashboard]]
- the `summary:` kernel (or first body sentence) of every note → rebuilds [`llms.txt`](../../../llms.txt)

The markdown outputs carry a `<!-- GENERATED … -->` marker; content below it is
overwritten. `llms.txt` is fully generated. Output is **content-deterministic**
(no timestamps) so regeneration only changes files when the source actually did.

**Update on commit (automated).** A committed git pre-commit hook
(`scripts/hooks/pre-commit`, self-installed by `npm run prepare` →
`core.hooksPath`) runs `npm run docs && npm run wiki` and re-stages the four
artifacts on **every commit** — so the knowledge you commit always matches the
code you commit. It's best-effort: a tooling hiccup warns but never blocks the
commit (CI is the real gate). Manual runs (`npm run wiki`, `npm run check:wiki`)
still work for tightening the loop mid-session.

**Merge/rebase conflicts.** The three fully-generated files
(`sux/src/fns/index.ts`, `sux/FUNCTIONS.md`, `llms.txt`) carry a `merge=ours`
attribute (`.gitattributes`, driver registered by `npm run prepare`) so
`git rebase main` / a PR merge never hand-conflicts on them — the
`scripts/hooks/post-merge` + `post-rewrite` hooks regenerate and re-stage them
afterwards (commit/amend before pushing; CI gates on their being in sync). The
two hybrid MOCs (`Functions-MOC.md`, `Status-Dashboard.md`) are deliberately
left on normal git merge: on a conflict, resolve the hand-authored section
_above_ the `<!-- GENERATED -->` marker by hand, then let `npm run wiki`
(auto-run by those same hooks) rebuild everything below it.

**2. Curated layer — updated by the same session that changes the thing.**

Home, the MOCs, and the concept notes are hand-written. The rule that keeps them
live is procedural, tied to the repo's existing "one change per cycle" workflow
([[CLAUDE|CLAUDE.md]]):

| When you… | …update |
|---|---|
| Ship a fn / change the surface | `npm run docs && npm run wiki` (regenerates [[Functions-MOC]] + dashboard) |
| Move a doc from designed → shipped (or park it) | flip its `status:` frontmatter, then `npm run wiki` |
| Add a new proposal doc | give it frontmatter per [[wiki-conventions]]; link it from the right MOC |
| Introduce a load-bearing concept | add a `docs/wiki/concepts/` note; link source + consumers |
| Close a session with durable decisions | fold them into the owning concept/proposal note (not just the transcript) — mirrors the "continuity lives in memory + docs, not the session" rule |

## Keeping status honest

The single most useful signal this wiki carries is **shipped vs designed vs
parked** (the [[SUX]] pivot parked a whole retrieval/algebra corpus that still
reads as active if you only skim it). [[Status-Dashboard]] surfaces that from
frontmatter, so the discipline reduces to: *when reality moves, flip the
`status:` field.* One field, one regen.

## This wiki and the runtime vault (the seam, now decided)

This repo's own `ingest` / `obsidian` fns write to the `colinxs/obsidian-vault`
store, not here — two corpora with different authorities (public code-docs vs
Colin's private KB). The stance is now **decided, not parked**: unify the *view*,
never copy the *content*. A gitignored symlink mounts this public `docs/` *into*
the private vault (public→private is safe), and the repo reaches the vault the
other way through the already-built `/vault/mcp` tools — so both are accessible
and editable from either surface with **no cross-repo copy, hence no divergence**.
See [[vault-docs-reconciliation]] for the full design (mount direction, edit-flow,
phased plan), plus [[vault-stack]] and [[namespace-architecture]].
