import { afterEach, describe, expect, it, vi } from "vitest";

const { kagiTool } = vi.hoisted(() => ({ kagiTool: vi.fn() }));
vi.mock("../kagi", () => ({ kagiTool }));

const { kagiSession } = vi.hoisted(() => ({ kagiSession: vi.fn() }));
vi.mock("./web_search", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./web_search")>();
	return { ...actual, kagiSession };
});

const { pdfRun, renderRun, waybackRun, scrapeRun, ingestRun, loadBytesMock, putBlobMock } = vi.hoisted(() => ({
	pdfRun: vi.fn(),
	renderRun: vi.fn(),
	waybackRun: vi.fn(),
	scrapeRun: vi.fn(),
	ingestRun: vi.fn(),
	loadBytesMock: vi.fn(),
	putBlobMock: vi.fn(),
}));
vi.mock("./index", () => ({
	FUNCTIONS: [
		{ name: "pdf", run: pdfRun },
		{ name: "render", run: renderRun },
		{ name: "wayback", run: waybackRun },
		{ name: "scrape", run: scrapeRun },
		{ name: "ingest", run: ingestRun },
	],
}));
vi.mock("./_util", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./_util")>();
	return { ...actual, loadBytes: loadBytesMock, putBlob: putBlobMock };
});

afterEach(() => vi.clearAllMocks());

function blobEnv() {
	const r2 = new Map<string, Uint8Array>();
	const kv = new Map<string, string>();
	return {
		R2: {
			put: async (k: string, v: any) => void r2.set(k, new Uint8Array(v)),
			get: async (k: string) => {
				const b = r2.get(k);
				return b ? { size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), text: async () => new TextDecoder().decode(b) } : null;
			},
		},
		OAUTH_KV: { put: async (k: string, v: string) => void kv.set(k, v), get: async (k: string) => kv.get(k) ?? null },
	} as any;
}

import { isUrlInput, parseStrategies } from "./get";
import { KIND_PLANS, LENSES } from "./get";
import { dedupeEditions } from "./get";
import { runStrategies } from "./get";
import { fetchAndNormalize } from "./get";
import { acquireFromUrl } from "./get";
import { storeResult } from "./get";
import { get } from "./get";

describe("isUrlInput", () => {
	it("recognizes absolute http(s) URLs", () => {
		expect(isUrlInput("https://example.com/doc.pdf")).toBe(true);
		expect(isUrlInput("http://example.com")).toBe(true);
	});
	it("rejects plain queries", () => {
		expect(isUrlInput("deep learning textbook")).toBe(false);
		expect(isUrlInput("file(pdf, cats)")).toBe(false);
	});
});

describe("parseStrategies", () => {
	it("wraps a bare query with the given kind (default any)", () => {
		expect(parseStrategies("deep learning textbook")).toEqual([{ kind: "any", query: "deep learning textbook" }]);
		expect(parseStrategies("deep learning textbook", "pdf")).toEqual([{ kind: "pdf", query: "deep learning textbook" }]);
	});

	it("parses one or more file(kind, query) clauses, ignoring the kind arg", () => {
		const strategies = parseStrategies("file(pdf, deep learning) file(code, react hooks)", "docs");
		expect(strategies).toEqual([
			{ kind: "pdf", query: "deep learning" },
			{ kind: "code", query: "react hooks" },
		]);
	});

	it("falls back to a bare-query strategy when no clause matches a known kind", () => {
		expect(parseStrategies("file(bogus, x)")).toEqual([{ kind: "any", query: "file(bogus, x)" }]);
	});
});

describe("LENSES", () => {
	it("has the full verified catalog (built-in + custom, shared)", () => {
		expect(LENSES).toEqual({
			pdfs: "3",
			usenetArchive: "5648",
			academic: "2",
			documentHosts: "31362",
			codeSearch: "31363",
			techDocs: "31364",
			artifacts: "31365",
			wikisNotes: "31366",
		});
	});
});

describe("KIND_PLANS", () => {
	it("maps every kind to <=2 lens ids (bounded metered spend)", () => {
		for (const plan of Object.values(KIND_PLANS)) expect(plan.lensIds.length).toBeLessThanOrEqual(2);
	});
	it("scopes 'pdf' to the PDFs lens plus a filetype:pdf operator", () => {
		expect(KIND_PLANS.pdf).toEqual({ operatorScopes: [{ file_type: "pdf" }], lensIds: [LENSES.pdfs] });
	});
	it("scopes 'any' to both bounded lenses plus pdf/archive.org operators", () => {
		expect(KIND_PLANS.any.lensIds).toEqual([LENSES.pdfs, LENSES.usenetArchive]);
		expect(KIND_PLANS.any.operatorScopes).toEqual([{ file_type: "pdf" }, { include_domains: ["archive.org"] }]);
	});
});

