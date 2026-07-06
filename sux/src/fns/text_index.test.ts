import { describe, expect, it } from "vitest";
import { textIndex } from "./text_index";

const run = (args: any) => textIndex.run({} as any, args);
const json = async (args: any) => JSON.parse((await run(args)).content[0].text);

const DOCS = [
	{ id: "cat", text: "The quick brown fox jumps over the lazy dog" },
	{ id: "finance", text: "Federal Reserve raises interest rates to fight inflation" },
	{ id: "mixed", text: "A dog and a fox discuss interest rates over coffee" },
];

describe("index", () => {
	it("builds an inverted index", async () => {
		const idx = await json({ documents: DOCS });
		expect(idx.n).toBe(3);
		expect(idx.postings.fox).toBeTruthy();
		expect(idx.docs.map((d: any) => d.id)).toEqual(["cat", "finance", "mixed"]);
	});

	it("ranks query results by BM25", async () => {
		const idx = await json({ documents: DOCS });
		const res = await json({ mode: "query", index: idx, query: "interest rates" });
		expect(res.hits[0].id).toBe("finance");
		expect(res.hits.map((h: any) => h.id)).toContain("mixed");
		expect(res.hits.every((h: any) => h.score > 0)).toBe(true);
	});

	it("accepts plain string documents", async () => {
		const idx = await json({ documents: ["hello world", "goodbye world"] });
		const res = await json({ mode: "query", index: idx, query: "hello" });
		expect(res.hits[0].id).toBe("0");
	});

	it("round-trips through a compressed index (build compress -> query uncompress)", async () => {
		const built = await json({ documents: DOCS, compress: true });
		expect(built.compressed).toBe(true);
		expect(built.out_bytes).toBeLessThan(built.in_bytes + 1); // gzip blob present
		// Query using the gzip+base64 blob directly — loadIndex must inflate it.
		const res = await json({ mode: "query", index: built.base64, query: "fox dog" });
		expect(res.hits[0].id).toBe("cat");
	});

	it("accepts a JSON-string index", async () => {
		const idxStr = (await run({ documents: DOCS })).content[0].text;
		const res = await json({ mode: "query", index: idxStr, query: "inflation" });
		expect(res.hits[0].id).toBe("finance");
	});

	it("honors stopwords toggle", async () => {
		const idx = await json({ documents: ["the the the cat"], stopwords: false });
		expect(idx.postings.the).toBeTruthy(); // stopword kept
		const idx2 = await json({ documents: ["the the the cat"] });
		expect(idx2.postings.the).toBeUndefined(); // stopword dropped by default
	});

	it("errors on empty documents and missing query/index", async () => {
		expect((await run({ documents: [] })).isError).toBe(true);
		expect((await run({ mode: "query", index: {} })).isError).toBe(true);
		expect((await run({ mode: "query", query: "x" })).isError).toBe(true);
	});

	it("is marked raw", () => {
		expect(textIndex.raw).toBe(true);
	});
});
