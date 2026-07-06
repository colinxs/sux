import { type Fn, fail, ok } from "../registry";
import { toB64 } from "./_util";

const DEFAULT_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Unbiased integer in [0, n) from crypto bytes via rejection sampling. */
function randInt(n: number): number {
	if (n <= 0) return 0;
	// Smallest power-of-two-aligned rejection bound for a 32-bit draw.
	const max = Math.floor(0x100000000 / n) * n;
	const buf = new Uint32Array(1);
	let x: number;
	do {
		crypto.getRandomValues(buf);
		x = buf[0];
	} while (x >= max);
	return x % n;
}

export const random: Fn = {
	name: "random",
	description:
		"Cryptographically-random values. kind (required): int | float | string | bytes. int/float use min (default 0) and max (int max default 100, inclusive; float max default 1, exclusive). string/bytes use length (default 16); string uses alphabet (default alphanumeric). bytes are returned base64.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["kind"],
		properties: {
			kind: { type: "string", enum: ["int", "float", "string", "bytes"] },
			min: { type: "number", description: "Lower bound for int/float (default 0)." },
			max: { type: "number", description: "Upper bound: int inclusive (default 100), float exclusive (default 1)." },
			length: { type: "number", description: "Length for string/bytes (default 16)." },
			alphabet: { type: "string", description: "Characters to draw from for string (default alphanumeric)." },
		},
	},
	cacheable: false,
	raw: true,
	run: async (_env, args) => {
		const kind = String(args?.kind ?? "");

		if (kind === "int") {
			const min = Math.trunc(Number(args?.min ?? 0));
			const max = Math.trunc(Number(args?.max ?? 100));
			if (!Number.isFinite(min) || !Number.isFinite(max)) return fail("int: min and max must be finite numbers.");
			if (max < min) return fail("int: max must be >= min.");
			const span = max - min + 1; // inclusive
			return ok(String(min + randInt(span)));
		}

		if (kind === "float") {
			const min = Number(args?.min ?? 0);
			const max = Number(args?.max ?? 1);
			if (!Number.isFinite(min) || !Number.isFinite(max)) return fail("float: min and max must be finite numbers.");
			if (max < min) return fail("float: max must be >= min.");
			// 53-bit uniform mantissa in [0,1).
			const buf = crypto.getRandomValues(new Uint32Array(2));
			const hi = buf[0] >>> 5; // 27 bits
			const lo = buf[1] >>> 6; // 26 bits
			const unit = (hi * 0x4000000 + lo) / 0x20000000000000; // /2^53
			return ok(String(min + unit * (max - min)));
		}

		if (kind === "string") {
			const length = Math.max(0, Math.trunc(Number(args?.length ?? 16)) || 0);
			const alphabet = typeof args?.alphabet === "string" && args.alphabet.length ? String(args.alphabet) : DEFAULT_ALPHABET;
			let s = "";
			for (let i = 0; i < length; i++) s += alphabet[randInt(alphabet.length)];
			return ok(s);
		}

		if (kind === "bytes") {
			const length = Math.max(0, Math.trunc(Number(args?.length ?? 16)) || 0);
			return ok(toB64(crypto.getRandomValues(new Uint8Array(length))));
		}

		return fail("kind must be int | float | string | bytes.");
	},
};
