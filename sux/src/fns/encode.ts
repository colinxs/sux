import { type Fn, fail, ok } from "../registry";

export const encode: Fn = {
	name: "encode",
	description: "Encode or decode text. codec: base64 | hex | url. direction: encode (default) | decode.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text", "codec"],
		properties: {
			text: { type: "string" },
			codec: { type: "string", enum: ["base64", "hex", "url"] },
			direction: { type: "string", enum: ["encode", "decode"], default: "encode" },
		},
	},
	cacheable: true,
	raw: true,
	run: async (_env, args) => {
		const text = String(args?.text ?? "");
		const codec = String(args?.codec ?? "");
		const decode = args?.direction === "decode";
		try {
			if (codec === "url") return ok(decode ? decodeURIComponent(text) : encodeURIComponent(text));
			if (codec === "base64") {
				if (decode) return ok(new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0))));
				return ok(btoa(String.fromCharCode(...new TextEncoder().encode(text))));
			}
			if (codec === "hex") {
				if (decode) {
					const bytes = text.match(/.{1,2}/g)?.map((h) => parseInt(h, 16)) ?? [];
					return ok(new TextDecoder().decode(Uint8Array.from(bytes)));
				}
				return ok(Array.from(new TextEncoder().encode(text)).map((b) => b.toString(16).padStart(2, "0")).join(""));
			}
			return fail("codec must be base64 | hex | url");
		} catch (e) {
			return fail(`${decode ? "decode" : "encode"} failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
