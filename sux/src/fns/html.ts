import { type Fn, fail, ok } from "../registry";
import { mdToHtml } from "./_markup";

// html(x): convert Markdown TO HTML. Inverse of markdown(). Same common subset.

export const html: Fn = {
	name: "html",
	description: "Convert Markdown to HTML (common subset: headings, links, bold/em, lists, inline code, fenced code blocks, blockquotes, paragraphs). Inverse of markdown().",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { type: "string", description: "Markdown source to convert to HTML." },
		},
	},
	cacheable: true,
	ttl: 86400, // pure deterministic converter — Markdown→HTML output never changes
	run: async (_env, args) => {
		const data = String(args?.data ?? "");
		if (!data.trim()) return fail("`data` is required.");
		try {
			return ok(mdToHtml(data));
		} catch (e) {
			return fail(`html failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
