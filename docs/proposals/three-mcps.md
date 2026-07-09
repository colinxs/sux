# Three MCPs — vault · jmap · sux

Split the monolith into three focused MCP connectors, each owning one domain. Claude connects to all three and composes them. The knowledge/note/oracle interface is the `vault` MCP; email is `jmap`; web search is `sux`.

## The three

| MCP | Domain | Transport |
|---|---|---|
| **vault** | Your Obsidian knowledge store — notes, knowledge lifecycle, oracle | Two: local (Local REST API over Tailscale, live vault, preferred) / cloud (worker → `colinxs/vault` git) when off-tailnet or Mac asleep. One interface, routed at runtime. |
| **jmap** | Fastmail email, full JMAP | One: `api.fastmail.com` (public cloud API), token as worker secret — reachable from anywhere. |
| **sux** | Web search & retrieval, residentially-proxied | One: the existing sux worker, refocused. |

---

## `vault` MCP — the knowledge/note/oracle interface

Six verbs in three tiers. The `note` tier is the CRUD primitive everything else composes; the knowledge tier is the lifecycle; the oracle tier is the query.

### note tier — the primitive
| verb | args | contract |
|---|---|---|
| **note** | `action` (get\|put\|patch\|append\|delete\|list\|search), `path`, `content?`, `query?` | Direct CRUD + search over a note by path. Maps to the Local REST API (local) or the git backend (cloud). `patch` = heading/block-relative surgical edit. The substrate. |

### knowledge tier — the lifecycle
| verb | args | contract |
|---|---|---|
| **capture** | `text`, `source?` (chat\|clip\|email\|url), `to?` (Inbox\|Daily) | Append a raw item to `Inbox/` (or today's `Daily/`) with baseline frontmatter + provenance. Zero polishing, <10s. Intake only — never files or edits. |
| **remember** | `fact`, `type` (project\|reference\|user\|feedback), `links?` | Write one durable, memory-typed fact per file (`metadata.node_type: memory`) and index its line in the relevant MOC. Claude's own durable knowledge. |
| **organize** | `scope?` (inbox\|orphans\|topic) | Triage `Inbox/` (file / promote / discard) + wire notes into MOCs + heal orphans; flag when 4+ siblings warrant a new MOC. Runs on a cadence, not per-capture. |
| **consolidate** | `scope?` | Periodic GC (memory's consolidate lifecycle): merge overlaps, retire stale, absolutize dates, prune the re-findable, re-fit each MOC to its ~200-line budget. |

### oracle tier — the query
| verb | args | contract |
|---|---|---|
| **ask** | `query`, `write_back?` | Retrieve via the ladder (MOC → Local REST search / DQL → whole-note read → Smart Connections semantic fallback → link-follow, cap ~12 notes) and answer with `[[note#heading]]` citations. Optionally write the synthesis back as a keepable note. |

**Two skills carry these** (per the core decisions): a cheap **capture/remember** skill and a careful **organize/consolidate** skill; `note` and `ask` are the shared substrate both use. Writes are unblocked — git is the undo.

---

## `jmap` MCP — Fastmail email

| verb | args | contract |
|---|---|---|
| **mail** | `action` (search\|read\|send\|draft\|archive\|label\|masked), … | Ergonomic everyday email. `masked` = create a masked-email address (the connector can't). Send/destroy gated. |
| **jmap** | `{using, methodCalls}` \| `{method, args}` | Raw full-protocol JMAP escape hatch — the whole surface (Email/Mailbox/Thread/Submission/masked/contacts/calendars), auto batch/paginate around limits, byte-exact. Per `jmap.md`; security model intact (scoped token, send/destroy gated, `cacheable:false`). |

---

## `sux` MCP — web search & retrieval

| verb | args | contract |
|---|---|---|
| **search** | `query`, `backends?`, `filter?` | Web/research search across Kagi + engines, residentially-proxied, direct-fallback. |
| **fetch** | `url`, `render?` | Retrieve a page through the scrape → render → render:mac escalation ladder (beats bot walls). |

(The worker keeps its utility fns — extract, convert, etc. — but the headline verbs are `search` + `fetch`.)

---

## Composition — Claude is the cross-source oracle

The three MCPs stay focused; Claude orchestrates across them. Each answers over its own domain:

| Intent | Composition |
|---|---|
| ask my notes | `vault.ask` |
| ask my mail | `jmap.mail search` |
| search the web | `sux.search` |
| **ask everything** | Claude fans `vault.ask` + `jmap.mail` + `sux.search`, synthesizes, cites per source (the "Ask Your Org" pattern over your own domains) |
| capture an email as a note | `jmap.mail read` → `vault.capture` |
| research X and file it | `sux.search`/`fetch` → `vault.capture` or `remember` |

No MCP calls another (clean separation); the composition lives in Claude.

---

## Build plan

**Phase 1 — `vault` MCP (the core, first).**
1. `note` primitive over both transports; **add the git-backend gap-fills** (`patch`/`delete`/`put`) so cloud/mobile matches local op-parity.
2. `capture` + `remember` — the cheap intake skill. (First useful thing — starts paying down the 24-item Inbox.)
3. `organize` + `consolidate` — the maintenance skill.
4. `ask` — the oracle: wire the retrieval ladder.

**Phase 2 — `jmap` MCP.** Ship `jmap` (raw, per jmap.md) + `mail` (ergonomic). Token as worker secret. Wire email into `vault.capture` (capture-from-email) and into `ask` as a source.

**Phase 3 — `sux` MCP.** Refocus the existing worker as the search MCP: `search` + `fetch`. Wire into `ask` as a web source.

Each ships as its own connector; the `vault` core lands first, and it's independently useful before jmap/sux are split out.
