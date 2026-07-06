import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";

// extract — pull structure out of a page. `what`: links | jsonld | text.
// Dispatches on `what` (Julia-style method selection). Fetches via proxy if given a url.
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
		let html = String(args?.html ?? "");
		if (!html && args?.url) {
			if (!/^https?:\/\//.test(String(args.url))) return fail("url must be absolute http(s).");
			html = await (await smartFetch(env, String(args.url), {})).text();
		}
		if (!html) return fail("Provide `html` or `url`.");
		const what = String(args?.what ?? "text");

		if (what === "links") {
			const links = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
			return ok([...new Set(links)].slice(0, 500).join("\n"));
		}
		if (what === "jsonld") {
			const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].trim());
			return ok(blocks.length ? blocks.join("\n\n") : "(no JSON-LD found)");
		}
		// text: strip tags + collapse whitespace (readability-lite).
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
