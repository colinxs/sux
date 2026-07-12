---
title: Vault backends, tasks & citations
status: designed
cluster: namespaces
type: proposal
summary: "Locks four vault backends + git-as-the-sync-bus; adds 3-way task sync (vault-Todoist-JMAP) and citation management on the same store verbs."
tags: [sux, namespaces, designed]
updated: 2026-07-09
---

# Vault backends, task-management, and citation-management

> **Note — connector framing is dated (point-in-time record).** This doc refers to the vault as a separate `/vault/mcp` connector. That per-domain connector was later **retired into the single `/mcp` front door**: the `vault_*` tools now ship as front-door verbs on the one `sux-router` connector (the `/vault/mcp` path still routes for back-compat, but is dormant). Read `/vault/mcp` below as "the vault surface" — the backend, sync-bus, task-sync and citation design are unaffected. Current shape: [[namespace-architecture]] / [[connector-surface-policy]].

Status: proposal / design lock
Scope: the STATEFUL notes namespace served at `/vault/mcp`, its four backend
implementations and sync bus, plus two new vault domains (task-management,
citation-management) that ride the same store verbs.

Grounding: `sux/src/fns/obsidian.ts` (457 lines, 3 backends today), `sux/src/vault-mcp.ts`
(the 9 `vault_*` tools, git-only), `sux/src/index.ts` (routes 345-374),
`sux/src/registry.ts` (Env 43-59), `sux/mcp-gate/README.md`, `docs/proposals/vpc-hosting.md`,
`docs/proposals/domains.md`. Every claim below traces to that reality.

---

## 0. The one rule that shapes every verb — references, not payloads (LOCKED)

Every vault verb passes **handles**, never bytes:

- A verb that **finds / lists** returns HANDLES + light metadata — vault paths
  (`Daily/2026-07-09.md`), git blob shas, note titles, task-ids, DOIs, message-ids,
  calendar-event-ids — **never** the note body, PDF bytes, or full email. Bodies
  transit context only when a caller explicitly reads exactly ONE.
- A verb that **stores / transforms** ACCEPTS a handle and does the fetch / move /
  write **server-side** (Worker-side, or on the live box), so large data never enters
  the model context. `vault_capture` already embodies this: it takes a `url`/`query`
  and `ingest` fetches + compresses + writes server-side; the model never sees the page.
- Every list-producing verb has a **BATCH** form that takes a *list* of handles and
  fans out server-side in one call — extending the existing `batch` / `batch_fetch`
  fns. This is what lets a skill do 100 items in a few calls with zero bytes in context.

Per-verb handle/batch behavior is called out inline throughout this doc. This rule is
non-negotiable and predates the backend work.

---

# PART 1 — Four backend implementations + the sync bus

## 1.1 The four implementations

The `obsidian` fn dispatches on `backend`. Today it has `git` (default, live),
`remote` (live Funnel), and `local` (unwired stub). This proposal locks the target set
of **four** implementations and refactors the enum accordingly.

### Impl 1 — Stateless Worker → git (GitHub API, cloud, no box)

- **Transport:** GitHub REST (contents / trees / search-code) from the Worker.
- **Store:** `colinxs/vault` git repo @ `main`. Truth = git; read-through KV cache
  (`OAUTH_KV`) keyed `cache:vault:git:{repo}@{branch}:…`, validated against HEAD sha
  (rechecked ≤1×/60s, trusted ≤10min on ref-fetch failure).
- **Latency:** GitHub API round-trips (~100-400ms), cache hits sub-10ms.
- **Availability:** always-on, no box, no LAN. The correctness floor of the system.
- **Egress:** public (api.github.com), Worker-native, no residential proxy, no SSRF risk.
- **Cannot:** full-text search a **private** repo — `search/code` is dead on private
  repos. No Dataview / DQL. No live commands.
- **Selected when:** no live box is reachable — the universal fallback. This is what
  `/vault/mcp` runs **today** (every `vault_*` tool forces `backend:"git"`).

### Impl 2 — Worker → VPC → HEADLESS OBSIDIAN (PRIMARY cloud impl)

