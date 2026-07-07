import { describe, expect, it, vi } from "vitest";

const { kagiTool } = vi.hoisted(() => ({
	kagiTool: vi.fn(async () => ({ content: [{ text: "## Results\n### [Ada Lovelace — UW](https://x.edu/ada)\nStaff profile\n\n### [Ada L.](https://y.edu/ada)\nDirectory" }] })),
}));
vi.mock("../kagi", () => ({ kagiTool }));

const { smartFetch } = vi.hoisted(() => ({ smartFetch: vi.fn() }));
vi.mock("../proxy", () => ({ smartFetch }));

import { people } from "./people";

describe("people", () => {
	it("requires a query", async () => {
		expect((await people.run({} as any, { query: "" })).content[0].text).toMatch(/required/);
	});

	it("web source parses Kagi hits", async () => {
		const r = await people.run({} as any, { query: "Ada Lovelace" });
		const out = JSON.parse(r.content[0].text);
		expect(out.source).toBe("web");
		expect(out.hits[0]).toMatchObject({ title: "Ada Lovelace — UW", url: "https://x.edu/ada" });
		expect(out.hits).toHaveLength(2);
	});

	it("web source extracts contacts from the top hit when asked", async () => {
		smartFetch.mockResolvedValueOnce(new Response("Reach me at ada@x.edu or (206) 555-1212.", { status: 200 }));
		const r = await people.run({} as any, { query: "Ada", extract_contacts: true });
		const out = JSON.parse(r.content[0].text);
		expect(out.contacts.emails).toContain("ada@x.edu");
		expect(out.contacts.phones[0]).toMatch(/206/);
		expect(out.contacts.from).toBe("https://x.edu/ada");
	});

	it("usagov source queries the federal directory and normalizes contacts", async () => {
		smartFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ Contacts: [{ Name: "General Services Administration", URI: "https://gsa.gov", Phone: [{ Number: "1-800-333-4636" }], Email: ["info@gsa.gov"] }] }), { status: 200 }),
		);
		const r = await people.run({} as any, { query: "GSA", source: "usagov" });
		const out = JSON.parse(r.content[0].text);
		expect(out.source).toBe("usagov");
		expect(out.contacts[0]).toMatchObject({ name: "General Services Administration", email: "info@gsa.gov" });
		expect(out.contacts[0].phones).toContain("1-800-333-4636");
	});

	it("usagov surfaces a deprecation-friendly error on HTTP failure", async () => {
		smartFetch.mockResolvedValueOnce(new Response("gone", { status: 404 }));
		const r = await people.run({} as any, { query: "x", source: "usagov" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/deprecated|HTTP 404/);
	});
});
