import { type Fn, ok } from "../registry";
import { isTailscaleConfigured, proxyEnabled, smartFetch } from "../proxy";

// Verify residential routing from an MCP client's perspective: compare the
// Worker's egress IP THROUGH the Tailscale residential proxy vs a DIRECT fetch.
// If they differ, traffic is genuinely exiting via the residential exit; if they
// match (or the probe fails), it's falling back to datacenter egress. Same logic
// the browsable /health page uses, exposed as a callable tool.

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
	return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

/** IP + best-effort geo of whoever the given fetcher egresses as. */
async function ipInfo(fetcher: (u: string) => Promise<Response>): Promise<Record<string, unknown> | null> {
	let ip: string | undefined;
	let country: string | undefined;
	let colo: string | undefined;
	try {
		const t = await (await fetcher("https://cloudflare.com/cdn-cgi/trace")).text();
		const m: Record<string, string> = Object.fromEntries(t.trim().split("\n").map((l) => l.split("=") as [string, string]));
		ip = m.ip;
		country = m.loc;
		colo = m.colo;
	} catch {
		return null;
	}
	if (!ip) return null;
	let city: string | undefined;
	let region: string | undefined;
	let org: string | undefined;
	try {
		const g = (await (await fetcher(`https://ipwho.is/${ip}`)).json()) as any;
		if (g?.success !== false) {
			city = g.city;
			region = g.region;
			org = g.connection?.org ?? g.connection?.isp;
			country = g.country ?? country;
		}
	} catch {
		// geo enrichment optional
	}
	return { ip, city, region, country, colo, org };
}

export const egress: Fn = {
	name: "egress",
	description:
		"Verify that traffic is routing through the Tailscale residential exit. Probes the Worker's egress IP THROUGH the residential proxy vs a DIRECT fetch (Cloudflare cdn-cgi/trace + best-effort geo) and reports whether they differ. " +
		"`routing: true` means requests are genuinely exiting from the residential IP; false means direct/datacenter egress (unconfigured, disabled, or the tailnet node is down and it fell back). Live check — not cached.",
	inputSchema: { type: "object", additionalProperties: false, properties: {} },
	run: async (env) => {
		const [residential, datacenter] = await Promise.all([
			withTimeout(ipInfo((u) => smartFetch(env, u, {})), 9000, null),
			withTimeout(ipInfo((u) => fetch(u)), 9000, null),
		]);
		const configured = isTailscaleConfigured(env);
		const enabled = proxyEnabled(env);
		const routing = Boolean(configured && enabled && residential && datacenter && (residential as any).ip !== (datacenter as any).ip);

		let verdict: string;
		if (routing) {
			verdict = `✅ Routing residentially via ${(residential as any).org ?? "residential ISP"} (${(residential as any).ip})${(residential as any).city ? ` — ${(residential as any).city}, ${(residential as any).region ?? ""}` : ""}.`;
		} else if (!configured) {
			verdict = "❌ Tailscale proxy not configured — egress is direct (datacenter).";
		} else if (!enabled) {
			verdict = "❌ Proxy configured but disabled (TAILSCALE_PROXY_ALL=0) — egress is direct.";
		} else if (residential && datacenter && (residential as any).ip === (datacenter as any).ip) {
			verdict = "⚠️ Proxy configured but the residential and direct egress IPs match — falling back to direct (tailnet node down?).";
		} else {
			verdict = "⚠️ Could not determine egress — a probe failed.";
		}

		return ok(JSON.stringify({ routing, configured, proxy_enabled: enabled, residential, datacenter, verdict }, null, 2));
	},
};
