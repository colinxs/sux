import { type Fn, fail, ok } from "../registry";
import { hasAI, MODELS } from "../ai";
import { fromB64, loadBytes } from "./_util";

export const ocr: Fn = {
	name: "ocr",
	cost: 2,
	description: "Extract text from an image with Workers AI vision. Give `url` (fetched via proxy) or `image` (base64). prompt customizes the instruction (default: transcribe all text).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			url: { type: "string", description: "Image URL." },
			image: { type: "string", description: "Base64-encoded image." },
			prompt: { type: "string", default: "Transcribe all text in this image exactly." },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		if (!hasAI(env)) return fail("Workers AI binding not configured (add \"ai\" to wrangler).");
		// Workers AI vision wants a number[] — adapt from base64 (data-URI tolerated)
		// or the shared _util.loadBytes URL path (binary-safe proxy, /s/ refs).
		let bytes: number[];
		try {
			if (args?.image) bytes = Array.from(fromB64(String(args.image).replace(/^data:[^,]+,/, "")));
			else if (args?.url) {
				if (!/^https?:\/\//i.test(String(args.url))) return fail("url must be absolute http(s).");
				bytes = Array.from((await loadBytes(env, { url: String(args.url) })).bytes);
			} else return fail("Provide `url` or `image`.");
		} catch (e) {
			return fail(`Could not load image: ${String((e as Error).message ?? e)}`);
		}
		try {
			const r = await (env as any).AI.run(MODELS.vision, { image: bytes, prompt: String(args?.prompt ?? "Transcribe all text in this image exactly."), max_tokens: 1024 });
			return ok(String(r?.description ?? r?.response ?? "").trim() || "(no text found)");
		} catch (e) {
			return fail(`ocr failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
