---
title: Knowledge core spec
status: designed
cluster: knowledge
type: proposal
summary: "Decisions-only spec for the personal knowledge store — transport-agnostic vault ops, PARA+MOC nav, memory frontmatter, the six-verb lifecycle."
tags: [sux, knowledge, designed]
updated: 2026-07-09
---

> **Reconciliation note (per Colin, 2026-07-08):** §1 below frames the worker as a "fallback." That's superseded — **both paths are first-class**: local Obsidian integration (direct Local REST over Tailscale) AND a cloud version for mobile. The cloud/mobile path routes through the sux worker, which PREFERS the live vault via the Funnel'd Local REST API (full ops when the Mac is up — the usual case) and degrades to the git backend only when the Mac is asleep. So "both first-class," graceful-degrade only when off. This resolves Open Decision #1 in favor of exposing the node's Local REST to claude.ai.

# Getting the knowledge core right

The core spec for a personal-knowledge store on `SuxOS/vault`. Decisions only — no feature/tool design. Each section is a call plus the reasoning and the strongest source behind it.

---

## 1. INTERACTION MODEL — skill hitting Local REST DIRECT, worker as fallback

**Decision: Claude works the vault as a SKILL that carries the smarts and hits the Obsidian Local REST API v4.1.3 DIRECTLY over Tailscale (mac node), with the Cloudflare worker git backend as an explicit fallback. The skill runs wherever Claude runs; the transport is chosen at runtime, not baked in.**

This is the central fork the whole survey points at. The `ai-vault-plugins` sweep names it outright: *"whether you build retrieval yourself or let the agent do it with grep/read tools is the single biggest architectural fork,"* and the recommended spine is the **Claudian / mcpvault local-agent + file-tools + wikilink-graph** model — the agent already has read/search/read-note tools and the vault's own link graph *is* the index, so you skip the embeddings pipeline that families B spend most of their code on. The intelligence belongs in a skill (conventions + routing + lifecycle), not in a cloud service. The `claude-skills` sweep confirms the shape: **SKILL.md = conventions + routing; `references/` = the mechanical detail** (frontmatter schema, git-vs-REST ops, consolidate lifecycle), loaded only when acting.

**Why direct-over-Tailscale is the default, not the worker.** The mac node's Local REST API is the *live* vault with full ops — read, search (`/search/simple`, Dataview DQL, JsonLogic), **patch, and delete**. The worker git backend can only commit files; it has no search, no patch, no fuzzy retrieval. Every retrieval recommendation in the `retrieval` sweep ("prefer the Local REST API over Omnisearch for headless reliability… `/search/` gives fuzzy + Dataview + JsonLogic without depending on the search UI") only exists on the direct path. Routing everything through the worker would throw away the richest surface you own.

