# The hub and the spokes — mapping the nine domains onto the knowledge core

The problem, stated once: **one assistant surface over Colin's whole personal-data estate** — notes (Obsidian), email (Fastmail/JMAP), tasks (Todoist-shaped), calendar, messages (iMessage), files (Dropbox), code (GitHub), and the open web (search) — without the failure mode visible in any current claude.ai session: ~29 Fastmail tools + ~50 Todoist tools + ~20 Dropbox tools + 4 iMessage tools + 4 Apple Notes tools, six disjoint connectors, none composable, none cached, none of which write anything durable into a store Claude can learn from. The sux answer is the inverse: **the vault is the hub, domain access is a handful of conduit verbs on one worker, and the intelligence lives in skills** ([knowledge-core.md](knowledge-core.md)'s six verbs). This doc maps each named domain onto that architecture, with the prior art each decision steals from.

Companion to [knowledge-core.md](knowledge-core.md) (the vault spec, decisions locked 2026-07-08) and [jmap.md](jmap.md) (the email conduit, spec final). Nothing here reopens those; this adds the spokes.

---

## 0. Ground truth (verified 2026-07-08, this machine)

Facts that anchor the decisions below — several correct the docs:

1. **The live vault** is `~/Documents/Obsidian/Primary/Primary` = `colinxs/vault` (git remote confirmed, auto-backup commits flowing). It runs exactly **three** community plugins: `obsidian-linter`, `obsidian-local-rest-api`, `obsidian-git`. It is already the plugin-light target state.
2. **knowledge-core §5's "keep the plugins you have" list is stale** — smart-connections, omnisearch, task-archiver, nldates, calendar, omnivore live only in the **old** vault at `~/Documents/Notes/Primary` (not a git repo, no REST API — a pre-migration copy). Consequence: **retrieval-ladder step 4 (Smart Connections `.smart-env/` cache) does not exist on the live vault.** See §6, decision 2.
3. **Scale:** the live vault is 224 notes (81 dailies). At this size ladder steps 1–3 (MOC → REST search → whole-note read) cover essentially everything; semantic fallback is a someday-problem.
4. **Dailies stalled 2026-04-19**, while `Home.md` (the Home MOC, hot-cache shape with pointer lines) was created fresh 2026-07-08. The task convention ("checkboxes in today's daily") currently has no live daily habit under it.
5. **Todoist is empty** — one default Inbox, zero projects, zero sections (checked via the connector). "Drop Todoist" costs nothing; there is no migration.
6. **Mac node topology confirmed:** Funnel :443 → `render_server.py` (aiohttp, `/render` + `/health`, cwd `sux/mac-render`), Funnel :8443 → Obsidian Local REST (27123). Tailscale Funnel offers exactly three ports (443/8443/10000) — **one slot free**, but path-routing new endpoints on the existing :443 server costs zero slots.
7. **sux worker:** 89 fns; `obsidian` fn today = `list/read/search/append` (git default, `remote` reaches the live vault). The `write`/`edit`/`delete` gaps named in [SUX.md](SUX.md) are still open.
8. **Installed sux-router skill is byte-identical to repo HEAD** — no drift to reconcile.

---

## 1. The unifying frame: three transport classes

Every domain falls into exactly one of three transport classes. This is the whole routing story — the skill asks one question per domain, not nine bespoke questions.

| Class | Domains | Transport | Cloud/mobile path | Degrades when |
|---|---|---|---|---|
| **A. Cloud-native API** | Fastmail (email/calendar/contacts), Dropbox, GitHub, Todoist-if-kept | Worker conduit fn, token as worker secret | Identical — same fn, same token | Never (provider outage only) |
| **B. Mac-local surface** | Live vault (Local REST), **iMessage**, Apple-anything | Tailscale direct from local Claude; worker → Funnel from cloud | Worker prefers the Funnel'd live surface, falls back where a fallback exists | Mac asleep / off-net |
| **C. Open web** | search / scrape / render | The existing 89-fn engine | Already uniform | Per the escalation ladder |

Two consequences:

