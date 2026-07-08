import { describe, expect, it } from "vitest";
import { html } from "./html";

const hrun = async (args: any) => (await html.run({} as any, args)).content[0].text;

describe("html (Markdown -> HTML)", () => {
	it("renders fenced code blocks and escapes entities", async () => {
		expect(await hrun({ data: "```\na < b & c\n```" })).toBe("<pre><code>a &lt; b &amp; c</code></pre>");
	});

	it("renders ordered lists and blockquotes", async () => {
		expect(await hrun({ data: "1. a\n2. b" })).toBe("<ol><li>a</li><li>b</li></ol>");
		expect(await hrun({ data: "> quoted" })).toBe("<blockquote>quoted</blockquote>");
	});

	it("renders links and inline code", async () => {
		expect(await hrun({ data: "see [x](http://y) and `code`" })).toBe('<p>see <a href="http://y">x</a> and <code>code</code></p>');
	});

	it("keeps markdown syntax inside inline code literal", async () => {
		expect(await hrun({ data: "`**bold** [x](y)`" })).toBe("<p><code>**bold** [x](y)</code></p>");
	});

	it("errors on empty data", async () => {
		expect((await html.run({} as any, { data: "  " })).isError).toBe(true);
	});
});
