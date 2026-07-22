import { afterEach, describe, expect, it, vi } from "vitest";

import { ocr } from "./ocr";
import { toB64 } from "./_util";

// smartFetch (proxy) does a direct fetch for a first-party API host like api.mistral.ai,
// so stubbing global fetch exercises the REAL smartFetch + _ocr + putBlob path (the
// study/oracle suite idiom) — only the network egress is faked.
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

/** A minimal Map-backed OAUTH_KV + R2 so putBlob (the store leg + Mistral file-upload URL) works. */
function makeEnv(opts: { key?: boolean } = {}) {
	const kv = new Map<string, string>();
	const objects = new Map<string, unknown>();
	const env: any = {
		OAUTH_KV: { put: vi.fn(async (k: string, v: string) => void kv.set(k, v)), get: vi.fn(async (k: string) => kv.get(k) ?? null), delete: vi.fn() },
		R2: { put: vi.fn(async (k: string, v: unknown) => void objects.set(k, v)) },
		STORE_BASE: "https://suxos.net",
	};
	if (opts.key !== false) env.MISTRAL_API_KEY = "test-key";
	return { env, kv, objects };
}

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // ‰PNG
const mistralResponse = (markdown: string) => new Response(JSON.stringify({ pages: [{ index: 0, markdown }] }), { status: 200, headers: { "content-type": "application/json" } });
const parse = (r: any) => JSON.parse(r.content[0].text);

afterEach(() => {
	vi.clearAllMocks();
	fetchMock.mockReset();
});

describe("ocr — first-class Mistral smart-scan", () => {
	it("requires url or file", async () => {
		const r = await ocr.run(makeEnv().env, {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Provide `url` or `file`/);
	});

	it("rejects a non-http url", async () => {
		const r = await ocr.run(makeEnv().env, { url: "ftp://nope/a.pdf" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/absolute http/);
	});

	it("PDF bytes → Mistral OCR (document part), returns the transcribed text", async () => {
		fetchMock.mockResolvedValue(mistralResponse("# Lease\nRent due on the 1st."));
		const { env } = makeEnv();
		const r = await ocr.run(env, { file: toB64(PDF_BYTES) });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("# Lease\nRent due on the 1st.");
		// One Mistral call, keyed on the CAS handle, as a document_url (not image_url).
		const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
		expect(String(url)).toBe("https://api.mistral.ai/v1/ocr");
		const body = JSON.parse((init as any).body);
		expect(body.model).toBe("mistral-ocr-latest");
		expect(body.document.type).toBe("document_url");
		expect((init as any).headers.Authorization).toBe("Bearer test-key");
	});

	it("a .pdf URL → Mistral fetches it directly as a document_url (no local re-upload)", async () => {
		fetchMock.mockResolvedValue(mistralResponse("PDF text from the url."));
		const { env, objects } = makeEnv();
		const r = await ocr.run(env, { url: "https://example.com/report.pdf" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("PDF text from the url.");
		const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
		expect(body.document).toEqual({ type: "document_url", document_url: "https://example.com/report.pdf" });
		expect(objects.size).toBe(0); // nothing stored — Mistral fetched the source itself
	});

	it("an image (default kind) is STORED, not OCR'd — returns its handle, no Mistral call", async () => {
		const { env, objects } = makeEnv();
		const r = await ocr.run(env, { file: toB64(PNG_BYTES) });
		expect(r.isError).toBeFalsy();
		const j = parse(r);
		expect(j).toMatchObject({ stored: true, ocr: false, content_type: "image/png" });
		expect(j.url).toMatch(/\/s\/[0-9a-f-]{36}$/);
		expect(objects.size).toBe(1);
		expect(fetchMock).not.toHaveBeenCalled(); // no OCR forced on a plain image
	});

	it("kind:\"doc\" forces OCR on an image (a photo of a document) — image_url part", async () => {
		fetchMock.mockResolvedValue(mistralResponse("passport no. X123, exp 2030."));
		const { env } = makeEnv();
		const r = await ocr.run(env, { file: toB64(PNG_BYTES), kind: "doc" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("passport no. X123, exp 2030.");
		const body = JSON.parse((fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1] as any).body);
		expect(body.document.type).toBe("image_url");
	});

	it("OCR failure (Mistral 500) stores the raw and returns needs_ocr — never fabricates text", async () => {
		fetchMock.mockResolvedValue(new Response("upstream boom", { status: 500 }));
		const { env, objects } = makeEnv();
		const r = await ocr.run(env, { file: toB64(PDF_BYTES) });
		expect(r.isError).toBeFalsy();
		const j = parse(r);
		expect(j.needs_ocr).toBe(true);
		expect(j.reason).toMatch(/500/);
		expect(j.stored.url).toMatch(/\/s\//);
		expect(j.stored.content_type).toBe("application/pdf");
		expect(objects.size).toBeGreaterThan(0); // raw kept
	});

	it("unconfigured (no MISTRAL_API_KEY) also degrades to store-raw + needs_ocr, no fabrication", async () => {
		const { env } = makeEnv({ key: false });
		const r = await ocr.run(env, { file: toB64(PDF_BYTES) });
		expect(r.isError).toBeFalsy();
		const j = parse(r);
		expect(j.needs_ocr).toBe(true);
		expect(j.reason).toMatch(/MISTRAL_API_KEY/);
		expect(fetchMock).not.toHaveBeenCalled(); // never reached the API without a key
	});
});
