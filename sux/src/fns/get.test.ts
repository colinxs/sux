import { describe, expect, it } from "vitest";
import { isUrlInput, parseStrategies } from "./get";
import { KIND_PLANS, LENSES } from "./get";
import { dedupeEditions } from "./get";

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
