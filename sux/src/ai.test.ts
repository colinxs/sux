import { describe, expect, it, vi } from "vitest";

vi.mock("./proxy", () => ({
	smartFetch: vi.fn(async (_env: any, url: string) =>
		url.includes("/missing")
			? new Response("<h1>404 Not Found</h1>", { status: 404 })
			: new Response("<p>Hello <script>x()</script><b>world</b></p>", { status: 200 }),
	),
}));

import { hasAI, llm, textFromUrlOr } from "./ai";

const envWith = (response: unknown) => ({ AI: { run: vi.fn(async () => ({ response })) } }) as any;

describe("llm", () => {
	it("returns string responses trimmed", async () => {
		expect(await llm(envWith("  hello  "), "sys", "user")).toBe("hello");
	});

	it("JSON-encodes object responses instead of [object Object]", async () => {
		const out = await llm(envWith({ labels: ["a"], why: "because" }), "sys", "user");
		expect(out).not.toContain("[object Object]");
		expect(JSON.parse(out)).toEqual({ labels: ["a"], why: "because" });
	});

	it("returns empty string for null responses", async () => {
		expect(await llm(envWith(null), "sys", "user")).toBe("");
	});

	it("throws without the AI binding", async () => {
		await expect(llm({} as any, "sys", "user")).rejects.toThrow(/Workers AI/);
	});

	it("hasAI detects the binding", () => {
		expect(hasAI({ AI: { run: () => {} } } as any)).toBe(true);
		expect(hasAI({} as any)).toBe(false);
	});
});

describe("textFromUrlOr", () => {
	it("prefers provided text over fetching", async () => {
		expect(await textFromUrlOr({} as any, "given text", "https://example.com")).toBe("given text");
	});

	it("strips scripts and markup from a fetched page", async () => {
		expect(await textFromUrlOr({} as any, "", "https://example.com")).toBe("Hello world");
	});

	it("throws on upstream 4xx/5xx instead of returning the error page's markup", async () => {
		await expect(textFromUrlOr({} as any, "", "https://example.com/missing")).rejects.toThrow(/HTTP 404/);
	});
});
