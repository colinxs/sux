import { type Fn, fail, ok } from "../registry";
import { clamp, loadHtml, stripHtml } from "./_util";

/** Count the text length carried by <p> tags inside a fragment (density signal). */
function paragraphTextLen(fragment: string): number {
	let len = 0;
	for (const m of fragment.matchAll(/<p[\s>][\s\S]*?<\/p>/gi)) {
		len += stripHtml(m[0]).length;
	}
	return len;
}

/** Grab the innerHTML of the first <tag ...>…</tag> block, or "" if absent. */
function firstBlock(html: string, tag: string): string {
	return html.match(new RegExp(`<${tag}[\\s>][\\s\\S]*?<\\/${tag}>`, "i"))?.[0] ?? "";
}

export const readability: Fn = {
	name: "readability",
	description:
		"Extract the main article content from an HTML page (or url), dropping nav/header/footer/aside/forms/scripts. Prefers <article>/<main>, else the densest paragraph block. Returns JSON { title, byline?, text } with clean plain text.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			url: { type: "string", description: "URL to fetch (via proxy) — or pass `html`." },
			html: { type: "string", description: "Raw HTML to parse instead of fetching a url." },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const loaded = await loadHtml(env, args);
		if ("error" in loaded) return fail(loaded.error);

		const html = loaded.html;
		const title = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") || undefined;

		const meta = (name: string) =>
			html.match(new RegExp(`<meta[^>]+(?:name|property)=["'](?:${name})["'][^>]*content=["']([^"']*)["']`, "i"))?.[1] ??
			html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["'](?:${name})["']`, "i"))?.[1];
		const byline = (meta("author|article:author|og:article:author") ?? "").trim() || undefined;

		// Drop boilerplate/non-content elements before picking a region.
		const cleaned = html
			.replace(/<!--[\s\S]*?-->/g, " ")
			.replace(/<(script|style|nav|header|footer|aside|form|noscript|svg)[\s\S]*?<\/\1>/gi, " ");

		// Prefer a semantic region; otherwise fall back to the densest generic block.
		let region = firstBlock(cleaned, "article") || firstBlock(cleaned, "main");
		if (!region) {
			const blocks = [
				...cleaned.matchAll(/<(?:div|section)[\s>][\s\S]*?<\/(?:div|section)>/gi),
			].map((m) => m[0]);
			let best = "";
			let bestLen = 0;
			for (const b of blocks) {
				const len = paragraphTextLen(b);
				if (len > bestLen) {
					bestLen = len;
					best = b;
				}
			}
			region = best || firstBlock(cleaned, "body") || cleaned;
		}

		const text = stripHtml(region);
		if (!text) return fail("No readable content found.");

		return ok(
			JSON.stringify(
				{ title: title ?? null, ...(byline ? { byline } : {}), text: clamp(text) },
				null,
				2,
			),
		);
	},
};
