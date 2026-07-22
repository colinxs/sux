import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";
import type { RtEnv } from "../registry";

// _pdf_shrink — the "optimize-original" leg (v5 arc W4, #1276): real embedded-IMAGE
// recompression for a scanned-book PDF, complementing (not replacing) the purely
// structural shrink @suxos/lib's pdfShrink already does (object streams + metadata
// strip — it never touches raster content). This is new territory suxlib doesn't
// cover, so it lives here rather than as an addition to pdfShrink.
//
// DUAL-PACKAGE HAZARD (read before importing anything from @suxos/lib here): sux
// and @suxos/lib each resolve their OWN separately-installed copy of pdf-lib — a
// PDFDocument built by one fails instanceof/method calls against the other's
// classes (see fns/pdf.ts's top-of-file note, confirmed the same way there). This
// module therefore imports pdf-lib directly (sux's own copy, same as fns/pdf.ts)
// and never imports @suxos/lib's src/domain/pdf.ts — its loadBoundedPdf/pdfShrink
// are read-only design reference, not a dependency. The bomb-guard constants/logic
// below are a deliberate small duplication of that file's shape, not a shared import.

/** Reject a PDF larger than this before handing it to pdf-lib — mirrors suxlib's
 *  loadBoundedPdf (MAX_PDF_INPUT_BYTES), duplicated locally per the hazard above. */
const MAX_PDF_INPUT_BYTES = 50_000_000;

/** Reject a parsed PDF whose object graph exceeds this many indirect objects —
 *  mirrors suxlib's loadBoundedPdf (MAX_PDF_OBJECTS), duplicated locally. */
const MAX_PDF_OBJECTS = 500_000;

/** Chunked byte->latin1-string decode — avoids a call-stack blowup from spreading
 *  a huge array (mirrors suxlib's bytesToLatin1). */
function bytesToLatin1(bytes: Uint8Array): string {
	let s = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	return s;
}

/** Cheap pre-parse estimate of the declared object count straight from the raw
 *  bytes (obj headers + each object-stream's declared /N) — mirrors suxlib's
 *  estimateDeclaredPdfObjectCount; see that file for the object-stream-repetition
 *  attack this guards against. */
function estimateDeclaredPdfObjectCount(input: Uint8Array): number {
	const text = bytesToLatin1(input);
	const objHeaders = (text.match(/\d+\s+\d+\s+obj\b/g) ?? []).length;
	let objStreamObjects = 0;
	let searchFrom = 0;
	for (;;) {
		const idx = text.indexOf("/ObjStm", searchFrom);
		if (idx === -1) break;
		const window = text.slice(idx, idx + 200);
		const n = Number(window.match(/\/N\s+(\d+)/)?.[1]);
		if (Number.isFinite(n)) objStreamObjects += n;
		searchFrom = idx + "/ObjStm".length;
	}
	return objHeaders + objStreamObjects;
}

/** Load a PDF with the same three bomb guards every suxlib entry point shares
 *  (pre-parse byte cap, pre-parse declared-object estimate, post-parse object
 *  cap) — reused shape, not reused code, per the dual-package hazard above. */
async function loadBoundedPdfLocal(input: Uint8Array): Promise<PDFDocument> {
	if (input.length > MAX_PDF_INPUT_BYTES) throw new Error(`PDF is larger than ${MAX_PDF_INPUT_BYTES} bytes (bomb guard).`);
	if (estimateDeclaredPdfObjectCount(input) > MAX_PDF_OBJECTS) throw new Error(`PDF declares more than ${MAX_PDF_OBJECTS} objects (bomb guard).`);
	const doc = await PDFDocument.load(input, { updateMetadata: false });
	if (doc.context.enumerateIndirectObjects().length > MAX_PDF_OBJECTS) throw new Error(`PDF expands to more than ${MAX_PDF_OBJECTS} objects (bomb guard).`);
	return doc;
}

/** Only these two filters carry an already-self-contained image file as their raw
 *  stream bytes (a JPEG/JPEG2000 codestream needs no further decoding to hand to
 *  Cloudflare Images) — everything else (FlateDecode raw bitmaps, CCITTFax, no
 *  filter, ...) would need a real pixel decode this repo has no codec for, so
 *  those are a graceful skip, not a to-do. */
const SHRINKABLE_FILTERS = new Set(["/DCTDecode", "/JPXDecode"]);

/** US-Letter-width heuristic for "150 DPI": a page-filling scan at 150dpi is
 *  roughly 150 * 8.5in wide. A PDF image XObject dict has pixel /Width/Height
 *  but no DPI field, so this is an approximation, not a precise DPI computation
 *  — confirm against real scanned test PDFs before treating the default as final
 *  (per the issue's own note). */
const LETTER_LONG_SIDE_INCHES = 8.5;
const DEFAULT_MAX_DPI = 150;
const DEFAULT_QUALITY = 75;

export type PdfShrinkImagesOptions = {
	/** Long-side cap, expressed as a "DPI-equivalent" on US-Letter width (see the
	 *  heuristic note above). Default 150. */
	maxDpi?: number;
	/** Cloudflare Images JPEG output quality (1-100). Default 75. */
	quality?: number;
};

