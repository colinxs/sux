import { describe, expect, it, vi } from "vitest";

// Stub FUNCTIONS with fake retailer fns so we test product_search's fan-out and
// merge plumbing, not the real retailers. `kroger` echoes the args it received
// (so we can assert zip pass-through) and returns one product; `walmart` returns
// two; `amazon` fails (isError). The rest are absent from the merged output.
const seen = vi.hoisted(() => ({ krogerArgs: null as any }));

vi.mock("./index", () => ({
	FUNCTIONS: [
		{
			name: "kroger",
			run: async (_e: any, a: any) => {
				seen.krogerArgs = a;
				return { content: [{ type: "text", text: JSON.stringify({ retailer: "kroger", action: "search", count: 1, products: [{ id: "k1", title: "Milk", currency: "USD" }] }) }] };
			},
		},
		{
			name: "walmart",
			run: async () => ({
				content: [{ type: "text", text: JSON.stringify({ retailer: "walmart", action: "search", count: 2, products: [{ id: "w1", title: "Milk A", currency: "USD" }, { id: "w2", title: "Milk B", currency: "USD" }] }) }],
			}),
		},
		{
			name: "amazon",
			run: async () => ({ content: [{ type: "text", text: "amazon: blocked or render failed" }], isError: true }),
		},
		// homedepot throws (not a fail result) — proves a thrown error is also isolated.
		{
			name: "homedepot",
			run: async () => {
				throw new Error("boom");
			},
		},
		{ name: "lowes", run: async () => ({ content: [{ type: "text", text: JSON.stringify({ products: [] }) }] }) },
		{ name: "costco", run: async () => ({ content: [{ type: "text", text: JSON.stringify({ products: [] }) }] }) },
		{ name: "ace", run: async () => ({ content: [{ type: "text", text: JSON.stringify({ products: [] }) }] }) },
	],
}));

import { product_search } from "./product_search";

describe("product_search", () => {
	it("requires a term", async () => {
		const r = await product_search.run({} as any, {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/term is required/);
	});

	it("merges products across retailers, tagging each with its retailer", async () => {
		const r = await product_search.run({} as any, { term: "milk", retailers: ["kroger", "walmart"] });
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		expect(out.term).toBe("milk");
		expect(out.count).toBe(3);
		expect(out.by_retailer).toEqual({ kroger: 1, walmart: 2 });
		expect(out.products.map((p: any) => p.retailer).sort()).toEqual(["kroger", "walmart", "walmart"]);
		// Every merged product carries the shared shape plus its retailer tag.
		expect(out.products.find((p: any) => p.id === "k1")).toMatchObject({ retailer: "kroger", title: "Milk" });
		expect(out.errors).toEqual([]);
	});

	it("isolates a per-retailer failure into errors without aborting the rest", async () => {
		const r = await product_search.run({} as any, { term: "milk", retailers: ["kroger", "walmart", "amazon", "homedepot"] });
		const out = JSON.parse(r.content[0].text);
		// kroger + walmart still merged despite amazon (fail) and homedepot (throw).
		expect(out.count).toBe(3);
		expect(out.by_retailer).toEqual({ kroger: 1, walmart: 2 });
		const failed = out.errors.map((e: any) => e.retailer).sort();
		expect(failed).toEqual(["amazon", "homedepot"]);
		expect(out.errors.find((e: any) => e.retailer === "amazon").error).toMatch(/blocked/);
		expect(out.errors.find((e: any) => e.retailer === "homedepot").error).toMatch(/boom/);
	});

	it("passes zip through to kroger and search args to each retailer", async () => {
		await product_search.run({} as any, { term: "milk", retailers: ["kroger"], zip: "97201" });
		expect(seen.krogerArgs).toMatchObject({ action: "search", term: "milk", zip: "97201" });
	});

	it("caps the merged list by limit", async () => {
		const r = await product_search.run({} as any, { term: "milk", retailers: ["kroger", "walmart"], limit: 2 });
		const out = JSON.parse(r.content[0].text);
		expect(out.products).toHaveLength(2);
		expect(out.count).toBe(2);
	});

	it("by_retailer reflects the post-slice counts, not raw per-retailer totals, when limit cuts off a later retailer", async () => {
		// kroger (1 product) settles before walmart (2 products); limit:1 keeps only
		// kroger's product, so walmart must be entirely absent from by_retailer too —
		// otherwise by_retailer would report walmart:2 while zero walmart products
		// actually appear in `products`.
		const r = await product_search.run({} as any, { term: "milk", retailers: ["kroger", "walmart"], limit: 1 });
		const out = JSON.parse(r.content[0].text);
		expect(out.products).toHaveLength(1);
		expect(out.by_retailer).toEqual({ kroger: 1 });
		expect(Object.values(out.by_retailer as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(out.products.length);
	});

	it("rejects when no known retailer is selected", async () => {
		const r = await product_search.run({} as any, { term: "milk", retailers: ["nope", "alsonope"] });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/No known retailers/);
	});

	it("advertises the MCP Apps ui:// template on the tool definition", () => {
		expect(product_search.meta).toEqual({ ui: { resourceUri: "ui://sux/product-search-dashboard" } });
	});

	it("without ui:true returns only the JSON text block", async () => {
		const r = await product_search.run({} as any, { term: "milk", retailers: ["kroger", "walmart"] });
		expect(r.content).toHaveLength(1);
		expect(r.content[0].type).toBe("text");
	});

	it("with ui:true appends an embedded MCP Apps resource block alongside the JSON", async () => {
		const r = await product_search.run({} as any, { term: "milk", retailers: ["kroger", "walmart"], ui: true });
		expect(r.content).toHaveLength(2);
		expect(r.content[0].type).toBe("text");
		const out = JSON.parse((r.content[0] as { text: string }).text);
		expect(out.count).toBe(3);
		const resourcePart = r.content[1] as unknown as { type: string; resource: { uri: string; mimeType: string; text: string } };
		expect(resourcePart.type).toBe("resource");
		expect(resourcePart.resource.uri).toBe("ui://sux/product-search-dashboard");
		expect(resourcePart.resource.mimeType).toBe("text/html;profile=mcp-app");
		// Both retailers' products (untitled prices in the mock fixtures) render into
		// the dashboard markup without throwing, and untrusted text is escaped.
		expect(resourcePart.resource.text).toContain("<!doctype html>");
		expect(resourcePart.resource.text).toContain("Price comparison — milk");
	});

	it("with ui:true and no priced products renders the empty-chart message, not an error", async () => {
		const r = await product_search.run({} as any, { term: "milk", retailers: ["lowes", "costco", "ace"], ui: true });
		expect(r.isError).toBeFalsy();
		const resourcePart = r.content[1] as unknown as { resource: { text: string } };
		expect(resourcePart.resource.text).toContain("No priced results to chart.");
	});
});
