---
title: sux — MCP server vs skill vs plugin vs connector (canonical decomposition)
status: living
audience: Colin + future Claude sessions — the one place that settles "which layer is this?"
---

# The five layers, and where sux's mess is

Colin's confusion is real and it has one root cause: **the same two skills and the same
one connector are copied into four places.** The *concepts* barely overlap — it's the
*files* that duplicate. Below: (1) crisp one-line definitions in sux's own terms, (2) an
inventory of what actually ships where and what's redundant, (3) the clean end-state, and
(4) a punch-list marked SAFE vs NEEDS-COLIN.

Companion docs: `docs/knowledge/patterns-and-conventions.md` (fn anatomy, front verbs),
`docs/design/north-star.md` (vision), `CLAUDE.md` (how we work).

---

## 1. Definitions — one line each, concretely for sux

| Layer | In sux, this IS… | Lives in | Count |
|---|---|---|---|
| **MCP server** | The **one Cloudflare Worker** at `suxos.net`, exposing every capability behind one `/mcp` front door + OAuth (`/authorize`, `/register`, `/token`; GitHub IdP). `CONNECTORS` in `sux/src/connectors.ts` now lists exactly one path: `/mcp`. | `sux/src/` | 1 |
| **MCP fn / tool** | A **leaf capability** — one `Fn` object (`sux/src/registry.ts`), one file `sux/src/fns/<name>.ts`, collected in the generated `fns/index.ts`. `search`, `scrape`, `render`, `pack`, `wayback`, … | `sux/src/fns/` | ~95 (109 in the array) |
| **Front verb** | The **~18 curated tools** `tools/list` actually advertises (`FRONT_VERBS`, `registry.ts`) so the surface stays phone-legible. Everything else is a leaf, still reachable by name or via the `fn({name,args})` escape, still discoverable via the self-describing `sux` map. | `registry.ts` | ~18 |
| **Skill** | An **instruction file** (`SKILL.md`) that routes *intent → fns*. Pure Markdown + frontmatter; ships no code, calls no API itself. sux has two: **`sux`** (which fn to reach for) and **`life`** (the capture→recall→consolidate memory discipline over vault/mail). | `.claude/skills/`, and copied into the plugin | 2 |
| **Plugin** | The **Claude Code bundle** that ships the skills **and** the connector config in one installable unit: `.claude-plugin/plugin.json` + `skills/` + inline `mcpServers`. Referenced by the marketplace. | `plugins/sux/` | 1 (should be) |
| **Connector** | The **client→Worker wiring**: `{ "type": "http", "url": ".../mcp" }`. It is *not a separate artifact* — it's a few lines of JSON that live **inside** the plugin (Claude Code / claude.ai) or inside the MCPB manifest (Claude Desktop). OAuth runs in-browser on the first `401`. | inside plugin.json / .mcp.json / MCPB manifest | — |

**The mental model in one sentence:** the **Worker** is the engine, **fns** are its
capabilities, **front verbs** are the ~18 it puts on the menu, a **skill** is a recipe card
telling Claude which capability to use, a **plugin** is the box that ships the recipe cards
plus the plug, and a **connector** is the plug itself.

Key non-obvious facts, so the layers don't blur:

- **Connector ≠ MCP server.** The server is the deployed Worker; the connector is the
  client-side JSON that points at it. One server, many possible connector declarations.
- **Front verb ≠ fn.** Every front verb *is* a fn, but only ~18 of ~95 fns are front
  verbs. "Front verb" is a visibility tier, not a different kind of thing.
- **Skill ≠ plugin.** A skill is inert Markdown. A plugin is the delivery vehicle that
  *contains* skills + connector config. You can ship a skill without a plugin (raw
  `SKILL.md`) and a connector without a skill (bare `.mcp.json`), but the plugin is what
  bundles both for one-click install.
- **The per-domain `/<ns>/mcp` connectors are retired.** vault/mail/files/cal/contact are
  now ordinary **front verbs** on the one `/mcp` connector (the `action`-dispatch pattern),
  so there is exactly **one** connector, not six.

---

## 2. What ships where — the actual inventory (and the redundancy)

