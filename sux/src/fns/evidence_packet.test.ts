import { describe, expect, it, vi } from "vitest";
import { evidence_packet } from "./evidence_packet";

const RECORDS = [
	{ path: "Health/cardio.md", fm: { title: "Cardiology visit", date: "2026-03-05", tags: ["health"] }, links: [], tags: ["health"], tasks: [], excerpt: "BP check excerpt", keywords: ["cardiology"] },
	{ path: "Health/labs.md", fm: { title: "Lab results", date: "2026-01-10" }, links: [], tags: ["health"], tasks: [], excerpt: "Lab excerpt", keywords: [] },
	{ path: "Legal/contract.md", fm: { title: "Contract" }, links: [], tags: ["legal"], tasks: [], excerpt: "Contract excerpt", keywords: [] },
];

vi.mock("../vault-mcp", () => ({ scanVault: async () => ({ records: RECORDS, total: RECORDS.length, truncated: false }) }));
vi.mock("./obsidian", () => ({ obsidian: { run: async (_env: unknown, a: { path: string }) => ({ content: [{ type: "text", text: `full body of ${a.path}` }] }) } }));

describe("evidence_packet", () => {
	it("rejects a call with no selector", async () => {
		const res = await evidence_packet.run({} as any, {});
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("at least one selector");
	});

	it("selects by tag, sorts chronologically, and cites each source", async () => {
		const res = await evidence_packet.run({} as any, { tag: "health", as: "base64" });
		expect(res.isError).toBeFalsy();
		const body = JSON.parse(res.content[0].text);
		expect(body.selected).toBe(2);
		expect(body.citations).toEqual(["Health/labs.md", "Health/cardio.md"]);
		expect(body.mime).toBe("application/pdf");
	});

	it("selects by topic (title/path/excerpt/keywords match)", async () => {
		const res = await evidence_packet.run({} as any, { topic: "cardiology", as: "base64" });
		const body = JSON.parse(res.content[0].text);
		expect(body.selected).toBe(1);
		expect(body.citations).toEqual(["Health/cardio.md"]);
	});

	it("selects by date range", async () => {
		const res = await evidence_packet.run({} as any, { from: "2026-02-01", to: "2026-12-31", as: "base64" });
		const body = JSON.parse(res.content[0].text);
		expect(body.citations).toEqual(["Health/cardio.md"]);
	});

	it("reports zero selected instead of erroring when nothing matches", async () => {
		const res = await evidence_packet.run({} as any, { tag: "nonexistent" });
		expect(res.isError).toBeFalsy();
		const body = JSON.parse(res.content[0].text);
		expect(body.selected).toBe(0);
	});
});