- **Class B is a pattern, not a one-off.** The obsidian dual-transport decision (knowledge-core reconciliation note: live REST preferred, git degrade) is the template every Mac-local surface reuses. iMessage is simply the second instance.
- **Class C never joins the store.** [SUX.md](SUX.md) already rules this: web search is a separate retrieval engine. Web content enters the vault only through an explicit `capture`/`remember` with provenance — never as an ambient index.

And one governance principle that falls out of Colin's write-safety decision, worth stating as law because it resolves every per-domain gating question mechanically:

> **Unblocked where git can undo; gated where the world can't.**
> Vault writes are revertible commits → Claude is fully unblocked (locked decision #4). Outward-facing mutations — send an email, send an iMessage, RSVP, create a masked address, complete/destroy in a third-party system — are not revertible → they carry `allow_send`/`allow_destroy`-style gates ([jmap.md](jmap.md) D4–D6), honestly documented as accident guards, not injection boundaries; the credential scope is the real boundary.

---

## 2. Domain-by-domain calls

### obsidian — decided; one gap to fill, plus a serving-architecture directive (Colin, 2026-07-08)
The hub. Everything in [knowledge-core.md](knowledge-core.md) stands. The only build item this doc adds urgency to: **fill the `obsidian` fn's `write`/`edit`/`delete` ops** (SUX.md's "small gaps"), because every spoke's capture path terminates in these ops, and the task convention (§3) needs `edit` to check a box. On the live-REST path, `edit` = the surgical `PATCH` (heading/block-targeted); on the git path, `edit` = read-modify-commit.

**Serving architecture (decided):** *stateless worker emulation of obsidian; tailscale-served obsidian to tailnet and funnel; wrapper around the bearer token.* Concretely:

