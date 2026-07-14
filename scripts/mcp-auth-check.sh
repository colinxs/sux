#!/usr/bin/env bash
#
# mcp-auth-check.sh — headless health check for the OAuth-gated MCP connectors
# (cloudflare, grafana-cloud, sux). `claude mcp list` already health-checks every
# configured server non-interactively; this just filters to ones this repo cares
# about and exits non-zero if any still need auth, so it's usable as a gate.
#
#   ./scripts/mcp-auth-check.sh
#
set -uo pipefail

WATCH='plugin:cloudflare:cloudflare-api|plugin:cloudflare:cloudflare-bindings|plugin:cloudflare:cloudflare-builds|plugin:cloudflare:cloudflare-observability|plugin:grafana-cloud-mcp:grafana-cloud|plugin:sux:sux'

OUT=$(claude mcp list 2>&1)
echo "$OUT" | grep -E "$WATCH"

NEEDS_AUTH=$(echo "$OUT" | grep -E "$WATCH" | grep -c "Needs authentication")

if [ "$NEEDS_AUTH" -gt 0 ]; then
	echo
	echo "✗ $NEEDS_AUTH connector(s) still need authentication."
	echo "  Run an interactive \`claude\` session, type /mcp, and connect each — see docs/mcp-server-auth.md."
	exit 1
fi

echo
echo "✓ all watched connectors authenticated."
