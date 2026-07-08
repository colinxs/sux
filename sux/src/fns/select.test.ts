import { describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async () => new Response("<html></html>", { status: 200 })),
}));

import { select } from "./select";

const HTML = `<html><body>
  <div class="post"><h2>Title A</h2><a href="/a" class="link">Read A</a></div>
  <div class="post featured"><h2>Title B</h2><a href="/b" class="link">Read B</a></div>
  <p id="foot">footer</p>
</body></html>`;

describe("select", () => {
	it("returns text for a class selector", async () => {
		const r = await select.run({} as any, { html: HTML, selector: "h2" });
		const out = JSON.parse(r.content[0].text);
		expect(out).toEqual(["Title A", "Title B"]);
	});

	it("returns an attribute with `attr`", async () => {
		const r = await select.run({} as any, { html: HTML, selector: "a.link", attr: "href" });
		expect(JSON.parse(r.content[0].text)).toEqual(["/a", "/b"]);
	});

	it("supports descendant combinators", async () => {
		const r = await select.run({} as any, { html: HTML, selector: "div.featured a" });
		expect(JSON.parse(r.content[0].text)).toEqual(["Read B"]);
	});

	it("supports comma lists and de-dupes", async () => {
		const r = await select.run({} as any, { html: HTML, selector: "#foot, p" });
		expect(JSON.parse(r.content[0].text)).toEqual(["footer"]);
	});

	it("returns [] for no match and errors without a selector", async () => {
		const none = await select.run({} as any, { html: HTML, selector: "table" });
		expect(none.content[0].text).toBe("[]");
		const bad = await select.run({} as any, { html: HTML, selector: "" });
		expect(bad.isError).toBe(true);
	});
});

describe("select descendant combinator self-match", () => {
	it("does not match a scope element as its own descendant", async () => {
		// `.a .b` requires a `.b` inside a `.a`; a single element carrying both
		// classes must NOT match (it has no matching ancestor).
		const r = await select.run({} as any, { html: '<div class="a b">x</div>', selector: ".a .b" });
		expect(r.content[0].text).toBe("[]");
	});

	it("still matches a genuine descendant", async () => {
		const html = '<div class="a"><span class="b">y</span></div>';
		const r = await select.run({} as any, { html, selector: ".a .b" });
		expect(JSON.parse(r.content[0].text)).toEqual(["y"]);
	});

	it("does not self-match same-tag descendant selectors", async () => {
		const r = await select.run({} as any, { html: "<div>only</div>", selector: "div div" });
		expect(r.content[0].text).toBe("[]");
	});
});

describe("select comma inside attribute value", () => {
	it("does not split the selector on a comma inside [attr=\"...\"]", async () => {
		// Naive `selector.split(",")` would break this into `meta[content="a` and
		// `b"]`, both unparseable, silently returning [] despite a real match.
		const html = '<meta name="k" content="a,b">';
		const r = await select.run({} as any, { html, selector: 'meta[content="a,b"]', attr: "content" });
		expect(JSON.parse(r.content[0].text)).toEqual(["a,b"]);
	});

	it("still treats a top-level comma as a selector-list union", async () => {
		const html = '<meta name="k" content="a,b"><p>hi</p>';
		const r = await select.run({} as any, { html, selector: 'meta[content="a,b"], p' });
		expect(JSON.parse(r.content[0].text)).toEqual(["", "hi"]);
	});
});

describe("select attr regex-injection safety", () => {
	it("treats an attr name with regex metacharacters literally", async () => {
		// Unescaped, `\bdata.x=` (. = any char) would match data1x first → "wrong".
		const html = '<input data1x="wrong" data.x="right">';
		const r = await select.run({} as any, { html, selector: "input", attr: "data.x" });
		expect(JSON.parse(r.content[0].text)).toEqual(["right"]);
	});
});
