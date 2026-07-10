---
title: Fetch Ladder
status: shipped
cluster: infrastructure
type: concept
tags: [sux, infrastructure, shipped]
updated: 2026-07-09
related: ["[[content-addressed-cache]]", "[[oauth-gate]]", "[[fn-registry]]", "[[architecture]]", "[[Infrastructure-MOC]]"]
---

# Fetch Ladder

**Source:** [`sux/README.md`](../../../sux/README.md), [`sux/src/proxy.ts`](../../../sux/src/proxy.ts)

Cloudflare Workers egress from datacenter IPs, and datacenter IPs get blocked on reputation alone — residential egress is why sux exists at all. The ladder picks the cheapest rung that beats a given site's defenses: rung 1 is a plain Worker `fetch()`; rung 2 is `smartFetch`, a drop-in fetch (`sux/src/proxy.ts`) that routes through a Tailscale-Funnel'd OpenWRT box running curl-impersonate — matching Chrome's JA3/JA4/HTTP2 fingerprint coherently, not just its IP — and **always falls back to direct** on proxy error, so enabling it can never take the Worker down. Requests are HMAC-signed (`ts`+`sig`) riding the *query string*, not headers, because uhttpd drops custom headers on POST. Rung 3 is Cloudflare Browser Rendering for JS-rendered but non-hostile pages. Rung 4 is the Mac's headless patchright browser (real residential IP, real browser, no spoofing), which auto-escalates to rung 4s — a CapSolver-extension solver tier — when a challenge string is detected in the DOM. PerimeterX's press-and-hold is solved without CapSolver at all: a real `mouse.move → down → hold → up` gesture, the exact human action the challenge asks for.
