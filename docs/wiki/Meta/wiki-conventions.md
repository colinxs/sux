---
title: Wiki conventions
status: reference
cluster: meta
type: reference
tags: [sux, meta, reference]
updated: 2026-07-09
---

# Wiki conventions

The rules every wiki note obeys so the vault stays coherent and the generator
([[wiki-protocol]]) can drive dashboards from note metadata. This is the spec —
if a note and this doc disagree, this doc wins.

## The vault

The **repo root is the Obsidian vault.** Open `sux-mcp/` in Obsidian and the
whole thing is browsable. `[[wikilinks]]` resolve by **basename** across every
folder, so notes never had to move — the design corpus stays in
`docs/proposals/`, the code docs under `sux/`, and this wiki layer adds
navigation on top. Heavy non-doc folders (`node_modules/`, `sux/src/`, …) are in
`userIgnoreFilters` (`.obsidian/app.json`) so they don't clutter search.

Layout:

| Path | What lives there |
|---|---|
| `Home.md` | Vault entry dashboard |
| `docs/wiki/MOCs/` | Maps of Content — the navigational spine |
| `docs/wiki/concepts/` | Atomic concept notes (the graph nodes) |
| `docs/wiki/Meta/` | This spec + the living-wiki protocol |
| `docs/proposals/` | The design corpus (unchanged bodies; frontmatter + Related added) |
| `sux/`, `README.md`, `CLAUDE.md`, … | Code + code docs, linked from the wiki |

## Frontmatter schema

Every wiki-managed note starts with YAML frontmatter. The generator reads
`status` and `cluster` to build [[Status-Dashboard]]; Obsidian reads `tags` for
the tag pane and graph.

```yaml
---
title: <human title, matches the H1>
status: shipped | designed | draft | parked | meta | reference
cluster: algebra | retrieval | knowledge | namespaces | infrastructure | operations | meta
type: proposal | concept | moc | dashboard | code-doc | handoff | reference | meta | log
summary: <one dense line — the terse, Claude-optimized kernel of this note>
tags: [sux, <cluster>, <status>]
updated: YYYY-MM-DD
related: ["[[note-a]]", "[[note-b]]"]   # optional; concept notes especially
---
```

**Two formats, one file.** The prose body is the human-readable format; the
`summary:` line is the terse, Claude-optimized format. The generator collects
every note's `summary` (falling back to the first body sentence if absent) into
[`llms.txt`](../../../llms.txt) — the whole vault as a dense machine index. Keep
`summary` to a single line: status-relevant facts + what it owns, no fluff.

### `status` — the lifecycle axis

| Status | Meaning |
|---|---|
| `shipped` | Built and running in `origin/main` / production |
| `designed` | Design-locked, on the active build path, not yet built |
| `draft` | Proposed, not yet design-locked (e.g. an open exploratory PR) |
| `parked` | Explored to high polish via design iteration, **not on the build path** (superseded by the [[SUX]] pivot) |
| `meta` | Program-level coherence / strategy / history, not a feature spec |
| `reference` | Stable reference material (this doc, config surface) |

### `cluster` — the thematic axis

`algebra` · `retrieval` · `knowledge` · `namespaces` · `infrastructure` ·
`operations` · `meta`. See the [[Home]] dashboard for what each contains.

## Naming & links

- **Concept notes**: `kebab-case.md`, unique basename, H1 in Title Case.
- **MOCs**: `<Name>-MOC.md`.
- **Links**: `[[basename]]` or `[[basename|alias]]`. Basenames are unique across
  the vault *except* `architecture.md` (both `docs/proposals/` and `sux/docs/`)
  — link the design one as `[[architecture]]`; reference the code one by path.
- Every note should be reachable from at least one MOC, and every concept note
  should link back to its **authoritative source** (the proposal doc or the
  code file that owns the concept).

## What is generated vs hand-written

`[[Functions-MOC]]` and `[[Status-Dashboard]]` are **generated** by
`scripts/gen-wiki.mjs` (`npm run wiki`) — do not hand-edit below their generated
marker. Everything else is hand-written. See [[wiki-protocol]] for the update loop.
