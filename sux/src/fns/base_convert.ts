import { type Fn, fail, ok } from "../registry";

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Value of a single base-N digit char, or -1 if not a valid digit for that base. */
function digitValue(ch: string, base: number): number {
	const v = DIGITS.indexOf(ch.toLowerCase());
	return v >= 0 && v < base ? v : -1;
}

export const baseConvert: Fn = {
	name: "base_convert",
	description:
		"Convert an integer between numeric bases. value is the number as a string (optional leading `-`); from_base and to_base are 2-36. Digits are validated against from_base. Arbitrary size via BigInt. Returns JSON { value, from_base, to_base, result } with the result lowercased.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["value", "from_base", "to_base"],
		properties: {
			value: { type: "string", description: "The integer to convert, e.g. `ff` or `-1010`." },
			from_base: { type: "integer", minimum: 2, maximum: 36, description: "Base of the input (2-36)." },
			to_base: { type: "integer", minimum: 2, maximum: 36, description: "Base of the output (2-36)." },
		},
	},
	cacheable: true,
	raw: true,
	run: async (_env, args) => {
		const raw = String(args?.value ?? "").trim();
		const fromBase = Number(args?.from_base);
		const toBase = Number(args?.to_base);
		if (!Number.isInteger(fromBase) || fromBase < 2 || fromBase > 36) return fail("from_base must be an integer in 2-36.");
		if (!Number.isInteger(toBase) || toBase < 2 || toBase > 36) return fail("to_base must be an integer in 2-36.");
		if (!raw) return fail("Provide a non-empty `value`.");

		const neg = raw.startsWith("-");
		const body = neg ? raw.slice(1) : raw;
		if (!body) return fail("`value` has no digits.");

		let acc = 0n;
		const bigBase = BigInt(fromBase);
		for (const ch of body) {
			const d = digitValue(ch, fromBase);
			if (d < 0) return fail(`'${ch}' is not a valid base-${fromBase} digit.`);
			acc = acc * bigBase + BigInt(d);
		}

		let digits = "";
		const outBase = BigInt(toBase);
		if (acc === 0n) {
			digits = "0";
		} else {
			let m = acc;
			while (m > 0n) {
				digits = DIGITS[Number(m % outBase)] + digits;
				m /= outBase;
			}
		}
		const result = (neg && acc !== 0n ? "-" : "") + digits;
		return ok(JSON.stringify({ value: raw, from_base: fromBase, to_base: toBase, result }, null, 2));
	},
};
