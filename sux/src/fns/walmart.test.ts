import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cfRender } from "../cf-render";
import { unlockerRender } from "../unlocker-render";
import { walmart } from "./walmart";

// Reads go through retailRender's cf→unlocker ladder, so both rungs are mocked. cf
// is the PRIMARY leg; the paid unlocker is the fallback (fail-closed default:
// unconfigured). Success cases drive the cf leg.
vi.mock("../cf-render", () => ({ cfRender: vi.fn() }));
vi.mock("../unlocker-render", () => ({ unlockerRender: vi.fn() }));

const cfRenderMock = vi.mocked(cfRender);
const unlockerRenderMock = vi.mocked(unlockerRender);

beforeEach(() => {
	// Factory vi.fn() mocks survive restoreAllMocks, so clear both rungs' call history
	// each test (call-count assertions rely on a clean slate). Default cf to unavailable
	// and the unlocker to unconfigured (the fail-closed production default).
	cfRenderMock.mockReset();
	cfRenderMock.mockResolvedValue({ ok: false, error: "Browser Run is not configured (BROWSER binding)." });
	unlockerRenderMock.mockReset();
	unlockerRenderMock.mockResolvedValue({ ok: false, error: "unlocker not configured" });
});

// Wrap a __NEXT_DATA__ JSON object in a minimal page, as the render backend would
// return the rendered Walmart HTML.
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
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: pageWithNextData(SEARCH_NEXT_DATA) });
		const r = await walmart.run({ BROWSER: {} } as any, { action: "search", term: "drill" });
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
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: pageWithNextData(many) });
		const r = await walmart.run({ BROWSER: {} } as any, { action: "search", term: "x", limit: 3 });
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(3);
	});

	it("product extracts the product node from __NEXT_DATA__", async () => {
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: pageWithNextData(PRODUCT_NEXT_DATA) });
		const r = await walmart.run({ BROWSER: {} } as any, { action: "product", item_id: "444555666" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.products[0]).toMatchObject({ id: "444555666", title: "Milwaukee M18 Impact", price: 149.5, in_stock: false });
	});

	it("fails helpfully when the render backend fails", async () => {
		// cf unavailable (default) and the unlocker unconfigured → retailRender fails → blocked.
		const r = await walmart.run({} as any, { action: "search", term: "drill" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/blocked or no data/);
	});

	it("fails when the page has no __NEXT_DATA__ (challenged)", async () => {
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: "<html><body>Robot check</body></html>" });
		const r = await walmart.run({ BROWSER: {} } as any, { action: "search", term: "drill" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/blocked or no data/);
	});

	it("reads go cf-FIRST: cf serves the page and the unlocker fallback is never touched", async () => {
		cfRenderMock.mockResolvedValueOnce({ ok: true, contentType: "text/html", body: pageWithNextData(SEARCH_NEXT_DATA) });
		const r = await walmart.run({ BROWSER: {} } as any, { action: "search", term: "drill" });
		expect(r.isError).toBeFalsy();
		expect(JSON.parse(r.content[0].text).count).toBe(1);
		expect(cfRenderMock).toHaveBeenCalledTimes(1);
		expect(unlockerRenderMock).not.toHaveBeenCalled();
	});
});
