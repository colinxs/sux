#!/bin/sh
# Unified MCP gateway. launchd (com.sux.mcp-gate) runs this at load and
# restarts it if it dies.
#   tailscale serve  :9443  (tailnet only) -> 127.0.0.1:27126  identity tier
#   tailscale funnel :10000 (public)       -> 127.0.0.1:27125  secret-path tier
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export TAILNET_PORT=27126
export PUBLIC_PORT=27125
export ALLOW_LOGINS="colinxs@github"
export GATE_SECRET=$(cat "$HOME/.sux-mcp-gate.secret")
cd "$(dirname "$0")"
exec node gate.mjs
