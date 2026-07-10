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

One `@cloudflare/workers-oauth-provider` instance, built lazily on first request, guards the whole Worker: `apiRoute: ["/mcp", "/vault/mcp"]` names both connector paths, `apiHandler` is `rtServer`, and `defaultHandler` is the GitHub OAuth flow (`github-handler.ts`). It is single-user by construction — `rtServer.fetch` checks `ctx.props?.login` against `isAllowedLogin(login, env.ALLOWED_GITHUB_LOGIN)` and returns a bare 403 for anyone else, so only one GitHub identity ever reaches a tool. Public, unauthenticated observability routes (`/health`, `/metrics`, `/logs`, `/feedback`, `/s/<uuid>`) are matched and served *before* `getOAuthProvider().fetch` runs, since the provider would otherwise claim every path under it. This single gate is what lets one Worker host N `/<domain>/mcp` connector namespaces — today `/mcp` and `/vault/mcp` — behind one login instead of standing up separate auth per namespace; see [[namespace-architecture]] for how those namespaces are split and [[connector-surface-policy]] for what belongs on which one.
