import { type Fn, fail, ok } from "../registry";
import { loadHtml, stripHtml } from "./_util";

/** Resolve `href` against `base`, tolerating a junk base (e.g. a non-URL `url`
 * arg passed alongside raw `html`) — a bad base leaves `href` unchanged instead
 * of throwing "Invalid URL". */
function resolveAgainst(href: string, base: string): string {
	if (!base) return href;
	try {
		return new URL(href, base).href;
	} catch {
		return href;
	}
}

export const metadata: Fn = {
	name: "metadata",
	description:
		"Extract page metadata into a flat JSON object: title, description, keywords, author, canonical, favicon, and every og:* / twitter:* tag found. Pass a url or raw html.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			url: { type: "string", description: "URL to fetch (via proxy) — or pass `html`. Also used to resolve relative canonical/favicon." },
			html: { type: "string", description: "Raw HTML to parse instead of fetching a url." },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const loaded = await loadHtml(env, args);
		if ("error" in loaded) return fail(loaded.error);

		const html = loaded.html;
		const base = args?.url ? String(args.url) : "";
		const head = html.match(/<head[\s\S]*?<\/head>/i)?.[0] ?? html;
		const out: Record<string, string> = {};

		const title = stripHtml(head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
		if (title) out.title = title;

		for (const m of head.matchAll(/<meta\s+([^>]+?)\/?>/gi)) {
			const attrs = m[1];
			const key = attrs.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1];
			const content = attrs.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
			if (!key || content == null) continue;
			const k = key.toLowerCase();
			// Keep the metadata fields we care about, plus all og:/twitter: tags.
			if (k === "description" || k === "keywords" || k === "author" || k.startsWith("og:") || k.startsWith("twitter:")) {
				if (!(k in out)) out[k] = content;
			}
		}

		let canonical = head.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1];
		if (canonical) out.canonical = resolveAgainst(canonical, base);

		let favicon =
			head.match(/<link[^>]+rel=["'][^"']*\bicon\b[^"']*["'][^>]*href=["']([^"']+)["']/i)?.[1] ??
			head.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*\bicon\b[^"']*["']/i)?.[1];
		if (favicon) favicon = resolveAgainst(favicon, base);
		else if (base) favicon = resolveAgainst("/favicon.ico", base);
		if (favicon) out.favicon = favicon;

		if (!Object.keys(out).length) return ok("(no metadata found)");
		return ok(JSON.stringify(out, null, 2));
	},
};
