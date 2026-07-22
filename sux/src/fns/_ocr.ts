// The ONE OCR implementation in the worker. Mistral OCR (api.mistral.ai/v1/ocr,
// `mistral-ocr-latest`) is the single engine — it ingests native PDFs (no
// rasterizing) and photos of documents, returning per-page markdown. Every OCR
// caller composes on this: the first-class `ocr` convert leaf (ocr.ts), `study`'s
// document→text path (study.ts), the assimilation spine (_assimilate.ts), the
// document radar (_document_radar.ts), and pdf's `ocr:true` append (pdf.ts). There
// is deliberately no second OCR path — the former Workers-AI llama-3.2-vision call
// was removed when this landed.
//
// Mistral fetches the document itself from a public URL (`document_url` for a PDF,
// `image_url` for a photo), so bytes are content-addressed into the R2 CAS store
// (putBlob → a public /s/<uuid> handle) and Mistral is handed that URL. There is no
// Mistral files-upload helper in this worker, so the CAS handle IS the upload path.

import type { RtEnv } from "../registry";
import { smartFetch } from "../proxy";
import { errMsg, putBlob } from "./_util";

export const MISTRAL_OCR_URL = "https://api.mistral.ai/v1/ocr";
export const MISTRAL_OCR_MODEL = "mistral-ocr-latest";

/** Whether the Mistral OCR engine is armed — the MISTRAL_API_KEY secret is set.
 *  Absent ⇒ every OCR path fails cleanly with a "set MISTRAL_API_KEY" message and
 *  the caller keeps the raw file (never fabricates text). */
export function hasMistral(env: { MISTRAL_API_KEY?: string }): boolean {
	return typeof env.MISTRAL_API_KEY === "string" && env.MISTRAL_API_KEY.trim() !== "";
}

const NO_KEY = "Mistral OCR is not configured — set MISTRAL_API_KEY (wrangler secret put MISTRAL_API_KEY).";

/** True when `mime` is a raster image type Mistral OCR takes as an `image_url` part
 *  (a photo of a document) rather than a `document_url` (a PDF / office doc). */
export function isImageMime(mime?: string): boolean {
	return typeof mime === "string" && /^image\//i.test(mime);
}

/** True when a URL's path ends in an image extension — the default `image_url` vs
 *  `document_url` signal for a bare URL with no caller-supplied type hint. A `.pdf`
 *  (or any non-image / extension-less URL) is treated as a document. */
export function looksImageUrl(url: string): boolean {
	try {
		return /\.(png|jpe?g|gif|webp|tiff?|bmp|avif|heic|heif)(\?|#|$)/i.test(new URL(url).pathname);
	} catch {
		return /\.(png|jpe?g|gif|webp|tiff?|bmp|avif|heic|heif)(\?|#|$)/i.test(url);
	}
}

/** Best-effort content-type from a byte-header magic number — enough to route OCR
 *  (PDF vs image) and to label the CAS blob. Falls back to undefined for anything
 *  unrecognized; callers default undefined to application/pdf (the common doc case). */
export function sniffMime(bytes: Uint8Array): string | undefined {
	if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "application/pdf"; // %PDF
	if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif"; // GIF8
	if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp"; // RIFF....WEBP
	if (bytes.length >= 4 && ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))) return "image/tiff";
	return undefined;
}

/** True when bytes are a PDF (used by the `ocr` leaf's auto smart-scan: a PDF → OCR,
 *  any other blob → store-only unless the caller forces `kind:"doc"`). */
export function isPdfBytes(bytes: Uint8Array): boolean {
	return sniffMime(bytes) === "application/pdf";
}

/**
 * OCR a publicly-fetchable URL with Mistral. `image:true` routes it as an `image_url`
 * document part (a photo of a document); otherwise `document_url` (a PDF). Returns the
 * concatenated per-page markdown. THROWS (caller wraps) when the key is missing, the
 * API errors/times out, or no text comes back — never returns fabricated text.
 */
export async function ocrUrl(env: RtEnv, url: string, opts?: { image?: boolean }): Promise<string> {
	if (!hasMistral(env)) throw new Error(NO_KEY);
	const image = opts?.image ?? looksImageUrl(url);
	const document = image ? { type: "image_url", image_url: url } : { type: "document_url", document_url: url };
	const resp = await smartFetch(env, MISTRAL_OCR_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${env.MISTRAL_API_KEY}` },
		body: JSON.stringify({ model: MISTRAL_OCR_MODEL, document }),
	});
	if (!resp.ok) throw new Error(`Mistral OCR HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
	const j = (await resp.json()) as { pages?: Array<{ markdown?: string }> };
	const pages = Array.isArray(j?.pages) ? j.pages : [];
	const text = pages
		.map((p) => String(p?.markdown ?? ""))
		.join("\n\n")
		.trim();
	if (!text) throw new Error("Mistral OCR returned no text.");
	return text;
}

/**
 * OCR raw bytes with Mistral. Content-addresses the bytes into R2 to mint a public
 * /s/<uuid> URL Mistral can fetch, then OCRs that URL — the file-upload path (there
 * is no Mistral files-upload helper here). `contentType`/`image` are inferred from a
 * byte-header sniff when not supplied. THROWS (caller wraps) on any failure.
 */
export async function ocrBytes(env: RtEnv, bytes: Uint8Array, opts?: { contentType?: string; image?: boolean }): Promise<string> {
	if (!hasMistral(env)) throw new Error(NO_KEY);
	const contentType = opts?.contentType ?? sniffMime(bytes) ?? "application/pdf";
	const image = opts?.image ?? isImageMime(contentType);
	const ref = await putBlob(env, bytes, contentType);
	return ocrUrl(env, ref.url, { image });
}

/**
 * The one document→text OCR entry point callers compose on. Give a `url` OR `bytes`;
 * `image` forces the `image_url` part (a photo of a document) when the type can't be
 * inferred. THROWS (caller wraps) — success is always real extracted text.
 */
export async function ocrDocument(env: RtEnv, src: { url?: string; bytes?: Uint8Array; contentType?: string; image?: boolean }): Promise<string> {
	if (src.bytes?.length) return ocrBytes(env, src.bytes, { contentType: src.contentType, image: src.image });
	if (src.url) return ocrUrl(env, src.url, { image: src.image });
	throw new Error("ocrDocument: need a `url` or `bytes`.");
}

/** Shared wrapper: run `fn`, returning its text on success or `undefined` on any OCR
 *  failure — the shape the radar/mail detectors want (best-effort, never throws). */
export async function ocrTextOrUndefined(fn: () => Promise<string>): Promise<string | undefined> {
	try {
		const text = (await fn()).trim();
		return text || undefined;
	} catch {
		return undefined;
	}
}

/** Re-export so callers can build a uniform "OCR failed, kept the raw" message. */
export { errMsg };