1. **Stateless emulation.** The worker `obsidian` fn presents the full op vocabulary (list/read/search/append + the new write/edit/delete) as **stateless one-shot ops** against the Local REST API's plain REST endpoints (`/vault/`, `/search/` — which are stateless), with the same vocabulary emulated over git when the Mac is down. The current `action=tools/call` wrapping of the **stateful** `/mcp/` endpoint (initialize→session-id→initialized per call) becomes a legacy escape hatch, not the path the verbs ride — the emulation makes the worker surface session-free end to end.
2. **Two-tier serving via mcp-gate (PR #27).** Obsidian's Local REST is served both ways the gate already defines: `tailscale serve` (tailnet tier — identity-authed, for local Claude and tailnet devices) and Funnel (public tier — secret-path, for the worker). Consequence: the dedicated Funnel :8443 → Local REST **retires** once obsidian rides the gate, freeing a Funnel slot (2 of 3 free).
3. **Bearer-token wrapper.** The gate holds and injects the Obsidian API bearer token Mac-side. Callers authenticate to the *gate* (tailnet identity, or gate secret on the public tier); the vault's own token never transits the public internet and stops being a worker secret — `OBSIDIAN_REMOTE_KEY` on the worker is replaced by the gate credential. This also unblocks the stubbed `local` backend: tailnet-side sessions hit the serve tier directly with no token juggling.
4. **Git as truth; KV as cache** (Colin, 2026-07-08). Authority order among the vault's representations: the **git history is the single source of truth** — the Local REST surface is the fast live view (its writes become commits via obsidian-git auto-backup; verify the cadence is tight, tighten if not), and **Workers KV is a read-through cache** in front of both for cloud reads. Hot notes and the MOC index serve from KV, validated against the vault's HEAD SHA (`vault:head` key, throttled GitHub HEAD check); fn-side writes invalidate their keys inline. Consequence: Mac-asleep no longer means slow — hot reads come from KV, cold reads from git, and the degrade story becomes freshness (KV/git may trail an uncommitted live edit) rather than availability.

### jmap (email + calendar + contacts) — spec final; covers three of the nine names
[jmap.md](jmap.md) ships as designed: one conduit fn, +1 to the count, no substrate dependency, ships anytime (ROADMAP step 12). **Green-lit by Colin 2026-07-08** — and note it already embodies the stateless-conduit pattern of the obsidian serving directive: one-shot JMAP method calls against `api.fastmail.com`, token as worker secret. No wrapper tier needed because there is no Mac in the loop — the wrapper exists to keep *Mac-local* credentials off the worker; a cloud-native API's token lives on the worker by design. What this doc adds is emphasis: **jmap is not just "email" — it is the calendar and contacts answer too.** Fastmail advertises JMAP calendars/contacts on the same session (feature-detected per jmap.md §16; the current claude.ai Fastmail connector demonstrably drives calendar on this account). So the domains "jmap", "calendar", and the contacts half of "imessages" (resolving a handle to a person) all land on this one fn. No separate calendar spoke is built. Apple Calendar/EventKit via the Mac node is explicitly **not** v1 — revisit only if a non-Fastmail calendar becomes load-bearing.

**And notes (Colin, 2026-07-08): "jmap notes as Apple notes."** Fastmail Notes live server-side and surface in Apple Notes as the Fastmail account's folder on any device where the account is added with Notes enabled. The claude.ai connector already drives full note CRUD (create/read/search/update/delete/append) on this account — the API surface is proven. So the **Apple Notes domain lands on the jmap fn too**: zero new fns, Class A, no Mac in the loop — notes readable and writable from cloud and phone alike, where the local Apple Notes MCP was Class-B-trapped. Role in the system: Fastmail/Apple Notes = the **mobile quick-capture surface** — jot on the phone, and the triage sweep promotes keepers into the vault with provenance. It is an inbox, not a second brain; the vault stays the only knowledge store. jmap.md feature-detection settles the exact mechanism (a first-class notes capability vs. the Notes-mailbox convention) at token time. Setup check: the Fastmail account needs Notes enabled on Colin's Apple devices for the mailbox to equal Apple Notes in practice.

### todoist / tasks — drop the product, keep its lessons
Grounded: Todoist is empty; there is nothing to migrate (ground truth #5). **Decision: no `todoist` fn, ever, unless Colin starts using Todoist again** (if that day comes, it's a Class-A conduit in the jmap mold, not 50 tools). Tasks are a **vault convention plus the six verbs**, per SUX.md's productivity emulation:

- **Format:** plain `- [ ]` checkboxes under `## Tasks`/`## Errands` (knowledge-core §2 locked this; Obsidian Tasks emoji metadata is an optional later enrichment, not core).
- **Where:** today's daily note for day-scoped tasks; `Home.md → ## Next actions` for longer-lived ones (exactly what Home.md already declares).
- **Ops:** add = `append`; list = `search` for `- [ ]` + parse; complete = `edit` (`[ ]`→`[x]`, append `✅ date`). Three store ops, zero new fns.

**Stolen from the Todoist MCP** (the sharpest tool-design lesson in the whole survey): it ships `reschedule-tasks` as a *separate verb* from `update-tasks`, because a naive update rewrites the due string and **destroys recurrence**. Translated to our world: task edits must be **metadata-preserving surgical patches** — the skill edits exactly the checkbox glyph and appends the completion date; it never reprints the line, let alone the note. This is the same rule knowledge-core §4 already states for notes ("never reprint a whole note"), now grounded in a shipped product's scar tissue. Also stolen: batch caps baked into the verb (their 25/call), and `get-overview` as an orientation call — which is exactly our MOC-first ladder step 1.

**Stolen from the productivity plugin's `/update` command:** its four-row reconciliation table (external task found/not-in-file → offer-add; already-matched → skip; in-file/not-external → flag stale; completed-externally → offer-complete) is the contract for the **triage** verb whenever tasks arrive from a spoke (an email that is really a todo, an iMessage "can you..."). Fuzzy title-match, never auto-add without the capture verb's explicit intent.

### imessages — the one genuinely new spoke to build
The only named domain with no existing path. It is Class B by nature (the message store is `~/Library/Messages/chat.db` on this Mac; sending requires local automation) and the obsidian dual-transport pattern maps onto it directly:

- **Mac-node endpoint:** extend the existing aiohttp server (`sux/mac-render/render_server.py`, already Funnel'd at :443) with path-routed `/imessage/*` — no new Funnel slot needed (ground truth #6). Three routes, mirroring the proven minimal surface of the local iMessage MCP (`get_unread` / `read` / `search_contacts` / `send`):
  - `GET /imessage/threads?since=…&contact=…` — query chat.db (read-only SQLite; needs Full Disk Access for the server process, a one-time grant).
  - `GET /imessage/messages?thread=…&limit=…`
  - `POST /imessage/send` — AppleScript/Shortcuts bridge, **gated** (`allow_send`, per the §1 law: an iMessage is unrecallable).
- **Worker fn `imessage`** (+1, → 91): thin conduit to those routes over the Funnel, `cacheable:false` (same PII logic as jmap D1), no body logging (jmap D21 discipline).
- **Local sessions** keep using the local iMessage MCP directly — same "prefer the near surface" rule as the vault.
- **Degrade:** Mac asleep → the spoke is simply down. Unlike the vault there is no git fallback; the skill says so instead of pretending (stolen from the Dropbox connector's "Not Supported — Do Not Advertise" honesty: capability boundaries are stated, not faked).

Verb integration: **capture** an exchange → note with provenance (contact, timestamps, thread id); **retrieve** gains a messages source for "what did X and I decide"; **remember** extracts the durable fact. Contact resolution rides jmap's Contact/query rather than a second address book.

### github — already load-bearing; build nothing
GitHub is not a knowledge domain here; it is **infrastructure the core already stands on**: the vault's sync/undo layer (`colinxs/vault`, git = the safety net), the worker's degraded backend, and retrieval's exact-identifier rung (GitHub code search, ladder §3). Issues/PRs: local Claude has `gh` in full; a cloud `github` conduit fn is deferred until a real recurring cloud need appears (none does today). **Zero new fns.**

### dropbox — R2-like data store, App-folder-scoped (decided 2026-07-08; reverses the earlier defer)
Colin's call: **Dropbox joins as a second blob store in the R2 mold, scoped to the Dropbox App folder.** A `dropbox` fn (+1) shaped like the existing `store` fn — `put`/`get`/`list`/`delete` — operating only inside `/Apps/sux/` via a Dropbox app registered with **App-folder** permission. This is the §1 law's cleanest instance yet: the token *structurally cannot see* anything outside the app folder, so the credential scope is the boundary and Claude is fully unblocked inside it — no gates, no confirm dances, same posture as vault writes (where git is the undo, here the folder is the wall; Dropbox's own version history is the undo).

Division of labor: **R2 = machine-facing** (cache, artifacts, cheap and invisible); **Dropbox app folder = human-facing exchange** — deliverables land in a folder that syncs to every device Colin owns, and anything he drops in becomes visible to capture (a human-writable inbox for scans, PDFs, files-to-file). The vault remains the only knowledge store; both blob stores hold bytes, not facts. The broad claude.ai Dropbox connector stays for the rare whole-Dropbox "find that file"; the sux fn never needs that scope.

**Stolen anyway** (from the Dropbox plugin's skill suite, the cleanest verb-design study in the survey): the **read/write firewall** — read-intent skills that structurally cannot mutate, write-intent skills with plan→confirm→mutate→report contracts and explicit tool allowlists; and **cursor honesty** (never claim completeness before the cursor drains — adopted by jmap's paginate/cursor design already, and binding on any future spoke).

### search / open web — decided; stays outside the store
Per SUX.md: a separate engine, parked corpus and all. The **retrieve** verb may call it as an explicit final rung ("not in the vault or mail — want me to search the web?"), but web results enter the store only via capture/remember with source URLs verbatim (knowledge-core §4 provenance rule). No change.

---

## 3. What the six verbs mean once the spokes exist

The verbs don't multiply per domain — each verb gains *sources*. This is the whole point of hub-and-spoke: N domains × 6 verbs stays 6 verbs.

| Verb | With spokes attached |
|---|---|
| **capture** | from thought (as today) · from email/thread (jmap → note, message-id provenance) · from a quick Apple-Note (= Fastmail Notes mailbox via jmap — the mobile jot surface) · from iMessage exchange · from web page (existing readability/markdown chain) · from a file dropped in the Dropbox app folder (the human-writable inbox). Always → `Inbox/` or today's daily, always with provenance, never polished. |
| **triage** | Inbox items as specced, **plus two standing sweeps** (Colin, 2026-07-08): the **mail inbox** — classify → archive/label (gated per jmap.md) → task-shaped items through the reconciliation contract → capture keepers with message-id provenance; and the **Notes mailbox** — phone-jotted quick captures promoted into the vault. Reconciliation contract (§2-todoist) for task-shaped arrivals from any spoke: offer-add / skip / flag-stale / offer-complete — never silent. |
| **link** | unchanged — spokes produce notes; notes get wired into MOCs. |
| **retrieve** | the ladder gains parallel *sources*, searched concurrently where independent (stolen from enterprise-search: "always execute searches across sources in parallel"): vault (REST search) ∥ mail (Email/query) ∥ messages (imessage) — then whole-item reads, then one synthesis with per-source citations (`[[note#heading]]`, message-id, thread). Also stolen from enterprise-search: an **authority order per query type** — for decisions: vault note > email thread > chat; for logistics/facts-in-flight: mail/messages first. |
| **consolidate** | unchanged (Anthropic Phases 1–3; durable-vs-dated; "drop what's cheap to re-fetch" — and spoke-sourced notes are *exactly* the cheap-to-refetch class, so consolidate prunes them hardest: keep the distilled fact, drop the transcript, the source system still has the original). |
| **remember** | unchanged in mechanics; gains "extracted from a spoke" as the common case, with `originSessionId` + source provenance both recorded. |

**Skill count stays two** (locked decision #2). The spokes are recipes *inside* capture/remember and sources *inside* retrieve — not new skills. The sux router skill gains the `jmap`/`imessage` rows it needs for direct tool routing (the sync ritual, jmap.md §18 step 7). One steal from the productivity plugin applies at the skill-prose level: its `~~category` placeholder indirection ("~~email", "~~messages") — write the verb recipes against the *category*, name the concrete fn in one routing table, so a future backend swap (different mail host, different chat) edits one line, not every recipe.

---

## 4. What was stolen from whom — the ledger

| Source | Lesson taken | Where it landed |
|---|---|---|
| **Todoist MCP** | `reschedule` ≠ `update`: destructive-edit and safe-move deserve different verbs; batch caps in the verb; overview-first | Task ops = surgical patch only (§2); MOC-first ladder already = overview-first |
| **Fastmail MCP** | `draft` vs `send`, `compose_event` staging: reversibility encoded in the verb vocabulary | The §1 law; jmap gates; imessage `send` gate |
| **Dropbox plugin skills** | Intent-scoped skills, read/write firewall, plan→mutate→report, cursor honesty, "Not Supported — Do Not Advertise" | Spoke capability honesty (§2-imessage degrade); any future dropbox fn shape; jmap cursor design (already aligned) |
| **productivity plugin** | Hot cache + `→ pointer` breadcrumbs; decode-on-ingest from real tasks; the 4-row sync reconciliation table; `~~category` indirection | Home.md already is the hot cache; triage contract (§3); skill-prose indirection (§3) |
| **anthropic consolidate-memory** | durable-vs-dated; drop-if-cheap-to-refetch; hard index budgets | Already in knowledge-core §4; sharpened for spoke-sourced notes (§3) |
| **enterprise-search plugin** | Parallel multi-source fan-out; per-query-type authority hierarchy; digest grouped by topic not source | retrieve with spokes (§3) |
| **anthropic schedule skill** | A reified recurring task must carry a fully self-contained prompt (runs cold) | The consolidate cadence + any future digest routine |
| **tieubao/github-mcp-worker, Claudian** (prior memory) | Worker→git-vault precedent; agent-does-retrieval | Already the spine (knowledge-core §1) |

---

## 5. The plan (phased; updated 2026-07-08 after the storage/notes/triage calls)

Knowledge-core's deferred order (capture/remember → consolidate → ladder) survives intact; the spokes and storage semantics slot around it. Phases are dependency-ordered; items inside a phase are independent.

**Phase 0 — store primitive + storage semantics** *(everything composes onto this)*
1. `obsidian` fn: add `write`/`edit`/`delete` as **stateless REST ops** (never the stateful `/mcp/` path), mirrored on the git backend. Git-as-truth discipline: git-backend writes commit directly; REST-path writes ride obsidian-git auto-backup (verify the cadence, tighten if loose).
2. **KV read-through cache** inside the obsidian fn (no new fn — the compress-to-KV algebra already exists): `vault:<path>` entries + a `vault:head` HEAD-SHA validator (throttled GitHub check); fn-side writes invalidate inline. Cloud reads get fast; Mac-asleep reads serve hot from KV before falling to git.

**Phase 1 — the two skills** *(vault-only sources first)*
3. Capture/remember skill: auto-creates today's daily, Inbox convention, provenance rules, task ops (add/list/complete as recipes over append/search/edit — surgical patches only).
4. Consolidate skill (GC pass; prunes spoke-sourced transcripts hardest, per §3).

**Phase 2 — jmap (89→90): email + calendar + contacts + notes**
5. `jmap` fn per [jmap.md](jmap.md), plus the Notes surface (§2): Apple Notes CRUD lands here.
6. Triage recipes: the mail-inbox sweep and the Notes-mailbox sweep (§3), both through the reconciliation contract, keepers captured with provenance.
7. Setup (non-code): Fastmail API token → worker secret; confirm Session capability URNs; confirm Notes is enabled for the Fastmail account on the Apple devices.

**Phase 3 — retrieval ladder v2**
8. Ladder with sources and the cache rung: KV → vault (REST when Mac up / git when not) ∥ mail ∥ notes — parallel where independent, per-query-type authority order, per-source citations.

**Phase 4 — remaining spokes**
9. `imessage`: mac-node `/imessage/*` routes on the existing :443 server → worker fn (90→91), `allow_send` gate at jmap parity.
10. `dropbox`: R2-mold `put`/`get`/`list`/`delete` on `/Apps/sux/` (91→92). Setup: register the Dropbox app with App-folder permission, token → worker secret.

**Phase 5 — gate integration** *(blocked on PR #27 merging)*
11. Obsidian behind mcp-gate: tailnet serve tier + public Funnel tier, bearer wrapper Mac-side, retire Funnel :8443, swap `OBSIDIAN_REMOTE_KEY` for the gate credential, wire the `local` backend.

**One-time chores (any time):** old-vault triage pass (Omnivore keepers → live vault, then archive the directory); amend knowledge-core §5 to the 3-plugin reality.

**Deferred, triggers written down:** `github` cloud fn (trigger: recurring cloud need for issues/PRs), Apple-calendar bridge (trigger: a non-Fastmail calendar matters), Smart Connections (trigger: keyword recall misses at scale — nowhere near 224 notes).

---

## 6. Open items — resolved 2026-07-08

1. **Daily-note habit vs. task home — RESOLVED: (a) revive dailies with auto-create.** The capture verb auto-creates today's daily on first touch (the manual-creation friction is what killed the habit); day tasks live in the daily, `Home.md ## Next actions` keeps only longer-lived ones.
2. **knowledge-core §5 plugin list — RESOLVED by redirection: stay lean; invest in serving, not plugins.** No re-adoption of Smart Connections or the old vault's plugins; ladder step 4 stays dropped until the scale trigger fires. In its place Colin issued the **serving-architecture directive** now specced in §2-obsidian: stateless worker emulation, two-tier tailscale serving via mcp-gate, bearer-token wrapper. Amend knowledge-core §5 to the 3-plugin reality.
3. **Old vault disposal — RESOLVED: triage keepers, then archive.** One pass migrates the worthwhile Omnivore clippings and unique notes into the live vault (with provenance), then the directory moves out of `~/Documents` so two look-alike vaults can't cause a wrong-vault write.
4. **iMessage send gate — RESOLVED: jmap-parity.** `allow_send` boolean on the cloud fn, honestly documented as an accident guard; mobile send stays possible, which is the point of the cloud path.
5. ~~**Fastmail calendars/contacts confirmation.**~~ **Verified 2026-07-08** via the claude.ai connector (JMAP-backed): the account serves 23 calendars (Personal, Family, Bills, a leftover Todoist feed, …) and a populated address book (contact groups imported 2026-07-08). "Calendar and contacts = jmap" is fact. Residual check at token time: the Session object's capability URNs (`…:calendars`/`…:contacts`), per jmap.md §16 feature-detection.
