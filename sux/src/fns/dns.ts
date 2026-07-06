import { type Fn, fail, ok } from "../registry";

const TYPES = ["A", "AAAA", "MX", "TXT", "CNAME", "NS", "SOA", "CAA", "SRV", "PTR"];

export const dns: Fn = {
	name: "dns",
	description: "Resolve DNS records via DoH. type: A (default) | AAAA | MX | TXT | CNAME | NS | SOA | CAA | SRV | PTR. Returns the answer records.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["name"],
		properties: {
			name: { type: "string", description: "Hostname to resolve." },
			type: { type: "string", enum: TYPES, default: "A" },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const name = String(args?.name ?? "").trim();
		if (!name) return fail("Provide a `name`.");
		const type = String(args?.type ?? "A").toUpperCase();
		if (!TYPES.includes(type)) return fail(`type must be one of: ${TYPES.join(", ")}`);
		const u = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`;
		const resp = await fetch(u, { headers: { accept: "application/dns-json" } });
		if (!resp.ok) return fail(`DoH query failed: HTTP ${resp.status}`);
		const j = (await resp.json()) as { Status: number; Answer?: Array<{ name: string; type: number; TTL: number; data: string }> };
		if (!j.Answer?.length) return ok(`(no ${type} records for ${name}; status ${j.Status})`);
		return ok(j.Answer.map((a) => `${a.name}\t${a.TTL}\t${type}\t${a.data}`).join("\n"));
	},
};
