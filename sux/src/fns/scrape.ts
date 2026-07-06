import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";

export const scrape: Fn = {
	name: "scrape",
	description:
		"Fetch a web page through the residential proxy (falls back to direct) and return its raw content. Use for pages that block datacenter IPs. Parsing happens in the cloud.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: {
			url: { type: "string", description: "Absolute http(s) URL." },
			method: { type: "string", default: "GET" },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const url = String(args?.url ?? "");
		if (!/^https?:\/\//.test(url)) return fail("Provide an absolute http(s) url.");
		const resp = await smartFetch(env, url, { method: args?.method });
		const body = await resp.text();
		const result = ok(`HTTP ${resp.status} — ${url}\n\n${body.slice(0, 100_000)}`);
		// Raw transport faithfully returns error pages too — but never caches them,
		// so a transient 403/429/consent wall can't poison repeat calls for an hour.
		if (resp.status >= 400) result.noCache = true;
		return result;
	},
};
