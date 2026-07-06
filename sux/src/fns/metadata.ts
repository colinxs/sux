import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";

export const metadata: Fn = {
	name: "metadata",
	description: "Extract page metadata: title, description, canonical URL, favicon, and all OpenGraph/Twitter-card tags. Pass a url or raw html.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: { url: { type: "string" }, html: { type: "string" } },
	},
	cacheable: true,
	run: async (env, args) => {
		let html = String(args?.html ?? "");
		const url = args?.url ? String(args.url) : "";
		if (!html && url) {
			if (!/^https?:\/\//i.test(url)) return fail("url must be absolute http(s).");
			html = await (await smartFetch(env, url, {})).text();
		}
		if (!html) return fail("Provide `html` or `url`.");
		const head = html.match(/<head[\s\S]*?<\/head>/i)?.[0] ?? html;

		const meta: Record<string, string> = {};
		for (const m of head.matchAll(/<meta\s+([^>]+?)\/?>/gi)) {
			const attrs = m[1];
			const name = attrs.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1];
			const content = attrs.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
			if (name && content != null) meta[name] = content;
		}
		const title = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
		const canonical = head.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1];
		let favicon = head.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']+)["']/i)?.[1];
		if (favicon && url) favicon = new URL(favicon, url).href;
		else if (!favicon && url) favicon = new URL("/favicon.ico", url).href;

		return ok(
			JSON.stringify(
				{
					title: title ?? meta["og:title"] ?? null,
					description: meta.description ?? meta["og:description"] ?? null,
					canonical: canonical ?? null,
					favicon: favicon ?? null,
					og: Object.fromEntries(Object.entries(meta).filter(([k]) => k.startsWith("og:"))),
					twitter: Object.fromEntries(Object.entries(meta).filter(([k]) => k.startsWith("twitter:"))),
				},
				null,
				2,
			),
		);
	},
};
