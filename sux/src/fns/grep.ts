import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";

export const grep: Fn = {
	name: "grep",
	description:
		"Filter lines by regex. source: raw text OR an http(s) url (fetched via residential proxy first). flags: regex flags (default 'i'). context: N lines of surrounding context. invert: keep non-matching lines. count: return only the match count. Returns matching lines with 1-based line numbers.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["source", "pattern"],
		properties: {
			source: { type: "string", description: "Text to search, or an absolute http(s) URL to fetch and search." },
			pattern: { type: "string", description: "JavaScript regular expression." },
			flags: { type: "string", default: "i", description: "Regex flags, e.g. 'i', 'im'. 'g' is implied." },
			context: { type: "integer", default: 0, minimum: 0, maximum: 20 },
			invert: { type: "boolean", default: false },
			count: { type: "boolean", default: false },
			max: { type: "integer", default: 200, description: "Cap on returned matches." },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const source = String(args?.source ?? "");
		if (!source) return fail("Provide `source` (text or url).");
		const pattern = String(args?.pattern ?? "");
		if (!pattern) return fail("Provide a regex `pattern`.");

		let flags = String(args?.flags ?? "i").replace(/g/g, "");
		let re: RegExp;
		try {
			re = new RegExp(pattern, flags);
		} catch (e) {
			return fail(`Invalid regex: ${String((e as Error).message ?? e)}`);
		}

		let text = source;
		if (/^https?:\/\//i.test(source)) {
			try {
				text = await (await smartFetch(env, source, {})).text();
			} catch (e) {
				return fail(`Fetch failed: ${String((e as Error).message ?? e)}`);
			}
		}

		const lines = text.split(/\r?\n/);
		const invert = args?.invert === true;
		const context = Math.min(Number(args?.context) || 0, 20);
		const max = Number(args?.max) || 200;

		const hitIdx: number[] = [];
		for (let i = 0; i < lines.length; i++) {
			if (re.test(lines[i]) !== invert) hitIdx.push(i);
		}

		if (args?.count === true) return ok(String(hitIdx.length));
		if (!hitIdx.length) return ok("(no matches)");

		const keep = new Set<number>();
		for (const i of hitIdx.slice(0, max)) {
			for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep.add(j);
		}
		const out: string[] = [];
		let prev = -1;
		for (const i of [...keep].sort((a, b) => a - b)) {
			if (prev !== -1 && i > prev + 1) out.push("--");
			out.push(`${i + 1}:${lines[i]}`);
			prev = i;
		}
		const truncated = hitIdx.length > max ? `\n… ${hitIdx.length - max} more matches (raise \`max\`)` : "";
		return ok(out.join("\n") + truncated);
	},
};
