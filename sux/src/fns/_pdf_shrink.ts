import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";
import { MAX_PDF_INPUT_BYTES, MAX_PDF_OBJECTS } from "@suxos/lib";
import type { RtEnv } from "../registry";
import { errMsg } from "./_util";

// _pdf_shrink — the optimize-original leg (v5 W4, #1276): recompress a PDF's
// embedded raster page images so the R2 CAS archive tier stays cheap enough to
// keep everything (arc doc G4 — "store OPTIMIZED original (pdf shrink)"). This is
// the one oracle stage the v5 design audit found missing: today's structural
// shrink (@suxos/lib's pdfShrink — xref object streams + metadata strip) does
// nothing for a scanned book's dominant cost, the embedded page images.
//
// Approach (#1187 Part 3, verbatim): walk the document's indirect objects for
// `/Subtype /Image` XObjects (the same context walk @suxos/lib's pdfShrink uses
// for /Metadata keys — same traversal, new target), and recompress each embedded
// JPEG through the already-wired Cloudflare Images binding (`env.IMAGES`, the same
// binding image_convert.ts uses) at a configurable maxDpi/quality (default 150 DPI
// / quality 75), replacing the XObject's stream with the smaller bytes.
//
// DUAL-PACKAGE HAZARD (#1276, and pdf.ts's own note): sux and @suxos/lib each
// resolve their OWN installed copy of pdf-lib, so a PDFDocument produced by one
// instance breaks method calls (copyPages/save/…) made from the other. Every
// PDFDocument here is built AND consumed with SUX's pdf-lib instance only — nothing
// but raw bytes ever crosses the sux/suxlib boundary. The bomb-guard LIMITS are
// reused from @suxos/lib (imported constants — one source of truth, so a suxlib
// bump carries here) rather than re-hardcoded; but the load/walk/save runs on sux's
// own pdf-lib, never suxlib's loadBoundedPdf() (which would hand back a
// cross-instance PDFDocument this code must not touch).
//
// FAIL-OPEN (hard): every gate returns the ORIGINAL bytes unchanged rather than
// throwing — an already-small PDF, one with no recompressible raster images, a
// codec failure, or a parse error all degrade to "archive the original," never to
// a lost document. Callers (study.archiveKnowledge, the _assimilate spine's
// optimize-original leg) archive `bytes` and only prefer the result when `shrunk`.

export type PdfImageShrinkOptions = {
	/** Downscale any embedded image whose longest pixel edge exceeds ~maxDpi × a
	 *  Letter page's long side (11 in) before re-encoding — a KISS stand-in for true
	 *  per-image on-page DPI, which would need content-stream CTM parsing. Default 150. */
	maxDpi?: number;
	/** JPEG re-encode quality handed to the Images binding (1–100). Default 75. */
	quality?: number;
};

export type PdfImageShrinkResult = {
	/** The optimized bytes when `shrunk`; otherwise the ORIGINAL input, unchanged
	 *  (same reference — a caller can compare identity to know nothing happened). */
	bytes: Uint8Array;
	inputBytes: number;
	outputBytes: number;
	/** True iff ≥1 image was recompressed AND the whole document got strictly smaller. */
	shrunk: boolean;
	imagesRecompressed: number;
	/** Present on a no-op — the fail-open reason (why the original was kept). */
	note?: string;
};

const DEFAULT_MAX_DPI = 150;
const DEFAULT_QUALITY = 75;
/** maxDpi × a Letter page's long edge (inches) = the max pixel long-edge we keep. */
const LETTER_LONG_IN = 11;

function keepOriginal(input: Uint8Array, note: string, imagesRecompressed = 0): PdfImageShrinkResult {
	return { bytes: input, inputBytes: input.length, outputBytes: input.length, shrunk: false, imagesRecompressed, note };
}

/** Read a JPEG's frame header (SOFn) → its true pixel dimensions and component
 *  count. Component count is the ground truth for the recompressed image's
 *  colorspace (1 = grayscale, 3 = YCbCr/RGB, 4 = YCCK/CMYK — which we refuse, since
 *  the Images binding decodes to sRGB and an RGB /ColorSpace over CMYK samples would
 *  corrupt the page). Returns null for anything that isn't a parseable JPEG (SOF
 *  always precedes the SOS scan header, so this never needs to walk entropy data). */
export function jpegFrameInfo(b: Uint8Array): { width: number; height: number; components: number } | null {
	if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
	let i = 2;
	while (i < b.length - 1) {
		if (b[i] !== 0xff) {
			i++;
			continue;
		}
		const marker = b[i + 1];
		if (marker === 0xff) {
			i++; // fill byte before the real marker
			continue;
		}
		// Standalone markers carry no length payload: TEM (0x01), RSTn (0xD0–0xD7),
		// SOI (0xD8), EOI (0xD9).
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
			i += 2;
			continue;
		}
		if (i + 3 >= b.length) break;
		const len = (b[i + 2] << 8) | b[i + 3];
		// SOFn frame headers: 0xC0–0xCF except DHT (0xC4), JPG (0xC8), DAC (0xCC).
		const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isSOF) {
			const p = i + 4; // past marker(2) + segment length(2)
			if (p + 5 >= b.length) return null;
			const height = (b[p + 1] << 8) | b[p + 2];
			const width = (b[p + 3] << 8) | b[p + 4];
			const components = b[p + 5];
			return width > 0 && height > 0 ? { width, height, components } : null;
		}
		i += 2 + len; // skip this segment (len counts the 2 length bytes, not the marker)
	}
	return null;
}

