---
title: OAuth Gate
status: shipped
cluster: infrastructure
type: concept
tags: [sux, infrastructure, shipped]
updated: 2026-07-09
related: ["[[namespace-architecture]]", "[[connector-surface-policy]]", "[[vault-stack]]", "[[Infrastructure-MOC]]"]
---

# OAuth Gate

**Source:** [`sux/src/index.ts`](../../../sux/src/index.ts) (`getOAuthProvider`)

One `@cloudflare/workers-oauth-provider` instance, built lazily on first request, guards the whole Worker: `apiRoute: CONNECTOR_PATHS` (`["/mcp", "/vault/mcp", "/mail/mcp", "/files/mcp"]` from [`connectors.ts`](../../../sux/src/connectors.ts)) names every routed connector path — `/mcp` is the one advertised front door, the three per-domain paths stay OAuth-authorized for back-compat but ship no plugin. `apiHandler` is `rtServer`, and `defaultHandler` is the GitHub OAuth flow (`github-handler.ts`). It is single-user by construction — `rtServer.fetch` checks `ctx.props?.login` against `isAllowedLogin(login, env.ALLOWED_GITHUB_LOGIN)` and returns a bare 403 for anyone else, so only one GitHub identity ever reaches a tool. Public, unauthenticated observability routes (`/health`, `/metrics`, `/logs`, `/feedback`, `/s/<uuid>`) are matched and served *before* `getOAuthProvider().fetch` runs, since the provider would otherwise claim every path under it. This single gate is what lets one Worker host every connector path behind one login instead of standing up separate auth per namespace — today the one advertised `/mcp` front door plus the dormant per-domain routes it absorbed; see [[namespace-architecture]] for how those namespaces collapsed onto the one connector and [[connector-surface-policy]] for what belongs on it.
