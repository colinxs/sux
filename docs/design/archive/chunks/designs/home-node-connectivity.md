---
title: Home-node connectivity — cloudflared vs Tailscale (Worker→home bridge)
status: reference
source: research 2026-07-12 (CF Tunnel + Tailscale docs)
---

**Verdict: cloudflared (Cloudflare Tunnel) for the Worker→home data plane; Tailscale for the
ops plane; neither fixes the SPOF — keep any home node as a best-effort cost tier only.**

**cloudflared** — home daemon makes outbound-only conns to CF edge (no inbound ports, no public
IP), CF↔daemon is mTLS. Route a public hostname (`render.sux.dev`) through the tunnel to the home
service; a Worker reaches it with a plain `fetch()`. Gate *who* can hit it with **Cloudflare
Access + a service token**: the Worker sends `CF-Access-Client-Id` / `CF-Access-Client-Secret`
headers, enforced at the edge before traffic reaches home — layered on top of sux's existing HMAC.
(WARP-to-Tunnel private mode needs a WARP client, which a Worker isn't → use the public-hostname +
Access-service-token route.)

**Tailscale** — Workers can't run tailscaled / join a tailnet. Funnel = public HTTPS into one node
but **carries no identity headers** (HMAC-only, your job); Serve = tailnet-only (unreachable from a
Worker). Exit nodes = residential egress, but a Worker can't use one. Good for the ops plane
(private mesh, SSH/admin) and optional home-egress, not the Worker's data path.

**Which for which:**
- Secure Worker→home bridge → **cloudflared** (same vendor, outbound-only, edge-enforced machine auth).
- Residential-IP egress → **non-need if the render node is at home** (its outbound already exits on
  the residential IP natively).
- Compose: home node on the tailnet (ops) **+ cloudflared/Access as the Worker-facing edge** (data).

**Honest take (ties to the retire-mac decision):** better plumbing ≠ higher uptime. The mac node
is a SPOF because it's one home machine (power/ISP/hardware); tunnels change *how the Worker reaches
it*, not *whether it's up*, and add their own liveness dependency. So: paid unlocker stays the
reliable fallback on the critical path; a tunnel-bridged home node is at most an explicit
best-effort *cost-optimization tier* (try cheap home render first, unlocker if it's down). The one
durable win: cloudflared/tailscale lets sux retire the Tailscale-proxy hack and reach any future
home helper securely without port-forwarding — worth doing for that alone.

Refs: developers.cloudflare.com/tunnel/ · /cloudflare-one/.../tunnel-with-firewall/ ·
tailscale.com/docs/features/{tailscale-funnel,tailscale-serve,exit-nodes}