- **What it is:** an always-on VPC node runs Obsidian **headless** (KasmVNC
  `sytone/obsidian-remote`) with the Local REST API over a **node-local clone** of the
  vault. The Worker hits a **LIVE vault** across the private Workers-VPC link. This is a
  live node-local vault kept in sync by git — **not** a git backend. (Any earlier framing
  of impl 2 as "worker→vpc→git" is SUPERSEDED.)
- **Transport:** Workers VPC (beta, free). `cloudflared` on the box (outbound-only)
  reaches `127.0.0.1:27124`; registered as a VPC Service; bound as
  `vpc_services:[{binding:"OBSIDIAN_HOME"},{binding:"OBSIDIAN_CLOUD"}]`; called via
  `env.OBSIDIAN_HOME.fetch(...)`. Strictly better than Funnel: no public hostname,
  built-in SSRF pinning, no 3-port ceiling. Bearer still rides as
  `Authorization: Bearer` (per-box `OBSIDIAN_HOME_KEY` / `OBSIDIAN_CLOUD_KEY`).
- **Store:** node-local vault clone; git `colinxs/vault` stays source of truth;
  obsidian-git commits/pulls on the box; Obsidian Sync added for device convergence.
- **Latency:** low, cloud-side (Worker↔VPC intra-CF), full server-side search + DQL.
- **Availability:** ALWAYS-ON (that is the whole point) — home box primary (x86_64),
  Hetzner CX22 failover (pull/mirror-only).
- **Egress:** private (VPC), never public. Obsidian never gets a public hostname.
- **Can:** everything — read/list/write/append/edit/delete **plus** live full-text
  `search`, Dataview DQL, and `tools`/`call` against the plugin's stateful `/mcp/`.
- **Selected when:** the cloud path needs live-vault ops (search/DQL) and no on-tailnet
  desktop box is present — i.e. the always-on cloud default once built.

### Impl 3 — Local Obsidian over TAILSCALE (Local REST API, live, full ops)

- **What it is:** the Mac's live Obsidian + Local REST API, reached over **Tailscale**
  (Mac tailnet IP / MagicDNS), **not** localhost-bound and **not** Funnel-bound.
  Tailscale answers loopback, so this path works from ANY tailnet session **including the
  same node**. This unifies today's remote(Funnel `:8443`) + local(localhost) into one
  tailnet path (mcp-gate tailnet tier), retiring the public Funnel.
- **Transport:** Tailscale to the Mac's tailnet IP; via mcp-gate tailnet tier
  (`tailscale serve :9443` → `127.0.0.1:27126`, identity via `Tailscale-User-Login`,
  enforced against `ALLOW_LOGINS`) so tailnet devices carry zero client secrets.
- **Store:** the Mac's live vault (81 dailies today), obsidian-git committing to
  `colinxs/vault`.
- **Latency:** LAN/tailnet fast when the Mac is awake; unavailable when asleep.
- **Availability:** desktop-only, best-effort (Mac sleeps).
- **Egress:** private (tailnet).
- **Can:** everything live — search + DQL + commands.
- **Selected when:** a tailnet desktop session with the Mac up — the interactive desktop
  default (mcp-gate → 3).

### Impl 4 — Local git (filesystem clone, direct)

- **Transport:** direct filesystem access to a local clone (no network).
- **Store:** the on-disk `colinxs/vault` working copy.
- **Latency:** instant (local FS).
- **Availability:** wherever the clone lives (desktop/dev box).
- **Egress:** none.
- **Cannot:** full-text search a private repo without an index (same limit as impl 1);
  no DQL, no live commands.
- **Selected when:** offline / scripted desktop use, or as the desktop fallback when the
  local Obsidian process is down but the clone is present (mcp-gate → 4).

## 1.2 Op-parity matrix (honest)

Rows = operations; cols = the four impls. ✅ full, ⚠️ works but degraded/no-index, ✖ not possible.

