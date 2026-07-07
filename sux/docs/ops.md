# Operations (deep dive)

Complements the Operations section of the [README](../README.md). This is the
runbook for the two residential machines and the Worker.

## The Cloudflare Worker

- Deployed to `https://sux.colinxs.workers.dev`.
- **Deploy:** `npm run deploy:sux` (= `wrangler deploy --config sux/wrangler.jsonc`).
- **Gate before deploy:** `npm run type-check && npm test` — both green.
- **Secrets:** `npm run secret:sux <NAME>` (= `wrangler secret put --config
  sux/wrangler.jsonc`). See the README's Config section for the full list.
  - **Gotcha:** the repo root holds a separate, stale `kagi-mcp` worker. A bare
    `wrangler secret put` / `wrangler deploy` (no `--config`) targets *that*
    worker. Always use the `secret:sux` / `deploy:sux` scripts.
- **Public endpoints:** `/health` (three pillars + cache hit-rate + residential
  route ratio; `routing:true` = really exiting residential), `/metrics`,
  `/logs`, `/feedback` (+ `?type=issue`), `/s/<uuid>` (R2 blob streaming). `/mcp`
  is OAuth-gated (unauth → 401).
- **After a schema-changing deploy, reconnect the MCP connector** — it caches
  `tools/list`.

## The Mac render service (rung 4 + solver tier)

Files under `sux/mac-render/`:

| file | purpose |
|---|---|
| `render_server.py` | async patchright render server (`PORT=8790`, `CONCURRENCY=4`); block-detection + CapSolver solver context + PerimeterX hold gesture. |
| `run.sh` | reads `~/.sux-render.secret`, `exec caffeinate -s python3 render_server.py`. |
| `com.sux.render.plist` | launchd job (RunAtLoad + KeepAlive). |
| `extensions/` | **gitignored** — downloaded CapSolver browser extension (embeds the key). Never commit. |

**Keys/paths on the Mac:**
- `~/.sux-render.secret` — the HMAC secret shared with `MAC_RENDER_SECRET`.
- `~/.sux-capsolver.key` — the CapSolver API key (read by `render_server.py`).
- `~/.sux-render-profile` — the persistent patchright browser profile.

**Install:**
```
pip3 install --user patchright aiohttp capsolver_extension_python
python3 -m patchright install chromium
tailscale funnel --bg 8790          # expose the service
launchctl load ~/Library/LaunchAgents/com.sux.render.plist  # or bootstrap
```

**Restart:** `launchctl kickstart -k gui/$(id -u)/com.sux.render`
**Logs:** `/tmp/sux-render.log`, `/tmp/sux-render.err`

**Why headed + persistent profile:** CapSolver's extension is headed-only, so
the solver tier runs a headed browser; the persistent profile keeps clearance
cookies warm between calls.

## The OpenWRT node (rung 2)

Files under `sux/node/openwrt/`. x86_64 **musl** box, reachable at
`router.owl-tegu.ts.net`.

- **curl-impersonate** (Chrome build, `-musl` — the `-gnu` build fails with
  "required file not found" because there's no glibc interpreter).
- **uhttpd CGI** at `/fetch` (`fetch.sh`) shells out to curl-impersonate.
  - uhttpd **drops custom POST headers** → HMAC `ts`+`sig` ride the **query
    string**.
  - `base64` isn't installed → the CGI encodes with `openssl base64`.
- **HMAC secret** in `/etc/sux-proxy.secret` (matches `TAILSCALE_PROXY_SECRET`).
- Exposed via `tailscale funnel --bg 8787`.
- Build/deploy helpers: `npm run build:node`, `npm run check:node`.

## Tailscale Funnel notes

- Needs the tailnet's HTTPS/Funnel feature enabled **and** a provisioned cert
  (`tailscale cert <node>`) — the ACL `nodeAttr` alone isn't enough.
- Both machines are reached over their `*.owl-tegu.ts.net` Funnel URLs, signed
  with the same HMAC scheme (`ts`+`sig` on the query string).

## CI/CD & cron

- **`.github/workflows/ci.yml`** — type-check + tests on every push/PR.
- **`.github/workflows/deploy.yml`** — deploy on `main`.
- **`.github/workflows/health.yml`** — daily 09:17 UTC regression canary + live
  smoke check; opens/updates a tracking issue on failure.
- **Cloudflare cron** `0 13 * * *` (`scheduled()` in `sux/src/index.ts`) —
  best-effort daily tick that warms the Kroger OAuth token in KV. Never throws.

## Security hygiene

- **Rotate the CapSolver key** — one briefly reached the private repo before
  `sux/mac-render/extensions/` was gitignored. Rotate, and keep that directory
  out of git permanently.
- Secrets live only in Wrangler (Worker) and dotfiles on the two machines; none
  belong in the repo.
