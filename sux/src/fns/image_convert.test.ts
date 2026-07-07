import { describe, expect, it } from "vitest";
import { imageConvert } from "./image_convert";

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
// Minimal MP4: "ftyp" box at offset 4.
const MP4 = btoa(String.fromCharCode(0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, ...Array(16).fill(0)));

function mockImagesEnv(captured: any) {
	return {
		IMAGES: {
			input: (_bytes: any) => ({
				transform: (t: any) => {
					captured.t = t;
					return {
						output: async (o: any) => {
							captured.o = o;
							return { response: () => new Response(new Uint8Array([9, 9, 9])) };
						},
					};
				},
			}),
		},
	} as any;
}

describe("image_convert", () => {
	it("transforms via the Images binding and passes options through", async () => {
		const cap: any = {};
		const r = await imageConvert.run(mockImagesEnv(cap), { image: PNG_1x1, to: "webp", width: 100, fit: "cover", quality: 80 });
		expect(r.isError).toBeFalsy();
		expect(cap.t).toMatchObject({ width: 100, fit: "cover" });
		expect(cap.o).toMatchObject({ format: "image/webp", quality: 80 });
		// Standard inline envelope: { mime, size, base64 }.
		const j = JSON.parse(r.content[0].text);
		expect(j.mime).toBe("image/webp");
		expect(j.size).toBe(3);
		expect(atob(j.base64)).toBe("\t\t\t"); // bytes 9,9,9
	});

	it("rejects an unsupported target format", async () => {
		const r = await imageConvert.run(mockImagesEnv({}), { image: PNG_1x1, to: "gif" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/to.*must be one of/);
	});

	it("rejects video input with a clear best-effort message", async () => {
		const r = await imageConvert.run(mockImagesEnv({}), { image: MP4, to: "png" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Video input detected/);
	});

	it("degrades gracefully when the Images binding is absent", async () => {
		const r = await imageConvert.run({} as any, { image: PNG_1x1, to: "png" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Cloudflare Images binding/);
	});

	it("requires an image or url", async () => {
		const r = await imageConvert.run(mockImagesEnv({}), { to: "png" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Provide `image`/);
	});

	it('as:"url" stores the output in the CAS store and returns a compact ref', async () => {
		const env = mockImagesEnv({});
		env.R2 = { put: async () => {} };
		env.OAUTH_KV = { put: async () => {} };
		const r = await imageConvert.run(env, { image: PNG_1x1, to: "webp", as: "url" });
		expect(r.isError).toBeFalsy();
		const ref = JSON.parse(r.content[0].text);
		expect(ref.url).toMatch(/\/s\/[0-9a-f-]{36}$/);
		expect(ref.content_type).toBe("image/webp");
		expect(ref.size).toBe(3); // the mocked 9,9,9 bytes
	});
});
