import { describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async () => new Response("alpha\nBETA\ngamma\n", { status: 200 })),
}));

import { smartFetch } from "../proxy";
import { grep } from "./grep";

const TEXT = "alpha\nBeta line\ngamma\nbeta again\ndelta";

describe("grep", () => {
	it("matches lines and reports line numbers", async () => {
		const r = await grep.run({} as any, { pattern: "beta", text: TEXT, ignore_case: true });
		const out = JSON.parse(r.content[0].text);
		expect(out.count).toBe(2);
		expect(out.matches[0].line).toBe(2);
		expect(out.matches[0].text).toBe("Beta line");
	});

	it("is case-sensitive by default", async () => {
		const r = await grep.run({} as any, { pattern: "beta", text: TEXT });
		expect(JSON.parse(r.content[0].text).count).toBe(1); // only "beta again"
	});

	it("includes context lines", async () => {
		const r = await grep.run({} as any, { pattern: "^gamma$", text: TEXT, context: 1 });
		const out = JSON.parse(r.content[0].text);
		expect(out.matches[0].context).toEqual(["Beta line", "gamma", "beta again"]);
	});

	it("fails on invalid regex", async () => {
		const r = await grep.run({} as any, { pattern: "(", text: TEXT });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Invalid regex/);
	});

	it("errors without text or url", async () => {
		const r = await grep.run({} as any, { pattern: "x" });
		expect(r.isError).toBe(true);
	});

	it("fails on an upstream error page instead of grepping it", async () => {
		vi.mocked(smartFetch).mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 }));
		const r = await grep.run({} as any, { pattern: "Requests", url: "https://example.com/big.log" });
		expect(r.isError).toBe(true); // errors never enter the KV cache
		expect(r.content[0].text).toMatch(/HTTP 429/);
	});
});
