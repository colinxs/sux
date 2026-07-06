import { type Fn, fail, ok } from "../registry";

export const redirects: Fn = {
	name: "redirects",
	description: "Trace a URL's redirect chain hop by hop. Returns each status + Location and the final destination. Follows up to 20 redirects.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: { url: { type: "string", description: "Absolute http(s) URL." } },
	},
	cacheable: false,
	run: async (_env, args) => {
		let url = String(args?.url ?? "");
		if (!/^https?:\/\//i.test(url)) return fail("url must be absolute http(s).");
		const chain: Array<{ status: number; url: string; location?: string }> = [];
		for (let i = 0; i < 20; i++) {
			let resp: Response;
			try {
				resp = await fetch(url, { method: "GET", redirect: "manual" });
			} catch (e) {
				return fail(`Fetch failed at ${url}: ${String((e as Error).message ?? e)}`);
			}
			const loc = resp.headers.get("location") ?? undefined;
			chain.push({ status: resp.status, url, location: loc });
			if (resp.status >= 300 && resp.status < 400 && loc) {
				url = new URL(loc, url).href;
				continue;
			}
			break;
		}
		return ok(JSON.stringify({ hops: chain.length, chain, final: chain[chain.length - 1]?.url }, null, 2));
	},
};
