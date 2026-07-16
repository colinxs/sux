import { type Fn, fail, ok } from "../registry";
import { errMsg, fromB64, toB64 } from "./_util";

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
	ttl: 86400, // pure deterministic transform — encode/decode output never changes
	raw: true,
	run: async (_env, args) => {
		const text = String(args?.text ?? "");
		const codec = String(args?.codec ?? "");
		const decode = args?.direction === "decode";
		try {
			if (codec === "url") return ok(decode ? decodeURIComponent(text) : encodeURIComponent(text));
			if (codec === "base64") {
				if (decode) return ok(new TextDecoder().decode(fromB64(text)));
				return ok(toB64(new TextEncoder().encode(text)));
			}
			if (codec === "hex") {
				if (decode) {
					const clean = text.replace(/\s+/g, "");
						if (!/^([0-9a-f]{2})*$/i.test(clean)) return fail("hex decode input must be whitespace-separated pairs of hex digits");
						const bytes = clean.match(/.{2}/g)?.map((h) => parseInt(h, 16)) ?? [];
					return ok(new TextDecoder().decode(Uint8Array.from(bytes)));
				}
				return ok(Array.from(new TextEncoder().encode(text)).map((b) => b.toString(16).padStart(2, "0")).join(""));
			}
			return fail("codec must be base64 | hex | url");
		} catch (e) {
			return fail(`${decode ? "decode" : "encode"} failed: ${errMsg(e)}`);
		}
	},
};
