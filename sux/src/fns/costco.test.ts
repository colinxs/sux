import { describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async () => new Response("", { status: 200 })),
}));

import { smartFetch } from "../proxy";
import { costco } from "./costco";

// A couple of realistic Costco search-result product tiles: an image thumbnail
// anchor and a description anchor both pointing at `<slug>.product.<id>.html`,
// plus a price element with Costco's automation-id.
const SEARCH_HTML = `<!doctype html><html><body>
<div class="product-list">
	<div class="product-tile-set">
		<div class="product">
			<div class="thumbnail">
				<a href="/kirkland-signature-item.product.100561234.html">
					<img src="https://images.costco.com/a.jpg" alt="Kirkland Signature Item">
				</a>
			</div>
			<div class="description">
				<a automation-id="productDescriptionLink_0" href="/kirkland-signature-item.product.100561234.html">Kirkland Signature Item</a>
			</div>
			<div class="price-container">
				<div class="price" automation-id="itemPriceOutput_0">$1,234.99</div>
			</div>
		</div>
	</div>
	<div class="product-tile-set">
		<div class="product">
			<div class="thumbnail">
				<a href="https://www.costco.com/other-gadget.product.400099888.html">
					<img src="https://images.costco.com/b.jpg" alt="Other Gadget">
				</a>
			</div>
			<div class="description">
				<a automation-id="productDescriptionLink_1" href="https://www.costco.com/other-gadget.product.400099888.html">Other Gadget</a>
			</div>
			<div class="price-container">
				<div class="price" automation-id="itemPriceOutput_1">$59.99</div>
			</div>
		</div>
	</div>
</div>
</body></html>`;

const mockHtml = (html: string, status = 200) => vi.mocked(smartFetch).mockResolvedValueOnce(new Response(html, { status }));

describe("costco", () => {
	it("fetches CatalogSearch through the residential proxy (route: proxy)", async () => {
		mockHtml(SEARCH_HTML);
		await costco.run({} as any, { action: "search", term: "kirkland" });
		expect(smartFetch).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("CatalogSearch?keyword=kirkland"), expect.anything(), "proxy");
	});

	it("extracts and normalizes products from search tiles", async () => {
		mockHtml(SEARCH_HTML);
		const r = await costco.run({} as any, { action: "search", term: "kirkland" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j).toMatchObject({ retailer: "costco", action: "search", count: 2 });
		expect(j.products[0]).toMatchObject({
			id: "100561234",
			title: "Kirkland Signature Item",
			price: 1234.99,
			currency: "USD",
			image: "https://images.costco.com/a.jpg",
			url: "https://www.costco.com/kirkland-signature-item.product.100561234.html",
		});
		expect(j.products[1]).toMatchObject({
			id: "400099888",
			title: "Other Gadget",
			price: 59.99,
			url: "https://www.costco.com/other-gadget.product.400099888.html",
		});
	});

	it("honors the limit", async () => {
		mockHtml(SEARCH_HTML);
		const r = await costco.run({} as any, { action: "search", term: "kirkland", limit: 1 });
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
	});

	it("extracts from embedded adobeProductList JSON when present", async () => {
		const html = `<html><body><script>
			var s = {"adobeProductList":[{"productId":"777","name":"JSON Widget","salePrice":42.5,"image":"https://images.costco.com/j.jpg","url":"/json-widget.product.777.html"}]};
		</script></body></html>`;
		mockHtml(html);
		const r = await costco.run({} as any, { action: "search", term: "widget" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.products[0]).toMatchObject({ id: "777", title: "JSON Widget", price: 42.5, url: "https://www.costco.com/json-widget.product.777.html" });
	});

	it("fails as an Akamai block on a tiny/denied body", async () => {
		mockHtml("Access Denied");
		const r = await costco.run({} as any, { action: "search", term: "kirkland" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/blocked by Akamai/);
	});

	it("fails as a layout change when a full page yields no products", async () => {
		const bigButEmpty = `<html><body>${"<div>nothing to see here</div>".repeat(200)}</body></html>`;
		mockHtml(bigButEmpty);
		const r = await costco.run({} as any, { action: "search", term: "kirkland" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/no products extracted \(layout change\)/);
	});

	it("requires a term", async () => {
		const r = await costco.run({} as any, { action: "search" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/requires a `term`/);
	});
});
