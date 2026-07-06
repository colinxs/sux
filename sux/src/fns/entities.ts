import { type Fn, fail, ok } from "../registry";

export const entities: Fn = {
	name: "entities",
	description: "Extract entities from text: dates, money amounts, percentages, URLs, emails, @handles, #hashtags, and candidate proper nouns. Returns each category with deduped values.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text"],
		properties: { text: { type: "string" } },
	},
	cacheable: true,
	run: async (_env, args) => {
		const text = String(args?.text ?? "");
		if (!text) return fail("Provide `text`.");
		const grab = (re: RegExp) => [...new Set([...text.matchAll(re)].map((m) => m[0].trim()))].slice(0, 100);
		const out = {
			dates: grab(/\b(?:\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?|\d{1,2}\/\d{1,2}\/\d{2,4})\b/gi),
			money: grab(/(?:[$€£¥]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|dollars|euros))\b/gi),
			percentages: grab(/\b\d+(?:\.\d+)?\s?%/g),
			urls: grab(/https?:\/\/[^\s"'<>)]+/gi),
			emails: grab(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi),
			handles: grab(/(?<![\w])@\w{2,}/g),
			hashtags: grab(/#\w{2,}/g),
			proper_nouns: grab(/\b(?:[A-Z][a-z]+)(?:\s+[A-Z][a-z]+){0,3}\b/g).filter((s) => s.split(" ").length > 1 || s.length > 3),
		};
		return ok(JSON.stringify(out, null, 2));
	},
};
