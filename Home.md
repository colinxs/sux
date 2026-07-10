---
title: Home
status: reference
cluster: meta
type: moc
summary: "Vault entry dashboard — what sux is, the two design eras (active namespaces vs parked retrieval), and links into the MOCs, status, and functions."
tags: [sux, meta, home]
updated: 2026-07-09
---

# sux — vault home

> This repo *is* an Obsidian vault. Open `sux-mcp/` in Obsidian and browse. The
> code and its design corpus stay where they live; this wiki layer adds
> navigation, status, and a concept graph on top. New here? Read
> [[wiki-conventions]] and [[wiki-protocol]].

**sux** is a personal, self-owned web-access and personal-data layer: one
Cloudflare Worker exposing ~91 composable functions over MCP, that fetches from
*your own residential IP*, caches at the edge, and hosts a git-backed knowledge
vault — all behind one OAuth login. See the root [`README.md`](README.md) and
[`PLAN.md`](PLAN.md) for the pitch; [[architecture]] for the picture.

## Start here

- 🗺️ **[[Status-Dashboard]]** — every doc by lifecycle status (generated)
- 🧩 **[[Functions-MOC]]** — the ~91-function `/mcp` surface (generated)
- 📐 **[[architecture]]** — the shipped topology in diagrams
- 🤖 [`llms.txt`](llms.txt) — the terse, Claude-optimized whole-vault index (generated; load this to orient a fresh session cheaply)

## The four Maps of Content

| MOC | What it covers |
|---|---|
| **[[Namespaces-MOC]]** | The personal-data connectors — vault (shipped), mail, files — and the cross-store write/act layer. **The active build path.** |
| **[[Infrastructure-MOC]]** | What everything stands on: the [[fetch-ladder]], [[content-addressed-cache]], [[oauth-gate]], [[mcp-gate]], and vault hosting. |
| **[[Knowledge-Engine-MOC]]** | Turning sources into knowledge: the [[six-verb-lifecycle]], the [[kb-substrate]], and where the read layer went ([[oracle-supersession]]). |
| **[[Parked-Retrieval-MOC]]** | The high-polish web-retrieval / data-algebra corpus that the [[SUX]] pivot **parked** — kept for the ideas, not on the build path. |

## The one thing to know: two eras

This corpus spans two design eras. The [[SUX]] pivot reframed the **knowledge
store as the core** and everything else as thin tools on top — which **parked**
an entire retrieval + algebra program (search / shop / travel / the
[[verb-algebra]]) that still reads as active if you only skim it. The
[[Status-Dashboard]] is the source of truth for what's `shipped` vs `designed`
vs `parked`; when reality moves, a note's `status:` flips and `npm run wiki`
regenerates. That discipline is what makes this wiki *living* — see
[[wiki-protocol]].

## In flight

- **This work** — the four-namespace design pass ([[three-mcps]], [[sux-verbs]],
  [[vault-backends]], [[files]], [[mail]], [[enterprise-ops]]) is `designed`; the
  vault slice is `shipped` ([[vault-stack]]).
- **[[mychart|MyChart / Epic FHIR + Apple Health]]** — a separate `draft`
  proposal (open PR #31), health-data integration. Not started.
