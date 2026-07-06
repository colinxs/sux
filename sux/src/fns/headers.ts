import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";

export const headers: Fn = {
	name: "headers",
	description: "Probe a URL with HEAD: returns HTTP status, response headers, and round-trip latency (ms). Cheap way to check content-type, caching, redirects, and availability.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: {
			url: { type: "string", description: "Absolute http(s) URL." },
			method: { type: "string", default: "HEAD", description: "HEAD (default) or GET." },
		},
	},
	cacheable: false,
	run: async (env, args) => {
		const url = String(args?.url ?? "");
		if (!/^https?:\/\//i.test(url)) return fail("url must be absolute http(s).");
		const method = String(args?.method ?? "HEAD").toUpperCase();
		const t0 = Date.now();
		const resp = await smartFetch(env, url, { method });
		const ms = Date.now() - t0;
		return ok(JSON.stringify({ url, status: resp.status, statusText: resp.statusText, latency_ms: ms, headers: Object.fromEntries([...resp.headers]) }, null, 2));
	},
};
