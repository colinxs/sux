import { describe, expect, it, vi } from "vitest";
import { hasAI, llm } from "./ai";

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
