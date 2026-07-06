import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({
	hasAI: (env: any) => typeof env?.AI?.run === "function",
	llm: vi.fn(async () => "• point one\n• point two"),
	textFromUrlOr: vi.fn(async (_env: any, text: string, url?: string) => text || (url ? "fetched page text" : "")),
}));

vi.mock("../kagi", () => ({
	kagiTool: vi.fn(async () => ({ content: [{ type: "text", text: "Kagi summary of the page." }] })),
}));

import { summarize } from "./summarize";
import { llm, textFromUrlOr } from "../ai";
import { kagiTool } from "../kagi";

const env = { AI: { run: vi.fn() } } as any;

afterEach(() => vi.clearAllMocks());

describe("summarize", () => {
	it("fails without the AI binding", async () => {
		const r = await summarize.run({} as any, { text: "hello world" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Workers AI/);
	});

	it("fails when neither text nor a fetchable url is given", async () => {
		const r = await summarize.run(env, {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Provide `text`/);
	});

	it("summarizes provided text and honors max_words", async () => {
		const r = await summarize.run(env, { text: "some long article body", style: "tldr", max_words: 40 });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("point one");
		const [, system, , maxTokens] = (llm as any).mock.calls[0];
		expect(system).toMatch(/TL;DR/);
		expect(system).toMatch(/under 40 words/);
		expect(maxTokens).toBe(80);
	});

	it("pulls text from a url when no text is given (no Kagi key)", async () => {
		const r = await summarize.run(env, { url: "https://example.com" });
		expect(r.isError).toBeFalsy();
		expect(textFromUrlOr).toHaveBeenCalledWith(env, "", "https://example.com");
		expect(kagiTool).not.toHaveBeenCalled();
	});

	it("dispatches url → Kagi Universal Summarizer when the gateway is configured", async () => {
		const kagiEnv = { ...env, KAGI_API_KEY: "k" };
		const r = await summarize.run(kagiEnv, { url: "https://example.com", style: "tldr" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("Kagi summary of the page.");
		expect(kagiTool).toHaveBeenCalledWith(kagiEnv, "kagi_summarizer", { url: "https://example.com", summary_type: "takeaway" });
		expect(llm).not.toHaveBeenCalled(); // Kagi handled it — no Workers-AI duplication
	});

	it("falls back to Workers AI when the Kagi call fails", async () => {
		(kagiTool as any).mockRejectedValueOnce(new Error("kagi down"));
		const r = await summarize.run({ ...env, KAGI_API_KEY: "k" }, { url: "https://example.com" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("point one");
		expect(llm).toHaveBeenCalled();
	});

	it("text input never routes to Kagi", async () => {
		const r = await summarize.run({ ...env, KAGI_API_KEY: "k" }, { text: "some text" });
		expect(r.isError).toBeFalsy();
		expect(kagiTool).not.toHaveBeenCalled();
	});
});
