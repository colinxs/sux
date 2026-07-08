import { type Fn, failWith, ok } from "../registry";
import { smartFetch } from "../proxy";
import { isHttpUrl, noCacheOn4xx } from "./_util";

export const geo_fetch: Fn = {
	name: "geo_fetch",
	description:
		"Fetch a URL through the residential proxy, hinting a chosen exit locale. geo: locale hint e.g. 'us-ca', 'de' (passed as an x-exit-geo header; the proxy node interprets it, harmless if unsupported). max_bytes default 100000. Returns JSON { url, geo, status, bytes, text }.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: {
			url: { type: "string", description: "Absolute http(s) URL." },
			geo: { type: "string", description: "Exit locale hint, e.g. 'us-ca' or 'de'. Support depends on the proxy node." },
			max_bytes: { type: "number", default: 100000, description: "Max response bytes to return." },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const url = String(args?.url ?? "");
		if (!isHttpUrl(url)) return failWith("bad_input", "url must be absolute http(s).");
		const geo = args?.geo != null ? String(args.geo).trim() : "";
		const maxBytes = Number.isFinite(args?.max_bytes) ? Math.max(0, Number(args.max_bytes)) : 100_000;
		const headers: Record<string, string> = {};
		if (geo) headers["x-exit-geo"] = geo;

		let resp: Response;
		try {
			resp = await smartFetch(env, url, { headers });
		} catch (e) {
			return failWith("upstream_error", `Fetch failed: ${String((e as Error).message ?? e)}`);
		}
		const full = await resp.text();
		const text = full.slice(0, maxBytes);
		return noCacheOn4xx(ok(JSON.stringify({ url, geo: geo || null, status: resp.status, bytes: full.length, text }, null, 2)), resp.status);
	},
};