| op | 1 · git (GitHub) | 2 · vpc-live (headless Obsidian) | 3 · obsidian (Mac, Tailscale) | 4 · local-git (clone) |
|---|---|---|---|---|
| **read** | ✅ contents API, KV read-through, >1MB raw refetch | ✅ `GET /vault/{p}` live, KV fallback | ✅ live over tailnet | ✅ FS read |
| **list** | ✅ trees API `?recursive=1`, `.md` by folder, KV vs HEAD | ✅ `GET /vault/{dir}/` live | ✅ live over tailnet | ✅ FS walk |
| **write** | ✅ `vaultPut` commit, warms cache | ✅ `PUT /vault/{p}` write-through | ✅ live | ✅ FS write (+ commit) |
| **append** | ✅ read-modify-commit, body-preserving | ✅ `POST /vault/{p}` server-side merge | ✅ live | ✅ FS append (+ commit) |
| **edit** | ✅ read→`applyEdit` unique-match→commit | ✅ read→`applyEdit`→`PUT` | ✅ live | ✅ FS surgical patch |
| **delete** | ✅ contents DELETE (needs sha) | ✅ `DELETE /vault/{p}` | ✅ live | ✅ FS unlink (+ commit) |
| **search** | ✖ code-search dead on private repo | ✅ **live full-text `POST /search/simple/`** | ✅ **live full-text** | ⚠️ FS grep only, no ranking/DQL |
| **daily** | ✅ read/append `Daily/{today}.md` | ✅ same, live | ✅ same, live | ✅ same, FS |
| **commands (DQL / tools / call)** | ✖ | ✅ **Dataview DQL + stateful `/mcp/` tools/call** | ✅ **DQL + tools/call** | ✖ |

**The honest split:** the **two live-Obsidian impls (2 vpc, 3 Mac) have search + DQL**;
the **two git impls (1 GitHub, 4 clone) cannot full-text search a private repo** (code-search
is dead on private repos; a clone can only grep). Therefore **cloud full-text search =
impl 2, always-on**. Until impl 2 ships, `/vault/mcp` (git only) has **no cloud search** —
this is the accepted v1 gap (Colin, 2026-07-08): full-text search waits for tier-2 vpc;
desktop keeps live-vault search via mcp-gate → impl 3 meanwhile.

### Per-op handle / batch contract (cross-cutting rule)

| op | returns / accepts | batch form |
|---|---|---|
| list | returns **paths + sha/mtime**, never bodies | `list` is already a fan-in of the tree; one call returns N handles |
| read | returns ONE body only when explicitly asked | `batch_fetch` of N paths → N bodies fetched server-side, packed/compressed |
| search | returns **path + line-hit snippets**, never full notes | one query → N handles server-side |
| write/append/edit/delete | accept a **path (+ patch)**, do the write server-side | `batch` of N ops fans out server-side, one call, zero bodies in context |
| capture | accepts a **url/query handle**; `ingest` fetches+writes server-side | `batch` of N urls → N notes, server-side |

## 1.3 Dispatch selector + precedence

The `obsidian` fn resolves an **effective backend** before dispatching the action. Two
resolution contexts:

**Cloud (the Worker / `/vault/mcp`):**
```
if env.OBSIDIAN_HOME bound and healthy      -> 2 (vpc-live, home)
elif env.OBSIDIAN_CLOUD bound and healthy   -> 2 (vpc-live, cloud failover)
else                                        -> 1 (git)          # always-on floor
# read degrade ladder inside 2: home VPC -> cloud VPC -> KV cache -> git
```

**Desktop (mcp-gate):**
```
if on-tailnet and Mac Obsidian up           -> 3 (live, tailnet)
elif local clone present                    -> 4 (local-git)
else (off-tailnet)                          -> hit /vault/mcp -> cloud selector above
```

**Global precedence (Colin LOCKED):**
`on-tailnet-box-up → 3 / 4` · `cloud-VPC-up → 2` · `fallback → 1`.
Impl 1 is the correctness floor nobody can knock out; impl 2 is the always-on cloud
default; impl 3/4 win when a tailnet desktop is present because they are lower-latency
and offer live search/DQL locally.

## 1.4 Consumer mapping

| Consumer | Today | Upgrades to |
|---|---|---|
| `/vault/mcp` cloud connector (claude.ai / mobile / desktop, one OAuth flow) | impl 1 (git-only) | **impl 2** (vpc-live) once built; git stays the fallback under it |
| Desktop mcp-gate (local Claude Code / tailnet devices) | Funnel `:8443` remote + localhost | **impl 3 / 4** over the tailnet tier; public Funnel retired |
| claude.ai custom connector via mcp-gate public tier | Funnel `:10000` capability-URL | unchanged (capability-by-URL; git-backed undo justifies it) |

