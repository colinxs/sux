import { type Fn, fail, ok } from "../registry";
import { fetchTextOkEscalating, oj } from "./_util";

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
		// ReDoS guardrails: cap the pattern size and reject the classic
		// catastrophic-backtracking shapes — an outer quantifier (+, *, {n,})
		// applied to a group whose body already contains a quantifier ((a+)+,
		// (a*)*, (.*)+, (a{2,})+ …) or a top-level alternation ((a|aa)+ …).
		// Both make matching backtrack exponentially. Heuristic, not exhaustive;
		// grep is OAuth-gated so this bounds self-inflicted stalls, and a rejected
		// pattern can be rewritten without an outer quantifier over such a group.
		if (pattern.length > 1000) return fail("Pattern too long (max 1000 chars).");
		if (/\([^)]*[+*{|][^)]*\)\s*[+*{]/.test(pattern)) {
			return fail("Pattern rejected: an outer quantifier over a group that itself contains a quantifier or alternation ((x+)+, (x*)*, (.*)+, (x{2,})+, (a|aa)+ …) risks catastrophic backtracking. Rewrite without a quantifier applied to such a group.");
		}

		let re: RegExp;
		try {
			re = new RegExp(pattern, args?.ignore_case === true ? "i" : "");
		} catch (e) {
			return fail(`Invalid regex: ${String((e as Error).message ?? e)}`);
		}

		let text = typeof args?.text === "string" ? args.text : "";
		if (!text && args?.url) {
			const fetched = await fetchTextOkEscalating(env, args.url);
			if ("error" in fetched) return fail(fetched.error);
			text = fetched.text;
		}
		if (!text) return fail("Provide `text` or `url`.");

		const context = Math.min(Number(args?.context) || 0, 20);
		const max = Math.min(5000, Math.max(1, Number(args?.max) || 200));
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

		return ok(oj({ count: total, matches }));
	},
};
