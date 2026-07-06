import { PDFDocument } from "pdf-lib";
import { type Fn, fail, ok } from "../registry";
import { deliverBytes, fromB64, toB64 } from "./_util";
import { smartFetch } from "../proxy";
import { isHttpUrl } from "./_util";

type FieldSpec = {
	name: string;
	type?: "text" | "checkbox";
	page?: number; // 0-indexed
	x: number;
	y: number;
	width?: number;
	height?: number;
	value?: string | boolean;
	fontSize?: number;
	multiline?: boolean;
};

export const fillable: Fn = {
	name: "fillable",
	description:
		"Make a PDF fillable by adding interactive AcroForm fields. Give `pdf` (base64) or a `url`, plus `fields[]` — each { name, type: text|checkbox, page (0-indexed), x, y, width, height, value?, fontSize?, multiline? } positioned in PDF points. " +
		"Origin is bottom-left by default; set `origin: 'top'` to measure y from the top of the page. `flatten: true` bakes the values in and makes the form non-editable. Returns the new PDF as base64. " +
		"(Positions are explicit — auto-detecting blank lines/underscores needs the WASM text-layout parser, see PLAN P5.)",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["fields"],
		properties: {
			pdf: { type: "string", description: "Base64-encoded source PDF." },
			url: { type: "string", description: "URL of the source PDF (fetched via the residential proxy)." },
			origin: { type: "string", enum: ["bottom", "top"], description: "Y-axis origin for field coordinates. Default 'bottom' (PDF-native).", default: "bottom" },
			flatten: { type: "boolean", description: "Bake field values into the page and make them non-editable.", default: false },
			as: { type: "string", enum: ["base64", "url"], default: "base64", description: "Delivery: inline base64 (default) or a content-addressed /s/<uuid> URL (~100 tokens)." },
			fields: {
				type: "array",
				description: "Fields to add.",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["name", "x", "y"],
					properties: {
						name: { type: "string" },
						type: { type: "string", enum: ["text", "checkbox"], default: "text" },
						page: { type: "integer", minimum: 0, default: 0 },
						x: { type: "number" },
						y: { type: "number" },
						width: { type: "number", default: 120 },
						height: { type: "number", default: 16 },
						value: {},
						fontSize: { type: "number", default: 11 },
						multiline: { type: "boolean", default: false },
					},
				},
			},
		},
	},
	cacheable: true,
	raw: true,
	run: async (env, args) => {
		const fields = args?.fields as FieldSpec[] | undefined;
		if (!Array.isArray(fields) || fields.length === 0) return fail("Provide a non-empty `fields` array.");

		// Load the source bytes from base64 or a URL.
		let bytes: Uint8Array;
		try {
			if (typeof args?.pdf === "string" && args.pdf) {
				bytes = fromB64(args.pdf);
			} else if (isHttpUrl(args?.url)) {
				const resp = await smartFetch(env, String(args.url), {});
				if (!resp.ok) return fail(`Failed to fetch PDF: HTTP ${resp.status}`);
				bytes = new Uint8Array(await resp.arrayBuffer());
			} else {
				return fail("Provide `pdf` (base64) or a fetchable `url`.");
			}
		} catch (e) {
			return fail(`Could not read source PDF: ${String((e as Error).message ?? e)}`);
		}

		try {
			const doc = await PDFDocument.load(bytes);
			const form = doc.getForm();
			const pages = doc.getPages();
			const fromTop = (args?.origin ?? "bottom") === "top";
			const seen = new Set<string>();

			for (const [i, f] of fields.entries()) {
				if (!f?.name) return fail(`fields[${i}] is missing a name.`);
				if (seen.has(f.name)) return fail(`Duplicate field name '${f.name}' (field names must be unique).`);
				seen.add(f.name);
				const pageIdx = f.page ?? 0;
				if (pageIdx < 0 || pageIdx >= pages.length) return fail(`fields[${i}] page ${pageIdx} is out of range (0-${pages.length - 1}).`);
				const page = pages[pageIdx];
				const width = f.width ?? 120;
				const height = f.height ?? 16;
				// Convert a top-origin y to PDF's bottom-left origin.
				const y = fromTop ? page.getHeight() - f.y - height : f.y;
				const rect = { x: f.x, y, width, height };

				if (f.type === "checkbox") {
					const cb = form.createCheckBox(f.name);
					cb.addToPage(page, rect);
					if (f.value === true || f.value === "true") cb.check();
				} else {
					const tf = form.createTextField(f.name);
					if (f.multiline) tf.enableMultiline();
					if (typeof f.value === "string") tf.setText(f.value);
					if (f.fontSize) tf.setFontSize(f.fontSize);
					tf.addToPage(page, rect);
				}
			}

			if (args?.flatten === true) form.flatten();
			const out = await doc.save();
			return deliverBytes(env, out, "application/pdf", args?.as, () => ok(toB64(out)));
		} catch (e) {
			return fail(`fillable failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
