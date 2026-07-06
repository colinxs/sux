import { type Fn, fail, ok } from "../registry";
import { fetchTextOk } from "./_util";

export const grep: Fn = {
	name: "grep",
	description:
		"Regex search over text, line by line. Provide a `pattern` plus either raw `text` or a `url` (fetched via residential proxy first). ignore_case (default false) adds the 'i' flag. context (default 0) includes N lines before and after each match. max (default 200) caps returned matches. Returns JSON { count, matches:[{ line, text, context? }] }; invalid regex fails with the error.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["pattern"],
		properties: {
			pattern: { type: "string", description: "JavaScript regular expression." },
			text: { type: "string", description: "Text to search (used instead of fetching `url`)." },
			url: { type: "string", description: "Absolute http(s) URL to fetch and search." },
			ignore_case: { type: "boolean", default: false, description: "Case-insensitive matching." },
			context: { type: "integer", default: 0, minimum: 0, maximum: 20, description: "Lines of surrounding context per match." },
			max: { type: "integer", default: 200, minimum: 1, maximum: 5000, description: "Max matches to return." },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const pattern = String(args?.pattern ?? "");
		if (!pattern) return fail("Provide a regex `pattern`.");

		let re: RegExp;
		try {
			re = new RegExp(pattern, args?.ignore_case === true ? "i" : "");
		} catch (e) {
			return fail(`Invalid regex: ${String((e as Error).message ?? e)}`);
		}

		let text = typeof args?.text === "string" ? args.text : "";
		if (!text && args?.url) {
			const fetched = await fetchTextOk(env, args.url);
			if ("error" in fetched) return fail(fetched.error);
			text = fetched.text;
		}
		if (!text) return fail("Provide `text` or `url`.");

		const context = Math.min(Number(args?.context) || 0, 20);
		const max = Math.min(Number(args?.max) || 200, 5000);
		const lines = text.split(/\r?\n/);

		const matches: Array<{ line: number; text: string; context?: string[] }> = [];
		let total = 0;
		for (let i = 0; i < lines.length; i++) {
			if (!re.test(lines[i])) continue;
			total++;
			if (matches.length >= max) continue;
			const hit: { line: number; text: string; context?: string[] } = { line: i + 1, text: lines[i] };
			if (context > 0) {
				hit.context = lines.slice(Math.max(0, i - context), Math.min(lines.length, i + context + 1));
			}
			matches.push(hit);
		}

		return ok(JSON.stringify({ count: total, matches }, null, 2));
	},
};
