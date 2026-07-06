import { type Fn, fail, ok } from "../registry";
import { deliverBytes } from "./_util";

export const qr: Fn = {
	name: "qr",
	description:
		"Encode text into a QR code PNG or decode a QR image back to text. direction: encode (default; give `data`) | decode (give `image` as a url or base64). size is the PNG edge in px for encode. " +
		'`as: "url"` stores the PNG in the content-addressed R2 store and returns { url, sha256, size } (~100 tokens) instead of inline base64.',
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			data: { type: "string", description: "Text/URL to encode." },
			image: { type: "string", description: "QR image to decode: http(s) url or base64 PNG/JPEG." },
			direction: { type: "string", enum: ["encode", "decode"], default: "encode" },
			size: { type: "integer", default: 300, minimum: 50, maximum: 1000 },
			as: { type: "string", enum: ["base64", "url"], default: "base64", description: "Delivery: inline base64 (default) or a content-addressed /s/<uuid> URL." },
		},
	},
	cacheable: true,
	raw: true,
	run: async (env, args) => {
		if (String(args?.direction ?? "encode") === "decode") {
			const image = String(args?.image ?? "");
			if (!image) return fail("Provide `image` (url or base64) to decode.");
			const form = new FormData();
			if (/^https?:\/\//i.test(image)) form.append("fileurl", image);
			else {
				const bytes = Uint8Array.from(atob(image.replace(/^data:[^,]+,/, "")), (c) => c.charCodeAt(0));
				form.append("file", new Blob([bytes]), "qr.png");
			}
			const resp = await fetch("https://api.qrserver.com/v1/read-qr-code/", { method: "POST", body: form });
			if (!resp.ok) return fail(`QR decode failed: HTTP ${resp.status}`);
			const j = (await resp.json()) as any;
			const data = j?.[0]?.symbol?.[0]?.data;
			const err = j?.[0]?.symbol?.[0]?.error;
			if (err || data == null) return fail(`No QR found${err ? `: ${err}` : ""}.`);
			return ok(String(data));
		}
		const data = String(args?.data ?? "");
		if (!data) return fail("Provide `data` to encode.");
		const size = Number(args?.size) || 300;
		const url = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(data)}`;
		const resp = await fetch(url);
		if (!resp.ok) return fail(`QR encode failed: HTTP ${resp.status}`);
		const buf = new Uint8Array(await resp.arrayBuffer());
		return deliverBytes(env, buf, "image/png", args?.as, () => {
			let s = "";
			for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
			return ok(JSON.stringify({ mime: "image/png", size, base64: btoa(s) }));
		});
	},
};
