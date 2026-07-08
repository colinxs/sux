import { type Fn, fail, ok } from "../registry";

// PII redaction. Every match becomes [REDACTED:type]. Credit-card candidates
// are Luhn-checked so long digit runs (IDs, order numbers) aren't clobbered.

const TYPES = ["email", "phone", "ssn", "credit_card", "ip"] as const;
type RedactType = (typeof TYPES)[number];

const PATTERNS: Array<{ type: RedactType; re: RegExp }> = [
	{ type: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
	// US SSN (NNN-NN-NNNN); require separators to avoid random 9-digit runs.
	{ type: "ssn", re: /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g },
	// Card-shaped digit groups (13–19 digits, optional space/dash groupings).
	{ type: "credit_card", re: /\b(?:\d[ -]?){13,19}\b/g },
	// IPv4 + common IPv6. Runs before phone so the phone regex can't eat the
	// leading octets of a dotted-quad (e.g. 192.168 out of 192.168.1.100).
	{ type: "ip", re: /\b(?:(?:\d{1,3}\.){3}\d{1,3}|(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{1,4})\b/g },
	// Phone: optional +country / (area), then grouped digits with separators, OR
	// a contiguous 10-digit / +country E.164 run (5551234567, +15551234567). The
	// contiguous branch is digit-boundary guarded so it can't bite into a longer
	// run (13–19-digit card candidates stay whole for the credit_card pass).
	{
		type: "phone",
		re: /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}[\s.-]\d{3,4}(?:[\s.-]\d{3,4})?\b|(?<!\d)(?:\+\d{1,3})?\d{10}(?!\d)/g,
	},
];

/** Luhn check on the digits of a card candidate. */
function luhnOk(s: string): boolean {
	const digits = s.replace(/\D/g, "");
	if (digits.length < 13 || digits.length > 19) return false;
	let sum = 0;
	let alt = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let d = digits.charCodeAt(i) - 48;
		if (alt) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
		alt = !alt;
	}
	return sum % 10 === 0;
}

function ipv4Ok(s: string): boolean {
	if (s.includes(":")) return true; // IPv6 candidate — accept as matched.
	const parts = s.split(".");
	return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

export const redact: Fn = {
	name: "redact",
	description:
		"Redact PII from text, replacing each match with [REDACTED:type]. types: optional subset of [email, phone, ssn, credit_card, ip] (default all). Credit cards are Luhn-validated and IPv4 octets range-checked to cut false positives. Returns JSON { redacted, counts }.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text"],
		properties: {
			text: { type: "string", description: "Text to scrub." },
			types: {
				type: "array",
				items: { type: "string", enum: [...TYPES] },
				description: "Subset of PII types to redact. Default: all.",
			},
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		let text = typeof args?.text === "string" ? args.text : "";
		if (!text) return fail("Provide non-empty `text`.");

		let want: Set<RedactType> | null = null;
		if (args?.types !== undefined) {
			if (!Array.isArray(args.types)) return fail("`types` must be an array.");
			const bad = args.types.filter((t: unknown) => !TYPES.includes(t as RedactType));
			if (bad.length) return fail(`Unknown type(s): ${bad.join(", ")}. Allowed: ${TYPES.join(", ")}.`);
			if (args.types.length) want = new Set(args.types as RedactType[]);
		}

		const counts: Record<string, number> = {};
		for (const { type, re } of PATTERNS) {
			if (want && !want.has(type)) continue;
			text = text.replace(re, (m: string) => {
				if (type === "credit_card" && !luhnOk(m)) return m;
				if (type === "ip" && !ipv4Ok(m)) return m;
				counts[type] = (counts[type] ?? 0) + 1;
				return `[REDACTED:${type}]`;
			});
		}

		return ok(JSON.stringify({ redacted: text, counts }, null, 2));
	},
};
