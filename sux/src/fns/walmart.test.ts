import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cfRender } from "../cf-render";
import { macRender } from "../mac-render";
import { walmart } from "./walmart";

// Reads go through retailRender's cf→mac ladder now, so both backends are mocked. cf
// defaults to unavailable (no BROWSER binding) so the existing mac-path tests still
// exercise the mac leg; the cf-first test overrides it.
vi.mock("../mac-render", () => ({ macRender: vi.fn() }));
vi.mock("../cf-render", () => ({ cfRender: vi.fn() }));

const macRenderMock = vi.mocked(macRender);
const cfRenderMock = vi.mocked(cfRender);

beforeEach(() => {
	// Factory vi.fn() mocks survive restoreAllMocks, so clear both backends' call
	// history each test (call-count assertions rely on a clean slate).
	macRenderMock.mockReset();
	cfRenderMock.mockReset();
	cfRenderMock.mockResolvedValue({ ok: false, error: "Browser Run is not configured (BROWSER binding)." });
});

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

	it("reads go cf-FIRST: cf serves the page and the mac gesture leg is never touched", async () => {
		cfRenderMock.mockReset();
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: pageWithNextData(SEARCH_NEXT_DATA) });
		const r = await walmart.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y", BROWSER: {} } as any, { action: "search", term: "drill" });
		expect(r.isError).toBeFalsy();
		expect(JSON.parse(r.content[0].text).count).toBe(1);
		expect(cfRenderMock).toHaveBeenCalledTimes(1);
		expect(macRenderMock).not.toHaveBeenCalled();
	});

	it("carries solve:true onto the mac fallback leg (the press-and-hold gesture)", async () => {
		macRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: pageWithNextData(SEARCH_NEXT_DATA) });
		await walmart.run({ MAC_RENDER_URL: "x", MAC_RENDER_SECRET: "y" } as any, { action: "search", term: "drill" });
		expect(macRenderMock.mock.calls[0][1]).toMatchObject({ solve: true });
	});
});
