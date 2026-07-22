import { describe, expect, it } from "vitest";
import {
	classifyScan,
	extractScanText,
	indexSignal,
	renderScanBody,
	reprocessScanBacklog,
	type ReprocessDeps,
	type ScanOcr,
} from "./_scan_ingest";

const env = {} as any;

// An OCR stub — the injectable seam over the shared _ocr.ts Mistral engine. `throwing` models an
// image-only scan / unconfigured key (ocrDocument throws "no text"); a returned string models a
// real OCR pull.
const okOcr = (text: string): ScanOcr => async () => text;
const noTextOcr: ScanOcr = async () => {
	throw new Error("Mistral OCR returned no text.");
};

describe("classifyScan (3-way, deterministic)", () => {
	it("routes an image to photo", () => {
		expect(classifyScan("IMG_1234.jpg")).toBe("photo");
		expect(classifyScan("photo.HEIC")).toBe("photo");
	});
	it("routes a doc/scan/legal filename to ocr", () => {
		expect(classifyScan("scan_20260721 (3).pdf")).toBe("ocr");
		expect(classifyScan("small-claims-order.pdf")).toBe("ocr");
		expect(classifyScan("letter-to-court.pdf")).toBe("ocr");
	});
	it("routes a reference/manual to keep", () => {
		expect(classifyScan("router-manual.pdf")).toBe("keep");
		expect(classifyScan("annual-report.pdf")).toBe("keep");
	});
	it("routes a large uncued PDF to keep, a small one to ocr", () => {
		expect(classifyScan("blob.pdf", { size: 20 * 1024 * 1024 })).toBe("keep");
		expect(classifyScan("blob.pdf", { size: 1000 })).toBe("ocr");
	});
	it("honors an explicit mode override over the heuristic", () => {
		expect(classifyScan("scan.pdf", { mode: "keep" })).toBe("keep");
		expect(classifyScan("IMG.jpg", { mode: "ocr" })).toBe("ocr");
		expect(classifyScan("manual.pdf", { mode: "photo" })).toBe("photo");
	});
});

describe("extractScanText (composes on the shared Mistral engine)", () => {
	it("returns the OCR'd text as hasText via mistral", async () => {
		const r = await extractScanText(env, "order.pdf", new Uint8Array(), {
			ocr: okOcr("COURT ORDER: judgment for plaintiff, case 25-123."),
		});
		expect(r.hasText).toBe(true);
		expect(r.via).toBe("mistral");
		expect(r.text).toContain("COURT ORDER");
	});
	it("reports NO text (never a silent empty success) when OCR throws — with the error captured", async () => {
		const r = await extractScanText(env, "scan.pdf", new Uint8Array(), { ocr: noTextOcr });
		expect(r.hasText).toBe(false);
		expect(r.text).toBeUndefined();
		expect(r.error).toContain("no text");
	});
	it("quality-gates a near-empty extraction as no-text (a stray glyph is not document text)", async () => {
		const r = await extractScanText(env, "scan.pdf", new Uint8Array(), { ocr: okOcr("  x \n ") });
		expect(r.hasText).toBe(false);
	});
	it("never throws — an OCR engine error degrades to no-text + error", async () => {
		const r = await extractScanText(env, "scan.pdf", new Uint8Array(), {
			ocr: async () => {
				throw new Error("Mistral OCR HTTP 500");
			},
		});
		expect(r.hasText).toBe(false);
		expect(r.error).toContain("HTTP 500");
	});
});

describe("renderScanBody (branch-aware + honest)", () => {
	const base = { name: "f.pdf", link: "https://dbx/f", dropboxPath: "/Scans/f.pdf", size: 10, source: "scan f" };
	it("photo → just the image link", () => {
		const b = renderScanBody({ ...base, name: "p.jpg", title: "P", cls: "photo" });
		expect(b).toContain("Scanned image: [p.jpg](https://dbx/f)");
		expect(b).not.toContain("## Extracted text");
	});
	it("keep → saved-PDF note + lightweight filename signal, never full text", () => {
		const b = renderScanBody({ ...base, title: "Ref", cls: "keep" });
		expect(b).toContain("not full-text OCR'd");
		expect(b).toContain("## Signal");
		expect(b).toContain("f.pdf");
		expect(b).not.toContain("## Extracted text");
	});
	it("ocr + text → embeds the extracted text", () => {
		const b = renderScanBody({ ...base, title: "Order", cls: "ocr", extract: { hasText: true, text: "JUDGMENT for plaintiff.", via: "mistral" } });
		expect(b).toContain("## Extracted text");
		expect(b).toContain("JUDGMENT for plaintiff.");
		expect(b).toContain("extracted via mistral");
	});
	it("ocr + no text → truthful image-only marker, NOT fabricated text", () => {
		const b = renderScanBody({ ...base, title: "S", cls: "ocr", extract: { hasText: false, error: "Mistral OCR returned no text." } });
		expect(b).toContain("image-only scan");
		expect(b).toContain("pending");
		expect(b).not.toContain("## Extracted text");
	});
});

