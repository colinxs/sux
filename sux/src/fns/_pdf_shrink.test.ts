import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { shrinkPdfImages } from "./_pdf_shrink";

// Mirrors image_convert.test.ts's mockImagesEnv shape (input().transform().output()) —
// same Cloudflare Images binding, so the same mock idiom applies here.
function mockImagesEnv(outputBytes: Uint8Array, captured?: { t?: unknown; o?: unknown }) {
	return {
		IMAGES: {
			input: (_bytes: Uint8Array) => ({
				transform: (t: unknown) => {
					if (captured) captured.t = t;
					return {
						output: async (o: unknown) => {
							if (captured) captured.o = o;
							return { response: () => new Response(outputBytes) };
						},
					};
				},
			}),
		},
	} as any;
}

/** A PDF with one Image XObject stream registered directly on the context (not wired
 *  into any page's /Resources) — pdf-lib's writer serializes every
 *  context.enumerateIndirectObjects() entry regardless of trailer-reachability (the
 *  same behavior @suxos/lib's pdf.ts documents and relies on for its own metadata
 *  walk), so shrinkPdfImages' walk finds it on both the original save and after a
 *  reload, without needing full page/content-stream wiring. */
async function pdfWithImageXObject(opts: { contents: Uint8Array; width: number; height: number; filter?: string }): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	doc.addPage([100, 100]);
	const dict: Record<string, string | number> = { Type: "XObject", Subtype: "Image", Width: opts.width, Height: opts.height, BitsPerComponent: 8, ColorSpace: "DeviceRGB" };
	if (opts.filter) dict.Filter = opts.filter;
	const stream = doc.context.stream(opts.contents, dict);
	doc.context.register(stream);
	return doc.save();
}

/** Find the one Image XObject in a saved PDF's indirect-object graph (test helper only). */
async function loadImageDict(bytes: Uint8Array) {
	const doc = await PDFDocument.load(bytes);
	for (const [, obj] of doc.context.enumerateIndirectObjects()) {
		if (!(obj instanceof PDFRawStream)) continue;
		const subtype = obj.dict.get(PDFName.of("Subtype"));
		if (subtype instanceof PDFName && subtype.asString() === "/Image") return obj;
	}
	return undefined;
}

describe("shrinkPdfImages", () => {
	it("recompresses a DCTDecode image XObject when the mocked Images output is smaller", async () => {
		const original = new Uint8Array(500).fill(7);
		const bytes = await pdfWithImageXObject({ contents: original, width: 2000, height: 1000, filter: "DCTDecode" });
		const smaller = new Uint8Array(50).fill(1);
		const captured: { t?: unknown; o?: unknown } = {};

		const result = await shrinkPdfImages(mockImagesEnv(smaller, captured), bytes);

		expect(result.imagesShrunk).toBe(1);
		expect(result.imagesSkipped).toBe(0);
		expect(result.outputBytes).toBeLessThan(result.inputBytes);
		// 150dpi-equivalent cap on US-Letter width (150 * 8.5 = 1275) caps the 2000px-wide long side.
		expect(captured.t).toMatchObject({ width: 1275 });
		expect(captured.o).toMatchObject({ format: "image/jpeg", quality: 75 });

		const img = await loadImageDict(result.bytes);
		expect(img).toBeDefined();
		expect(img!.getContents()).toEqual(smaller);
		expect(img!.dict.get(PDFName.of("Filter"))).toBe(PDFName.of("DCTDecode"));
		expect(img!.dict.get(PDFName.of("DecodeParms"))).toBeUndefined();
		const width = img!.dict.get(PDFName.of("Width"));
		expect(width).toBeInstanceOf(PDFNumber);
		expect((width as PDFNumber).asNumber()).toBe(1275);
		const height = img!.dict.get(PDFName.of("Height"));
		expect((height as PDFNumber).asNumber()).toBe(638); // 1000 * (1275/2000), rounded
	});

	it("passes a text-only / no-image PDF through unchanged", async () => {
		const doc = await PDFDocument.create();
		doc.addPage([100, 100]);
		const bytes = await doc.save();

		const result = await shrinkPdfImages(mockImagesEnv(new Uint8Array(1)), bytes);

		expect(result.imagesShrunk).toBe(0);
		expect(result.imagesSkipped).toBe(0);
		expect(result.bytes).toBe(bytes);
		expect(result.outputBytes).toBe(result.inputBytes);
	});

	it("skips an unsupported filter (e.g. a raw FlateDecode bitmap) — counted, not shrunk, no crash", async () => {
		const original = new Uint8Array(200).fill(3);
		const bytes = await pdfWithImageXObject({ contents: original, width: 100, height: 100, filter: "FlateDecode" });

		const result = await shrinkPdfImages(mockImagesEnv(new Uint8Array(1)), bytes);

		expect(result.imagesShrunk).toBe(0);
		expect(result.imagesSkipped).toBe(1);
		expect(result.bytes).toBe(bytes);
	});

	it("keeps the original when the recompressed candidate isn't actually smaller", async () => {
		const original = new Uint8Array(50).fill(9);
		const bytes = await pdfWithImageXObject({ contents: original, width: 100, height: 100, filter: "DCTDecode" });
		const notSmaller = new Uint8Array(200).fill(1);

		const result = await shrinkPdfImages(mockImagesEnv(notSmaller), bytes);

		expect(result.imagesShrunk).toBe(0);
		expect(result.imagesSkipped).toBe(1);
		expect(result.bytes).toBe(bytes);
	});

	it("degrades gracefully (no-op) when the Cloudflare Images binding is absent", async () => {
		const bytes = await pdfWithImageXObject({ contents: new Uint8Array(10), width: 100, height: 100, filter: "DCTDecode" });

		const result = await shrinkPdfImages({} as any, bytes);

		expect(result.imagesShrunk).toBe(0);
		expect(result.imagesSkipped).toBe(0);
		expect(result.bytes).toBe(bytes);
	});

	it("rejects an oversized input via the local bomb guard without throwing", async () => {
		// One byte over this module's local MAX_PDF_INPUT_BYTES (50_000_000) guard —
		// mirrors @suxos/lib's loadBoundedPdf guard shape, duplicated locally per the
		// dual-package hazard documented at the top of _pdf_shrink.ts.
		const huge = new Uint8Array(50_000_001);

		const result = await shrinkPdfImages(mockImagesEnv(new Uint8Array(1)), huge);

		expect(result.imagesShrunk).toBe(0);
		expect(result.imagesSkipped).toBe(0);
		expect(result.bytes).toBe(huge);
		expect(result.outputBytes).toBe(huge.length);
	});
});
