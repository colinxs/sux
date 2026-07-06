# Tailscale residential fetch-proxy

A tiny zero-dependency Node server that fetches URLs from **its own IP** on behalf
of the Kagi Worker. The Worker egresses from Cloudflare datacenter IPs, which
Akamai-protected retailers (Home Depot, Lowe's, Costco) block. Run this on a box
in your tailnet with a residential connection and the Worker can borrow that IP.

```
Worker ──POST /fetch {url}──▶  Tailscale Funnel  ──▶  this proxy  ──fetch──▶  target
         (Bearer secret)      (public HTTPS URL)      (residential IP)
```

## Run it

On a machine in your tailnet (home server, Raspberry Pi, always-on laptop), Node 20+:

```bash
export PROXY_SECRET="$(openssl rand -hex 32)"   # strong secret
node server.mjs                                  # listens on :8787
```

Expose it to the Worker over the public internet via **Tailscale Funnel**:

```bash
tailscale funnel 8787
# → https://<node>.<tailnet>.ts.net  (this is your TAILSCALE_PROXY_URL)
```

(Funnel requires HTTPS + the `funnel` node attribute in your tailnet ACLs. If you'd
rather not use Funnel, put `cloudflared` in front instead — any public HTTPS URL
that reaches the proxy works.)

## Point the Worker at it

```bash
wrangler secret put TAILSCALE_PROXY_URL      # https://<node>.<tailnet>.ts.net
wrangler secret put TAILSCALE_PROXY_SECRET   # the PROXY_SECRET value
```

Then in the Worker: `fetchPageViaTailscale(env, url)` (see `src/tailscale.ts`).

## API

- `GET /health` → `{"status":"ok"}`
- `POST /fetch` — body `{ url, method?, headers?, body? }`. Auth is **HMAC**, not a
  bearer token: send
  - `X-Timestamp: <epoch ms>`
  - `X-Signature: <hex HMAC-SHA256( `${timestamp}\n${rawBody}`, PROXY_SECRET )>`

  The proxy recomputes the HMAC and rejects stale timestamps (±5 min), so the
  secret never crosses the wire and requests can't be replayed. → `{ status,
  statusText, headers, bytes, truncated, body }`

## Config (env vars)

| var | default | purpose |
|---|---|---|
| `PROXY_SECRET` | *(required, ≥16 chars)* | HMAC signing secret (shared with the Worker) |
| `ALLOWED_HOSTS` | *(empty = any public host)* | comma-separated allowlist, e.g. `mcp.kagi.com,homedepot.com,lowes.com`. Suffix-matched, so `homedepot.com` also allows `www.homedepot.com`. Set this to shrink a leaked secret's blast radius to only the hosts you proxy. |
| `PORT` | `8787` | listen port |
| `MAX_BYTES` | `5242880` | response body cap (5 MiB) |
| `TIMEOUT_MS` | `30000` | per-fetch timeout |
| `CLOCK_SKEW_MS` | `300000` | max timestamp age (replay window) |

## Security

This is an authenticated fetch proxy on your home network — treat the secret like
a password.

- **Strong `PROXY_SECRET`** (32+ random bytes). Auth is HMAC — the secret signs
  each request and is never transmitted — and requests are replay-bounded to ±5 min.
- **Set `ALLOWED_HOSTS`** to the hosts you actually proxy (e.g.
  `mcp.kagi.com,homedepot.com,lowes.com,costco.com`). Then even a leaked secret can
  only reach those hosts, not arbitrary URLs.
- **SSRF guard built in**: the proxy resolves each target hostname and refuses
  loopback / private / link-local / CGNAT (incl. Tailscale's own `100.64/10`) /
  cloud-metadata (`169.254.169.254`) addresses — so a leaked secret still can't
  reach your LAN or `localhost`.
- Funnel exposes the port publicly; the Bearer check is the only gate — rotate the
  secret if you suspect exposure.
- It does **not** run JavaScript. For JS-rendered pages, pair with Cloudflare
  Browser Run, or extend this proxy with Playwright later.
