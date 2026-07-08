# mcp-gate

Tiered gateway that exposes local MCP servers (currently the Obsidian vault)
to every kind of Claude client, with upstream bearer tokens injected here so
they never leave the Mac. One process, one routes map, two trust tiers:

```
                        ┌──────────────────────── Mac ────────────────────────┐
tailnet devices ──HTTPS─▶ tailscale serve :9443 ──▶ 127.0.0.1:27126 ┐          │
(Claude Code, zero      │  (tailnet only; injects                   ├─ gate.mjs ──▶ upstreams
 secrets in config)     │   Tailscale-User-Login)                   │  routes.json   (obsidian
                        │                                           │   + bearer      :27123/mcp/)
claude.ai / anything ───▶ tailscale funnel :10000 ─▶ 127.0.0.1:27125┘   injection
(public internet)       └──────────────────────────────────────────────────────┘
```

- **Tailnet tier** — `https://colins-macbook-pro.owl-tegu.ts.net:9443/<route>/mcp`.
  Identity is the credential: `tailscale serve` injects `Tailscale-User-Login`
  on tailnet connections (and strips client-supplied `Tailscale-*` headers),
  the gate enforces `ALLOW_LOGINS`. No client-side secrets at all.
- **Public tier** — `https://colins-macbook-pro.owl-tegu.ts.net:10000/<secret>/<route>/mcp`
  (legacy `/<secret>/mcp` = default route `obsidian`). For clients that can't
  join the tailnet or send custom headers — claude.ai custom connectors. The
  secret lives in `~/.sux-mcp-gate.secret` (32 hex, chmod 600).
- **Local tier** (no gate involved) — Claude Code on this Mac talks straight
  to `http://127.0.0.1:27123/mcp/` with the bearer header (user-scope config).

## Config

- `routes.json` — `{ "<route>": { "upstream", "bearerFile", "bearerField" } }`.
  Bearer files are re-read per request, so key rotation needs no restart.
- `run.sh` — ports, `ALLOW_LOGINS`, secret file. Changes need a restart.

## Ops

```sh
launchctl kickstart -k gui/501/com.sux.mcp-gate   # restart after config change
tail -f /tmp/sux-mcp-gate.log                     # per-request identity attribution
tailscale funnel --https=10000 off                # kill public exposure
tailscale serve  --https=9443  off                # kill tailnet exposure
```

Rotate the public secret: write new 32-hex to `~/.sux-mcp-gate.secret`,
kickstart, update the claude.ai connector URL.

First-time install on a fresh Mac:

```sh
umask 077 && openssl rand -hex 16 > ~/.sux-mcp-gate.secret
cp com.sux.mcp-gate.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sux.mcp-gate.plist
tailscale serve  --bg --https=9443  http://127.0.0.1:27126
tailscale funnel --bg --https=10000 http://127.0.0.1:27125
```

## Security model

The public tier is capability-by-URL: 128 bits of entropy, but anyone holding
the URL has full vault access (including `vault_write`/`command_execute`) —
accepted because the vault is git-backed (undo). Upgrade path if that stops
being acceptable: Cloudflare Access managed OAuth in front (Access app type
`mcp`), or Anthropic MCP tunnels once/if claude.ai supports them. The tailnet
tier's next step is per-user tool capabilities via `tailscale whois` grant
CapMaps instead of a flat allowlist.
