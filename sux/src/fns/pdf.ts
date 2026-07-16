import { PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, StandardFonts } from "pdf-lib";
import { type Fn, fail } from "../registry";
import { deliverBytes, inlineB64, isHttpUrl, loadBytes, stripHtml, toB64 } from "./_util";
import { ocr as ocrFn } from "./ocr";

// This fn is a full "anything to PDF" builder (merge sources, OCR, TOC, form
// fields) — far beyond @suxos/lib's domain/pdf.ts, which only covers the
// narrower "shrink" op sux-fileops actually shipped. It stays local rather
// than becoming a re-export.
//
// Tried routing the donor-PDF load below through suxlib's loadBoundedPdf (for
// its bomb guards) and reverted it: sux and @suxos/lib each resolve their own
// separate installed copy of pdf-lib (confirmed: the two packages' PDFDocument
// classes are not === each other here), so a PDFDocument produced by
// suxlib's pdf-lib instance breaks copyPages/getForm/etc. on this file's
// pdf-lib instance — a real dual-package-hazard, not a test artifact. Revisit
// only once pdf-lib is guaranteed deduped to one instance across sux+suxlib
// (npm dedupe/hoisting or a shared peerDependency), not as part of this
// absorption pass.

type Kind = "pdf" | "png" | "jpg" | "text" | "html" | "markdown" | "auto";
type Source = { data?: string; url?: string; kind?: Kind };
type Field = { name: string; type?: "text" | "checkbox"; page?: number; x: number; y: number; width?: number; height?: number; value?: string | boolean };
type TocItem = { title: string; page?: number; level?: number };

const MAGIC = (b: Uint8Array): Kind => {
	if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "pdf"; // %PDF
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
	return "text";
};

/** Parse a human (1-indexed) page range like "1-3,5,8-" into 0-indexed indices. */
function parsePages(spec: string, n: number): number[] {
	const out: number[] = [];
	for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
		const m = /^(\d+)?\s*-\s*(\d+)?$/.exec(part);
		if (m) {
			const a = m[1] ? Number(m[1]) : 1;
			const b = m[2] ? Number(m[2]) : n;
			for (let p = a; p <= b; p++) if (p >= 1 && p <= n) out.push(p - 1);
		} else if (/^\d+$/.test(part)) {
			const p = Number(part);
			if (p >= 1 && p <= n) out.push(p - 1);
		}
	}
	return out;
}

/** Fetch bytes for a source (base64 or URL, via the shared _util.loadBytes). */
async function loadSource(env: any, src: Source): Promise<{ bytes: Uint8Array; kind: Kind }> {
	if (!(typeof src.data === "string" && src.data) && !isHttpUrl(src.url)) throw new Error("each source needs `data` (base64) or `url`");
	const { bytes } = await loadBytes(env, { base64: src.data, url: src.url });
	const declared = src.kind && src.kind !== "auto" ? src.kind : MAGIC(bytes);
	return { bytes, kind: declared };
}

/** Lay text out onto paginated Letter-size pages. */
async function drawText(doc: PDFDocument, text: string) {
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const [W, H] = [612, 792];
	const margin = 54;
	const size = 11;
	const lh = size * 1.35;
	const maxW = W - margin * 2;
	let page = doc.addPage([W, H]);
	let y = H - margin;
	const nl = () => {
		y -= lh;
		if (y < margin) {
			page = doc.addPage([W, H]);
			y = H - margin;
		}
	};
	for (const para of text.replace(/\r\n?/g, "\n").split("\n")) {
		if (para === "") {
			nl();
			continue;
		}
		let line = "";
		for (const word of para.split(/\s+/)) {
			const trial = line ? `${line} ${word}` : word;
			if (font.widthOfTextAtSize(trial, size) > maxW && line) {
				page.drawText(line, { x: margin, y, size, font });
				nl();
				line = word;
			} else line = trial;
		}
		if (line) {
			page.drawText(line, { x: margin, y, size, font });
			nl();
		}
	}
}

async function drawImage(doc: PDFDocument, bytes: Uint8Array, kind: Kind) {
	const img = kind === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
	const page = doc.addPage([img.width, img.height]);
	page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
}

