import { afterEach, describe, expect, it, vi } from "vitest";
import { zotero } from "./zotero";

const env = () => ({ ZOTERO_API_KEY: "key123", ZOTERO_USER_ID: "5609438" }) as any;

afterEach(() => vi.restoreAllMocks());

describe("zotero", () => {
	it("is not_configured when either secret is missing", async () => {
		const r1 = await zotero.run({ ZOTERO_API_KEY: "k" } as any, { action: "collections" });
		expect(r1.isError).toBe(true);
		expect(r1.errorCode).toBe("not_configured");
		const r2 = await zotero.run({} as any, { action: "collections" });
		expect(r2.errorCode).toBe("not_configured");
	});

	it("search sends Zotero-API-Key/Version headers and normalizes items", async () => {
		const body = [
			{
				key: "ABCD1234",
				data: { itemType: "journalArticle", title: "A Paper", creators: [{ firstName: "Ada", lastName: "Lovelace" }], date: "2020", DOI: "10.1/x", tags: [{ tag: "math" }] },
				meta: { numChildren: 2 },
			},
		];
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
		const r = await zotero.run(env(), { action: "search", q: "algebra" });
		const out = JSON.parse(r.content[0].text);
		expect(out.count).toBe(1);
		expect(out.items[0]).toMatchObject({ key: "ABCD1234", title: "A Paper", creators: ["Ada Lovelace"], doi: "10.1/x", tags: ["math"], numChildren: 2 });
		const [url, init] = spy.mock.calls[0];
		expect(String(url)).toContain("/users/5609438/items?");
		expect(String(url)).toContain("q=algebra");
		expect((init?.headers as Record<string, string>)["Zotero-API-Key"]).toBe("key123");
		expect((init?.headers as Record<string, string>)["Zotero-API-Version"]).toBe("3");
	});

	it("search requires q", async () => {
		const r = await zotero.run(env(), { action: "search" });
		expect(r.isError).toBe(true);
	});

	it("search scopes to a collection's items when `collection` is given", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
		await zotero.run(env(), { action: "search", q: "x", collection: "COLLKEY" });
		expect(String(spy.mock.calls[0][0])).toContain("/collections/COLLKEY/items?");
	});

	it("item fetches detail + children in parallel", async () => {
		const item = { key: "K1", data: { itemType: "book", title: "The Book" }, meta: {} };
		const children = [{ key: "K2", data: { itemType: "note", note: "<p>hi <b>there</b></p>" } }, { key: "K3", data: { itemType: "attachment", filename: "scan.pdf", contentType: "application/pdf" } }];
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
			const url = String(input);
			if (url.endsWith("/children")) return new Response(JSON.stringify(children), { status: 200 });
			return new Response(JSON.stringify(item), { status: 200 });
		});
		const r = await zotero.run(env(), { action: "item", key: "K1" });
		const out = JSON.parse(r.content[0].text);
		expect(out.item).toMatchObject({ key: "K1", title: "The Book" });
		expect(out.children).toHaveLength(2);
		expect(out.children[0]).toMatchObject({ key: "K2", title: "hi there" });
		expect(out.children[1]).toMatchObject({ key: "K3", filename: "scan.pdf", contentType: "application/pdf" });
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("item requires key", async () => {
		const r = await zotero.run(env(), { action: "item" });
		expect(r.isError).toBe(true);
	});

	it("collections builds a tree from one flat request via parentCollection links", async () => {
		const flat = [
			{ key: "TOP", data: { name: "Top", parentCollection: false }, meta: { numItems: 3 } },
			{ key: "CHILD", data: { name: "Child", parentCollection: "TOP" }, meta: { numItems: 1 } },
		];
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(flat), { status: 200 }));
		const r = await zotero.run(env(), { action: "collections" });
		const out = JSON.parse(r.content[0].text);
		expect(out.collections).toHaveLength(1);
		expect(out.collections[0]).toMatchObject({ key: "TOP", name: "Top", numItems: 3 });
		expect(out.collections[0].children).toEqual([{ key: "CHILD", name: "Child", numItems: 1, children: [] }]);
		expect(spy).toHaveBeenCalledTimes(1); // no per-node recursive fetch
	});

	it("recent sorts by dateModified desc against /items/top", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
		await zotero.run(env(), { action: "recent", limit: 5 });
		const url = String(spy.mock.calls[0][0]);
		expect(url).toContain("/items/top?");
		expect(url).toContain("sort=dateModified");
		expect(url).toContain("direction=desc");
		expect(url).toContain("limit=5");
	});

	it("bib parses the csl-entry HTML into plain-text citation lines", async () => {
		const html = `<div class="csl-bib-body"><div class="csl-entry">Lovelace, A. (2020). <i>A Paper</i>.</div><div class="csl-entry">Turing, A. (1950). <i>Computing.</i></div></div>`;
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(html, { status: 200 }));
		const r = await zotero.run(env(), { action: "bib", keys: ["ABCD1234", "EFGH5678"], style: "chicago-author-date" });
		const out = JSON.parse(r.content[0].text);
		expect(out.style).toBe("chicago-author-date");
		expect(out.entries).toEqual(["Lovelace, A. (2020). A Paper .", "Turing, A. (1950). Computing."]);
		const url = String(spy.mock.calls[0][0]);
		expect(url).toContain("itemKey=ABCD1234%2CEFGH5678");
		expect(url).toContain("format=bib");
		expect(url).toContain("style=chicago-author-date");
	});

	it("bib requires a non-empty keys array", async () => {
		const r = await zotero.run(env(), { action: "bib", keys: [] });
		expect(r.isError).toBe(true);
	});

	it("rejects an unknown action", async () => {
		const r = await zotero.run(env(), { action: "nope" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/search, item, collections, recent, bib/);
	});

	it("surfaces the Backoff header on an HTTP error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("slow down", { status: 429, headers: { Backoff: "5" } }));
		const r = await zotero.run(env(), { action: "collections" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/429/);
		expect(r.content[0].text).toMatch(/back off 5s/);
	});
});
