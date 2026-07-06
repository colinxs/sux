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
const load = async (r: any) => PDFDocument.load(unb64(r.content[0].text));

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

	it("errors with no usable source", async () => {
		expect((await run({})).isError).toBe(true);
	});

	it("is marked raw", () => {
		expect(pdf.raw).toBe(true);
	});
});