/** Build a nested PDF outline (table of contents) from a flat, level-tagged list. */
function buildOutline(doc: PDFDocument, items: TocItem[]) {
	if (!items.length) return;
	const ctx = doc.context;
	const pages = doc.getPages();
	type Node = { title: string; page: number; children: Node[]; ref?: any };
	const root: Node = { title: "", page: 0, children: [] };
	const byLevel: Record<number, Node> = { [-1]: root } as any;
	for (const it of items) {
		const level = Math.max(0, Math.floor(it.level ?? 0));
		const parent = byLevel[level - 1] ?? root;
		const node: Node = { title: String(it.title ?? ""), page: Math.max(0, (Math.floor(it.page ?? 1) || 1) - 1), children: [] };
		parent.children.push(node);
		byLevel[level] = node;
		for (const k of Object.keys(byLevel)) if (Number(k) > level) delete byLevel[Number(k)];
	}
	const assign = (n: Node) => {
		n.ref = ctx.nextRef();
		n.children.forEach(assign);
	};
	root.children.forEach(assign);
	const descendants = (n: Node): number => n.children.reduce((s, c) => s + 1 + descendants(c), 0);
	const outlinesRef = ctx.nextRef();
	const process = (children: Node[], parentRef: any) => {
		children.forEach((node, i) => {
			const pageIdx = Math.min(node.page, pages.length - 1);
			const dest = ctx.obj([pages[pageIdx].ref, PDFName.of("XYZ"), PDFNull, PDFNull, PDFNull]);
			const map: Record<string, any> = { Title: PDFHexString.fromText(node.title), Parent: parentRef, Dest: dest };
			if (i > 0) map.Prev = children[i - 1].ref;
			if (i < children.length - 1) map.Next = children[i + 1].ref;
			if (node.children.length) {
				map.First = node.children[0].ref;
				map.Last = node.children[node.children.length - 1].ref;
				map.Count = PDFNumber.of(descendants(node));
			}
			ctx.assign(node.ref, ctx.obj(map));
			if (node.children.length) process(node.children, node.ref);
		});
	};
	process(root.children, outlinesRef);
	ctx.assign(
		outlinesRef,
		ctx.obj({
			Type: PDFName.of("Outlines"),
			First: root.children[0].ref,
			Last: root.children[root.children.length - 1].ref,
			Count: PDFNumber.of(root.children.reduce((s, c) => s + 1 + descendants(c), 0)),
		}),
	);
	doc.catalog.set(PDFName.of("Outlines"), outlinesRef);
}

function addFields(doc: PDFDocument, fields: Field[], fromTop: boolean) {
	const form = doc.getForm();
	const pages = doc.getPages();
	const seen = new Set<string>();
	for (const f of fields) {
		if (!f?.name || seen.has(f.name)) throw new Error(`field names must be present and unique (offender: '${f?.name}')`);
		seen.add(f.name);
		const page = pages[Math.min(Math.max(0, (Math.floor(f.page ?? 1) || 1) - 1), pages.length - 1)];
		const width = f.width ?? 120;
		const height = f.height ?? 16;
		const y = fromTop ? page.getHeight() - f.y - height : f.y;
		const rect = { x: f.x, y, width, height };
		if (f.type === "checkbox") {
			const cb = form.createCheckBox(f.name);
			cb.addToPage(page, rect);
			if (f.value === true || f.value === "true") cb.check();
		} else {
			const tf = form.createTextField(f.name);
			if (typeof f.value === "string") tf.setText(f.value);
			tf.addToPage(page, rect);
		}
	}
}

