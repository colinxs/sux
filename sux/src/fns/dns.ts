import { type Fn, fail, ok } from "../registry";

const TYPES = ["A", "AAAA", "MX", "TXT", "CNAME", "NS", "SOA", "CAA", "SRV", "PTR"];

// DoH resolvers. `filter` picks a Control D free filtering resolver, which returns
// a null-route (0.0.0.0 / ::) or NXDOMAIN for domains in the chosen blocklist —
// so `dns` doubles as an "is this an ad/tracker/malware domain?" check.
const RESOLVERS: Record<string, string> = {
	off: "https://cloudflare-dns.com/dns-query",
	malware: "https://freedns.controld.com/p1", // malware
	ads: "https://freedns.controld.com/p2", // malware + ads + trackers
	social: "https://freedns.controld.com/p3", // + social
};

export const dns: Fn = {
	name: "dns",
	description:
		"Resolve DNS records via DoH. type: A (default) | AAAA | MX | TXT | CNAME | NS | SOA | CAA | SRV | PTR. " +
		"`filter` routes through a Control D free filtering resolver — malware | ads (ads+trackers+malware) | social — and reports whether the domain is `blocked` (null-routed) by that list; off (default) uses Cloudflare. Returns records (text), or JSON { blocked, records } when filtering.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["name"],
		properties: {
			name: { type: "string", description: "Hostname to resolve." },
			type: { type: "string", enum: TYPES, default: "A" },
			filter: { type: "string", enum: ["off", "malware", "ads", "social"], default: "off", description: "Control D filtering list to resolve through." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const name = String(args?.name ?? "").trim();
		if (!name) return fail("Provide a `name`.");
		const type = String(args?.type ?? "A").toUpperCase();
		if (!TYPES.includes(type)) return fail(`type must be one of: ${TYPES.join(", ")}`);
		const filter = String(args?.filter ?? "off");
		const base = RESOLVERS[filter] ?? RESOLVERS.off;
		const resp = await fetch(`${base}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: "application/dns-json" } });
		if (!resp.ok) return fail(`DoH query failed: HTTP ${resp.status}`);
		const j = (await resp.json()) as { Status: number; Answer?: Array<{ name: string; type: number; TTL: number; data: string }> };
		const records = (j.Answer ?? []).map((a) => ({ name: a.name, ttl: a.TTL, type, data: a.data }));

		if (filter !== "off") {
			// Control D null-routes blocked domains to 0.0.0.0 / :: (or NXDOMAIN).
			const blocked = records.some((r) => r.data === "0.0.0.0" || r.data === "::") || (j.Status === 3 && !records.length);
			return ok(JSON.stringify({ name, filter, blocked, records }, null, 2));
		}
		if (!records.length) return ok(`(no ${type} records for ${name}; status ${j.Status})`);
		return ok(records.map((r) => `${r.name}\t${r.ttl}\t${type}\t${r.data}`).join("\n"));
	},
};
