# Single-vault, portal-as-view design

**Date:** 2026-07-18
**Status:** approved (design), not yet implemented

## Problem

The vault currently splits across two repos: `colinxs/vault` (Colin's full private record)
and `SuxOS/vault` (the public-ish portal backing portal.suxos.net). This breaks the knowledge
graph — Obsidian backlinks, MOCs, and `[[wikilinks]]` don't cross repo boundaries, so anything
that should connect a technical/general note to related private context (or vice versa) can't.

## Decision

**One repo, one graph, filtered serving — not physical repo separation.**

- `colinxs/vault` becomes the single source of truth. All notes, all backlinks, one Obsidian
  graph. Nothing splits by content type.
- `SuxOS/vault` is retired as an independent *content* repo. Portal content stops being written
  there directly.
- `portal.suxos.net` becomes a **served view** of `colinxs/vault`, not a separate repo. The sux
  Cloudflare Worker reads from `colinxs/vault` and serves only what's explicitly marked
  portal-visible. Raw GitHub access to `colinxs/vault` stays fully private regardless of what the
  portal serves.

### Why not a two-repo split with promotion (rejected alternative)

Considered: default-private, explicit-promote via a `#portal` tag, with promoted notes copied
into `SuxOS/vault`. Rejected because Colin wants a genuinely connected knowledge tree — physical
duplication across two repos still breaks the live graph (edits to a private note wouldn't
propagate to its portal copy, and cross-repo links still can't resolve). Single-repo +
serving-layer filter preserves the graph and needs zero duplication.

### Why not git/repo-layer access control (rejected alternative)

Considered enforcing access control at the git/repo layer (submodules, per-audience repos synced
from one source). Rejected: git has no native folder-level ACLs, and any git-layer approach
reintroduces some form of repo-splitting to get there. Serving-layer enforcement (the Worker
gates what portal.suxos.net can read) achieves the same access-control goal without touching git
topology at all — confirmed as the enforcement layer of choice.

## Access control mechanic

Reuses the pattern already established in the vault (`#growth` tag, see
`Meta/Model-of-Colin.md`'s reconciliation rule) rather than inventing a new mechanism:

- A note or folder opts in via a **`#portal`** tag or a `visibility: portal` frontmatter field.
- **Default is private.** Nothing is portal-visible unless explicitly marked — matches the
  existing safe-default instinct in the vault's write model.
- The sux Worker's portal-serving route filters on that tag/field before returning any content.
- Colin's own authenticated paths (local Obsidian REST API over Tailscale, authenticated Worker
  calls) always see the full, unfiltered vault — the access-control layer only applies to the
  unauthenticated/portal-audience serving path.

## Graph-integrity handling (private ↔ portal links)

Since it's one repo, a portal-tagged note can contain a `[[wikilink]]` to a private note. Decision
for how the portal *renders* that link:

- **Private stub (chosen).** The link renders, but resolves to a stub page indicating the target
  exists but isn't public — honest about the graph's shape without leaking content.
- (Rejected) Hide the link entirely — loses context that something more exists behind it.
- (Rejected) Let it 404 silently — worst UX, no signal to the reader.

## Migration

`SuxOS/vault`'s existing portal content needs a one-time reconciliation pass: pull what's
currently served from `SuxOS/vault`, tag the equivalent (or write fresh) notes in `colinxs/vault`
as `#portal`, then stop writing to `SuxOS/vault` as content. This is a **follow-on step, not a
day-one dependency** — `colinxs/vault` is currently archived/read-only on GitHub (being repaired
in a separate session as of 2026-07-18), so migration work is blocked until that's resolved and
should not be scheduled until confirmed unblocked.

## Testing / validation

A portal-serving smoke test, run after the Worker's filter logic is implemented:

1. Request a known `#portal`-tagged note via the Worker → confirm it renders.
2. Request a known private (untagged) note via the same path → confirm it's not served /
   doesn't appear.
3. Request a portal note containing a link to a private note → confirm the private-stub renders
   in place of the private note's content, not a leak and not a silent 404.

## Open items (not blocking this design, tracked for later)

- Exact frontmatter/tag syntax (`#portal` vs `visibility: portal`) — pick whichever is more
  consistent with the existing `#growth` convention when this is implemented; not decided here.
- Whether folder-level tagging (mark a whole subtree portal-visible) is needed in addition to
  per-note tagging, once real portal content volume is known.
