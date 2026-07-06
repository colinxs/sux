import { type Fn, fail, ok } from "../registry";
import { loadHtml } from "./_util";

export const extract: Fn = {
	name: "extract",
	description: "Extract structure from HTML (or a URL). what: links | jsonld | text. Fetches via residential proxy when given a url.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			url: { type: "string", description: "URL to fetch (via proxy) — or pass `html` directly." },
			html: { type: "string" },
			what: { type: "string", enum: ["links", "jsonld", "text"], default: "text" },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const loaded = await loadHtml(env, args);
		if ("error" in loaded) return fail(loaded.error);
		const html = loaded.html;
		const what = String(args?.what ?? "text");

		if (what === "links") {
			const links = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
			return ok([...new Set(links)].slice(0, 500).join("\n"));
		}
		if (what === "jsonld") {
			const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].trim());
			return ok(blocks.length ? blocks.join("\n\n") : "(no JSON-LD found)");
		}

		const text = html
			.replace(/<script[\s\S]*?<\/script>/gi, " ")
			.replace(/<style[\s\S]*?<\/style>/gi, " ")
			.replace(/<[^>]+>/g, " ")
			.replace(/&nbsp;/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return ok(text.slice(0, 100_000));
	},
};