## 1.5 `obsidian.ts` refactor — the backend enum

Replace the `git | remote | local` triple with a **four-value enum** and enforce it
(today action+backend are hand-normalized with no server-side enum check):

| new backend | dispatches to | replaces |
|---|---|---|
| `git` | GitHub API + KV read-through (unchanged) | `git` |
| `vpc` (a.k.a. vpc-live) | `env.OBSIDIAN_HOME.fetch` then `OBSIDIAN_CLOUD.fetch`; same `/vault/`, `/search/`, `/mcp/` handling + bearer + KV cache as `remote`, only transport swaps | **`remote` (cloud-live)** |
| `obsidian` (live) | Local REST API over Tailscale (mcp-gate tailnet tier) | the *live-ops* half of `remote` + the `local` stub's intent |
| `local-git` | filesystem clone, direct | the *filesystem* half of `local` |

Key moves:
- **`remote` is REPLACED**: its cloud-live role → **`vpc`** (impl 2); its live-ops role →
  **`obsidian`** (impl 3). `OBSIDIAN_REMOTE_URL` is retired and Funnel `:8443` freed;
  **keep the bearer** re-homed as `OBSIDIAN_HOME_KEY` (deleting it 401s every call).
- **`vpc` becomes the default when its binding exists** (`env.OBSIDIAN_HOME` bound),
  else `git`. This makes cloud search/DQL light up automatically at cutover with one
  code change (a `remote`-peer that only swaps transport).
- **`local` stub is retired**: the "isn't wired yet" fail is deleted; `obsidian` (tailnet)
  and `local-git` (clone) cover its cases. The Worker still can't reach LAN, so the
  live-local path is desktop-only via mcp-gate — never from the Worker.
- Enforce the enum server-side (reject unknown backends) instead of hand-normalizing.
- `vault-mcp.ts`: the `const git = (args)=>({...args, backend:"git"})` pin becomes a
  **selector** that resolves `vpc` when `OBSIDIAN_HOME` is bound, else `git` — so the
  9 `vault_*` tools inherit live cloud search/DQL for free at cutover. `vault_delete`
  keeps `confirm:true`; `vault_capture` keeps its `url/text/query/title/tags/summarize/compress`
  allowlist; path guards (`badVaultPath`: no `..`, no dot-prefixed segments) stay on all
  write ops.

## 1.6 Sync topology — git is the BUS (Colin LOCKED)

**git (`colinxs/vault`) = single authoritative source of truth + undo.** Three engines
coexist on the vault, with strict roles so we never run three bidirectional writers on
one folder:

- **(a) obsidian-git — the ONLY realtime writers, one per live node.** Each live node
  (impl 2 VPC box, impl 3 Mac) runs obsidian-git to commit + pull. **Write-master rule:**
  the home VPC box is the sole interactive-write master; **the moment the box's
  obsidian-git goes live, demote the Mac's to Sync-only** (two auto-committers + Sync =
  conflict files). At most one obsidian-git auto-committer active per node, one node
  authoritative at a time.
- **(b) Obsidian Sync — COEXISTS but MOBILE-only, not authoritative.** Built to coexist
  with obsidian-git; carries device convergence for mobile, never the source of truth.
- **(c) Dropbox — MIRRORS git ONE-WAY (git → Dropbox), never bidirectional.** Dropbox
  never writes into the vault dir. The Files MCP owns Dropbox as **blobs** and must NOT
  co-own the vault dir. (This is also why citation PDFs live in Files/Dropbox, not the vault —
  §3.)

**Convergence window.** A write on any live node lands in git on the next obsidian-git
commit tick (seconds to a couple minutes depending on the auto-commit interval); other
nodes pull on their own tick. So a **VPC-node write reaches the Mac via git**: box commits
→ Mac's obsidian-git pulls → Mac vault updates. Steady-state convergence is one
commit-interval + one pull-interval (target: well under a couple minutes). There is no
node-to-node path — everything rides the git bus.

**KV cache invalidation.** On any `vault_write` / `vault_append` / `vault_edit` /
`vault_delete`:
- git backend writes warm the cache inline (the contents API returns the new commit sha =
  new HEAD), and never feed writes (edit/append always re-read source — no CAS, accepted
  single-user).
