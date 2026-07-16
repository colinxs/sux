import { type Fn, fail, ok } from "../registry";
import { htmlToMd } from "./_markup";
import { errMsg } from "./_util";

// markdown(x): convert HTML TO Markdown. Inverse of html(). Common subset:
// headings, links, bold/em, lists, inline code, code blocks, blockquotes,
// paragraphs. Unknown tags are flattened to text.

export const markdown: Fn = {
	name: "markdown",
	description:
		"Convert HTML to Markdown (common subset: headings h1-h6, links, bold/em, ordered/unordered lists, inline code, code blocks, blockquotes, paragraphs; other tags flattened). Inverse of html(). Tables, images, and nested lists aren't handled.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { type: "string", description: "HTML source to convert to Markdown." },
		},
	},
	cacheable: true,
	ttl: 86400, // pure deterministic converter — HTML→Markdown output never changes
	run: async (_env, args) => {
		const data = String(args?.data ?? "");
		if (!data.trim()) return fail("`data` is required.");
		try {
			return ok(htmlToMd(data));
		} catch (e) {
			return fail(`markdown failed: ${errMsg(e)}`);
		}
	},
};
