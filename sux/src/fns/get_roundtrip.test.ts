import { randomBytes } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";

// End-to-end put → get round-trip over the REAL content-addressed store (#1479).
// Deliberately mocks as little as possible: only the network (smartFetch) and the
// fn registry (so the pdf/render legs are observable). putBlob/loadBytes/getBlob
// are the real implementations against a mock R2 + KV, so a byte-equality
// assertion here actually exercises the store path a live `put`/`get` takes.

const { smartFetchMock, pdfSpy, renderSpy } = vi.hoisted(() => ({ smartFetchMock: vi.fn(), pdfSpy: vi.fn(), renderSpy: vi.fn() }));
vi.mock("../proxy", () => ({ smartFetch: smartFetchMock }));
vi.mock("./index", () => ({
	FUNCTIONS: [
		{ name: "pdf", run: pdfSpy },
		{ name: "render", run: renderSpy },
	],
}));

import { get } from "./get";
import { pdf } from "./pdf";
import { put } from "./put";
import { getBlob, storeRefUuid, toB64 } from "./_util";

function mockKV() {
	const m = new Map<string, string>();
	return { _m: m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v), delete: async (k: string) => void m.delete(k) };
}
function mockR2() {
	const m = new Map<string, { bytes: Uint8Array; ct?: string }>();
	return {
		_m: m,
		put: async (key: string, value: any, opts?: any) => {
			const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
			m.set(key, { bytes, ct: opts?.httpMetadata?.contentType });
		},
		get: async (key: string) => {
			const o = m.get(key);
			if (!o) return null;
			return { size: o.bytes.length, httpMetadata: { contentType: o.ct }, arrayBuffer: async () => o.bytes.slice().buffer };
		},
	};
}
const mkEnv = () => ({ R2: mockR2(), OAUTH_KV: mockKV() }) as any;

/** A >1MB PDF whose payload lives OUTSIDE the page tree (an embedded file), which is
 *  exactly what pdf-lib's copyPages silently drops — the shape that turned a 3.1MB
 *  document into an 840-byte husk in #1479. Random bytes so it can't be gzipped away. */
async function bigPdf(): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const page = doc.addPage([300, 300]);
	page.drawText("round-trip fixture", { x: 20, y: 260, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
	doc.attach(new Uint8Array(randomBytes(1_200_000)), "payload.bin", { mimeType: "application/octet-stream" });
	return doc.save({ useObjectStreams: true });
}

/** Resolve whatever shape `get` delivered (inline base64 or a /s/<uuid> ref) back to bytes. */
async function deliveredBytes(env: any, file: { base64?: string; url?: string }): Promise<Uint8Array> {
	if (file.base64) return Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
	const uuid = storeRefUuid(file.url);
	if (!uuid) throw new Error(`neither base64 nor a /s/<uuid> ref: ${JSON.stringify(file)}`);
	const blob = await getBlob(env, uuid);
	if (!blob) throw new Error(`ref ${uuid} did not resolve`);
	return blob.bytes;
}

beforeEach(() => {
	vi.clearAllMocks();
	pdfSpy.mockImplementation((env: any, args: any) => pdf.run(env, args));
});

describe("put → get round-trip (#1479)", () => {
	it("returns the stored bytes verbatim for a >1MB binary, never a re-rendered stub", async () => {
		const source = await bigPdf();
		expect(source.length).toBeGreaterThan(1_000_000);
		smartFetchMock.mockResolvedValue(new Response(source, { status: 200, headers: { "content-type": "application/pdf" } }));
		const env = mkEnv();

		const stored = JSON.parse((await put.run(env, { urls: ["https://example.com/big.pdf"], force: true })).content[0].text)[0];
		expect(stored.src_bytes).toBe(source.length);
		expect(stored.bytes).toBe(source.length);

		const out = await get.run(env, { input: stored.ref });
		expect(out.isError).toBeFalsy();
		const parsed = JSON.parse(out.content[0].text);
		const bytes = await deliveredBytes(env, parsed.file);

		expect(bytes.length).toBe(stored.src_bytes);
		expect(bytes).toEqual(source);
	});

	it("hands back the caller's own permanent ref instead of minting an expiring copy", async () => {
		const source = await bigPdf();
		smartFetchMock.mockResolvedValue(new Response(source, { status: 200, headers: { "content-type": "application/pdf" } }));
		const env = mkEnv();
		const stored = JSON.parse((await put.run(env, { urls: ["https://example.com/big.pdf"], force: true })).content[0].text)[0];

		const parsed = JSON.parse((await get.run(env, { input: stored.ref })).content[0].text);
		expect(parsed.file.url).toBe(stored.ref);
		expect(parsed.file.size).toBe(source.length);
	});

	it("never re-renders a finished CAS artifact through the pdf or render fns", async () => {
		const source = await bigPdf();
		smartFetchMock.mockResolvedValue(new Response(source, { status: 200, headers: { "content-type": "application/pdf" } }));
		const env = mkEnv();
		const stored = JSON.parse((await put.run(env, { urls: ["https://example.com/big.pdf"], force: true })).content[0].text)[0];

		pdfSpy.mockClear();
		await get.run(env, { input: stored.ref });
		expect(pdfSpy).not.toHaveBeenCalled();
		expect(renderSpy).not.toHaveBeenCalled();
	});
});

describe("get never returns a plausible stub (#1479)", () => {
	it("returns a non-renderable binary as-is rather than printing it in headless Chromium", async () => {
		const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...randomBytes(2048)]);
		smartFetchMock.mockResolvedValue(new Response(docx, { status: 200, headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } }));

		const out = await get.run(mkEnv(), { input: "https://example.com/report.docx", deliver: "inline" });
		expect(out.content[0].text).not.toMatch(/failed/);
		expect(out.isError).toBeFalsy();
		expect(renderSpy).not.toHaveBeenCalled();
		const parsed = JSON.parse(out.content[0].text);
		expect(parsed.converted).toBe(false);
		expect(parsed.file.size).toBe(docx.length);
	});

	it("fails loudly when render hands back bytes that are not a PDF", async () => {
		smartFetchMock.mockRejectedValue(new Error("bot wall"));
		renderSpy.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ mime: "application/pdf", base64: toB64(new TextEncoder().encode("<html>nope</html>")) }) }] });

		const out = await get.run(mkEnv(), { input: "https://example.com/walled" });
		expect(out.isError).toBe(true);
		expect(out.content[0].text).toMatch(/not a PDF/i);
	});

	it("surfaces a pdf-fn failure as an error instead of a parse crash", async () => {
		const html = new TextEncoder().encode("<html><body>hi</body></html>");
		smartFetchMock.mockResolvedValue(new Response(html, { status: 200, headers: { "content-type": "text/html" } }));
		renderSpy.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ mime: "application/pdf", base64: toB64(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])) }) }] });
		pdfSpy.mockResolvedValue({ content: [{ type: "text", text: "pdf failed: donor is encrypted" }], isError: true });

		const out = await get.run(mkEnv(), { input: "https://example.com/page" });
		expect(out.isError).toBe(true);
		expect(out.content[0].text).toMatch(/donor is encrypted/);
	});
});
