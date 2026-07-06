import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";

const UA = "sux/1.0 (+https://sux.colinxs.workers.dev)";

export const tlsInfo: Fn = {
	name: "tls_info",
	description: "TLS certificate info for a host via Certificate Transparency logs (crt.sh). Returns recent certs: issuer, validity window, and covered names.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["host"],
		properties: {
			host: { type: "string", description: "Hostname, e.g. example.com." },
			limit: { type: "integer", default: 5, minimum: 1, maximum: 25 },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const host = String(args?.host ?? "").trim().replace(/^https?:\/\//, "").split("/")[0];
		if (!host) return fail("Provide a `host`.");
		// Route via the residential exit (crt.sh 403/502s datacenter IPs) with a UA.
		const resp = await smartFetch(env, `https://crt.sh/?q=${encodeURIComponent(host)}&output=json`, { headers: { accept: "application/json", "user-agent": UA } });
		if (!resp.ok) return fail(`crt.sh query failed: HTTP ${resp.status}`);
		let rows: any[];
		try {
			rows = (await resp.json()) as any[];
		} catch {
			return fail("crt.sh returned no parseable JSON (rate-limited?).");
		}
		if (!rows.length) return ok(`(no CT log entries for ${host})`);
		const limit = Number(args?.limit) || 5;
		const seen = new Set<string>();
		const out = [];
		for (const r of rows.sort((a, b) => String(b.not_before).localeCompare(String(a.not_before)))) {
			const key = `${r.issuer_name}|${r.not_before}|${r.name_value}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ issuer: r.issuer_name, not_before: r.not_before, not_after: r.not_after, names: String(r.name_value).split("\n") });
			if (out.length >= limit) break;
		}
		return ok(JSON.stringify(out, null, 2));
	},
};
