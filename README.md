# Kagi MCP — private OAuth→Bearer bridge

A tiny [Cloudflare Worker](https://developers.cloudflare.com/workers/) that lets
Claude's **custom connectors** (claude.ai web + iOS) reach [Kagi's hosted MCP
server](https://mcp.kagi.com/mcp).

## Why this exists

Claude's custom connectors speak **OAuth only** — there's no field for pasting a
static bearer token. Kagi's hosted MCP currently authenticates with
`Authorization: Bearer <API key>` and does **not** support OAuth yet. This Worker
bridges the gap:

1. It runs [`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
   as a full OAuth 2.1 server, so Claude can complete an OAuth flow.
2. It uses **GitHub** as the upstream identity provider (you log in with GitHub).
3. It gates access to a **single GitHub account** (`ALLOWED_GITHUB_LOGIN`) — fail-closed.
4. It then **reverse-proxies** the MCP JSON-RPC / SSE stream to Kagi, injecting the
   Kagi API key server-side so it never leaves the Worker.

This server defines **no tools of its own** — `kagi_search_fetch`, `kagi_extract`,
and anything else are entirely Kagi's, streamed straight through.

> When Kagi ships OAuth, delete this Worker and point Claude directly at
> `https://mcp.kagi.com/mcp`.

## Architecture

```
Claude connector ──OAuth(GitHub login)──▶ Worker /authorize,/callback,/token
                                              │  (workers-oauth-provider + GitHub)
                                              ▼
Claude connector ──Bearer <oauth token>──▶ Worker /mcp
                                              │  ① validate token → ctx.props.login
                                              │  ② gate: login === ALLOWED_GITHUB_LOGIN
                                              │  ③ swap in Kagi API key
                                              ▼
                                    https://mcp.kagi.com/mcp  (SSE / JSON-RPC)
```

Only `/mcp` is proxied (MCP Streamable HTTP transport). There is no `/sse`
endpoint.

## GitHub auth: device flow

This Worker authenticates you with GitHub's **device authorization flow**, not the
web/callback flow. The Worker asks GitHub for a short code, you enter it at
`github.com/login/device`, and the Worker polls GitHub for the token. There is
**no redirect_uri**, so:

- The **same** GitHub OAuth App works for localhost *and* production — no
  per-environment callback URLs, no second app.
- `GITHUB_CLIENT_SECRET` is **not used** (device flow is a public-client grant).

You must tick **"Enable Device Flow"** in the OAuth App settings, otherwise
GitHub returns `404` on the device-code endpoint (the `/authorize` page will say
so).

## Required secrets

| Secret | Purpose |
|---|---|
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID (device flow enabled) |
| `KAGI_API_KEY` | Your Kagi API token (from the Kagi dashboard) — injected server-side |
| `ALLOWED_GITHUB_LOGIN` | The **one** GitHub username allowed through (case-insensitive) |

`GITHUB_CLIENT_SECRET` and `COOKIE_ENCRYPTION_KEY` are no longer required by the
device flow (they were used by the old callback flow); leaving them set is
harmless.

If `ALLOWED_GITHUB_LOGIN` is unset or empty, auth fails closed — login is
rejected, and any stray token also `403`s at the proxy. If `KAGI_API_KEY` is
wrong, Kagi returns tool errors in-band (HTTP 200 with `"isError": true`) rather
than a clean 401 — see Troubleshooting.

## Deploy

1. Create a [GitHub OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app):
   - Homepage URL: `https://kagi-mcp.<your-subdomain>.workers.dev`
   - Authorization callback URL: anything (unused by device flow) — e.g. the
     homepage URL
   - **Check "Enable Device Flow"**, then save.
2. Create the KV namespace and put its id in `wrangler.jsonc` under `OAUTH_KV`:
   ```bash
   wrangler kv namespace create "OAUTH_KV"
   ```
3. Set the secrets:
   ```bash
   wrangler secret put GITHUB_CLIENT_ID
   wrangler secret put KAGI_API_KEY
   wrangler secret put ALLOWED_GITHUB_LOGIN
   ```
4. Deploy:
   ```bash
   wrangler deploy
   ```
5. In Claude → **Settings → Connectors → Add custom connector**, enter
   `https://kagi-mcp.<your-subdomain>.workers.dev/mcp`. Complete the GitHub device
   login (enter the shown code at `github.com/login/device`). Once connected,
   Kagi's tools appear.

## Local development

The same GitHub OAuth App works locally — no separate app needed. Create
`.dev.vars` (git-ignored):

```
GITHUB_CLIENT_ID=...
KAGI_API_KEY=...
ALLOWED_GITHUB_LOGIN=...
```

Then:

```bash
npm install
npm run dev        # http://localhost:8788
npm run type-check # tsc --noEmit
```

`.dev.vars` is read **only at startup** — restart `wrangler dev` after editing it.

## Troubleshooting

Run `wrangler tail` (or watch `wrangler dev` output) and match the symptom:

| Symptom | Cause | Fix |
|---|---|---|
| `/authorize` page says "Failed to start… Enable Device Flow"; log shows `device/code failed: HTTP 404` | Device Flow not enabled on the OAuth App | Tick **Enable Device Flow** in the GitHub OAuth App settings |
| Device page shows `GitHub user "x" is not authorized` | Logged-in GitHub user ≠ `ALLOWED_GITHUB_LOGIN`, or that secret is empty | Set `ALLOWED_GITHUB_LOGIN` to your exact GitHub username |
| Connector adds fine, but every search returns an error like `Token signature failed to verify` | Wrong/empty `KAGI_API_KEY` (Kagi validates only on tool calls, in-band) | Re-copy the key from the Kagi dashboard; no spaces/newlines |
| `502 bad_gateway`; log shows `upstream: fetch ... threw` | Worker couldn't reach `mcp.kagi.com` | Transient network / Kagi outage — retry |
| Device code never completes | Code expired (~15 min) or entered on a different GitHub account | Reload `/authorize` for a fresh code; sign into the allowed account |

## Security notes

- The Kagi API key lives only in Worker secrets and is injected server-side; it is
  never sent to the client.
- The gate is enforced twice: at **login** (a non-allowed GitHub user is rejected
  before any token is issued) and again at the `/mcp` **proxy** (defense in depth —
  a non-allowed token only ever gets a `403` and can never reach Kagi).
- This is a single-user bridge. Review Cloudflare's
  [Securing MCP Servers](https://github.com/cloudflare/agents/blob/main/docs/securing-mcp-servers.md)
  before broadening access.
