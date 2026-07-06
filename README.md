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

## Endpoints & guards

- **`/mcp`** — the OAuth-gated proxy. After token validation it checks the login
  against `ALLOWED_GITHUB_LOGIN` (comma-separated allowlist) and applies a
  per-user rate limit (`MCP_RATE_LIMITER`, 120 req/60s — tune in `wrangler.jsonc`)
  before forwarding to Kagi.
- **`/health`** — unauthenticated liveness for uptime monitors. Returns booleans
  for whether each required secret is configured (never the values).
  `GET /health?deep=1` also pings Kagi and reports `upstream.reachable`
  (`503`/`"degraded"` if unreachable).
- **`/authorize`, `/callback`, `/token`, `/register`** — the OAuth flow.

## Required secrets

| Secret | Purpose |
|---|---|
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret |
| `COOKIE_ENCRYPTION_KEY` | Random 32-byte hex, e.g. `openssl rand -hex 32` — signs the approval/session cookies |
| `KAGI_API_KEY` | Your Kagi API token (from the Kagi dashboard) — injected server-side |
| `ALLOWED_GITHUB_LOGIN` | Comma-separated GitHub usernames allowed through (case-insensitive), e.g. `alice` or `alice,bob` |

If `ALLOWED_GITHUB_LOGIN` is unset or empty, the gate fails closed and **every**
request returns `403`. If `KAGI_API_KEY` is wrong, Kagi returns tool errors
in-band (HTTP 200 with `"isError": true`) rather than a clean 401 — see
Troubleshooting.

## Deploy

1. Create a [GitHub OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app):
   - Homepage URL: `https://kagi-mcp.<your-subdomain>.workers.dev`
   - Authorization callback URL: `https://kagi-mcp.<your-subdomain>.workers.dev/callback`
2. Create the KV namespace and put its id in `wrangler.jsonc` under `OAUTH_KV`:
   ```bash
   wrangler kv namespace create "OAUTH_KV"
   ```
3. Set the secrets:
   ```bash
   wrangler secret put GITHUB_CLIENT_ID
   wrangler secret put GITHUB_CLIENT_SECRET
   wrangler secret put COOKIE_ENCRYPTION_KEY   # openssl rand -hex 32
   wrangler secret put KAGI_API_KEY
   wrangler secret put ALLOWED_GITHUB_LOGIN
   ```
4. Deploy:
   ```bash
   wrangler deploy
   ```
5. In Claude → **Settings → Connectors → Add custom connector**, enter
   `https://kagi-mcp.<your-subdomain>.workers.dev/mcp` and complete the GitHub
   login. Once connected, Kagi's tools appear.

## Local development

Use a **separate** GitHub OAuth app pointing at localhost:

- Homepage URL: `http://localhost:8788`
- Authorization callback URL: `http://localhost:8788/callback`

Create `.dev.vars` (git-ignored) with all five secrets:

```
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
COOKIE_ENCRYPTION_KEY=...
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
| `403 forbidden` on every call; log shows `gate: rejected login=...` | Logged-in GitHub user ≠ `ALLOWED_GITHUB_LOGIN`, or that secret is empty | Set `ALLOWED_GITHUB_LOGIN` to your exact GitHub username |
| Connector adds fine, but every search returns an error like `Token signature failed to verify` | Wrong/empty `KAGI_API_KEY` (Kagi validates only on tool calls, in-band) | Re-copy the key from the Kagi dashboard; no spaces/newlines |
| `502 bad_gateway`; log shows `upstream: fetch ... threw` | Worker couldn't reach `mcp.kagi.com` | Transient network / Kagi outage — retry |
| OAuth login loops or `Invalid state` | Stale/mismatched cookies or `COOKIE_ENCRYPTION_KEY` changed | Clear cookies; keep `COOKIE_ENCRYPTION_KEY` stable |

## CI/CD (GitHub Actions)

- **`.github/workflows/ci.yml`** — on every push/PR to `main`: `npm ci`,
  `type-check`, and `wrangler deploy --dry-run` (validates the bundle & config
  without deploying).
- **`.github/workflows/deploy.yml`** — on push to `main` (or manual dispatch):
  type-check then deploy via `cloudflare/wrangler-action`.

Deploy needs two **repo secrets** (Settings → Secrets and variables → Actions):

| Secret | How to get it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → *Edit Cloudflare Workers* template |
| `CLOUDFLARE_ACCOUNT_ID` | Workers & Pages → account ID in the URL/sidebar |

The deploy pushes **code + `wrangler.jsonc` vars only**. Worker *secrets*
(`KAGI_API_KEY`, `GITHUB_CLIENT_*`, `COOKIE_ENCRYPTION_KEY`,
`ALLOWED_GITHUB_LOGIN`) are managed out-of-band with `wrangler secret put` and are
never in the repo or the pipeline.

## Observability & debugging

- **Workers Logs** are enabled (`observability.enabled` in `wrangler.jsonc`), so
  requests are traceable in the Cloudflare dashboard, not just via live `wrangler
  tail`.
- **`DEBUG_MCP`** (a `vars` entry, default `"1"`) toggles verbose proxy logging:
  each request logs the JSON-RPC method in and Kagi's status out, correlated by
  `cf-ray`. Set it to `"0"` (and redeploy) for a quiet, fully-streaming
  production path — when off, request bodies are streamed straight through
  instead of being buffered to log them.

## Security notes

- The Kagi API key lives only in Worker secrets and is injected server-side; it is
  never sent to the client.
- The gate is enforced at the `/mcp` proxy. Any GitHub user can *complete* the
  OAuth flow and receive a token, but a non-allowed token only ever gets a `403` —
  it can never reach Kagi.
- This is a single-user bridge. Review Cloudflare's
  [Securing MCP Servers](https://github.com/cloudflare/agents/blob/main/docs/securing-mcp-servers.md)
  before broadening access.
