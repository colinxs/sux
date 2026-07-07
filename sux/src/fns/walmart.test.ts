import { afterEach, describe, expect, it, vi } from "vitest";

import { macRender } from "../mac-render";
import { walmart } from "./walmart";

vi.mock("../mac-render", () => ({ macRender: vi.fn() }));

const macRenderMock = vi.mocked(macRender);

// Wrap a __NEXT_DATA__ JSON object in a minimal page, as the mac render backend
// would return the rendered Walmart HTML.
function pageWithNextData(obj: unknown): string {
	return `<!doctype html><html><head></head><body><div id="app"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(obj)}</script></body></html>`;
}

const SEARCH_NEXT_DATA = {
	props: {
		pageProps: {
			initialData: {
				searchResult: {
					itemStacks: [
						{
							items: [
								{
									usItemId: "111222333",
									name: "DeWalt 20V Drill",
									brand: "DeWalt",
									priceInfo: { currentPrice: { price: 99.0 } },
									imageInfo: { thumbnailUrl: "https://i5.walmartimages.com/drill.jpg" },
									availabilityStatus: "IN_STOCK",
								},
								{ id: "sponsored-banner" },
							],
						},
					],
				},
			},
		},
	},
};

const PRODUCT_NEXT_DATA = {
	props: {
		pageProps: {
			initialData: {
				data: {
					product: {
						usItemId: "444555666",
						name: "Milwaukee M18 Impact",
						brand: "Milwaukee",
						priceInfo: { currentPrice: { price: 149.5 } },
						imageInfo: { thumbnailUrl: "https://i5.walmartimages.com/impact.jpg" },
						availabilityStatus: "OUT_OF_STOCK",
					},
				},
			},
		},
	},
};

afterEach(() => vi.restoreAllMocks());

describe("walmart", () => {
	it("search extracts and normalizes products from __NEXT_DATA__", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: pageWithNextData(SEARCH_NEXT_DATA) });
		const r = await walmart.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "search", term: "drill" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
		expect(j.products[0]).toMatchObject({
			id: "111222333",
			title: "DeWalt 20V Drill",
			brand: "DeWalt",
			price: 99.0,
			currency: "USD",
			image: "https://i5.walmartimages.com/drill.jpg",
			url: "https://www.walmart.com/ip/111222333",
			in_stock: true,
		});
	});

	it("search honors the limit", async () => {
		const many = {
			props: { pageProps: { initialData: { searchResult: { itemStacks: [{ items: Array.from({ length: 10 }, (_v, i) => ({ usItemId: String(i), name: `Item ${i}`, priceInfo: { currentPrice: { price: i + 1 } } })) }] } } } },
		};
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: pageWithNextData(many) });
		const r = await walmart.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "search", term: "x", limit: 3 });
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(3);
	});

	it("product extracts the product node from __NEXT_DATA__", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: pageWithNextData(PRODUCT_NEXT_DATA) });
		const r = await walmart.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "product", item_id: "444555666" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.products[0]).toMatchObject({ id: "444555666", title: "Milwaukee M18 Impact", price: 149.5, in_stock: false });
	});

	it("fails helpfully when macRender fails", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: false, error: "Mac render backend not configured." });
		const r = await walmart.run({} as any, { action: "search", term: "drill" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/blocked or no data/);
	});

	it("fails when the page has no __NEXT_DATA__ (challenged)", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: "<html><body>Robot check</body></html>" });
		const r = await walmart.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "search", term: "drill" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/blocked or no data/);
	});
});
