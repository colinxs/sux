---
title: Docs ⇄ vault reconciliation
status: designed
cluster: knowledge
type: design
summary: "Two SoT repos, one Obsidian view: gitignored symlink mounts public docs/ into the private vault; repo reaches the vault via the vault_* tools on the one /mcp connector; no cross-repo copy, so no divergence."
tags: [sux, knowledge, vault]
updated: 2026-07-11
related: ["[[wiki-protocol]]", "[[vault-stack]]", "[[namespace-architecture]]", "[[vault-backends-matrix]]"]
---

# Docs ⇄ vault reconciliation

Two corpora, two homes, one seam. This design says how the sux **repo docs (A)**
and the runtime **personal vault (B)** become both accessible and editable from
either surface **without ever copying content between them** — so they can never
diverge.

## The core decision: two sources of truth, unify the *view*, never copy the *content*

Reject bidirectional content sync. Reject a single merged store. Adopt
**single-source-of-truth *per corpus*, with view-layer unification (a zero-copy
symlink mount)**.

The two corpora have genuinely different authorities and must keep them:

| | (A) repo docs | (B) runtime vault |
|---|---|---|
| Home | `SuxOS/sux` (**PUBLIC**) — `docs/` + `Home.md` + `llms.txt` | `colinxs/obsidian-vault` (**PRIVATE**) + live Mac |
| Gate | CI (`check:wiki`, type-check, deploy dry-run), `gen-wiki`, pre-commit hook | git history = undo; KV cache; 409 optimistic-concurrency |
| Co-versioned with | the sux Worker code | Colin's life, mail digests, `vault_capture` |
| Conventions | `status/cluster/type/summary` frontmatter, MOCs | `Daily/ Inbox/ Templates/`, no such frontmatter |

Any mechanism that keeps **two copies** of the same notes across these two repos
(a CI sync job, a submodule, "the vault namespace mirrors `./docs`") reintroduces
exactly the divergence we want gone: merge conflicts, ordering races, and a
public-repo/private-repo leak hazard (the sux repo is public; the vault is
private). The way to get "both available, accessible, editable, without
divergence" is to make divergence **structurally impossible**: one copy on disk,
viewed from both surfaces.

**Privacy asymmetry is load-bearing and it dictates the mount direction:** mount
the PUBLIC `docs/` *into* the PRIVATE vault (public→private is safe). **Never**
symlink the private vault into the public repo tree (that risks committing
personal notes into a public repo). The repo-side needs the vault too, but it
gets it through the *already-built* sux vault MCP — not a filesystem symlink.

## Mechanism (the KISS pick)

1. **Repo docs → editable in Obsidian.** One gitignored symlink mounts the
   public repo's docs into the private personal vault as a folder:
   `…/obsidian-vault/sux` → symlink → `…/Code/sux-mcp/docs`.
   Obsidian follows symlinks and indexes the real files, so `sux/` shows up in
   Colin's daily-driver vault with working backlinks/search across both corpora —
   **same inodes, zero copy**. Add `sux/` to the *vault repo's* `.gitignore` so
   obsidian-git never commits the mount into the private repo. Edits to those
   files are still committed to `SuxOS/sux` through the normal branch→PR flow,
   so CI + `gen-wiki` + the pre-commit hook still gate them. (The sux repo's own
   root `.obsidian/` already lets Colin open the repo directly as a second vault —
   the mount just gives *one unified graph* instead of vault-switching.)

2. **Vault content → visible/editable from the repo.** Already shipped — the sux
   `vault_*` tools (`vault_read/list/write/edit/patch/…`, git-backed,
   KV-cached, 409 on races) on the one `/mcp` connector, plus the local `mcp__obsidian__*` connector. A Claude
   Code session in the sux repo already has full read/write to the personal
   vault. No new machinery, and deliberately **no** private-vault symlink inside
   the public tree.

3. **Cloud leg (park by default).** Making the sux *design docs* searchable from
   claude.ai mobile's sux connector (the `vault_*` verbs) would require them inside the
   private `obsidian-vault` repo (the vault backend reads that repo, not the public
   one). Only do this if the want is real, and only as a **one-way generated
   projection** (docs → a `sux-docs/` folder in the vault repo, driven by CI on
   the public repo, marked generated/read-only) — an *output* like `llms.txt`, so
   still divergence-free because the vault copy is never hand-edited. This matches
   [[wiki-protocol]]'s own parked stance.

## How edits flow both ways without conflict

- **Edit a sux doc** (in the vault's `sux/` mount, in the repo-as-vault, or via
  Claude Code) → all touch the *one* file in the sux working tree → committed to
  `SuxOS/sux` via branch→PR→CI (`check:wiki` gates the regenerated
  [[Functions-MOC]] / [[Status-Dashboard]] / `llms.txt`). The vault repo never
  sees it (gitignored). One copy, one git home → no conflict.
- **Edit a personal note** (Obsidian, or the sux vault MCP) → committed to
  `colinxs/obsidian-vault` (MCP writes carry read-time sha → 409 instead of
  silent clobber on races). The public repo never sees it. One copy, one git home.
- `gen-wiki.mjs` only walks the sux repo's `docs/` and only counts notes with
  `status:` frontmatter, so the mounted personal notes (different repo, no such
  frontmatter) can never pollute the generated artifacts even in the unified
  Obsidian graph.

## Phased plan

- **Phase 0 — design + guardrail (this PR, pure docs + one safety line).** Land
  this design doc, close the [[wiki-protocol]] seam, and add the public-repo
  `.gitignore` guardrail that makes an accidental private-vault commit
  impossible. No behavior change, fully reversible.
- **Phase 1 — the local mount.** Add an idempotent, local-only
  `scripts/mount-docs-in-obsidian.sh` that creates the
  `obsidian-vault/sux → sux-mcp/docs` symlink and appends `sux/` to the *vault
  repo's* `.gitignore`. Runs on the Mac, no-ops in CI. Colin runs it once. This
  delivers "docs editable in Obsidian, unified graph."
- **Phase 2 — verify + document the repo-side path.** Confirm the sux vault MCP
  is the sanctioned way to touch the vault from the repo; add a short "editing the
  personal vault from the repo" note. Fix the `colinxs/vault` →
  `colinxs/obsidian-vault` naming drift in `docs/proposals/archive/architecture.md` +
  `vault-backends.md`.
- **Phase 3 — (park) one-way cloud projection** of the public wiki into
  `obsidian-vault/sux-docs/` via CI, only if Colin wants sux docs reachable through the mobile
  sux connector's `vault_*` verbs. Generated/read-only; never hand-edited.

## Guardrail (this PR)

The public repo's `.gitignore` reserves the local vault-mount paths (`/.vault/`,
`/vault-mount/`) so a private-vault symlink can never be committed into this
PUBLIC repo. That is the only preventive change in Phase 0; the actual local
mount (Phase 1) is a follow-up Colin runs on his Mac. The mount script deliberately
appends the ignore to the **vault** repo, not this one — this repo only carries
the reservation so an accidental in-tree mount is caught by git.