- vpc/live backends delete the note's KV key on append and write-through on write/edit
  (as `remote` does today), keeping the separate `cache:vault:remote:note:…` namespace so
  a lagging git mirror can never clobber the fresher live copy.
- The HEAD recheck (≤1×/60s, ≤10min stale trust) bounds how long a *foreign* write (made
  on another node, arriving via git) stays invisible to the git backend's cache.

**Rare merge-conflict handling.** With one write-master the common case is conflict-free.
When a genuine concurrent edit collides, obsidian-git writes **conflict files** rather than
silently losing data; resolution is a human/agent `edit` picking the winner and deleting
the conflict marker file. git history is the undo — any bad converge is `git revert`-able.

---

# PART 2 — Task management (3-way sync: vault ⇄ Todoist ⇄ Fastmail/JMAP calendar)

**Colin LOCKED:** full 3-way sync between the **vault** (canonical checkbox + context —
the HUB), **Todoist** (task semantics: inbox / projects / priorities), and the
**Fastmail calendar** (the time-block event — NOT Google Calendar). Colin is
**RESUMING Todoist** (domains.md previously said *no* Todoist; that is now reversed).

> **Shipped correction (2026-07-11):** the calendar leg is **CalDAV, not JMAP**. Fastmail
> advertises no JMAP calendars capability, so the shipped calendar/tasks surface is a
> CalDAV subsystem (`sux/src/fns/_caldav.ts` + `cal_*`/`task_*` verbs in `mail-mcp.ts`,
> app-password gated), not `CalendarEvent/set` over `jmap`. This design's calendar leg must
> ride `cal_create`/`task_create` (VEVENT/VTODO), not a JMAP `CalendarEvent`.

## 2.1 Model — a converging replica set (no single writer)

An edit can originate in **any** of the three parties and must converge. There is no
single writer. The vault is the **tie-break hub**, not the sole author.

The three legs:
- **vault** — the canonical `- [ ]` checkbox + surrounding note context. Add = `append`,
  list = `search` for `- [ ]` + parse, complete = surgical `edit` (`[ ]`→`[x]`, append
  `✅ {date}`). Edits are **metadata-preserving surgical patches** — never reprint the
  line (the Todoist `reschedule` ≠ `update` scar); `applyEdit`'s unique-match already
  enforces this.
- **Todoist** — task semantics (inbox / projects / priorities / labels / due). Owns the
  task lifecycle vocabulary.
- **Fastmail JMAP calendar** — the **time-block CalendarEvent**. This leg is **already in
  scope**: JMAP covers Email + Calendar + Contacts, so the calendar rides the JMAP verbs
  the mail namespace already exposes. **The only new external integration is a Todoist
  adapter.**

### JMAP: events, not tasks

JMAP standardizes **JSCalendar**, which has both `Event` and `Task` (JSTask) object types —
**but Fastmail's JMAP calendar surface exposes CalendarEvents, not user-facing JSTasks.**
So we design accordingly: **the calendar leg is a time-block EVENT** (`create_event` /
`update_event` / `delete_event` / `search_events`), and **Todoist owns task semantics.**
We do not try to model tasks in JMAP. A vault checkbox that has a scheduled time projects
into (i) a Todoist task and (ii) a JMAP CalendarEvent time-block; a checkbox with no time
projects only into Todoist.

## 2.2 The 3-way id-map

A durable mapping row per task, stored **server-side** (KV: `task:map:{vault_task_id}`,
plus reverse indexes `task:byToDoist:{id}` and `task:byEvent:{id}`), never in context:

```
vault_task_id  <->  todoist_task_id  <->  jmap_calendarevent_id
```

- `vault_task_id` = a stable id minted on the checkbox line as an inline tag, e.g.
  `- [ ] Draft memo ^t-ab12cd` (Obsidian block-id `^t-…`) — survives surgical edits,
  found by `search`.
- The map row also holds: per-leg `mtime`, per-leg last-synced hash, `origin` tag (below),
  home-note path + block-id, and the field projection state.

Handle discipline: the reconciler passes **ids** between legs, never task bodies. Listing
tasks returns `{vault_task_id, todoist_task_id, event_id, path, due, status}` handles;
bodies/notes are read only on explicit drill-in.