| Artifact | Path | Contains | Consumed by | Duplicated / redundant? |
|---|---|---|---|---|
| **Worker (MCP server)** | `sux/src/` | ~95 fns, front-verb routing, OAuth, `/mcp` | every client | No — single source of truth. |
| **`sux` skill (canonical)** | `.claude/skills/sux/SKILL.md` | 218-line intent→fn router | this repo's own dev sessions | This is the current copy. |
| **`life` skill (canonical)** | `.claude/skills/life/SKILL.md` | memory discipline | this repo's own dev sessions | This is the current copy. |
| **The plugin** | `plugins/sux/` (v0.4.0) | `plugin.json` (inline `mcpServers` → `/mcp`) + **both** skills | marketplace / `claude --plugin-dir` / claude.ai | **This is the real, marketplace-referenced plugin.** Its two skills are byte-identical copies of `.claude/skills/`. |
| **Marketplace manifest** | `.claude-plugin/marketplace.json` | points at `./plugins/sux` | plugin installers | No — correct. |
| **MCPB / desktop extension** | `packaging/desktop-extension/manifest.json` | `mcp-remote` stdio bridge to `/mcp` | Claude Desktop (local stdio only) | **Keep** — genuinely distinct (Desktop can't take a remote URL via MCPB; needs the bridge). Ships **no** skill, only the connector bridge. |
| **Orphan plugin** | `packaging/claude-code-plugin/` (v1.0.0) | `plugin.json` + separate `.mcp.json` + **only the `sux` skill, STALE (101 lines)** | **nobody** — not in the marketplace | **REDUNDANT.** A second, older, divergent Claude Code plugin. Its skill copy is a stale fork. |
| **Orphan standalone skill** | `packaging/skill/` | a 4th copy of the `sux` skill, also **STALE (101 lines)** | nobody wires it in | **REDUNDANT.** Byte-identical to the orphan plugin's stale skill. |

**The redundancy, stated plainly:**

- The **`sux` skill exists in 4 places**: `.claude/skills/sux` and `plugins/sux/skills/sux`
  are identical and **current** (218 lines, sha `d52d7fe6`); `packaging/claude-code-plugin/skills/sux`
  and `packaging/skill` are identical to each other and **stale** (101 lines, sha `6f611731`).
  So there are two live copies (fine-ish) plus **two stale forks that will silently ship old
  guidance** if anyone installs from `packaging/`.
- There are **two Claude Code plugins** describing the same connector: `plugins/sux/`
  (v0.4.0, in the marketplace, both skills) and `packaging/claude-code-plugin/` (v1.0.0,
  orphaned, one stale skill). Only the first is real. The second is a trap.
- `packaging/README.md` still says **"~80 edge functions"** and calls this dir `dist/`; the
  Worker is ~95 and the dir is `packaging/`. Stale.

**Why even two live skill copies exist:** a plugin must physically *contain* its skills
(`skills/` under the plugin root), and `.claude/skills/` is what this repo loads for its own
dev sessions. Those two locations are legitimately different consumers — but they should be
kept in sync by generation, not by hand.

---

## 3. The clean decomposition (opinionated end-state)

**One server. One connector string. One plugin. One authoritative copy of each skill.
Everything else is generated or deleted.**

```
sux/src/                      ← the MCP server (the ONLY engine). ~95 fns, ~18 front verbs.
.claude/skills/{sux,life}/    ← the ONE authoritative copy of each skill (edited here).
plugins/sux/                  ← the ONE plugin. skills/ is GENERATED from .claude/skills/.
  └ .claude-plugin/plugin.json  (inline mcpServers → https://suxos.net/mcp)
.claude-plugin/marketplace.json ← points at ./plugins/sux. (unchanged)
packaging/desktop-extension/  ← the ONE non-Claude-Code packaging: MCPB stdio bridge. Keep.
```

**Deleted:** `packaging/claude-code-plugin/` (duplicate plugin) and `packaging/skill/`
(duplicate skill). Both are superseded by `plugins/sux/` and `.claude/skills/`.

**Skills stay DRY by generation, not copies.** Make `.claude/skills/{sux,life}` the source
of truth and have a tiny script (`npm run sync:skills`, alongside `gen:index`) copy them
into `plugins/sux/skills/`, with a `check:skills` CI gate that fails if they drift — exactly
the pattern already used for `sux/src/fns/index.ts`. Hand-editing the plugin copy then fails
CI, so the two live copies can never silently diverge again.

### The decision rule: fn vs skill vs plugin

When a new capability shows up, classify it with this ladder — **stop at the first yes:**

1. **Is it one deterministic capability the Worker can execute** (a fetch, a transform, a
   lookup, a store)? → **It's an fn.** Add `sux/src/fns/<name>.ts`, `gen:index`, done. This
   is the default and the overwhelming majority. Don't reach for anything heavier.
   - Sub-rule — **front verb or leaf?** Front-verb it (add to `FRONT_VERBS` or
     `surface:"front"`) only if a phone user would look for it by name in `tools/list`.
     Otherwise leave it a leaf, reachable via `fn`/`sux`. Keep the advertised surface ~18.
2. **Is it just *knowing which fns to chain* for a class of intent** — no new Worker code,
   only guidance? → **It's a skill** (or a section in `sux`/`life`). A skill is warranted
   only when the routing is non-obvious enough that Claude needs prose to get it right.
   Prefer extending an existing skill over minting a new one.
3. **Is it a genuinely separate product surface** — its own connector URL, its own auth, its
   own audience, shipped independently? → **It's its own plugin.** For sux today this is
   **basically never**: it's one Worker, one connector, one audience. New domains become
   **front verbs on `/mcp`**, not new plugins. Reserve a second plugin for the day sux
   splits into a truly separate deployable — not before.

**Bold call:** sux should be a **one-plugin, one-connector** ecosystem indefinitely. The
front-verb `action`-dispatch pattern already collapsed six connectors into one; resist ever
re-fragmenting into per-domain plugins or connectors. The `packaging/` tree is a museum of
that earlier fragmentation and most of it should go.

---

## 4. Concrete cleanup actions (punch-list)

Marked **SAFE** (docs-only / removing dead, unreferenced artifacts — do now) vs
**NEEDS-COLIN** (touches install surface or adds tooling — confirm first).

1. **SAFE — delete `packaging/skill/`.** A stale 4th copy of the `sux` skill, wired into
   nothing. Superseded by `.claude/skills/sux/`.
2. **SAFE — delete `packaging/claude-code-plugin/`.** An orphaned v1.0.0 duplicate plugin
   with a stale one-skill copy; not referenced by `marketplace.json`. `plugins/sux/` is the
   real plugin.
3. **SAFE — fix `packaging/README.md`.** Drop the deleted rows, correct "~80 edge
   functions" → "~95", and stop calling the dir `dist/`. After (1)+(2) it documents exactly
   one artifact: the desktop-extension MCPB.
4. **NEEDS-COLIN — add `sync:skills` + `check:skills`.** Generate `plugins/sux/skills/` from
   `.claude/skills/` and gate drift in CI, mirroring `gen:index`/`check:node`. Makes the two
   remaining live copies DRY-by-construction.
5. **NEEDS-COLIN — reconcile plugin version numbers.** `plugins/sux` is v0.4.0 while the
   dead `packaging` plugin was v1.0.0; once the orphan is gone, decide the single canonical
   version line for the marketplace.

---

### One-paragraph summary

sux is **one MCP server** (the Cloudflare Worker) exposing **~95 fns**, of which **~18 are
front verbs** advertised on the single **`/mcp` connector**; **two skills** (`sux` routing,
`life` memory) tell Claude which fns to chain; and **one plugin** (`plugins/sux/`) bundles
those skills plus the connector config for one-click install (with an MCPB variant for
Claude Desktop). The confusion is not conceptual overlap — it's that the skills and the
plugin were **copied into `packaging/`** as stale, orphaned forks. The fix is to keep one
authoritative copy of each skill in `.claude/skills/`, generate the plugin's copies from it
under CI, keep exactly one plugin and one connector, and delete the `packaging/` duplicates
— treating every future capability as an **fn** first, a **skill** only when routing needs
prose, and a **new plugin** essentially never.
