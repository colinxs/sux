import { type Fn, fail, ok } from "../registry";

// URL-safe nanoid alphabet (default from the nanoid library).
const NANO_ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

export const uuid: Fn = {
	name: "uuid",
	description:
		"Generate identifiers. kind: v4 (default) | nanoid | hex. count default 1. size (nanoid/hex length) default 21 for nanoid, 16 for hex. Returns one per line, or a JSON array when count>1.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: [],
		properties: {
			kind: { type: "string", enum: ["v4", "nanoid", "hex"], default: "v4" },
			count: { type: "number", default: 1, description: "How many to generate (1-1000)." },
			size: { type: "number", description: "Length for nanoid (default 21) or hex bytes (default 16)." },
		},
	},
	cacheable: false,
	raw: true,
	run: async (_env, args) => {
		const kind = String(args?.kind ?? "v4");
		if (!["v4", "nanoid", "hex"].includes(kind)) return fail("kind must be v4 | nanoid | hex.");
		const count = Math.min(1000, Math.max(1, Math.trunc(Number(args?.count ?? 1)) || 1));

		const one = (): string => {
			if (kind === "v4") return crypto.randomUUID();
			if (kind === "nanoid") {
				const size = Math.max(1, Math.trunc(Number(args?.size ?? 21)) || 21);
				const bytes = crypto.getRandomValues(new Uint8Array(size));
				let s = "";
				for (let i = 0; i < size; i++) s += NANO_ALPHABET[bytes[i] & 63];
				return s;
			}
			// hex: `size` bytes -> 2*size hex chars.
			const size = Math.max(1, Math.trunc(Number(args?.size ?? 16)) || 16);
			const bytes = crypto.getRandomValues(new Uint8Array(size));
			return Array.from(bytes)
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
		};

		const out = Array.from({ length: count }, one);
		return ok(count > 1 ? JSON.stringify(out, null, 2) : out[0]);
	},
};