## 2.3 Echo suppression / change-origin tags

Every write a sync makes is stamped so it cannot ricochet:
- Each map row carries an `origin` + a monotonically bumped `sync_epoch`. When the
  reconciler writes leg B to match leg A, it records the resulting B-side mtime/hash as
  **sync-authored** in the map.
- On the next poll, if leg B's current hash == the recorded sync-authored hash, the change
  is **ours** → ignored (no re-propagation). Only a hash that differs from *both* the last
  user-hash and the last sync-hash is a genuine user edit.
- Todoist writes are tagged with a hidden label/comment marker (`sux-sync`) as a
  belt-and-suspenders origin signal; JMAP events carry a `sux:origin` property in a
  custom field; vault lines carry no visible marker (the block-id + map hash suffice).

This is the standard converging-replica loop-breaker: **compare-against-last-written-hash
before propagating.**

## 2.4 Conflict rule

**Last-writer-wins by mtime, field-level where clean, vault as tie-break hub.**
- Reconcile **per field** (status, due/scheduled time, title, priority, project), not
  per whole-task, so two clean edits to different fields both survive.
- When the *same* field diverges across legs, the **latest mtime wins**.
- On an exact mtime tie (or unresolvable clock skew), **the vault wins** — it is the
  canonical hub.
- Completion is monotone-biased: a `complete` in any leg propagates to all; an
  `uncomplete` only wins if it is strictly newer than the completing edit.

## 2.5 Field projection — which fields map where

| Vault checkbox | Todoist task | JMAP CalendarEvent |
|---|---|---|
| `- [ ] text ^t-id` | task content | event title |
| note path + heading context | project (mapped from note/heading) | — |
| `⏳`/scheduled date (`📅 YYYY-MM-DD`) | `due` | event `start` date |
| **scheduled TIME** (e.g. `@14:00–15:00`) | `due` w/ time | **time-block `start`/`duration`** |
| priority marker (`🔺`/`⏫`/`🔼`) | `priority` (p1–p4) | (none) |
| `#tag` | label | — |
| `[x]` + `✅ {date}` | completed | **block cleared** (event deleted/marked done) |

Locked behaviors:
- **A vault checkbox with a scheduled time → a Todoist task AND a JMAP CalendarEvent
  time-block.**
- **Completing in Todoist checks the vault box AND clears the calendar block** (deletes
  the time-block event; the vault line gets `[x]` + `✅ {date}`).
- A checkbox **without** a time → Todoist task only (no event).

## 2.6 The Todoist adapter — a sux `todoist` fn (decision)

**Decision: add a sux `todoist` fn** (a thin adapter over the Todoist REST/Sync API in the
Worker), **not** the environment Todoist connector, for the sync engine. Rationale:
- The environment Todoist connector (`mcp__8afe831a…`, ~50 tools) is **model-facing and
  interactive** — it cannot run the unattended server-side reconciliation loop, cannot hold
  the token in the Worker, and would pull task bodies into context (violating the
  references-not-payloads rule). Keep it available for interactive human use, but the
  **sync loop uses the sux fn.**
- A sux `todoist` fn keeps the adapter server-side, secret-scoped, batchable, and
  cron-drivable — matching every other sux external integration. This is the **only new
  external integration** the whole 3-way needs (the calendar leg rides existing JMAP verbs).
- **Token/secret handling:** `TODOIST_TOKEN` as a Worker secret (Todoist personal API
  token), wired in `registry.ts` alongside the vault env vars; never leaves the Worker;
  re-read per request. Mirrors mcp-gate's bearer-per-request rotation posture.

`todoist` fn surface (handle-first, batchable): `list` (returns id-handles + light meta),
`add`, `update` (surgical field patch), `complete`, `reschedule`, `delete` — each with a
`batch` form taking a list of ids. `reschedule` is kept **distinct** from `update`
(remember the scar: reschedule must not reprint/rebuild the task).

**The reconciler** is a separate server-side verb (`task_sync`) run on a **cron**
(scheduled Worker / scheduled agent), not in any model turn. It: polls the three legs for
changes since last epoch → applies §2.3 echo-suppression → resolves per §2.4 → projects
per §2.5 → writes back with origin stamps → updates the id-map. It fans out server-side
(batch across all three adapters), so a 100-task reconcile is a handful of batched calls
with zero task bodies in context.