describe("dedupeEditions", () => {
	it("collapses the same title+filetype mirrored across different hosts into one edition", () => {
		const hits = [
			{ title: "Understanding Machine Learning", url: "https://archive.org/download/x/understanding-machine-learning.pdf" },
			{ title: "Understanding Machine Learning", url: "https://mirror.example.edu/files/understanding-machine-learning.pdf" },
		];
		const editions = dedupeEditions(hits);
		expect(editions.length).toBe(1);
		expect(editions[0].host).toBe("archive.org"); // first-seen wins
	});

	it("keeps different filetypes of the same title as separate editions", () => {
		const hits = [
			{ title: "Understanding Machine Learning", url: "https://a.com/book.pdf" },
			{ title: "Understanding Machine Learning", url: "https://a.com/book.epub" },
		];
		expect(dedupeEditions(hits).length).toBe(2);
	});

	it("keeps distinctly different titles as separate editions and assigns increasing rank", () => {
		const hits = [
			{ title: "Understanding Machine Learning", url: "https://a.com/a.pdf" },
			{ title: "Deep Learning by Goodfellow", url: "https://b.com/b.pdf" },
		];
		const editions = dedupeEditions(hits);
		expect(editions.length).toBe(2);
		expect(editions.map((e) => e.rank)).toEqual([1, 2]);
	});

	it("skips a hit with no parseable URL instead of throwing", () => {
		const hits = [{ title: "Bad", url: "not-a-url" }, { title: "Good", url: "https://a.com/g.pdf" }];
		expect(dedupeEditions(hits).length).toBe(1);
	});
});

describe("runStrategies", () => {
	it("runs operator strategies via kagiSession and lens strategies via kagiTool, merging all hits", async () => {
		kagiSession.mockResolvedValueOnce([{ title: "Op Hit", url: "https://a.com/op.pdf" }]);
		kagiTool.mockResolvedValueOnce({ content: [{ text: "### [Lens Hit](https://b.com/lens.pdf)\nsnippet" }] });
		const hits = await runStrategies({ KAGI_SESSION: "tok", KAGI_API_KEY: "k" }, [{ kind: "pdf", query: "textbook" }], [], "auto");
		expect(hits.map((h) => h.title)).toEqual(["Op Hit", "Lens Hit"]);
	});

	it("skips operator strategies when KAGI_SESSION is unset", async () => {
		kagiTool.mockResolvedValueOnce({ content: [{ text: "### [Lens Hit](https://b.com/lens.pdf)\nsnippet" }] });
		const hits = await runStrategies({ KAGI_API_KEY: "k" }, [{ kind: "pdf", query: "textbook" }], [], "auto");
		expect(kagiSession).not.toHaveBeenCalled();
		expect(hits.map((h) => h.title)).toEqual(["Lens Hit"]);
	});

	it("skips lens strategies when KAGI_API_KEY is unset", async () => {
		kagiSession.mockResolvedValueOnce([{ title: "Op Hit", url: "https://a.com/op.pdf" }]);
		const hits = await runStrategies({ KAGI_SESSION: "tok" }, [{ kind: "pdf", query: "textbook" }], [], "auto");
		expect(kagiTool).not.toHaveBeenCalled();
		expect(hits.map((h) => h.title)).toEqual(["Op Hit"]);
	});

	it("throws when neither secret is configured", async () => {
		await expect(runStrategies({}, [{ kind: "pdf", query: "x" }], [], "auto")).rejects.toThrow(/KAGI_SESSION|KAGI_API_KEY/);
	});

	it("swallows a single strategy's failure instead of rejecting the whole fan-out", async () => {
		kagiSession.mockRejectedValueOnce(new Error("boom"));
		kagiTool.mockResolvedValueOnce({ content: [{ text: "### [Lens Hit](https://b.com/lens.pdf)\nsnippet" }] });
		const hits = await runStrategies({ KAGI_SESSION: "tok", KAGI_API_KEY: "k" }, [{ kind: "pdf", query: "x" }], [], "auto");
		expect(hits.map((h) => h.title)).toEqual(["Lens Hit"]);
	});
});

