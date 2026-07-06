import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";

export const crawl: Fn = {
	name: "crawl",
	description: "Breadth-first crawl from a seed URL. Follows same-origin links up to `depth` and `max` pages, returning each URL + its title. same_origin=false allows off-site links (still capped).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: {
			url: { type: "string", description: "Seed absolute http(s) URL." },
			depth: { type: "integer", default: 1, minimum: 0, maximum: 3 },
			max: { type: "integer", default: 25, minimum: 1, maximum: 100 },
			same_origin: { type: "boolean", default: true },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const seed = String(args?.url ?? "");
		if (!/^https?:\/\//i.test(seed)) return fail("url must be absolute http(s).");
		const maxDepth = Math.min(Number(args?.depth ?? 1), 3);
		const maxPages = Math.min(Number(args?.max ?? 25), 100);
		const sameOrigin = args?.same_origin !== false;
		const origin = new URL(seed).origin;

		const seen = new Set<string>([seed]);
		const results: Array<{ url: string; title: string | null; depth: number }> = [];
		let frontier: Array<{ url: string; depth: number }> = [{ url: seed, depth: 0 }];

		while (frontier.length && results.length < maxPages) {
			const next: Array<{ url: string; depth: number }> = [];
			for (const { url, depth } of frontier) {
				if (results.length >= maxPages) break;
				let html: string;
				try {
					html = await (await smartFetch(env, url, {})).text();
				} catch {
					continue;
				}
				const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null;
				results.push({ url, title, depth });
				if (depth >= maxDepth) continue;
				for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
					let abs: string;
					try {
						abs = new URL(m[1], url).href.split("#")[0];
					} catch {
						continue;
					}
					if (!/^https?:\/\//i.test(abs) || seen.has(abs)) continue;
					if (sameOrigin && new URL(abs).origin !== origin) continue;
					seen.add(abs);
					next.push({ url: abs, depth: depth + 1 });
				}
			}
			frontier = next;
		}
		return ok(JSON.stringify({ seed, pages: results.length, results }, null, 2));
	},
};
