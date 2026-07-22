import { afterEach, describe, expect, it, vi } from "vitest";

import { hasMistral, isImageMime, isPdfBytes, looksImageUrl, ocrBytes, ocrDocument, ocrTextOrUndefined, ocrUrl, sniffMime } from "./_ocr";

// smartFetch (proxy) direct-fetches a first-party host like api.mistral.ai, so stubbing
// global fetch exercises the REAL smartFetch + putBlob path (only egress is faked).
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function makeEnv(opts: { key?: boolean } = {}) {
	const kv = new Map<string, string>();
	const objects = new Map<string, unknown>();
	const env: any = {
		OAUTH_KV: { put: vi.fn(async (k: string, v: string) => void kv.set(k, v)), get: vi.fn(async (k: string) => kv.get(k) ?? null), delete: vi.fn() },
		R2: { put: vi.fn(async (k: string, v: unknown) => void objects.set(k, v)) },
		STORE_BASE: "https://suxos.net",
	};
	if (opts.key !== false) env.MISTRAL_API_KEY = "test-key";
	return { env, objects };
}

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // %PDF-1
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const mistral = (markdown: string) => new Response(JSON.stringify({ pages: [{ index: 0, markdown }] }), { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
	vi.clearAllMocks();
	fetchMock.mockReset();
});

describe("_ocr — helpers", () => {
	it("hasMistral reflects the MISTRAL_API_KEY secret", () => {
		expect(hasMistral({ MISTRAL_API_KEY: "k" })).toBe(true);
		expect(hasMistral({ MISTRAL_API_KEY: "  " })).toBe(false);
		expect(hasMistral({})).toBe(false);
	});

	it("sniffMime / isPdfBytes recognize magic numbers", () => {
		expect(sniffMime(PDF)).toBe("application/pdf");
		expect(sniffMime(PNG)).toBe("image/png");
		expect(sniffMime(JPEG)).toBe("image/jpeg");
		expect(sniffMime(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
		expect(isPdfBytes(PDF)).toBe(true);
		expect(isPdfBytes(PNG)).toBe(false);
	});

	it("isImageMime / looksImageUrl classify image types and URLs", () => {
		expect(isImageMime("image/png")).toBe(true);
		expect(isImageMime("application/pdf")).toBe(false);
		expect(looksImageUrl("https://x/photo.jpg")).toBe(true);
		expect(looksImageUrl("https://x/report.pdf")).toBe(false);
		expect(looksImageUrl("https://suxos.net/s/uuid")).toBe(false); // extension-less → document
	});
});

describe("_ocr — ocrUrl (the single Mistral engine)", () => {
	it("throws (clean message) when unconfigured", async () => {
		const { env } = makeEnv({ key: false });
		await expect(ocrUrl(env, "https://x/a.pdf")).rejects.toThrow(/MISTRAL_API_KEY/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("posts a document_url for a PDF url and joins per-page markdown", async () => {
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ pages: [{ markdown: "page 1" }, { markdown: "page 2" }] }), { status: 200 }));
		const { env } = makeEnv();
		const text = await ocrUrl(env, "https://x/report.pdf");
		expect(text).toBe("page 1\n\npage 2");
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe("https://api.mistral.ai/v1/ocr");
		const body = JSON.parse((init as any).body);
		expect(body).toMatchObject({ model: "mistral-ocr-latest", document: { type: "document_url", document_url: "https://x/report.pdf" } });
		expect((init as any).headers.Authorization).toBe("Bearer test-key");
	});

	it("posts an image_url when image:true", async () => {
		fetchMock.mockResolvedValue(mistral("photo text"));
		const { env } = makeEnv();
		await ocrUrl(env, "https://x/scan", { image: true });
		const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
		expect(body.document).toEqual({ type: "image_url", image_url: "https://x/scan" });
	});

	it("throws on a non-ok response (→ caller's needs_ocr fallback), never fabricates", async () => {
		fetchMock.mockResolvedValue(new Response("nope", { status: 429 }));
		const { env } = makeEnv();
		await expect(ocrUrl(env, "https://x/a.pdf")).rejects.toThrow(/429/);
	});

	it("throws when Mistral returns no page text", async () => {
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ pages: [] }), { status: 200 }));
		const { env } = makeEnv();
		await expect(ocrUrl(env, "https://x/a.pdf")).rejects.toThrow(/no text/i);
	});
});

describe("_ocr — ocrBytes / ocrDocument (compose on ocrUrl via the CAS store)", () => {
	it("content-addresses bytes into R2, then OCRs the /s/ handle (document part for a PDF)", async () => {
		fetchMock.mockResolvedValue(mistral("lease terms"));
		const { env, objects } = makeEnv();
		const text = await ocrBytes(env, PDF);
		expect(text).toBe("lease terms");
		expect(objects.size).toBe(1); // stored to CAS for Mistral to fetch
		const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
		expect(body.document.type).toBe("document_url");
		expect(body.document.document_url).toMatch(/^https:\/\/suxos\.net\/s\/[0-9a-f-]{36}$/);
	});

	it("routes image bytes as an image_url part", async () => {
		fetchMock.mockResolvedValue(mistral("id card text"));
		const { env } = makeEnv();
		await ocrBytes(env, PNG, { image: true });
		const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
		expect(body.document.type).toBe("image_url");
	});

	it("ocrDocument routes url vs bytes", async () => {
		fetchMock.mockImplementation(async () => mistral("x")); // fresh Response per call
		const { env } = makeEnv();
		await ocrDocument(env, { url: "https://x/a.pdf" });
		expect(JSON.parse((fetchMock.mock.calls[0][1] as any).body).document.type).toBe("document_url");
		fetchMock.mockClear();
		await ocrDocument(env, { bytes: PDF });
		expect(JSON.parse((fetchMock.mock.calls[0][1] as any).body).document.document_url).toMatch(/\/s\//);
	});

	it("ocrDocument requires a url or bytes", async () => {
		const { env } = makeEnv();
		await expect(ocrDocument(env, {})).rejects.toThrow(/url` or `bytes/);
	});
});

describe("_ocr — ocrTextOrUndefined (best-effort wrapper)", () => {
	it("returns text on success, undefined on any failure", async () => {
		expect(await ocrTextOrUndefined(async () => "  hi  ")).toBe("hi");
		expect(await ocrTextOrUndefined(async () => "")).toBeUndefined();
		expect(
			await ocrTextOrUndefined(async () => {
				throw new Error("boom");
			}),
		).toBeUndefined();
	});
});