export type PdfShrinkImagesResult = {
	bytes: Uint8Array;
	inputBytes: number;
	outputBytes: number;
	imagesShrunk: number;
	imagesSkipped: number;
};

function passthrough(bytes: Uint8Array, imagesSkipped = 0): PdfShrinkImagesResult {
	return { bytes, inputBytes: bytes.length, outputBytes: bytes.length, imagesShrunk: 0, imagesSkipped };
}

/**
 * Best-effort embedded-image recompression for a PDF's JPEG/JPEG2000 XObjects,
 * via the same Cloudflare Images binding fns/image_convert.ts already uses
 * (input().transform().output()) — no new codec dependency. Walks every
 * indirect object for a `/Subtype /Image` stream; a handleable (DCTDecode/
 * JPXDecode) image is resized (only if its own /Width exceeds the DPI-heuristic
 * cap) and requantized at `quality`, and the XObject is replaced ONLY when the
 * recompressed bytes are strictly smaller. Every other case — binding absent,
 * guard trip, parse failure, an unhandled filter, a per-image transform error,
 * or simply no raster XObjects — is a graceful no-op on that image (counted in
 * `imagesSkipped`) or the whole document (original `bytes` returned unchanged,
 * `imagesShrunk: 0`). This function NEVER throws — callers that need a stronger
 * signal than the returned counts should not rely on a catch.
 */
export async function shrinkPdfImages(env: RtEnv, bytes: Uint8Array, opts: PdfShrinkImagesOptions = {}): Promise<PdfShrinkImagesResult> {
	if (!env.IMAGES) return passthrough(bytes);

	let doc: PDFDocument;
	try {
		doc = await loadBoundedPdfLocal(bytes);
	} catch {
		return passthrough(bytes);
	}

	const maxLongSide = Math.round((opts.maxDpi ?? DEFAULT_MAX_DPI) * LETTER_LONG_SIDE_INCHES);
	const quality = opts.quality ?? DEFAULT_QUALITY;

	let imagesShrunk = 0;
	let imagesSkipped = 0;

	for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
		if (!(obj instanceof PDFRawStream)) continue;
		const dict = obj.dict;
		let subtype: unknown = undefined;
		let filter: unknown = undefined;
		try {
			subtype = dict.lookupMaybe(PDFName.of("Subtype"), PDFName);
			filter = dict.lookupMaybe(PDFName.of("Filter"), PDFName);
		} catch {
			continue; // e.g. /Filter is an array (filter chain) — not a shape this pass handles
		}
		if (!(subtype instanceof PDFName) || subtype.asString() !== "/Image") continue;

		if (!(filter instanceof PDFName) || !SHRINKABLE_FILTERS.has(filter.asString())) {
			imagesSkipped++;
			continue;
		}

		try {
			const original = obj.getContents();
			let widthObj: unknown = undefined;
			let heightObj: unknown = undefined;
			try {
				widthObj = dict.lookupMaybe(PDFName.of("Width"), PDFNumber);
				heightObj = dict.lookupMaybe(PDFName.of("Height"), PDFNumber);
			} catch {
				/* malformed size fields — proceed without a resize target */
			}
			const width = widthObj instanceof PDFNumber ? widthObj.asNumber() : undefined;
			const height = heightObj instanceof PDFNumber ? heightObj.asNumber() : undefined;

			const transform: Record<string, unknown> = {};
			let newWidth: number | undefined;
			let newHeight: number | undefined;
			if (typeof width === "number" && width > maxLongSide) {
				newWidth = maxLongSide;
				transform.width = newWidth;
				if (typeof height === "number") newHeight = Math.round(height * (newWidth / width));
			}

			const result = await env.IMAGES.input(original).transform(transform).output({ format: "image/jpeg", quality });
			const newBytes = new Uint8Array(await result.response().arrayBuffer());
			if (newBytes.length >= original.length) {
				imagesSkipped++;
				continue;
			}

			// Mutate the old dict in place and wrap it in a fresh PDFRawStream — the
			// old PDFRawStream instance is discarded wholesale via context.assign, and
			// PDFRawStream.contents is readonly so there's no in-place stream mutation
			// to do instead (pdf-lib's own API shape, not a workaround).
			dict.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
			dict.delete(PDFName.of("DecodeParms"));
			if (newWidth !== undefined) dict.set(PDFName.of("Width"), PDFNumber.of(newWidth));
			if (newHeight !== undefined) dict.set(PDFName.of("Height"), PDFNumber.of(newHeight));
			// /Length is recomputed from the new contents by PDFStream.updateDict() at
			// save time — no need to set it here.
			doc.context.assign(ref, PDFRawStream.of(dict, newBytes));
			imagesShrunk++;
		} catch {
			imagesSkipped++;
		}
	}

	if (imagesShrunk === 0) return passthrough(bytes, imagesSkipped);

	try {
		const outBytes = await doc.save({ useObjectStreams: true });
		return { bytes: outBytes, inputBytes: bytes.length, outputBytes: outBytes.length, imagesShrunk, imagesSkipped };
	} catch {
		return passthrough(bytes, imagesSkipped);
	}
}
