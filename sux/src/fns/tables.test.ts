import { describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({ smartFetch: vi.fn() }));

import { tables } from "./tables";

const HTML = `<table>
	<tr><th>Name</th><th>Age</th></tr>
	<tr><td>Alice</td><td>30</td></tr>
	<tr><td>Bob</td><td>25</td></tr>
</table>
<table><tr><th>X</th></tr><tr><td>1</td></tr></table>`;

describe("tables", () => {
	it("parses json objects keyed by the header row", async () => {
		const r = await tables.run({} as any, { html: HTML, index: 0 });
		const out = JSON.parse(r.content[0].text);
		expect(out).toEqual([
			{ Name: "Alice", Age: "30" },
			{ Name: "Bob", Age: "25" },
		]);
	});

	it("returns all tables (nested arrays) when index omitted", async () => {
		const r = await tables.run({} as any, { html: HTML });
		const out = JSON.parse(r.content[0].text);
		expect(out).toHaveLength(2);
		expect(out[1]).toEqual([{ X: "1" }]);
	});

	it("emits csv when requested", async () => {
		const r = await tables.run({} as any, { html: HTML, index: 0, format: "csv" });
		expect(r.content[0].text).toBe("Name,Age\nAlice,30\nBob,25");
	});

	it("handles a page with no tables", async () => {
		const r = await tables.run({} as any, { html: "<p>nothing</p>" });
		expect(r.content[0].text).toBe("(no tables found)");
	});

	it("does not truncate an outer table at a nested </table>", async () => {
		const NESTED =
			"<table><tr><td><table><tr><td>x</td></tr></table></td></tr><tr><td>lost</td></tr></table>";
		const r = await tables.run({} as any, { html: NESTED });
		const out = JSON.parse(r.content[0].text);
		// One top-level table (no phantom extra), and the post-nesting "lost" row is retained.
		expect(out).toHaveLength(1);
		expect(JSON.stringify(out)).toContain("lost");
	});
});
