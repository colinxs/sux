import { type Fn, fail } from "../registry";

export const pdfToText: Fn = {
	name: "pdf_to_text",
	description: "Extract text (and optionally page layout) from a PDF. Requires a WASM PDF parser — not wired yet (P5). Scanned/image PDFs will route to `ocr`. The signature is stable.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			url: { type: "string", description: "PDF URL." },
			pdf: { type: "string", description: "Base64 PDF bytes." },
			pages: { type: "string", description: "Page range, e.g. '1-5'." },
		},
	},
	cacheable: true,
	run: async () => fail("pdf_to_text needs a WASM PDF parser (pdf.js/mupdf), not wired yet — see PLAN P5. For scanned pages, use `ocr`."),
};
