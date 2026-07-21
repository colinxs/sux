import { PDFDocument, PDFName } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { pdf } from "./pdf";

const b64 = (bytes: Uint8Array) => {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function blankPdf(pages = 1): Promise<string> {
	const doc = await PDFDocument.create();
	for (let i = 0; i < pages; i++) doc.addPage([300, 400]);
	return b64(await doc.save());
}

// 1x1 transparent PNG.
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const run = (args: any) => pdf.run({} as any, args);
// Inline delivery is the standard { mime, size, base64 } envelope.
const load = async (r: any) => PDFDocument.load(unb64(JSON.parse(r.content[0].text).base64));

describe("pdf", () => {
	it("renders literal text into a PDF", async () => {
		const r = await run({ text: "Hello world.\n\nThis is a paragraph that should wrap across the page width when it grows long enough to exceed the margin box." });
		expect(r.isError).toBeFalsy();
		expect((await load(r)).getPageCount()).toBeGreaterThanOrEqual(1);
	});

	it("merges multiple PDF sources in order", async () => {
		const r = await run({ sources: [{ data: await blankPdf(2) }, { data: await blankPdf(3) }] });
		expect(r.isError).toBeFalsy();
		expect((await load(r)).getPageCount()).toBe(5);
	});

	it("auto-detects and embeds an image as a page", async () => {
		const r = await run({ sources: [{ data: PNG_1x1 }] });
		expect(r.isError).toBeFalsy();
		expect((await load(r)).getPageCount()).toBe(1);
	});

	it("applies a 1-indexed page range to the merged doc", async () => {
		const r = await run({ sources: [{ data: await blankPdf(5) }], pages: "2-4" });
		expect(r.isError).toBeFalsy();
		expect((await load(r)).getPageCount()).toBe(3);
	});

	it("keeps out-of-order page specs in original document order (spec selects, does not reorder)", async () => {
		const doc = await PDFDocument.create();
		doc.addPage([100, 100]);
		doc.addPage([200, 200]);
		doc.addPage([300, 300]);
		const r = await run({ sources: [{ data: b64(await doc.save()) }], pages: "3,1" });
		expect(r.isError).toBeFalsy();
		const out = await load(r);
		expect(out.getPageCount()).toBe(2);
		// Pinned behavior: pages come back in original document order (1 then 3), not spec order (3 then 1).
		expect(out.getPage(0).getWidth()).toBe(100);
		expect(out.getPage(1).getWidth()).toBe(300);
	});

	it("adds a table-of-contents outline", async () => {
		const r = await run({
			sources: [{ data: await blankPdf(3) }],
			toc: [
				{ title: "Intro", page: 1, level: 0 },
				{ title: "Details", page: 2, level: 1 },
				{ title: "End", page: 3, level: 0 },
			],
		});
		expect(r.isError).toBeFalsy();
		const doc = await load(r);
		expect(doc.catalog.get(PDFName.of("Outlines"))).toBeTruthy();
	});

	it("adds interactive form fields", async () => {
		const r = await run({ sources: [{ data: await blankPdf(1) }], fields: [{ name: "name", x: 10, y: 10, value: "Ada" }] });
		expect(r.isError).toBeFalsy();
		const doc = await load(r);
		expect(doc.getForm().getTextField("name").getText()).toBe("Ada");
	});

	it("flattens forms when asked", async () => {
		const r = await run({ sources: [{ data: await blankPdf(1) }], fields: [{ name: "n", x: 5, y: 5, value: "x" }], flatten: true });
		expect((await load(r)).getForm().getFields()).toHaveLength(0);
	});

	it("sets metadata and strips it under compress", async () => {
		const withMeta = await load(await run({ text: "x", title: "My Title", author: "Ada" }));
		expect(withMeta.getTitle()).toBe("My Title");
		const compressed = await load(await run({ text: "x", compress: true }));
		expect(compressed.getTitle() ?? "").toBe("");
	});

	it("skips OCR gracefully when the AI binding is absent", async () => {
		const r = await run({ sources: [{ data: PNG_1x1 }], ocr: true });
		expect(r.isError).toBeFalsy(); // ocr fn fails internally -> skipped, image page still produced
		expect((await load(r)).getPageCount()).toBe(1);
	});

	it("returns the standard { mime, size, base64 } inline envelope", async () => {
		const r = await run({ text: "hello" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.mime).toBe("application/pdf");
		expect(j.size).toBe(unb64(j.base64).length);
		expect(j.size).toBeGreaterThan(0);
	});

	it("errors with no usable source", async () => {
		expect((await run({})).isError).toBe(true);
	});

	it('as:"url" stores the PDF in the CAS store and returns a compact ref', async () => {
		const env = { R2: { put: async () => {} }, OAUTH_KV: { put: async () => {} } } as any;
		const r = await pdf.run(env, { text: "hello", as: "url" });
		expect(r.isError).toBeFalsy();
		const ref = JSON.parse(r.content[0].text);
		expect(ref.url).toMatch(/\/s\/[0-9a-f-]{36}$/);
		expect(ref.content_type).toBe("application/pdf");
		expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(ref.size).toBeGreaterThan(0);
	});

	// Real (not smoke) test of deliverBytes' size-based auto-promotion, driven through
	// the actual pdf fn rather than the shared util in isolation: a >150KB output must
	// come back as a ref even though NO `as` was given, and a small one must still inline.
	it("auto-promotes to a ref when output exceeds the size threshold, even with no `as` arg", async () => {
		const env = { R2: { put: async () => {} }, OAUTH_KV: { put: async () => {} } } as any;
		// ~50k space-separated tokens wraps across enough Letter-size pages to clear the
		// 150KB threshold (measured ~155-200KB for this range) without an oversize fixture.
		const bigText = Array.from({ length: 50_000 }, (_, i) => `word${i % 1000}`).join(" ");
		const r = await pdf.run(env, { text: bigText });
		expect(r.isError).toBeFalsy();
		const parsed = JSON.parse(r.content[0].text);
		expect(parsed.url).toMatch(/\/s\/[0-9a-f-]{36}$/);
		expect(parsed.base64).toBeUndefined();
	});

	it("keeps small output inlined when `as` is omitted (below the size threshold)", async () => {
		const r = await run({ text: "hello" });
		expect(r.isError).toBeFalsy();
		const parsed = JSON.parse(r.content[0].text);
		expect(typeof parsed.base64).toBe("string");
		expect(parsed.url).toBeUndefined();
	});

	it("is marked raw", () => {
		expect(pdf.raw).toBe(true);
	});
});
