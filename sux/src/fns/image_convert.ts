import { type Fn, fail } from "../registry";

export const imageConvert: Fn = {
	name: "image_convert",
	description: "Convert/resize images between png, jpeg, webp, avif. Requires Cloudflare Images or a WASM codec (Photon/wasm-vips) — not wired yet (P5). The signature is stable.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["to"],
		properties: {
			url: { type: "string" },
			image: { type: "string", description: "Base64 image bytes." },
			to: { type: "string", enum: ["png", "jpeg", "webp", "avif"] },
			width: { type: "integer" },
			height: { type: "integer" },
			quality: { type: "integer", minimum: 1, maximum: 100 },
		},
	},
	cacheable: true,
	run: async () => fail("image_convert needs Cloudflare Images or a WASM codec (Photon/wasm-vips), not wired yet — see PLAN P5."),
};
