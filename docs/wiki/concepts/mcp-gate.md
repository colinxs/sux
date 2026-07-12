---
title: mcp-gate
status: shipped
cluster: infrastructure
type: concept
tags: [sux, infrastructure, shipped]
updated: 2026-07-09
related: ["[[vault-stack]]", "[[vault-backends-matrix]]", "[[vpc-hosting]]", "[[oauth-gate]]", "[[Infrastructure-MOC]]"]
---

# mcp-gate

**Source:** [`sux/mcp-gate/README.md`](../../../sux/mcp-gate/README.md)

A local Node process (`gate.mjs`, run under launchd) on the Mac that fronts LIVE local MCP servers — today the Obsidian Local REST API — for remote Claude clients, injecting upstream bearer tokens Mac-side from `routes.json` so they never leave the machine (bearer files are re-read per request, so key rotation needs no restart). Two trust tiers sit in front of it: **tailnet** — `tailscale serve` on `:9443`, where identity is the credential (Tailscale injects `Tailscale-User-Login` and strips client-supplied `Tailscale-*` headers; the gate enforces an `ALLOW_LOGINS` allowlist), no client secrets at all — and **public** — `tailscale funnel` on `:10000`, gated by a 128-bit secret-path segment (`~/.sux-mcp-gate.secret`, 32 hex chars) for clients that can't join the tailnet or send custom headers, e.g. claude.ai. This is distinct from the Worker's `vault_*` tools on `/mcp` (see [[vault-stack]]), which serve the cloud git store and need no box awake; mcp-gate is the path to the *live* vault, and its security model accepts the public tier's capability-by-URL risk because the vault is git-backed — every write is a revertible commit.
