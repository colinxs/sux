import { type Fn, failWith, ok } from "../registry";
import { smartFetch } from "../proxy";
import { clampBytes, isHttpUrl, noCacheOn4xx, noCacheOnMutation } from "./_util";

const MAX_BODY_BYTES = 100_000;

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
		if (!isHttpUrl(url)) return failWith("bad_input", "Provide an absolute http(s) url.");
		const resp = await smartFetch(env, url, { method: args?.method });
		const body = await resp.text();
		// clampBytes (not a bare slice): appends the truncation marker so the model knows
		// the page was cut at the cap rather than silently ending mid-content, and cuts on
		// a genuine byte boundary rather than UTF-16 code units (#580).
		return noCacheOnMutation(noCacheOn4xx(ok(`HTTP ${resp.status} — ${url}\n\n${clampBytes(body, MAX_BODY_BYTES)}`), resp.status), args?.method);
	},
};
