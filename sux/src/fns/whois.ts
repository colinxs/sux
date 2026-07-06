import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";

export const whois: Fn = {
	name: "whois",
	description: "Domain registration info via RDAP (JSON WHOIS). Returns registrar, key dates, status, and nameservers.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["domain"],
		properties: { domain: { type: "string", description: "Registrable domain, e.g. example.com." } },
	},
	cacheable: true,
	run: async (env, args) => {
		const domain = String(args?.domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
		if (!domain) return fail("Provide a `domain`.");
		// Route via the residential exit (rdap.org 403s some datacenter IPs) with a UA.
		const resp = await smartFetch(env, `https://rdap.org/domain/${encodeURIComponent(domain)}`, { headers: { accept: "application/rdap+json", "user-agent": "sux/1.0 (+https://sux.colinxs.workers.dev)" } });
		if (resp.status === 404) return ok(`(no RDAP record for ${domain})`);
		if (!resp.ok) return fail(`RDAP query failed: HTTP ${resp.status}`);
		const j = (await resp.json()) as any;
		const events: Record<string, string> = {};
		for (const e of j.events ?? []) events[e.eventAction] = e.eventDate;
		const registrar = (j.entities ?? []).find((e: any) => (e.roles ?? []).includes("registrar"));
		const regName = registrar?.vcardArray?.[1]?.find((f: any) => f[0] === "fn")?.[3];
		const nameservers = (j.nameservers ?? []).map((n: any) => n.ldhName).filter(Boolean);
		return ok(
			JSON.stringify(
				{
					domain: j.ldhName ?? domain,
					registrar: regName ?? registrar?.handle ?? null,
					status: j.status ?? [],
					registered: events.registration ?? null,
					updated: events.lastChanged ?? null,
					expires: events.expiration ?? null,
					nameservers,
				},
				null,
				2,
			),
		);
	},
};