describe("indexSignal", () => {
	it("photo → nothing to index", () => {
		expect(indexSignal({ cls: "photo", name: "p.jpg" })).toBeUndefined();
	});
	it("ocr + text → the text; keep / no-text → a filename signal", () => {
		expect(indexSignal({ cls: "ocr", name: "o.pdf", extract: { hasText: true, text: "HELLO" } })).toBe("HELLO");
		expect(indexSignal({ cls: "keep", name: "m.pdf" })).toContain("m.pdf");
	});
});

describe("reprocessScanBacklog (the 7-scan backlog sweep)", () => {
	const stub = (path: string, extraBody = "") => ({
		path,
		content: `---\ntype: capture\ntags: [capture, scan]\n---\n\n# Scan\n\nScanned document: [x.pdf](https://dbx/x)\nDropbox path: \`/Scans/2026/07/${path.split("/").pop()!.replace(".md", ".pdf")}\` (10 bytes)\n${extraBody}`,
	});

	const deps = (over: Partial<ReprocessDeps>): ReprocessDeps => ({
		listScanNotes: over.listScanNotes ?? (async () => []),
		resolveBytes: over.resolveBytes ?? (async (_e, p) => ({ name: p.split("/").pop()!, bytes: new Uint8Array([1]) })),
		writeNote: over.writeNote ?? (async () => ({ ok: true })),
		ocr: over.ocr,
	});

	it("rewrites an un-extracted scan note with the OCR'd text", async () => {
		const writes: Record<string, string> = {};
		const r = await reprocessScanBacklog(
			env,
			deps({
				// a.md → "a.pdf": OCR_CUE_RE has no match, but a small (1-byte) uncued PDF defaults to "ocr".
				listScanNotes: async () => [stub("Inbox/scan-2026-07-22 doc-a.md")],
				resolveBytes: async () => ({ name: "doc-a.pdf", bytes: new Uint8Array([1]) }),
				writeNote: async (_e, p, c) => {
					writes[p] = c;
					return { ok: true };
				},
				ocr: okOcr("Small Claims judgment, case 25-2-12345."),
			}),
		);
		expect(r.total).toBe(1);
		expect(r.extracted).toEqual(["Inbox/scan-2026-07-22 doc-a.md"]);
		expect(writes["Inbox/scan-2026-07-22 doc-a.md"]).toContain("## Extracted text");
		expect(writes["Inbox/scan-2026-07-22 doc-a.md"]).toContain("Small Claims judgment");
		expect(writes["Inbox/scan-2026-07-22 doc-a.md"]).toContain("type: capture"); // frontmatter preserved
	});

	it("is idempotent — skips a note that already has extracted text", async () => {
		const r = await reprocessScanBacklog(env, deps({ listScanNotes: async () => [stub("Inbox/scan-2026-07-22 a.md", "\n## Extracted text\n\nalready here")] }));
		expect(r.skipped).toEqual(["Inbox/scan-2026-07-22 a.md"]);
		expect(r.rewritten).toEqual([]);
	});

	it("skips a scan-prefixed note that is not an ingest scan stub (no /Scans/ path)", async () => {
		const r = await reprocessScanBacklog(env, deps({ listScanNotes: async () => [{ path: "Inbox/scan-2026-07-22 smoke.md", content: "---\n---\n\n# smoke test, no dropbox path" }] }));
		expect(r.total).toBe(0);
		expect(r.skipped).toContain("Inbox/scan-2026-07-22 smoke.md");
	});

	it("writes an honest marker (still rewritten, not extracted) for an image-only scan", async () => {
		const writes: Record<string, string> = {};
		const r = await reprocessScanBacklog(
			env,
			deps({
				listScanNotes: async () => [stub("Inbox/scan-2026-07-22 doc-a.md")],
				resolveBytes: async () => ({ name: "doc-a.pdf", bytes: new Uint8Array([1]) }),
				writeNote: async (_e, p, c) => {
					writes[p] = c;
					return { ok: true };
				},
				ocr: noTextOcr, // OCR yields no text → honest marker
			}),
		);
		expect(r.rewritten).toEqual(["Inbox/scan-2026-07-22 doc-a.md"]);
		expect(r.extracted).toEqual([]);
		expect(writes["Inbox/scan-2026-07-22 doc-a.md"]).toContain("image-only scan");
	});

	it("one note failing never aborts the sweep", async () => {
		const r = await reprocessScanBacklog(
			env,
			deps({
				listScanNotes: async () => [stub("Inbox/scan-2026-07-22 doc-a.md"), stub("Inbox/scan-2026-07-22 doc-b.md")],
				resolveBytes: async (_e, p) => {
					if (p.includes("doc-a.pdf")) throw new Error("dropbox 404");
					return { name: "doc-b.pdf", bytes: new Uint8Array([1]) };
				},
				ocr: okOcr("Full OCR text extracted for note b — a scanned document with real content."),
			}),
		);
		expect(r.errors.some((e) => e.includes("doc-a.md") && e.includes("dropbox 404"))).toBe(true);
		expect(r.extracted).toEqual(["Inbox/scan-2026-07-22 doc-b.md"]);
	});
});