## 2.7 Frontmatter / format, cadence, propagation

- **Task format:** plain Obsidian-Tasks-style checkboxes, `- [ ] text 📅 YYYY-MM-DD
  🔺 #tag ^t-id`. No per-line frontmatter; the block-id `^t-id` is the only added marker.
  Home-note frontmatter may carry `tasks: synced` to opt a note into reconciliation.
- **Task-home resolution (reconciled with domains.md §6):** day tasks live as `- [ ]` under
  `## Tasks` / `## Errands` in **today's daily** (`Daily/{today}.md`, `DAILY_DIR="Daily"`,
  capitalized — the live vault has 81 dailies); longer-lived tasks under
  `Home.md → ## Next actions`. **Revive dailies with auto-create:** `vault_capture` and
  `vault_daily_append` **auto-create today's daily** if missing (the habit stalled
  2026-04-19; auto-create is the fix). `vault_daily_append` is the quick-capture surface
  that also becomes a task-add.
- **Reconciliation cadence:** cron every ~5 min for the interactive window, plus an
  on-write hook (a `vault_edit` that flips a checkbox enqueues an immediate reconcile for
  that one id so completion feels instant). Full sweep hourly to catch drift.
- **Delete / complete propagation:** complete in any leg → `[x]` + `✅ {date}` in vault,
  completed in Todoist, time-block event cleared. Delete in any leg → tombstone in the
  id-map (so it doesn't resurrect from a lagging leg), remove from the other two, leave the
  vault line struck/removed per user preference. Tombstones expire after one full
  convergence window.

## 2.8 Reconciliation with domains.md

- **Revive dailies** — yes, auto-create on capture (above).
- **Capture auto-creates the daily** — yes.
- **Previously NO Todoist → now RESUMING Todoist** — this section supersedes domains.md's
  "no todoist fn / tasks are pure vault convention". The **vault side stays convention +
  store verbs** (no vault-side fn), and we add exactly **one** new external fn (`todoist`)
  + one reconciler verb (`task_sync`). The calendar leg is free (existing JMAP verbs).
- The surgical-patch lesson (edits as unique-match patches, never reprint the line) is
  retained and now also governs the Todoist adapter's `update`/`reschedule` split.

---

# PART 3 — Citation management

Academic references become **vault notes** (markdown), fed by the existing sux scholarly
fns, with the **PDF stored in Files (Dropbox) as a blob** and linked from the note. The
vault/files boundary is strict: **the citation NOTE lives in the vault; the PDF blob lives
in Files** (matching §1.6(c) — Files MCP owns Dropbox blobs, never the vault dir).

## 3.1 Citation note schema

One note per reference, typed frontmatter, cite-key alias:

```markdown
---
type: citation
aliases: [smith2023attention]      # cite key = the note's primary alias
title: "Attention Is All You Need"
authors: ["Vaswani, A.", "Shazeer, N.", "..."]
year: 2017
venue: "NeurIPS"
doi: 10.5555/3295222.3295349
url: https://arxiv.org/abs/1706.03762
source: arxiv                       # which scholarly fn produced it
source_id: "1706.03762"             # arxiv id / PMID / OpenAlex id / S2 id
pdf: "dropbox:/Papers/smith2023attention.pdf"   # HANDLE into Files, not bytes
tags: [transformers, attention, nlp]
added: 2026-07-09
---

# Attention Is All You Need

> One-line abstract / why-it-matters (from `summarize`).

## Notes
- ...

## Cited by / cites
- [[some-other-citation]]
```

- **`aliases` = cite key** so `[[smith2023attention]]` resolves and BibTeX keys round-trip.
- **`pdf` is a Files handle** (`dropbox:/Papers/…`), never embedded bytes — the note stays
  small and greppable; the blob lives in Files.
- Notes live under `References/` (e.g. `References/smith2023attention.md`).

## 3.2 References / Bibliography MOC

`References/Bibliography.md` is a Map-of-Content that indexes citations by a live query
(Dataview on the live-Obsidian impls 2/3; a generated list on git impls 1/4):

```dataview
TABLE year, venue, doi FROM "References" WHERE type = "citation" SORT year DESC
```

On git-only backends (no DQL) the MOC is regenerated by a server-side sweep that `list`s
`References/`, reads frontmatter, and rewrites the table — server-side, handle-first, so
the model never ingests every note. Sub-MOCs by tag/topic link from here.

## 3.3 BibTeX / CSL export

A server-side export verb walks `References/` frontmatter (handles, batched) and emits
**BibTeX** (`.bib`) and **CSL-JSON** — no note bodies in context, just the typed
frontmatter fields → citation records. Output is written to Files (a `.bib` blob) with a
link back, or returned as a compact record set. Cite keys = the `aliases` field.

## 3.4 Capture flow (references, not payloads)

```
1. sux scholarly search  (arxiv | pubmed | crossref | semantic_scholar | openalex |
   clinical_trials)  -> returns HANDLES: {doi, source_id, title, url, pdf_url} + light meta
   (never the paper text).
2. For a chosen handle:
   a. metadata -> build the type:citation note frontmatter (authors/year/venue/doi/…).
   b. PDF -> `ingest`/Files fetches the pdf_url SERVER-SIDE and stores the blob in
      Dropbox (`dropbox:/Papers/{citekey}.pdf`). The bytes never transit context.
   c. `vault_write` the citation note under `References/{citekey}.md` with `pdf:` = the
      Dropbox handle and a `[[Bibliography]]` backlink.
3. Batch form: a LIST of scholarly handles -> N citation notes + N PDFs, fanned out
   server-side in one call (extends `batch`/`batch_fetch`), zero bytes in context.
```

This mirrors `vault_capture`'s existing discipline (`ingest` fetches + compresses +
writes server-side from a `url`/`query` handle) — the citation flow is that pattern
pointed at scholarly handles.

