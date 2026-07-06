import { type Fn, fail } from "../registry";

export const pdfToImages: Fn = {
	name: "pdf_to_images",
	description: "Rasterize PDF pages to images (base64 PNG/JPEG). Requires a WASM renderer or Browser Rendering — not wired yet (P5). The signature is stable.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			url: { type: "string" },
			pdf: { type: "string", description: "Base64 PDF bytes." },
			pages: { type: "string", description: "Page range, e.g. '1-3'." },
			dpi: { type: "integer", default: 150 },
		},
	},
	cacheable: true,
	run: async () => fail("pdf_to_images needs a WASM PDF renderer (mupdf/pdfium) or Browser Rendering, not wired yet — see PLAN P5."),
};
