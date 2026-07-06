import { type Fn, fail } from "../registry";

export const officeToPdf: Fn = {
	name: "office_to_pdf",
	description: "Convert an Office document (docx/xlsx/pptx) to PDF (base64). Requires a headless converter — not wired yet (P5). The signature is stable.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			url: { type: "string" },
			file: { type: "string", description: "Base64 document bytes." },
			from: { type: "string", enum: ["docx", "xlsx", "pptx"], description: "Source format (else inferred)." },
		},
	},
	cacheable: true,
	run: async () => fail("office_to_pdf needs a headless converter (LibreOffice/WASM), not wired yet — see PLAN P5."),
};