const num = (v: number) => PDFNumber.of(v);

/**
 * Recompress a PDF's embedded raster page images. Fail-open: returns the original
 * bytes unchanged (never throws) whenever it can't help. See the module header for
 * the dual-package boundary rule and the #1187 approach.
 */
export async function shrinkPdfImages(env: RtEnv, input: Uint8Array, opts: PdfImageShrinkOptions = {}): Promise<PdfImageShrinkResult> {
	if (!env.IMAGES) return keepOriginal(input, "no Images binding (IMAGES) configured — original archived unchanged");
	// Pre-parse byte cap — the first, cheapest bomb guard (reused limit, @suxos/lib).
	if (input.length > MAX_PDF_INPUT_BYTES) return keepOriginal(input, `PDF exceeds the ${MAX_PDF_INPUT_BYTES}-byte guard — not recompressed`);

	const maxDpi = typeof opts.maxDpi === "number" && opts.maxDpi > 0 ? opts.maxDpi : DEFAULT_MAX_DPI;
	const quality = typeof opts.quality === "number" && opts.quality >= 1 && opts.quality <= 100 ? opts.quality : DEFAULT_QUALITY;
	const maxEdge = Math.round(maxDpi * LETTER_LONG_IN);

	try {
		const doc = await PDFDocument.load(input, { updateMetadata: false });
		// Post-parse object-count cap — bounds the retained graph (reused limit).
		if (doc.context.enumerateIndirectObjects().length > MAX_PDF_OBJECTS) return keepOriginal(input, `PDF exceeds the ${MAX_PDF_OBJECTS}-object guard — not recompressed`);

		let recompressed = 0;
		let attempted = 0;
		for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
			if (!(obj instanceof PDFRawStream)) continue;
			const dict = obj.dict;
			if (dict.get(PDFName.of("Subtype"))?.toString() !== "/Image") continue;
			// Only a single DCTDecode (baseline/progressive JPEG) stream is a standalone
			// image file the Images binding can decode directly. A filter ARRAY (chained
			// filters), Flate raw samples, CCITTFax, or JPX would need colorspace/bit-depth
			// reconstruction to re-encode — out of scope (KISS); left untouched.
			if (dict.get(PDFName.of("Filter"))?.toString() !== "/DCTDecode") continue;
			// Transparency/stencil carriers: re-encoding to an opaque JPEG would silently
			// drop the alpha/mask, so skip them.
			if (dict.get(PDFName.of("SMask")) !== undefined || dict.get(PDFName.of("Mask")) !== undefined) continue;
			if (dict.get(PDFName.of("ImageMask"))?.toString() === "true") continue;

			const raw = obj.contents;
			const src = jpegFrameInfo(raw);
			if (!src || src.components === 4) continue; // unparseable, or CMYK/YCCK

			attempted++;
			try {
				const transform: Record<string, unknown> = {};
				if (Math.max(src.width, src.height) > maxEdge) {
					transform.width = maxEdge;
					transform.height = maxEdge;
					transform.fit = "scale-down"; // bound the long edge, keep aspect, never upscale
				}
				const result = await env.IMAGES.input(raw).transform(transform).output({ format: "image/jpeg", quality });
				const nb = new Uint8Array(await result.response().arrayBuffer());
				const out = jpegFrameInfo(nb);
				if (!out || nb.length >= raw.length) continue; // unusable output, or no saving — keep the original stream

				// The recompressed JPEG's own SOF is the source of truth for the new dict —
				// the Images binding may aspect-fit to different dims than requested, and it
				// always emits sRGB/grayscale, so /ColorSpace follows the output components.
				dict.set(PDFName.of("Width"), num(out.width));
				dict.set(PDFName.of("Height"), num(out.height));
				dict.set(PDFName.of("ColorSpace"), PDFName.of(out.components === 1 ? "DeviceGray" : "DeviceRGB"));
				dict.set(PDFName.of("BitsPerComponent"), num(8));
				dict.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
				dict.set(PDFName.of("Length"), num(nb.length));
				dict.delete(PDFName.of("DecodeParms")); // belonged to the replaced encoding
				dict.delete(PDFName.of("Decode"));
				doc.context.assign(ref, PDFRawStream.of(dict, nb));
				recompressed++;
			} catch (e) {
				// One image failing to recompress never aborts the pass — the rest still shrink.
				console.log(`pdf-shrink: image recompress skipped: ${errMsg(e)}`);
			}
		}

		if (recompressed === 0) {
			return keepOriginal(
				input,
				attempted > 0
					? "raster images found but none recompressed smaller (codec grew them or failed) — original preserved"
					: "no recompressible raster images (text/vector, or unsupported filter/colorspace)",
			);
		}

		const outBytes = await doc.save({ useObjectStreams: true });
		if (outBytes.length >= input.length) return keepOriginal(input, "recompression did not reduce total document size — original preserved", recompressed);
		return { bytes: outBytes, inputBytes: input.length, outputBytes: outBytes.length, shrunk: true, imagesRecompressed: recompressed };
	} catch (e) {
		return keepOriginal(input, `shrink failed, original preserved: ${errMsg(e)}`);
	}
}
