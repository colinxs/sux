import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";

export const readability: Fn = {
	name: "readability",
	description: "Extract the main article/body text from an HTML page (or url), dropping nav, ads, scripts, and boilerplate. Returns clean text plus the detected title.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			url: { type: "string", description: "URL to fetch (via proxy) — or pass `html`." },
			html: { type: "string" },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		let html = String(args?.html ?? "");
		if (!html && args?.url) {
			if (!/^https?:\/\//i.test(String(args.url))) return fail("url must be absolute http(s).");
			html = await (await smartFetch(env, String(args.url), {})).text();
		}
		if (!html) return fail("Provide `html` or `url`.");

		const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "";
		const body = (html.match(/<body[\s\S]*?<\/body>/i)?.[0] ?? html)
			.replace(/<(script|style|nav|header|footer|aside|form|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
			.replace(/<!--[\s\S]*?-->/g, " ");

		const chunks = body.split(/<\/(?:p|div|section|article|li|h[1-6])>/i);
		const paras: string[] = [];
		for (const c of chunks) {
			const text = c.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
			if (text.length >= 60) paras.push(text);
		}
		const article = paras.join("\n\n") || body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
		return ok(`${title ? `# ${title}\n\n` : ""}${article.slice(0, 100_000)}`);
	},
};