export const pdf: Fn = {
	name: "pdf",
	description:
		"Best-effort 'anything to PDF'. `sources` is one or more inputs (each { data: base64 | url, kind: pdf|png|jpg|text|html|markdown|auto }); multiple sources are merged in order. " +
		"Kind is auto-detected from magic bytes. Options: `pages` (1-indexed range like '1-3,5,8-' applied to the merged doc), `toc` ([{title, page, level}] → nested bookmarks/outline), " +
		"`fields` ([{name,type,page,x,y,width,height,value}] → interactive AcroForm, origin bottom-left unless `origin:'top'`), `flatten` (bake forms), " +
		"`title`/`author`/`subject`/`keywords` (metadata), and `ocr: true` (transcribe image sources via Workers AI and append the text as searchable pages). " +
		"`compress: true` re-saves with object streams and strips metadata for smaller size. Returns JSON { mime, size, base64 } (or a compact ref with `as: \"url\"`). " +
		"Note: text/HTML/markdown render as plain reflowed text (Helvetica); high-fidelity HTML/Office rendering and true OCR text overlays need the WASM renderer (PLAN P5).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			sources: {
				type: "array",
				description: "Inputs to convert/merge. If omitted, provide a single `data`/`url`/`text`.",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						data: { type: "string" },
						url: { type: "string" },
						kind: { type: "string", enum: ["pdf", "png", "jpg", "text", "html", "markdown", "auto"] },
					},
				},
			},
			data: { type: "string", description: "Single source: base64 bytes." },
			url: { type: "string", description: "Single source: URL." },
			text: { type: "string", description: "Single source: literal text/markdown/html." },
			pages: { type: "string", description: "1-indexed page range to keep from the merged document, e.g. '1-3,5'." },
			toc: { type: "array", description: "Table of contents / bookmarks: [{ title, page (1-indexed), level }].", items: { type: "object" } },
			fields: { type: "array", description: "Form fields to add.", items: { type: "object" } },
			origin: { type: "string", enum: ["bottom", "top"], default: "bottom" },
			flatten: { type: "boolean", default: false },
			as: { type: "string", enum: ["base64", "url"], default: "base64", description: "Delivery: inline base64 (default) or a content-addressed /s/<uuid> URL (~100 tokens)." },
			ocr: { type: "boolean", description: "Transcribe image sources with Workers AI and append the recognized text.", default: false },
			compress: { type: "boolean", description: "Re-save with object streams and strip metadata for smaller size.", default: false },
			title: { type: "string" },
			author: { type: "string" },
			subject: { type: "string" },
			keywords: { type: "array", items: { type: "string" } },
		},
	},
	cacheable: true,
	raw: true,
	run: async (env, args) => {
		// Normalize inputs to a list of { text } | Source items.
		const items: Array<{ text: string } | Source> = [];
		if (Array.isArray(args?.sources) && args.sources.length) items.push(...(args.sources as Source[]));
		else if (typeof args?.text === "string" && args.text) items.push({ text: args.text });
		else if (typeof args?.data === "string" && args.data) items.push({ data: args.data } as Source);
		else if (isHttpUrl(args?.url)) items.push({ url: String(args.url) } as Source);
		else return fail("Provide `sources[]`, or a single `data` (base64), `url`, or `text`.");

		try {
			const out = await PDFDocument.create();
			const ocrTexts: string[] = [];

			for (const item of items) {
				// Literal text convenience.
				if ("text" in item) {
					await drawText(out, item.text);
					continue;
				}
				const { bytes, kind } = await loadSource(env, item);
				if (kind === "pdf") {
					const donor = await PDFDocument.load(bytes);
					const copied = await out.copyPages(donor, donor.getPageIndices());
					copied.forEach((p) => out.addPage(p));
				} else if (kind === "png" || kind === "jpg") {
					await drawImage(out, bytes, kind);
					if (args?.ocr === true) {
						const r = await ocrFn.run(env, { image: toB64(bytes) });
						if (!r.isError) ocrTexts.push(r.content[0].text);
					}
				} else {
					const raw = new TextDecoder().decode(bytes);
					await drawText(out, kind === "html" ? stripHtml(raw) : raw);
				}
			}

			if (ocrTexts.length) await drawText(out, `\n[OCR transcription]\n\n${ocrTexts.join("\n\n")}`);

			// Page selection over the merged document.
			if (typeof args?.pages === "string" && args.pages.trim()) {
				const keep = parsePages(args.pages, out.getPageCount());
				if (!keep.length) return fail(`Page range '${args.pages}' selected no pages (document has ${out.getPageCount()}).`);
				// Remove pages not kept, from the back so indices stay valid. The spec selects
				// pages; kept pages stay in original document order (no reordering).
				const wanted = new Set(keep);
				for (let i = out.getPageCount() - 1; i >= 0; i--) if (!wanted.has(i)) out.removePage(i);
			}

			if (out.getPageCount() === 0) return fail("No pages were produced.");
			if (Array.isArray(args?.fields) && args.fields.length) addFields(out, args.fields as Field[], (args?.origin ?? "bottom") === "top");
			if (Array.isArray(args?.toc) && args.toc.length) buildOutline(out, args.toc as TocItem[]);
			if (args?.flatten === true) {
				try {
					out.getForm().flatten();
				} catch {
					/* no form to flatten */
				}
			}

			// Metadata (stripped under `compress` unless explicitly provided).
			if (typeof args?.title === "string") out.setTitle(args.title);
			else if (args?.compress) out.setTitle("");
			if (typeof args?.author === "string") out.setAuthor(args.author);
			else if (args?.compress) out.setAuthor("");
			if (typeof args?.subject === "string") out.setSubject(args.subject);
			if (Array.isArray(args?.keywords)) out.setKeywords(args.keywords.map(String));
			out.setProducer("sux/pdf");

			const bytes = await out.save({ useObjectStreams: true });
			return deliverBytes(env, bytes, "application/pdf", args?.as, () => inlineB64(bytes, "application/pdf"));
		} catch (e) {
			return fail(`pdf failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