describe("fetchAndNormalize", () => {
	it("compresses a PDF via the pdf fn and reports converted:false", async () => {
		const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4
		loadBytesMock.mockResolvedValueOnce({ bytes: pdfBytes, contentType: "application/pdf" });
		pdfRun.mockResolvedValueOnce({ content: [{ type: "text", text: '{"mime":"application/pdf","size":8,"base64":"x"}' }] });
		const { result, converted } = await fetchAndNormalize({} as any, "https://a.com/doc.pdf", false, "inline");
		expect(converted).toBe(false);
		expect(pdfRun).toHaveBeenCalledWith({}, expect.objectContaining({ compress: true, as: "base64" }));
		expect(result.content[0].text).toContain("application/pdf");
	});

	it("converts html to PDF via the pdf fn when convertToPdf is true, reports converted:true", async () => {
		const html = new TextEncoder().encode("<html><body>hi</body></html>");
		loadBytesMock.mockResolvedValueOnce({ bytes: html, contentType: "text/html; charset=utf-8" });
		pdfRun.mockResolvedValueOnce({ content: [{ type: "text", text: '{"mime":"application/pdf","size":8,"base64":"x"}' }] });
		const { converted } = await fetchAndNormalize({} as any, "https://a.com/page.html", true, "inline");
		expect(converted).toBe(true);
		expect(pdfRun).toHaveBeenCalledWith({}, expect.objectContaining({ kind: "html", compress: true }));
	});

	it("delivers a non-convertible binary (e.g. epub) as-is, respecting deliver:url via the real content-addressed store", async () => {
		const bytes = new Uint8Array([1, 2, 3, 4]);
		loadBytesMock.mockResolvedValueOnce({ bytes, contentType: "application/epub+zip" });
		const { result, converted } = await fetchAndNormalize(blobEnv(), "https://a.com/book.epub", true, "url");
		expect(converted).toBe(false);
		expect(pdfRun).not.toHaveBeenCalled();
		expect(result.isError).toBeFalsy();
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.url).toMatch(/^https:\/\/suxos\.net\/s\//);
	});
});

describe("acquireFromUrl", () => {
	it("as:pdf delegates to render(as:pdf, delivery:base64) and decodes the returned base64", async () => {
		renderRun.mockResolvedValueOnce({ content: [{ text: '{"mime":"application/pdf","size":4,"base64":"JVBERg=="}' }] });
		const { bytes, contentType } = await acquireFromUrl({} as any, "https://a.com/page", "pdf");
		expect(renderRun).toHaveBeenCalledWith({}, expect.objectContaining({ url: "https://a.com/page", as: "pdf", delivery: "base64" }));
		expect(contentType).toBe("application/pdf");
		expect(bytes.length).toBeGreaterThan(0);
	});

	it("as:archive uses wayback's raw_url when a snapshot is available", async () => {
		waybackRun.mockResolvedValueOnce({ content: [{ text: '{"available":true,"url":"https://web.archive.org/web/2020/https://a.com","raw_url":"https://web.archive.org/web/2020id_/https://a.com"}' }] });
		loadBytesMock.mockResolvedValueOnce({ bytes: new TextEncoder().encode("<html>archived</html>"), contentType: "text/html" });
		const { contentType } = await acquireFromUrl({} as any, "https://a.com", "archive");
		expect(waybackRun).toHaveBeenCalledWith({}, expect.objectContaining({ url: "https://a.com", mode: "snapshot" }));
		expect(loadBytesMock).toHaveBeenCalledWith({}, { url: "https://web.archive.org/web/2020id_/https://a.com" });
		expect(contentType).toBe("text/html");
	});

	it("as:archive falls back to scrape when no wayback snapshot exists", async () => {
		waybackRun.mockResolvedValueOnce({ content: [{ text: '{"available":false,"url":"https://a.com"}' }] });
		scrapeRun.mockResolvedValueOnce({ content: [{ text: "<html>live</html>" }] });
		const { bytes, contentType } = await acquireFromUrl({} as any, "https://a.com", "archive");
		expect(scrapeRun).toHaveBeenCalledWith({}, { url: "https://a.com" });
		expect(contentType).toBe("text/html");
		expect(new TextDecoder().decode(bytes)).toBe("<html>live</html>");
	});
});

describe("storeResult", () => {
	it("puts the bytes into the content-addressed store, then delegates to ingest with that URL", async () => {
		putBlobMock.mockResolvedValueOnce({ uuid: "u1", url: "https://sux.example/s/u1", key: "cas/abc", sha256: "abc", size: 4, content_type: "application/pdf" });
		ingestRun.mockResolvedValueOnce({ content: [{ text: '{"path":"Inbox/2026-07-15 doc.md"}' }] });
		const { where, ref } = await storeResult({} as any, new Uint8Array([1, 2, 3, 4]), "application/pdf", "vault", true);
		expect(putBlobMock).toHaveBeenCalledWith({}, expect.any(Uint8Array), "application/pdf");
		expect(ingestRun).toHaveBeenCalledWith({}, expect.objectContaining({ url: "https://sux.example/s/u1", blobs: "auto", summarize: true, tags: ["get"] }));
		expect(where).toBe("vault");
		expect(ref).toContain("Inbox");
	});

	it("passes blobs:dropbox when store is dropbox", async () => {
		putBlobMock.mockResolvedValueOnce({ uuid: "u2", url: "https://sux.example/s/u2", key: "cas/def", sha256: "def", size: 4, content_type: "application/pdf" });
		ingestRun.mockResolvedValueOnce({ content: [{ text: "{}" }] });
		await storeResult({} as any, new Uint8Array([1]), "application/pdf", "dropbox", false);
		expect(ingestRun).toHaveBeenCalledWith({}, expect.objectContaining({ blobs: "dropbox", summarize: false }));
	});

	it("throws when ingest itself fails", async () => {
		putBlobMock.mockResolvedValueOnce({ uuid: "u3", url: "https://sux.example/s/u3", key: "cas/ghi", sha256: "ghi", size: 1, content_type: "application/pdf" });
		ingestRun.mockResolvedValueOnce({ isError: true, content: [{ text: "vault not configured" }] });
		await expect(storeResult({} as any, new Uint8Array([1]), "application/pdf", "vault", false)).rejects.toThrow(/vault not configured/);
	});
});

