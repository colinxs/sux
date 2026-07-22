import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { MAX_PDF_INPUT_BYTES } from "@suxos/lib";
import type { RtEnv } from "../registry";
import { fromB64 } from "./_util";
import { jpegFrameInfo, shrinkPdfImages } from "./_pdf_shrink";

// Real baseline JPEGs (PIL, noisy RGB so they don't over-compress): BIG is 64×64
// (~4KB) and gets embedded as a DCTDecode XObject; SMALL is 24×24 (~800B) and is
// what the mock Images binding returns, so replacing BIG→SMALL shrinks the PDF.
const BIG_JPEG =
	"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";
const SMALL_JPEG =
	"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABsSFBcUERsXFhceHBsgKEIrKCUlKFE6PTBCYFVlZF9VXVtqeJmBanGQc1tdhbWGkJ6jq62rZ4C8ybqmx5moq6T/2wBDARweHigjKE4rK06kbl1upKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKT/wAARCAAYABgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwBctKc4dQBnaQCWwevv/n60zzBsDbdozggHgA5xuPP8utNd3XgloyWG0bcdfTHTnHOfyxTnDIxRSzZO8Ax8ngD8e/H6UbuxKS3GKzlQoG8E8KBjOcgcDJ4/zmipV/eBNxG7PDbcDbwTyfTnP1ooc2t0aXtuDgtJkszA5Deozz/hjjrT0IKBUAZGJJUsRg+579B/+sUUU5LRMm19BgIWN/MDMF4bHBHXPHpn9TRRRTpttaOxtTpxne5//9k=";

function bigJpeg(): Uint8Array {
	return fromB64(BIG_JPEG);
}
function smallJpeg(): Uint8Array {
	return fromB64(SMALL_JPEG);
}

/** A minimal mock of the Cloudflare Images binding that always returns `out`,
 *  optionally recording the input bytes / transform / output opts it received. */
function mockImages(out: Uint8Array, spy?: { input?: Uint8Array; transform?: unknown; output?: unknown }) {
	return {
		input: (bytes: Uint8Array) => {
			if (spy) spy.input = bytes;
			return {
				transform: (t: unknown) => {
					if (spy) spy.transform = t;
					return {
						output: async (o: unknown) => {
							if (spy) spy.output = o;
							return { response: () => new Response(out) };
						},
					};
				},
			};
		},
	};
}

const envWith = (images: unknown): RtEnv => ({ IMAGES: images }) as unknown as RtEnv;

async function pdfWithImage(jpeg: Uint8Array): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const img = await doc.embedJpg(jpeg);
	doc.addPage([200, 200]).drawImage(img, { x: 0, y: 0, width: 120, height: 120 });
	return doc.save({ useObjectStreams: true });
}

async function emptyPdf(): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	doc.addPage([200, 200]); // no raster XObjects
	return doc.save({ useObjectStreams: true });
}

function imageStreams(doc: PDFDocument): PDFRawStream[] {
	const out: PDFRawStream[] = [];
	for (const [, obj] of doc.context.enumerateIndirectObjects()) {
		if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of("Subtype"))?.toString() === "/Image") out.push(obj);
	}
	return out;
}

