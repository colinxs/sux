import { type Fn, fail, ok } from "../registry";
import { oj } from "./_util";
import { redactText, REDACT_TYPES, type RedactType } from "@suxos/lib";

// PII redaction. Every match becomes [REDACTED:type]. Credit-card candidates
// are Luhn-checked so long digit runs (IDs, order numbers) aren't clobbered.
// The actual pattern set + scrub logic now lives in @suxos/lib's
// domain/sanitize.ts (absorbed there from sux-fileops, which had itself ported
// this file) — this is a thin re-export so call sites here don't break. The
// suxlib version is a strict superset: it adds a context-gated bare-9-digit
// SSN pattern (only fires near an "SSN"/"social security" label) that this
// file's original pattern set didn't have.

export const TYPES = REDACT_TYPES;
export type { RedactType };

/** Pure PII scrub shared by the `redact` fn and any server-side sink (e.g. the public /feedback log). */
export function redactPII(text: string, want: Set<RedactType> | null = null): { redacted: string; counts: Record<string, number> } {
	return redactText(text, want ? [...want] : undefined);
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
		const text = typeof args?.text === "string" ? args.text : "";
		if (!text) return fail("Provide non-empty `text`.");

		let want: Set<RedactType> | null = null;
		if (args?.types !== undefined) {
			if (!Array.isArray(args.types)) return fail("`types` must be an array.");
			const bad = args.types.filter((t: unknown) => !TYPES.includes(t as RedactType));
			if (bad.length) return fail(`Unknown type(s): ${bad.join(", ")}. Allowed: ${TYPES.join(", ")}.`);
			if (args.types.length) want = new Set(args.types as RedactType[]);
		}

		return ok(oj(redactPII(text, want)));
	},
};