describe("get.run", () => {
	it("query mode: fans out, dedupes to unique editions, downloads+normalizes the top one, returns file+editions+picked", async () => {
		kagiSession.mockResolvedValueOnce([{ title: "Understanding ML", url: "https://archive.org/a/understanding-ml.pdf" }]);
		kagiTool.mockResolvedValueOnce({ content: [{ text: "### [Understanding ML](https://mirror.edu/understanding-ml.pdf)\nsnippet" }] });
		const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
		loadBytesMock.mockResolvedValueOnce({ bytes: pdfBytes, contentType: "application/pdf" });
		pdfRun.mockResolvedValueOnce({ content: [{ text: '{"mime":"application/pdf","size":4,"base64":"JVBR"}' }] });

		const r = await get.run({ KAGI_SESSION: "tok", KAGI_API_KEY: "k" } as any, { input: "understanding machine learning", kind: "pdf" });
		expect(r.isError).toBeFalsy();
		const parsed = JSON.parse(r.content[0].text);
		expect(parsed.editions.length).toBe(1); // same title+filetype mirrored -> one edition
		expect(parsed.picked).toBe(0);
		expect(parsed.file.base64).toBe("JVBR");
	});

	it("query mode with download:false returns only ranked editions, no file/network fetch", async () => {
		kagiSession.mockResolvedValueOnce([{ title: "A Book", url: "https://a.com/a.pdf" }]);
		const r = await get.run({ KAGI_SESSION: "tok" } as any, { input: "a book", kind: "pdf", download: false });
		expect(r.isError).toBeFalsy();
		const parsed = JSON.parse(r.content[0].text);
		expect(parsed.editions.length).toBe(1);
		expect(parsed.file).toBeUndefined();
		expect(parsed.picked).toBeNull();
		expect(loadBytesMock).not.toHaveBeenCalled();
	});

	it("query mode returns a clear failure when no editions are found", async () => {
		kagiSession.mockResolvedValueOnce([]);
		const r = await get.run({ KAGI_SESSION: "tok" } as any, { input: "nonexistent thing", kind: "pdf" });
		expect(r.isError).toBe(true);
	});

	it("url mode: acquires via render(as:pdf) and normalizes, no editions in the result", async () => {
		renderRun.mockResolvedValueOnce({ content: [{ text: '{"mime":"application/pdf","size":4,"base64":"JVBERg=="}' }] });
		pdfRun.mockResolvedValueOnce({ content: [{ text: '{"mime":"application/pdf","size":4,"base64":"JVBR2"}' }] });
		const r = await get.run({} as any, { input: "https://example.com/article" });
		expect(r.isError).toBeFalsy();
		const parsed = JSON.parse(r.content[0].text);
		expect(parsed.editions).toBeUndefined();
		expect(parsed.file.base64).toBe("JVBR2");
	});

	it("stores the result when store is requested", async () => {
		kagiSession.mockResolvedValueOnce([{ title: "A Book", url: "https://a.com/a.pdf" }]);
		const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
		loadBytesMock.mockResolvedValueOnce({ bytes: pdfBytes, contentType: "application/pdf" });
		pdfRun.mockResolvedValueOnce({ content: [{ text: '{"mime":"application/pdf","size":4,"base64":"JVBR"}' }] });
		putBlobMock.mockResolvedValueOnce({ uuid: "u1", url: "https://sux.example/s/u1", key: "cas/abc", sha256: "abc", size: 4, content_type: "application/pdf" });
		ingestRun.mockResolvedValueOnce({ content: [{ text: '{"path":"Inbox/x.md"}' }] });

		const r = await get.run({ KAGI_SESSION: "tok" } as any, { input: "a book", kind: "pdf", store: "vault" });
		const parsed = JSON.parse(r.content[0].text);
		expect(parsed.stored.where).toBe("vault");
	});
});
