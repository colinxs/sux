import { type Fn, fail, ok } from "../registry";
import { errMsg, oj } from "./_util";
import { smartFetch } from "../proxy";

export const redirects: Fn = {
	name: "redirects",
	description: "Trace a URL's redirect chain hop by hop. Returns each status + Location and the final destination. Follows up to 20 redirects. Routes through the residential proxy (direct fallback) so the trace originates from a residential IP.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: { url: { type: "string", description: "Absolute http(s) URL." } },
	},
	cacheable: false,
	run: async (env, args) => {
		let url = String(args?.url ?? "");
		if (!/^https?:\/\//i.test(url)) return fail("url must be absolute http(s).");
		const chain: Array<{ status: number; url: string; location?: string }> = [];
		for (let i = 0; i < 20; i++) {
			let resp: Response;
			try {
				// redirect:"manual" so each hop is observed, not followed; smartFetch
				// bounds every attempt (30s) and falls back to direct if the node is down.
				resp = await smartFetch(env, url, { method: "GET", redirect: "manual" });
			} catch (e) {
				return fail(`Fetch failed at ${url}: ${errMsg(e)}`);
			}
			const loc = resp.headers.get("location") ?? undefined;
			chain.push({ status: resp.status, url, location: loc });
			if (resp.status >= 300 && resp.status < 400 && loc) {
				try {
					// A malformed Location (servers emit garbage routinely) must not
					// discard the chain already traced — stop here and return what we have.
					url = new URL(loc, url).href;
				} catch {
					break;
				}
				continue;
			}
			break;
		}
		return ok(oj({ hops: chain.length, chain, final: chain[chain.length - 1]?.url }));
	},
};
