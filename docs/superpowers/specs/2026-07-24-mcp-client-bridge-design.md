# External-MCP-connector access for sux fns (Design Spec)

**Date:** 2026-07-24
**Scope:** Evaluate whether sux should gain a generic MCP-CLIENT bridge (delegate to
an external, user-authorized MCP server from a sux fn/cron/op-tree) — or whether the
identified capability gaps should instead be hand-rolled as native sux fns, the way
`scrape.ts`/`search.ts` already do for third-party HTTP APIs.
**Status:** Design decision — closes sux#1473 as "not needed — use native fns."
**Relates to:** the vault repo's `05-areas/legal/Legal-Tooling-Coverage-Map-2026-07-24.md`
audit (the motivating case) and its sibling issues (docket-watcher, sux#1475's
emulated-expert-role tier).

## 1. The gap, restated

sux is purely an MCP **server** today (`index.ts`'s `handleRpc`, `registry.ts`'s `Fn`).
Nothing in this codebase acts as an MCP **client** — there is no code that opens a
connection to *another* MCP server, completes its OAuth flow, discovers its tools, and
calls one. An interactive Claude session can reach connectors sux never sees (research
databases, SaaS tools, whatever's wired into claude.ai); sux's own fns/crons/`pipe`/
`batch` chains have no path to any of them.

## 2. Decision: hand-roll, not bridge

**Do not build a generic MCP-client bridge.** Add native sux fns for concrete
capability gaps as they're identified (the docket-watcher sibling issue is exactly
this shape), the same way `scrape.ts`/`search.ts`/`kagi.ts`/`tavily.ts` each hand-roll
one provider's HTTP API today. Reasons, in order of weight:

### 2.1 This repo's stateless-per-request model has no home for connection state

`index.ts`'s `handleRpc` runs every `tools/call` independently — no `Mcp-Session-Id`,
no Durable Object, the only per-request identity signal is the OAuth `login`
(`ctx.props?.login`, threaded via `RequestContext`/`fabric/request-context.ts`, #1456).
A real MCP client needs to hold a session across at least two round-trips per call
(`initialize` → `notifications/initialized` → the actual request) — `obsidian.ts`'s
`obsidianMcp()` already does this for the ONE remote MCP server sux talks to today
(the Obsidian Local REST API's built-in server), and it re-runs the full handshake
**on every single call** because there is nowhere durable to cache a session. That
already costs 2 extra round-trips per call for one fixed, self-hosted, always-on
server. A bridge to N *external*, user-authorized, possibly-rate-limited servers
would pay that tax on every call, times N servers, with no session reuse — and
`obsidian.ts`'s own comment block (see vault-mcp.ts's "Deliberately NOT ours to
re-implement" note) already flags this class of protocol machinery as something this
repo has chosen not to own.

### 2.2 Credential storage has a working precedent, but it's per-domain, not generic

`mychart.ts`'s per-org OAuth grant pattern (`sux:mychart:grant:*` in `OAUTH_KV`, or
#1460's proposed `GRANTS_KV` split) is real prior art for "sux completes an OAuth flow
and durably stores the result." But it's shaped around ONE known API's token/refresh
semantics. A generic bridge would need to store not just a token but each remote
server's **capability surface** (its `tools/list` schemas) and treat schema drift on
the remote end as a new, first-class failure mode this repo has never had to handle —
every existing integration (Fastmail, Dropbox, GitHub, MyChart, ...) has a schema this
repo's own code defines and controls. An external MCP server's schema is out of our
control and can change under us with no deploy on our side to catch it.

### 2.3 The actual motivating gaps don't need a bridge

The legal-research audit that surfaced this issue names CourtListener, Trellis,
Descrybe, Courtroom5. Each is a **specific HTTP API** a hand-rolled fn can reach
exactly like `courtlistener.ts` (hypothetical) would — same shape as the ~15 existing
research-database fns (`arxiv`, `pubmed`, `openalex`, `crossref`, `semantic_scholar`,
`stackexchange`, `reddit`, `zotero`, ...). None of them are described as *requiring*
MCP specifically — MCP is just the transport the user's Claude session happens to use
to reach them today. A native fn is strictly less machinery: no session handshake, no
generic schema-drift handling, no new `Fn` field, and it composes with `pipe`/`batch`/
crons the same way every other fn already does.

### 2.4 What a bridge would cost in `Fn`/`registry.ts`, for the record

Sketched only so a future re-proposal starts from a known shape, NOT because this spec
recommends building it: a `Fn` variant with `mcpServer: {grantKey, discoveryTtl}`
instead of `run`, a `registry.ts` dispatch branch that resolves the grant, runs (or
reuses — impossible today, see §2.1) the handshake, and forwards `tools/call`. The
discovery cache would need the same HEAD-keyed bounded-staleness shape `vault-mcp.ts`'s
`vaultIndex` uses for the vault's own derived index — rebuilt on some signal, degraded
gracefully when stale. This is a real, buildable design; it's just not justified by
the gaps in hand.

## 3. When to revisit

Reopen this if a concrete gap shows up that (a) has **no** usable native HTTP API — a
service that is *only* reachable via an MCP server with no REST/GraphQL surface behind
it — and (b) recurs across enough distinct integrations that the per-integration
hand-roll cost starts to dominate. Neither condition holds for the legal-research set
today: every named connector (CourtListener, Trellis, Descrybe, Courtroom5) sits on
top of a plain HTTP API.

## 4. Disposition

Closes sux#1473 as "not needed — use native fns" per the issue's own acceptance
criterion 4. The follow-up capability-gap issue (docket watcher) stands on its own and
should be scoped as a native fn, not blocked on this decision.