**The direct-vs-worker decision procedure (concrete, in this order):**
1. **Probe the mac node's Local REST API over Tailscale** (short timeout, ~2s). It answers → use it for everything: read, search, patch, delete, create. This is the happy path and should be the overwhelming majority of sessions.
2. **Node unreachable** (Mac asleep, off-net, Tailscale down) → **fall back to the worker git backend** for the operations it *can* do: read a file by path, create/append, commit. Accept the degradation: **no live search, no patch, no delete** — a git commit is the mutation primitive. Retrieval on this path degrades to "read known paths + read the MOC index" (which is exactly why §2 makes the MOC index load-bearing — it's the one retrieval surface that survives on the worker path).
3. **Both writable in a session is fine** because `obsidian-git` auto-syncs bidirectionally — but never write both in the same operation. Pick one transport per mutation to avoid a merge race; prefer the node when it's up.

**Where the skill runs.** It runs identically in **local Claude Code** (Tailscale in the same tailnet → direct is trivially reachable) and in **cloud claude.ai via the sux MCP connector** (the `obsidian` edge fn already exposes git/remote/local backends; "remote/local" = the Tailscale-reached Local REST API, "git" = the worker). The skill logic is transport-agnostic: it asks "is the Local REST node reachable from here?" and routes. On claude.ai the answer depends on whether the sux connector can currently reach the node's Funnel; if not, it uses the git backend. **One caveat from memory:** the Local REST API `/mcp/` endpoint is **stateful** (needs the initialize → session-id → initialized handshake), so the skill's REST calls must use the plain `/search`, `/vault`, `/periodic` REST routes (stateless, header-auth) for its own operations rather than the stateful `/mcp/` sub-server. Reserve `/mcp/` for when a client genuinely wants MCP semantics.

*Strongest source: `ai-vault-plugins` (Claudian/mcpvault local-agent spine) + `retrieval` §4 (Local REST over Omnisearch for headless reliability) + MEMORY `obsidian-remote-mcp` (stateful `/mcp/`).*

---

## 2. VAULT CONVENTIONS — build on PARA + the new MOCs + Anthropic's memory schema

**Decision: keep the existing PARA-ish folders and daily-note task convention exactly as they are; extend them with (a) Anthropic's live memory frontmatter contract for knowledge notes, (b) a small typed frontmatter baseline for all notes, (c) MOC-first navigation off the new Home/Man/Projects MOCs, and (d) tags-for-state-only.** Do not renumber folders or restructure; the durable move is to *layer conventions on*, not reorganize.

### Folders — keep as-is
`Inbox/` (capture), `Projects/` (folder + README each), `Man/` (reference), `Archive/`, `Daily/`, `Templates/`, `Omnivore/`, `Lists/`. This already *is* the low-regret setup the `pkm-structure` sweep endorses: **PARA folders for lifecycle/actionability + MOCs for navigation + a small consistent frontmatter schema + a strict inbox→triage→permanent→archive flow.** Folders express mutually-exclusive lifecycle only; relationships go in links, never a parallel folder tree.

### Frontmatter — one baseline, plus the memory contract for knowledge notes
Reuse the **exact contract already live** in `~/.claude/.../memory/` rather than inventing a schema (`claude-skills` sweep, verified across 17 files). Two tiers:

**Every note — baseline (from a per-type Templater template):**
```yaml
---
type:        # note | project | reference | moc | daily | clipping | memory
status:      # active | evergreen | archived  (identical meaning across all types)
tags:        []        # plural, reserved list — discovery/state only
aliases:     []        # plural, reserved list
created:     2026-07-08
modified:    2026-07-08
---
```
Reserved list fields **must be plural** (`tags`/`aliases`/`cssclasses`) — singular forms are deprecated as of Obsidian 1.9 (`pkm-structure`, help.obsidian.md). Keep it small: *"five well-maintained fields beat twenty inconsistently-filled ones."*

**Knowledge / memory notes — add Anthropic's memory discriminator** so Claude-authored durable facts are distinguishable and queryable and port 1:1 from the existing memory system:
```yaml
metadata:
  node_type: memory                      # marks this as a memory node vs ordinary note
  type: project | reference | user | feedback   # the 4 canonical memory types
  originSessionId: <session-uuid>        # provenance — which session minted the fact
```
`description:` (a quoted one-line hook) on these notes too. `originSessionId` is the one non-Obsidian field — **keep it**; it's the provenance hook consolidation relies on.

### Notes — atomic, descriptively titled, own-words, densely wikilinked
Permanent/knowledge notes are atomic (one idea, individually linkable, reusable across many MOCs); reference/`Man/` material may stay long. Human-readable titles ("MOC Investing"), not opaque IDs. `MOC ` prefix (or the existing Home/Man/Projects naming) marks index notes. (`pkm-structure`.)

### MOCs — the navigation backbone, reached from Home
The new **Home / Man / Projects MOCs are the routing layer** — this is precisely the LYT pattern that lets the vault survive to thousands of notes: every note reachable from Home in 2–3 hops, not by folder path. Rules Claude follows:
- When creating a note on an existing topic, **link it *from* the relevant MOC**.
- **"Mental squeeze point" trigger:** when 4+ sibling notes on a topic exist with no MOC, flag that one is warranted — don't create MOCs prospectively.
- `MEMORY.md`-style **index budget applies to each MOC: under ~200 lines / ~25 KB**, one line per entry `- [Title](file.md) — hook`. This is the always-loaded orientation layer (and the retrieval surface that survives the worker-only path).

### Tags — state/discovery only
`#to-process`, `#reference`, `#inferred` — cross-cutting signals you'll query, never a parallel hierarchy. Relationships live in links. (`pkm-structure`.)

### Tasks — keep the plain-checkbox convention
`- [ ]` under `## Tasks` / `## Errands` in `Daily/`, with `task-archiver` sweeping completed items. **Do not adopt inline `due::` fields or a Dataview task-rollup dashboard as core** — see §3 on Dataview. The existing convention is the durable, plugin-light one the research endorses.

*Strongest source: `claude-skills` (live memory frontmatter contract, verified) + `pkm-structure` (PARA + MOC + plural reserved fields + small schema).*

---

## 3. RETRIEVAL — a composition ladder, whole-note reads, MOC-first

**Decision: build retrieval as an agentic composition ladder over the tools you already have — MOC index → keyword/structured → whole-note read → semantic fallback → link-follow — with citations on every claim. Do NOT make embeddings the primary retriever. Do NOT install Dataview for the core.**

The `retrieval` sweep is unambiguous: *"the winning pattern is agentic composition, not a single retriever… embeddings worth keeping but as a fallback/expansion layer, not the primary path."* The two biggest wins are **(a) a MOC/index map Claude reads first** and **(b) always returning whole notes with provenance**, not fragments.

**The ladder (cheap → expensive, stop when confident):**

| Step | Tool | When |
|---|---|---|
| 1. Route | Read **Home / topic MOC** (the index map) | Always first — bounds the search, the highest-leverage move |
| 2. Keyword / structured | **Local REST `/search/simple`** (fuzzy) + **JsonLogic** for `type=project AND status=active` | Known terms, identifiers, tags, frontmatter filters |
| 3. Read | **`read_note` — whole notes**, not snippets | Candidates found — the answer forms here |
| 4. Semantic fallback | **Smart Connections** `.smart-env/` cache, cosine ~0.65, top-5 orphans | Keyword misses: synonyms, conceptual queries, terminology drift |
| 5. Link-follow | Traverse `[[wikilinks]]` 1–2 hops (depth) or multi-hub (synthesis) | Gather corroboration; bound at **~12 notes/query** |
| 6. Answer | Cite `[[note#heading]]` inline; shape `{path, heading, score, retriever}` | Every claim traces to a note |

**Tool-by-tool calls:**
- **Local REST `/search/` is the primary retriever, not Omnisearch** — Omnisearch (BM25) needs the Obsidian app open, a weak dependency for a headless agent; the REST API gives fuzzy + Dataview DQL + JsonLogic on the same direct path the skill already uses. (`retrieval` §4.)
- **Smart Connections stays, as a free fallback layer** — you already run the plugin; its `.smart-env/` cache is local and readable by external tools with numpy-only math, so "hybrid mode" costs ~zero. Add it because at 500–5,000 notes keyword collisions and terminology drift make semantic recall matter — but it is layer 4, never the backbone.
- **GitHub code search / grep** — reserve for exact identifiers and literal phrases (function names, config keys) where BM25/semantic are wasteful.
- **Just reading MOCs** — the answer for orientation and for the degraded worker-only path.

**Citations:** standardize tool output as `{path, heading, snippet/full, score, retriever}` and cite `[[note#heading]]` inline — which double as clickable Obsidian navigation. The wikilink graph traversed *is* the provenance trail.

**Dataview — do NOT install for the core.** Genuine tension here: the `pkm-structure` sweep leans on Dataview `TASK` rollups for the plugin-light task setup. But the `retrieval` sweep shows the **Local REST API already runs Dataview DQL queries server-side** (`application/vnd.olrapi.dataview.dql+txt`) *and* JsonLogic predicates — so Claude gets structured retrieval without the vault depending on the Dataview plugin's live-rendered dashboards. Adding Dataview also drags in a query-convention tax (inline `due::` fields, hand-rolled query discipline) that the `ai-vault-plugins` sweep flags as exactly the kind of plugin-owned machinery an agentic core should skip. **Keep the vault plugin-light; let the skill run DQL through REST when it needs a structured view.** (Revisit only if Colin wants live in-Obsidian task dashboards for his own eyes — see §6.)

*Strongest source: `retrieval` (composition ladder, Local-REST-over-Omnisearch, embeddings-as-fallback, MOC-first) + `ai-vault-plugins` (lexical-first, embeddings-optional).*

---

## 4. THE CORE OPERATION SET — 6 verbs (spec only; do not build now)

Converged from the `community-workflows` 6-verb set and the `claude-skills` capture/consolidate lifecycle. This is the spec for what gets built next.

| Verb | One-line contract |
|---|---|
| **capture** | Append a raw item to `Inbox/` (or today's `Daily/`) with baseline frontmatter, zero polishing, <10s friction — never files or edits, just intakes. |
| **triage** | For each Inbox item: classify → promote to a permanent/reference note, turn into a `- [ ]` task, or discard; move out of Inbox; runs on a cadence, not per-capture. |
| **link** | Add `[[wikilinks]]`, wire new notes into the right MOC, heal orphans; flag when 4+ siblings warrant a new MOC. |
| **retrieve** | Answer a query via the §3 ladder, whole-note reads with `[[note#heading]]` citations; write-back a keepable synthesized answer as a new note. |
| **consolidate** | Periodic GC pass (Anthropic's consolidate-memory Phases 1–3): merge overlaps, retire dated facts, absolutize dates, prune the re-findable, re-fit each MOC to the 200-line/25 KB budget. |
| **remember** | Write one durable fact per file with the memory frontmatter contract (`node_type: memory`, typed, `originSessionId`); append its line to the relevant MOC. |

**Shape (from `community-workflows`):** a linear write pipeline `capture → triage → link`, an always-available `retrieve` read-path that grows the vault from questions, and a scheduled `consolidate` maintenance loop. `remember` is the memory-typed specialization of capture+promote that keeps Claude's own durable facts in the vault. Keep **capture cheap / consolidate coherent** as two separate skills — that separation is the whole point of the lifecycle (`claude-skills`).

**Governance baked into every write** (`community-workflows`): one write-safety layer (not per-skill raw writes), **surgical `str_replace`/patch edits — never reprint a whole note** (via Local REST `/patch`), non-destructive & idempotent defaults, **explicit confirmation on delete**, contradictions *flagged* not silently resolved, and provenance/confidence tagging (`^[inferred]`, source URLs verbatim).

*Strongest source: `community-workflows` (6 verbs + pipeline/read-path/loop shape + governance) + `claude-skills` (capture/consolidate separation, memory contract).*

---

## 5. WHAT TO ADOPT vs IGNORE

**Adopt:**
- **Agent-does-retrieval over plugin-owned RAG** (Claudian/mcpvault) — the single biggest complexity saving; grep/read/search + the wikilink graph *is* the index. (`ai-vault-plugins`.)
- **Lexical/structured-first, embeddings-optional** (Copilot's two-tier) — Local REST search is always-on; Smart Connections is the opt-in upgrade layer. (`retrieval`, `ai-vault-plugins`.)
- **Surgical-edit + write-approval + word-level diff before write** — non-negotiable UX for an agent mutating notes; Local REST `/patch` gives surgical edits. (`ai-vault-plugins`, `community-workflows`.)
- **Inbox-folder auto-file loop** (Note Companion pattern) — "watched folder → read/tag/file/link" maps directly onto Claude tool use, no bespoke ML. (`ai-vault-plugins`.)
- **A generated MOC/index map read first** — highest-leverage change; what makes agentic routing beat vector RAG. (`retrieval`.)
- **Anthropic's live memory frontmatter contract + consolidate-memory Phases 1–3** — don't invent a schema; it's Obsidian-native and already proven. (`claude-skills`.)
- **doc-coauthoring discipline for substantial notes** — surgical patches + validate against a context-free reader (the note must stand alone for the next cold session). (`claude-skills`.)
- **Keep the plugins you have:** `local-rest-api`, `obsidian-git`, `smart-connections`, `omnisearch` (nice-to-have when app is open), `task-archiver`, `nldates`, `calendar`, `omnivore`, `linter`.

**Ignore / skip as bloat:**
- **pgvector / sentence-transformers server backends** (Khoj) — heavy infra for marginal gain when the agent can grep. Wrong altitude for a lean core. (`ai-vault-plugins`.)
- **Mandatory vault-wide embedding index with re-index cost** — keep semantic opt-in, reading the existing `.smart-env/` cache. (`retrieval`, `ai-vault-plugins`.)
- **55+ tool / multi-agent maximalism** (Obsilo, Vault Operator) — a focused capture/triage/link/retrieve/consolidate/remember set covers the 90%. (`ai-vault-plugins`, `community-workflows`.)
- **Handlebars/Text-Generator template DSL** — Claude's own skills/prompt-templates subsume it. (`ai-vault-plugins`.)
- **Dataview as a core dependency** — Local REST runs DQL server-side; adding the plugin imports a query-convention tax. (§3.)
- **Bundled image-gen / transcription in the retrieval-write path** — orthogonal, keep out. (`ai-vault-plugins`.)

---

## 6. OPEN DECISIONS for Colin

1. **Cloud-claude.ai reachability of the mac node.** The skill routes direct-vs-worker on "is the Local REST node reachable from here." From local Claude Code that's trivial. From claude.ai via the sux connector it depends on whether the connector can hit the node's Funnel. **Decision needed:** do you want the sux `obsidian` fn to expose the node's Local REST search to claude.ai (so cloud sessions get the *full* retrieval ladder), or is claude.ai deliberately worker-git-only (read + commit, degraded retrieval)? This sets how much the skill can do when you're on mobile.

2. **One skill or two.** The `claude-skills` sweep argues for **two** skills — a cheap append-optimistic *capture/remember* and a separate *consolidate* GC pass — because that separation is the lifecycle. But it's more surface to maintain and trigger-tune. **Decision:** two skills (clean lifecycle, recommended) vs one skill with modes (simpler, one description to tune)?

3. **Do you personally want live in-Obsidian dashboards?** The core doesn't need Dataview (§3). But if *you* (not Claude) want a rendered "open tasks across all dailies" or "active projects" dashboard *inside the Obsidian app*, that requires the Dataview plugin. **Decision:** install Dataview for your own human-facing dashboards (accepting the plugin + inline-field convention), or stay plugin-light and let Claude generate views on demand via REST DQL?

4. **Governance strictness for Claude's writes.** How hard a line on the non-destructive model — e.g. must every Claude edit land only inside `<!-- @generated -->` sentinel regions with human text never touched (strict, auditable, more friction), or is surgical `/patch` + confirm-on-delete + provenance tags enough (lighter, trusts the diff)? **Decision needed** before building the write-safety layer, since it's the one thing that's painful to retrofit.
---

## Finalized decisions (Colin, 2026-07-08)

1. **Both transports first-class** (Open Decision #1) — cloud/mobile via the sux worker prefers the live vault through the Funnel'd Local REST API (full ops when the Mac is up), git backend only when the Mac is asleep. Not a fallback; a graceful degrade.
2. **Two skills** — a cheap capture/remember skill + a separate consolidate (GC) skill. Clean lifecycle separation.
3. **Plugin-light, no Dataview** — Claude generates structured views on demand via the Local REST API's server-side DQL; the vault stays plugin-light.
4. **Claude fully unblocked on writes** — no per-write approval, no confirm-on-delete, no `@generated` sentinel regions. Claude creates/edits/deletes freely. **The safety net is git**: every change is a revertible commit in `SuxOS/vault` (obsidian-git auto-syncs), so "undo" = `git revert`. Surgical `/patch` edits are still PREFERRED for cleanliness (don't reprint whole notes), but not gated.

Build order (deferred until Colin says go): capture/remember skill → consolidate skill → wire the retrieval ladder + the both-transports routing.

---

## Email domain — Fastmail via full JMAP (added by Colin, 2026-07-08)

The knowledge core spans TWO first-class data domains, not one:
- **Vault** (notes) — via the Local REST API (local/Tailscale) or the worker (cloud). Needs the Mac/tailnet for the live path.
- **Fastmail** (email) — via the **full JMAP wrapper** (`jmap.md`): Email/Mailbox/Thread/query/get + EmailSubmission + masked-email + the whole protocol, NOT the lossy 29-tool connector.

**Transport for email is uniform on both paths.** Unlike the vault, Fastmail's JMAP is a public cloud API (`api.fastmail.com`), so it's reachable directly from BOTH local Claude and the cloud worker with the token — no Mac/Tailscale dependency. Route email through the sux `jmap` fn (token = worker secret, centralized, cached); the "avoid the worker hop" rule was about the *local vault* (the Mac is right there) and does not apply to email, which is cloud-native either way.

**Email plugs into the same six verbs:**
- **capture** — an email/thread (or a labeled/starred set) → a vault note in `Inbox/` (or appended to a relevant note), with provenance (message-id, from, date, JMAP link). Selective import of keepers, not a firehose.
- **retrieve** — the §3 ladder gains an email source: JMAP `Email/query` (keyword/structured, by mailbox/from/subject/date) alongside vault search; answers cite the email. "Ask across my notes AND my mail."
- **remember** — durable facts extracted from email → memory-typed notes.
- **triage / manage** (adjacent productivity, same wrapper) — archive/label/reply/send + masked-email creation. Email management is a productivity surface the full JMAP enables; the CORE integration is capture-from / retrieve-over / remember-from email.

**jmap.md status:** KEPT as the email-access spec (analogous to the Local REST API for the vault). Its security model (scoped token as worker secret, mutation gating on send/destroy, cacheable:false, batched-dispatch) stands. Masked email is the bonus the connector can't do.

## Related

- [[six-verb-lifecycle]]
- [[vault-stack]]
- [[jmap]]
- [[SUX]]
- [[Knowledge-Engine-MOC]]
