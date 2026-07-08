import { describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({
	smartFetch: vi.fn(
		async () =>
			new Response(
				`<html><head><title>My Article</title><meta name="author" content="Jane Doe"></head>
				<body><nav>menu junk everywhere here</nav>
				<article><p>${"This is the real article body with plenty of meaningful text. ".repeat(4)}</p></article>
				<footer>footer junk</footer></body></html>`,
				{ status: 200 },
			),
	),
}));

import { readability } from "./readability";

describe("readability", () => {
	it("extracts title, byline, and article text from a url", async () => {
		const r = await readability.run({} as any, { url: "https://example.com/post" });
		const out = JSON.parse(r.content[0].text);
		expect(out.title).toBe("My Article");
		expect(out.byline).toBe("Jane Doe");
		expect(out.text).toContain("real article body");
		expect(out.text).not.toContain("menu junk");
		expect(out.text).not.toContain("footer junk");
	});

	it("picks the densest block when no <article>/<main>", async () => {
		const html = `<html><body>
			<div><p>tiny</p></div>
			<div><p>${"Substantial paragraph content that dominates the page. ".repeat(3)}</p></div>
		</body></html>`;
		const r = await readability.run({} as any, { html });
		const out = JSON.parse(r.content[0].text);
		expect(out.text).toContain("Substantial paragraph content");
	});

	it("does not let custom elements sharing a tag prefix eat the main content", async () => {
		const html = `<html><body>
			<form-field>label</form-field>
			<article><p>${"The whole story lives right here in the article. ".repeat(4)}</p></article>
			<form><input name="q"></form>
		</body></html>`;
		const r = await readability.run({} as any, { html });
		const out = JSON.parse(r.content[0].text);
		expect(out.text).toContain("The whole story lives right here");
	});

	it("errors when neither html nor url is given", async () => {
		const r = await readability.run({} as any, {});
		expect(r.isError).toBe(true);
	});
});
