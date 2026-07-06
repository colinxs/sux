import { type Fn, fail, ok } from "../registry";

const ALGOS: Record<string, string> = { sha256: "SHA-256", sha384: "SHA-384", sha512: "SHA-512", sha1: "SHA-1" };

export const hash: Fn = {
	name: "hash",
	description: "Compute a cryptographic hash of text. algo: sha256 (default) | sha384 | sha512 | sha1.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text"],
		properties: {
			text: { type: "string" },
			algo: { type: "string", enum: Object.keys(ALGOS), default: "sha256" },
		},
	},
	cacheable: true,
	raw: true,
	run: async (_env, args) => {
		const algo = ALGOS[String(args?.algo ?? "sha256")];
		if (!algo) return fail(`Unknown algo. Use: ${Object.keys(ALGOS).join(", ")}`);
		const buf = await crypto.subtle.digest(algo, new TextEncoder().encode(String(args?.text ?? "")));
		const hex = Array.from(new Uint8Array(buf))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		return ok(hex);
	},
};
