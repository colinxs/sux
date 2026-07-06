import { type Fn, fail, ok } from "../registry";
import { fromB64, isHttpUrl, toB64 } from "./_util";
import { smartFetch } from "../proxy";

const MIME: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", avif: "image/avif" };

/** Best-effort detection of a video container, so we can fail it clearly. */
function looksLikeVideo(b: Uint8Array): boolean {
	if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return true; // ...ftyp (mp4/mov)
	if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true; // EBML (webm/mkv)
	if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x41 && b[9] === 0x56 && b[10] === 0x49) return true; // RIFF..AVI
	return false;
}

export const imageConvert: Fn = {
	name: "image_convert",
	description:
		"Transform an image: convert format (png, jpeg, webp, avif), resize, and apply light adjustments via the Cloudflare Images binding. " +
		"Give `image` (base64) or `url`, and `to` (target format). Options: width, height, fit (scale-down|contain|cover|crop|pad), rotate (90|180|270), quality (1-100), blur (1-250), sharpen (0-10), brightness, contrast, gamma. " +
		"Returns the transformed image as base64. Best-effort: needs the Cloudflare Images binding (IMAGES) at runtime; video is not supported here (use Cloudflare Media Transformations) and is rejected with a clear message.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["to"],
		properties: {
			url: { type: "string", description: "Source image URL (fetched via the residential proxy)." },
			image: { type: "string", description: "Base64 image bytes." },
			to: { type: "string", enum: ["png", "jpeg", "webp", "avif"] },
			width: { type: "integer", minimum: 1 },
			height: { type: "integer", minimum: 1 },
			fit: { type: "string", enum: ["scale-down", "contain", "cover", "crop", "pad"] },
			rotate: { type: "integer", enum: [90, 180, 270] },
			quality: { type: "integer", minimum: 1, maximum: 100 },
			blur: { type: "number", minimum: 1, maximum: 250 },
			sharpen: { type: "number", minimum: 0, maximum: 10 },
			brightness: { type: "number", minimum: 0 },
			contrast: { type: "number", minimum: 0 },
			gamma: { type: "number", minimum: 0 },
		},
	},
	cacheable: true,
	raw: true,
	run: async (env, args) => {
		const to = String(args?.to ?? "");
		if (!MIME[to]) return fail("`to` must be one of: png, jpeg, webp, avif.");

		// Load source bytes.
		let bytes: Uint8Array;
		try {
			if (typeof args?.image === "string" && args.image) bytes = fromB64(args.image);
			else if (isHttpUrl(args?.url)) {
				const resp = await smartFetch(env, String(args.url), {});
				if (!resp.ok) return fail(`Failed to fetch image: HTTP ${resp.status}`);
				bytes = new Uint8Array(await resp.arrayBuffer());
			} else return fail("Provide `image` (base64) or a fetchable `url`.");
		} catch (e) {
			return fail(`Could not read source image: ${String((e as Error).message ?? e)}`);
		}

		if (looksLikeVideo(bytes)) {
			return fail("Video input detected. Video transforms aren't wired here (they'd need Cloudflare Media Transformations) — not critical, skipping.");
		}
		if (!env.IMAGES) {
			return fail("image_convert needs the Cloudflare Images binding (IMAGES), not available in this environment.");
		}

		// Build the transform option set from the provided args.
		const t: Record<string, unknown> = {};
		for (const k of ["width", "height", "rotate", "blur", "sharpen", "brightness", "contrast", "gamma"] as const) {
			if (typeof args?.[k] === "number") t[k] = args[k];
		}
		if (typeof args?.fit === "string") t.fit = args.fit;

		try {
			const out: Record<string, unknown> = { format: MIME[to] };
			if (typeof args?.quality === "number") out.quality = args.quality;
			const result = await env.IMAGES.input(bytes).transform(t).output(out);
			const resultBytes = new Uint8Array(await result.response().arrayBuffer());
			return ok(toB64(resultBytes));
		} catch (e) {
			return fail(`image_convert failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