describe("jpegFrameInfo", () => {
	it("reads a JPEG's SOF dimensions and component count", () => {
		expect(jpegFrameInfo(bigJpeg())).toEqual({ width: 64, height: 64, components: 3 });
		expect(jpegFrameInfo(smallJpeg())).toEqual({ width: 24, height: 24, components: 3 });
	});
	it("returns null for non-JPEG bytes", () => {
		expect(jpegFrameInfo(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull();
		expect(jpegFrameInfo(new Uint8Array([]))).toBeNull();
	});
});

describe("shrinkPdfImages — the optimize-original leg (#1276)", () => {
	it("recompresses an embedded JPEG XObject and the PDF gets strictly smaller", async () => {
		const src = await pdfWithImage(bigJpeg());
		const small = smallJpeg();
		const spy: { input?: Uint8Array } = {};
		const r = await shrinkPdfImages(envWith(mockImages(small, spy)), src);

		expect(r.shrunk).toBe(true);
		expect(r.imagesRecompressed).toBe(1);
		expect(r.outputBytes).toBeLessThan(r.inputBytes);
		expect(r.bytes).not.toBe(src);
		// The binding was handed the embedded JPEG stream bytes, not the whole PDF.
		expect(spy.input && jpegFrameInfo(spy.input)).toEqual({ width: 64, height: 64, components: 3 });

		// The output PDF reloads and its image stream is now the small JPEG with matching dims.
		const out = await PDFDocument.load(r.bytes, { updateMetadata: false });
		const streams = imageStreams(out);
		expect(streams).toHaveLength(1);
		expect(streams[0].contents.length).toBe(small.length);
		expect(streams[0].dict.get(PDFName.of("Width"))?.toString()).toBe("24");
		expect(streams[0].dict.get(PDFName.of("Height"))?.toString()).toBe("24");
		expect(streams[0].dict.get(PDFName.of("Filter"))?.toString()).toBe("/DCTDecode");
	});

	it("passes a text/vector-only PDF through unchanged (no raster XObjects)", async () => {
		const src = await emptyPdf();
		const r = await shrinkPdfImages(envWith(mockImages(smallJpeg())), src);
		expect(r.shrunk).toBe(false);
		expect(r.imagesRecompressed).toBe(0);
		expect(r.bytes).toBe(src); // same reference — a true no-op
		expect(r.note).toMatch(/no recompressible raster images/);
	});

	it("downscales an oversized image and forwards maxDpi/quality to the binding", async () => {
		const src = await pdfWithImage(bigJpeg()); // 64px long edge
		const spy: { transform?: any; output?: any } = {};
		// maxDpi 5 → maxEdge = 5×11 = 55 < 64, so the image is downscaled.
		const r = await shrinkPdfImages(envWith(mockImages(smallJpeg(), spy)), src, { maxDpi: 5, quality: 40 });
		expect(r.shrunk).toBe(true);
		expect(spy.transform).toMatchObject({ width: 55, height: 55, fit: "scale-down" });
		expect(spy.output).toMatchObject({ format: "image/jpeg", quality: 40 });
	});

	it("fails open when the Images binding is not configured", async () => {
		const src = await pdfWithImage(bigJpeg());
		const r = await shrinkPdfImages({} as RtEnv, src);
		expect(r.shrunk).toBe(false);
		expect(r.bytes).toBe(src);
		expect(r.note).toMatch(/Images binding/i);
	});

	it("fails open when the Images binding throws — the original is preserved", async () => {
		const src = await pdfWithImage(bigJpeg());
		const boom = {
			input: () => ({ transform: () => ({ output: async () => { throw new Error("images down"); } }) }),
		};
		const r = await shrinkPdfImages(envWith(boom), src);
		expect(r.shrunk).toBe(false);
		expect(r.bytes).toBe(src);
	});

	it("fails open on unparseable / non-PDF bytes", async () => {
		const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
		const r = await shrinkPdfImages(envWith(mockImages(smallJpeg())), junk);
		expect(r.shrunk).toBe(false);
		expect(r.bytes).toBe(junk);
		expect(r.note).toMatch(/shrink failed/);
	});

	it("enforces the reused MAX_PDF_INPUT_BYTES bomb guard before touching the binding", async () => {
		const spy: { input?: Uint8Array } = {};
		const oversize = new Uint8Array(MAX_PDF_INPUT_BYTES + 1);
		const r = await shrinkPdfImages(envWith(mockImages(smallJpeg(), spy)), oversize);
		expect(r.shrunk).toBe(false);
		expect(r.note).toMatch(new RegExp(String(MAX_PDF_INPUT_BYTES)));
		expect(spy.input).toBeUndefined(); // short-circuited before any load or codec call
	});

	it("keeps the original when recompression does not reduce total size", async () => {
		// The binding echoes the SAME (large) JPEG back, so no per-image saving is possible.
		const big = bigJpeg();
		const src = await pdfWithImage(big);
		const r = await shrinkPdfImages(envWith(mockImages(big)), src);
		expect(r.shrunk).toBe(false);
		expect(r.bytes).toBe(src);
	});
});
