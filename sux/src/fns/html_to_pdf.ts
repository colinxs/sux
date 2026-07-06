import { type Fn, fail } from "../registry";

export const htmlToPdf: Fn = {
	name: "html_to_pdf",
	description: "Render HTML or a URL to a PDF (base64). Requires Cloudflare Browser Rendering — not wired yet (P5). The signature is stable; enable the browser binding to activate.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			url: { type: "string" },
			html: { type: "string" },
			format: { type: "string", enum: ["A4", "Letter", "Legal"], default: "A4" },
			landscape: { type: "boolean", default: false },
		},
	},
	cacheable: true,
	run: async () => fail("html_to_pdf needs Cloudflare Browser Rendering (headless Chromium), not wired yet — see PLAN P5. Add the browser binding to enable."),
};
