import { afterEach, describe, expect, it, vi } from "vitest";

const { kagiTool } = vi.hoisted(() => ({ kagiTool: vi.fn() }));
vi.mock("../kagi", () => ({ kagiTool }));

const { kagiSession } = vi.hoisted(() => ({ kagiSession: vi.fn() }));
vi.mock("./web_search", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./web_search")>();
	return { ...actual, kagiSession };
});

const { pdfRun, loadBytesMock } = vi.hoisted(() => ({ pdfRun: vi.fn(), loadBytesMock: vi.fn() }));
vi.mock("./index", () => ({ FUNCTIONS: [{ name: "pdf", run: pdfRun }] }));
vi.mock("./_util", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./_util")>();
	return { ...actual, loadBytes: loadBytesMock };
});

afterEach(() => vi.clearAllMocks());

import { isUrlInput, parseStrategies } from "./get";
import { KIND_PLANS, LENSES } from "./get";
import { dedupeEditions } from "./get";
import { runStrategies } from "./get";
import { fetchAndNormalize } from "./get";

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

	it("delivers a non-convertible binary (e.g. epub) as-is even when convertToPdf is true", async () => {
		const bytes = new Uint8Array([1, 2, 3, 4]);
		loadBytesMock.mockResolvedValueOnce({ bytes, contentType: "application/epub+zip" });
		const { result, converted } = await fetchAndNormalize({} as any, "https://a.com/book.epub", true, "url");
		expect(converted).toBe(false);
		expect(pdfRun).not.toHaveBeenCalled();
		expect(result.isError).toBeFalsy();
	});
});
