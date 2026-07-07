import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({ smartFetch: vi.fn() }));

import { fillable } from "./fillable";
import { smartFetch } from "../proxy";

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
		const outBytes = Uint8Array.from(atob(JSON.parse(r.content[0].text).base64), (c) => c.charCodeAt(0));
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
		const outBytes = Uint8Array.from(atob(JSON.parse(r.content[0].text).base64), (c) => c.charCodeAt(0));
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

	it("fetches the source PDF from a url via the proxy", async () => {
		const bytes = Uint8Array.from(atob(await blankPdfB64()), (c) => c.charCodeAt(0));
		vi.mocked(smartFetch).mockResolvedValueOnce(new Response(bytes, { status: 200 }));
		const r = await run({ url: "https://example.com/form.pdf", fields: [{ name: "f1", x: 10, y: 10, value: "v" }] });
		expect(r.isError).toBeFalsy();
		expect(smartFetch).toHaveBeenCalledWith(expect.anything(), "https://example.com/form.pdf", expect.anything());
		const outBytes = Uint8Array.from(atob(JSON.parse(r.content[0].text).base64), (c) => c.charCodeAt(0));
		const doc = await PDFDocument.load(outBytes);
		expect(doc.getForm().getTextField("f1").getText()).toBe("v");
	});

	it("fails when the url fetch returns an HTTP error", async () => {
		vi.mocked(smartFetch).mockResolvedValueOnce(new Response("nope", { status: 404 }));
		const r = await run({ url: "https://example.com/gone.pdf", fields: [{ name: "f", x: 1, y: 1 }] });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Could not read source PDF: Fetch failed: HTTP 404/);
	});

	it("applies multiline and fontSize field options", async () => {
		const r = await run({
			pdf: await blankPdfB64(),
			fields: [{ name: "notes", x: 20, y: 20, width: 200, height: 60, multiline: true, fontSize: 8, value: "line one\nline two" }],
		});
		expect(r.isError).toBeFalsy();
		const outBytes = Uint8Array.from(atob(JSON.parse(r.content[0].text).base64), (c) => c.charCodeAt(0));
		const tf = (await PDFDocument.load(outBytes)).getForm().getTextField("notes");
		expect(tf.isMultiline()).toBe(true);
		expect(tf.getText()).toBe("line one\nline two");
		expect(tf.acroField.getDefaultAppearance()).toContain("8 Tf");
	});

	it('as:"url" stores the output in the CAS store and returns a compact ref', async () => {
		const env = { R2: { put: async () => {} }, OAUTH_KV: { put: async () => {} } } as any;
		const r = await fillable.run(env, { pdf: await blankPdfB64(), as: "url", fields: [{ name: "f1", x: 10, y: 10 }] });
		expect(r.isError).toBeFalsy();
		const ref = JSON.parse(r.content[0].text);
		expect(ref.url).toMatch(/\/s\/[0-9a-f-]{36}$/);
		expect(ref.content_type).toBe("application/pdf");
		expect(ref.size).toBeGreaterThan(0);
	});

	it("returns the standard { mime, size, base64 } inline envelope", async () => {
		const r = await run({ pdf: await blankPdfB64(), fields: [{ name: "f", x: 1, y: 1 }] });
		const j = JSON.parse(r.content[0].text);
		expect(j.mime).toBe("application/pdf");
		expect(j.size).toBeGreaterThan(0);
		expect(typeof j.base64).toBe("string");
	});

	it("is marked raw so its base64 output is not normalized", () => {
		expect(fillable.raw).toBe(true);
	});
});
