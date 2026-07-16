// HTML-to-text stripping. Split out of fns/_util.ts (#565) — re-exported from
// there, so existing `from "./_util"` imports are unaffected.

/** Strip tags/scripts/styles to readable plain text. */
export function stripHtml(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		// `&amp;` decodes LAST — mirroring _markup.decodeEntities — so a double-escaped
		// `&amp;lt;` yields the literal text `&lt;` rather than collapsing to `<`.
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}
