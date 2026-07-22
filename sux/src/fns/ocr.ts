import { type Fn, failWith, ok } from "../registry";
import { errMsg, fromB64, loadBytes, oj, putBlob } from "./_util";
import { hasMistral, isPdfBytes, looksImageUrl, ocrBytes, ocrUrl, sniffMime } from "./_ocr";

// ocr — the first-class OCR leaf (convert domain). Mistral OCR is the single engine
// (see _ocr.ts). Smart-scan routing, per Colin: a DOCUMENT (a PDF, or a photo you
// mark `kind:"doc"`) is transcribed to markdown; a plain IMAGE is just STORED and its
// handle returned ("if it's an image, obviously just save the file"). An OCR failure
// stores the raw bytes and flags `needs_ocr` — it NEVER fabricates text.

export const ocr: Fn = {
	name: "ocr",
	cost: 2,
	description:
		"OCR / smart-scan a document or image with Mistral OCR (native PDF ingestion, no rasterizing). " +
		"Give `url` (an http(s) link to a PDF or image, fetched by Mistral) or `file` (base64 bytes). " +
		"Routing: a DOCUMENT — a PDF, or an image you mark `kind:\"doc\"` (a photo of a receipt/passport/page) — is transcribed to markdown text. " +
		"A plain IMAGE (default for non-PDF input) is just STORED to the content-addressed blob store and its handle returned — pass `kind:\"doc\"` to force OCR, `kind:\"image\"` to force store. " +
		"If OCR fails (Mistral error/timeout/unconfigured) the raw bytes are stored and a `needs_ocr` flag is returned — text is never fabricated.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			url: { type: "string", description: "http(s) URL of the document/image (Mistral fetches it for a doc; the bytes are fetched via the proxy to store an image)." },
			file: { type: "string", description: "Base64-encoded document/image bytes (data-URI prefix tolerated)." },
			image: { type: "string", description: "Alias for `file` (base64 bytes)." },
			kind: { type: "string", enum: ["auto", "doc", "image"], default: "auto", description: "auto (default: PDF → OCR, other → store) | doc (force OCR, e.g. a photo of a document) | image (force store, no OCR)." },
		},
	},
	cacheable: false,
	annotations: { readOnlyHint: false, openWorldHint: true },
	raw: true,
	run: async (env, args) => {
		const kind = ["auto", "doc", "image"].includes(String(args?.kind)) ? String(args.kind) : "auto";
		const url = typeof args?.url === "string" && args.url.trim() ? args.url.trim() : undefined;
		const rawB64 = typeof args?.file === "string" && args.file.trim() ? args.file : typeof args?.image === "string" && args.image.trim() ? args.image : undefined;

		if (!url && !rawB64) return failWith("bad_input", "Provide `url` or `file`.");
		if (url && !/^https?:\/\//i.test(url)) return failWith("bad_input", "`url` must be absolute http(s).");

		// Decode inline bytes once, up front, so a bad base64 payload is a clean bad_input
		// (never an uncaught throw — the "fns never throw" invariant, fuzz.test.ts).
		let inlineBytes: Uint8Array | undefined;
		if (rawB64) {
			try {
				inlineBytes = fromB64(String(rawB64).replace(/^data:[^,]+,/, ""));
			} catch {
				return failWith("bad_input", "`file`/`image` is not valid base64.");
			}
		}

		// Resolve the raw bytes + a content-type — inline when given, else fetched from the URL.
		// Used by the store leg and the OCR-failure fallback.
		const grabBytes = async (): Promise<{ bytes: Uint8Array; contentType?: string }> => {
			if (inlineBytes) return { bytes: inlineBytes, contentType: sniffMime(inlineBytes) };
			const loaded = await loadBytes(env, { url: String(url) });
			return { bytes: loaded.bytes, contentType: loaded.contentType ?? sniffMime(loaded.bytes) };
		};

		// Classify document-vs-image. `doc`/`image` force it; `auto` treats only a PDF as a
		// document (default PDFs → OCR) and everything else as a plain image to store.
		let isDoc: boolean;
		if (kind === "doc") isDoc = true;
		else if (kind === "image") isDoc = false;
		else if (inlineBytes) isDoc = isPdfBytes(inlineBytes);
		else isDoc = /\.pdf(\?|#|$)/i.test(String(url));

		if (isDoc) {
			try {
				const text = inlineBytes ? await ocrBytes(env, inlineBytes) : await ocrUrl(env, String(url), { image: looksImageUrl(String(url)) });
				return ok(text);
			} catch (e) {
				// OCR failed — keep the raw file and flag needs_ocr. Never fabricate text.
				try {
					const { bytes, contentType } = await grabBytes();
					const ref = await putBlob(env, bytes, contentType ?? "application/octet-stream");
					return ok(oj({ needs_ocr: true, reason: errMsg(e), stored: { url: ref.url, sha256: ref.sha256, size: ref.size, content_type: ref.content_type } }));
				} catch (storeErr) {
					// Couldn't even store the raw (e.g. an unfetchable url) — surface the original OCR
					// error so the caller knows OCR never ran, not a store bug.
					return failWith(hasMistral(env) ? "upstream_error" : "not_configured", `ocr failed: ${errMsg(e)} (could not store raw either: ${errMsg(storeErr)})`);
				}
			}
		}

		// Plain image (or forced kind:"image") → just store the file and return its handle.
		try {
			const { bytes, contentType } = await grabBytes();
			const ref = await putBlob(env, bytes, contentType ?? "application/octet-stream");
			return ok(oj({ stored: true, ocr: false, url: ref.url, sha256: ref.sha256, size: ref.size, content_type: ref.content_type, note: "stored as-is (not a document) — pass kind:\"doc\" to OCR instead." }));
		} catch (e) {
			return failWith("upstream_error", `could not store image: ${errMsg(e)}`);
		}
	},
};
