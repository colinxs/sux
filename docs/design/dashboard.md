---
title: WAN dashboard — metrics + notes behind Cloudflare Access
status: shipped (app code) / pending (Access policy)
cluster: infrastructure
type: design
summary: "A read-only single-page dashboard on the sux Worker (metrics snapshot + recent vault notes), meant to be gated by a Cloudflare Access self-hosted application. The app-side route is shipped; the actual Access application/policy is a manual Cloudflare dashboard/API step, not done by this change."
tags: [sux, infrastructure, dashboard, observability, cloudflare-access]
updated: 2026-07-14
related: ["[[observability-grafana]]", "[[keys]]"]
---

# WAN dashboard — metrics + notes behind Cloudflare Access

Implements GitHub issue #359: a single-page dashboard for sux, reachable from the
WAN, gated by Cloudflare Access — not a custom auth system.

## What shipped (app code)

- `sux/src/dashboard.ts` — three GET routes, served **before** the OAuth provider
  claims every path (same pre-gate trick `/health`/`/metrics`/`/logs` already use
  in `sux/src/observability.ts`):
  - `GET /dashboard` — static HTML shell, vanilla JS, no framework.
  - `GET /dashboard/api/metrics` — JSON snapshot built from `metrics.ts`
    (`readMetrics`/`deriveMetrics`/`sloReport`) — the exact same aggregate
    `GET /metrics` already exposes, just trimmed to what's worth a glance
    (totals, error/cache rates, p50/p95 latency, SLO breaches, top 10 tools by
    call volume). No new metrics pipeline.
  - `GET /dashboard/api/notes` — recent notes from the `Daily/` and `Inbox/`
    vault folders (sux's own write targets), read through the existing git
    vault path in `sux/src/fns/obsidian.ts` (`obsidian.run({action:'list'|'read',
    backend:'git'})` — the same call `vault_list`/`vault_read` make). No new
    content store. Recency is derived from the date-prefixed filenames
    (`Daily/<date>.md`, `Inbox/<date> <slug>.md`) via a basename sort, not a
    GitHub commit-log call.
- Wired into `sux/src/index.ts`'s `fetch()` right after `handleObservability`,
  same position/contract (returns `null` for paths it doesn't own, falls through
  to OAuth otherwise).
- Defense in depth: the API routes (not the HTML shell) reuse the existing
  `OBS_RATE_LIMITER` per-IP backpressure (`obsRateLimited`, now exported from
  `observability.ts`) — Access is the real gate, this just bounds a slow burst
  from driving KV/GitHub spend.
- **Fail-closed Access verification, in code** (`sux/src/access-jwt.ts`): every
  `/dashboard*` request now must carry a valid `Cf-Access-Jwt-Assertion` header —
  verified server-side (RS256 signature against the team's published JWKS, plus
  `aud`/`exp`/`nbf` checks) before any response is built. Added after a security
  review correctly flagged the original version as failing **open**: it relied
  entirely on the Access application existing and being correctly bound to the
  live route, with nothing in the code itself blocking a request that reached the
  Worker some other way (direct `workers.dev` origin, a misconfigured/removed
  Access app, etc.). This closes that gap — the route now blocks by default and
  only opens for a request Access has actually vouched for.

## Auth model: Cloudflare Access (edge) + JWT verification (app, defense in depth)

Per the issue's direction, this route still carries no session/bearer-token auth
of its own — no login form, no app-managed credentials. The GitHub-OAuth gate in
`sux/src/github-handler.ts`/`index.ts`'s `rtServer` is scoped to MCP JSON-RPC
(`CONNECTOR_PATHS`) and is the wrong shape for a browser page anyway, so
`/dashboard*` is served pre-gate, exactly like `/metrics`/`/logs`/`/health`.

The intended mechanism is a **Cloudflare Zero Trust Access self-hosted
application**, scoped to this Worker's public hostname + the `/dashboard*` path.
Access intercepts the request at Cloudflare's edge **before it ever reaches the
Worker** — an unauthenticated browser gets Access's login challenge, never a 200
from this code. This is the same pattern already documented (but not yet wired to
a live route) elsewhere in this repo:

- `docs/proposals/vpc-hosting.md` — "Access self-hosted app (SSO/WARP-gated)" as
  the human-web-UI pattern, and "Access self-hosted app... so you reach the full
  Obsidian app from any browser" for the (unbuilt) live-vault UI proposal.
- `sux/mcp-gate/README.md` — names "Cloudflare Access managed OAuth in front" as
  the upgrade path for the Mac-side gateway's public tier (a different host,
  same idea).

**No Access application exists yet for any live route in this repo** — the
mentions above are design-doc proposals, not shipped policy. That's why this
change adds no wrangler binding for Access: Access applications/policies are pure
Zero Trust dashboard (or Cloudflare API) configuration, not a Worker binding or
`wrangler.jsonc` field, so there is nothing to add there. `sux/wrangler.jsonc`
is unchanged by this PR.

## Manual follow-up (NOT done by this change)

Someone with Cloudflare Zero Trust access to the account must, in the Cloudflare
dashboard (**Zero Trust → Access → Applications → Add an application → Self-hosted**)
or via the Access API:

1. Create a self-hosted Access application scoped to the sux Worker's public
   hostname (`suxos.net`, per `docs/knowledge/refactor-runbook.md`) with path
   `/dashboard*`.
2. Attach a policy that allows only Colin's identity (GitHub SSO or a one-time-PIN
   email rule, whichever the Zero Trust org already uses for other apps) — Allow
   for that identity, block everyone else (the default when no other policy
   matches).
3. Verify: an unauthenticated request to `https://suxos.net/dashboard` gets
   Access's login page, not the dashboard HTML; after login it loads normally.
4. **Set the two secrets `access-jwt.ts` needs to verify anything at all** —
   without these, every `/dashboard*` request 401s regardless of Access:
   ```
   wrangler secret put CF_ACCESS_TEAM_DOMAIN --config sux/wrangler.jsonc
   # value: https://<your-team-name>.cloudflareaccess.com (Zero Trust → Settings → Custom Pages, or the URL your team's login page runs on)
   wrangler secret put CF_ACCESS_AUD --config sux/wrangler.jsonc
   # value: the "Audience (AUD) Tag" shown on the Access application's Overview tab, created in step 1
   ```
   Neither value is secret in the confidentiality sense (both are visible to
   anyone who inspects the JWT/Access redirect), but they're deploy-environment
   config, not something to hardcode — `wrangler secret put` was chosen over a
   `wrangler.jsonc` var so a wrong/placeholder value in source control can never
   silently become the production audience check.
5. Redeploy after setting the secrets (or they won't take effect for the currently
   running Worker instance).

This step was **not** performed by this change — it requires Cloudflare
dashboard/API access this session doesn't have, and the issue explicitly asked
that Access-policy creation not be attempted here. The JWT-verification *code*
(step 4's consumer) is shipped; only the two config values and the Access
application itself are the human's part.

## Non-goals (per the issue)

No write access, no new metrics pipeline, no new content store, no new
KV/database namespace, not a general admin panel — confirmed: `dashboard.ts` only
reads (`readMetrics`, `obsidian.run` with `action:'list'|'read'`), and introduces
no new bindings.