## 3.5 How the oracle cites them

`oracle` (and any retrieval skill) cites by **handle**: it `search`es / reads the
`References/` MOC, pulls the cite key (`aliases`) + doi/url from frontmatter, and emits
`[[citekey]]` wikilinks or formatted references — **without** loading PDF bytes. When a
claim needs the full paper, it reads exactly ONE note and, only if required, fetches the
ONE PDF via its Files handle (OCR/extract server-side). Retrieval is **MOC-first**
(frontmatter + Bibliography index), not embeddings — the note *is* the compressed,
citeable surface; the PDF stays a blob behind a handle.

## 3.6 vault / files boundary (restated)

- **vault** (markdown, git-backed, this doc's four backends): the citation **note** — small,
  typed, greppable, versioned, the undo-able source of truth.
- **files** (Dropbox blobs, Files MCP): the **PDF** — heavy, opaque, never in the vault dir,
  linked only by handle. Dropbox mirrors git one-way and owns blobs; it never co-owns the
  vault. This keeps the vault light and the reference/payload rule intact end to end.

---

## Appendix — build order (aligns with vpc-hosting.md phases A–E)

- **A** — tier-1 git store + `/vault/mcp` connector (git-only). *(done-ish)*
- **B** — stand up the home VPC box (headless Obsidian + Local REST + obsidian-git);
  demote Mac obsidian-git to Sync-only when the box goes live.
- **C** — add the `vpc` backend (a `remote`-peer, transport-swap only), make it default
  when `OBSIDIAN_HOME` is bound; retire `OBSIDIAN_REMOTE_URL` + Funnel `:8443`, re-home
  bearer as `OBSIDIAN_HOME_KEY`. Refactor the enum to `git | vpc | obsidian | local-git`;
  drop the `local` stub; light up cloud search/DQL.
- **C′ (parallel)** — mcp-gate tailnet tier becomes the desktop path to impl 3/4; retire the
  public desktop Funnel.
- **D** — `/vault/mcp` gains the stateless reverse-proxy connector into the box `/mcp/` over
  `env.OBSIDIAN_HOME` (Obsidian never public).
- **E** — cloud failover (Hetzner CX22) + task-management (`todoist` fn + `task_sync` cron +
  id-map) + citation-management (`References/` schema, MOC, BibTeX/CSL export, capture flow).

## Related

- [[vault-backends-matrix]]
- [[vpc-hosting]]
- [[vault-stack]]
- [[handle-discipline]]
- [[Namespaces-MOC]]
