import { type Fn, fail, ok } from "../registry";

const PATTERNS: Array<{ type: string; re: RegExp }> = [
	{ type: "email", re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi },
	{ type: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
	{ type: "credit_card", re: /\b(?:\d[ -]?){13,16}\b/g },
	{ type: "phone", re: /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g },
	{ type: "ipv4", re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
];

export const redact: Fn = {
	name: "redact",
	description: "Redact PII from text: emails, phone numbers, SSNs, credit-card numbers, and IPv4 addresses. Replaces each with a [TYPE] token and reports how many of each were masked. types: optional subset to redact.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text"],
		properties: {
			text: { type: "string" },
			types: { type: "array", items: { type: "string", enum: PATTERNS.map((p) => p.type) }, description: "Subset to redact; default all." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		let text = String(args?.text ?? "");
		if (!text) return fail("Provide `text`.");
		const want = Array.isArray(args?.types) && args.types.length ? new Set(args.types) : null;
		const counts: Record<string, number> = {};
		for (const { type, re } of PATTERNS) {
			if (want && !want.has(type)) continue;
			text = text.replace(re, (m) => {

				if (type === "credit_card" && m.replace(/\D/g, "").length < 13) return m;
				counts[type] = (counts[type] ?? 0) + 1;
				return `[${type.toUpperCase()}]`;
			});
		}
		return ok(JSON.stringify({ redacted: counts, text }, null, 2));
	},
};
