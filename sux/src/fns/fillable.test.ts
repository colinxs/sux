import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { fillable } from "./fillable";

// Build a blank one-page PDF and return it as base64.
async function blankPdfB64(): Promise<string> {
	const doc = await PDFDocument.create();
	doc.addPage([600, 800]);
	const bytes = await doc.save();
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

const run = (args: any) => fillable.run({} as any, args);

describe("fillable", () => {
	it("adds interactive text and checkbox fields", async () => {
		const pdf = await blankPdfB64();
		const r = await run({
			pdf,
			fields: [
				{ name: "full_name", x: 100, y: 700, width: 200, height: 18, value: "Ada" },
				{ name: "agree", type: "checkbox", x: 100, y: 650, width: 14, height: 14, value: true },
			],
		});
		expect(r.isError).toBeFalsy();
		const outBytes = Uint8Array.from(atob(r.content[0].text), (c) => c.charCodeAt(0));
		const doc = await PDFDocument.load(outBytes);
		const names = doc.getForm().getFields().map((f) => f.getName());
		expect(names).toContain("full_name");
		expect(names).toContain("agree");
		expect(doc.getForm().getTextField("full_name").getText()).toBe("Ada");
		expect(doc.getForm().getCheckBox("agree").isChecked()).toBe(true);
	});

	it("supports top-origin coordinates", async () => {
		const pdf = await blankPdfB64();
		const r = await run({ pdf, origin: "top", fields: [{ name: "f1", x: 50, y: 50, width: 100, height: 20 }] });
		expect(r.isError).toBeFalsy();
	});

	it("flattens when asked (no interactive fields remain)", async () => {
		const pdf = await blankPdfB64();
		const r = await run({ pdf, flatten: true, fields: [{ name: "f1", x: 10, y: 10, value: "x" }] });
		expect(r.isError).toBeFalsy();
		const outBytes = Uint8Array.from(atob(r.content[0].text), (c) => c.charCodeAt(0));
		const doc = await PDFDocument.load(outBytes);
		expect(doc.getForm().getFields()).toHaveLength(0);
	});

	it("rejects an empty fields array", async () => {
		expect((await run({ pdf: await blankPdfB64(), fields: [] })).isError).toBe(true);
	});

	it("rejects duplicate field names", async () => {
		const pdf = await blankPdfB64();
		const r = await run({ pdf, fields: [{ name: "dup", x: 1, y: 1 }, { name: "dup", x: 2, y: 2 }] });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Duplicate field name/);
	});

	it("rejects an out-of-range page", async () => {
		const r = await run({ pdf: await blankPdfB64(), fields: [{ name: "f", page: 5, x: 1, y: 1 }] });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/out of range/);
	});

	it("errors without a pdf or url", async () => {
		expect((await run({ fields: [{ name: "f", x: 1, y: 1 }] })).isError).toBe(true);
	});

	it("is marked raw so its base64 output is not normalized", () => {
		expect(fillable.raw).toBe(true);
	});
});
