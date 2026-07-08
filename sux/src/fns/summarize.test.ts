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

afterEach(() => {
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

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

	it("maps bullets/paragraph styles to Kagi summary_type 'summary'", async () => {
		const kagiEnv = { ...env, KAGI_API_KEY: "k" };
		await summarize.run(kagiEnv, { url: "https://example.com", style: "bullets" });
		await summarize.run(kagiEnv, { url: "https://example.com", style: "paragraph" });
		expect(kagiTool).toHaveBeenNthCalledWith(1, kagiEnv, "kagi_summarizer", { url: "https://example.com", summary_type: "summary" });
		expect(kagiTool).toHaveBeenNthCalledWith(2, kagiEnv, "kagi_summarizer", { url: "https://example.com", summary_type: "summary" });
	});

	it("falls back to Workers AI when the Kagi call fails", async () => {
		(kagiTool as any).mockRejectedValueOnce(new Error("kagi down"));
		const r = await summarize.run({ ...env, KAGI_API_KEY: "k" }, { url: "https://example.com" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("point one");
		expect(llm).toHaveBeenCalled();
	});

	it("falls back to Workers AI when Kagi resolves with isError (gateway errors resolve, not throw)", async () => {
		(kagiTool as any).mockResolvedValueOnce({ content: [{ type: "text", text: "kagi_summarizer failed: 502" }], isError: true });
		const r = await summarize.run({ ...env, KAGI_API_KEY: "k" }, { url: "https://example.com" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("point one");
		expect(llm).toHaveBeenCalled();
	});

	it("falls back to Workers AI when Kagi resolves with empty/whitespace text", async () => {
		(kagiTool as any).mockResolvedValueOnce({ content: [{ type: "text", text: "   \n  " }] });
		const r = await summarize.run({ ...env, KAGI_API_KEY: "k" }, { url: "https://example.com" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("point one");
		expect(llm).toHaveBeenCalled();
	});

	it("fails (uncacheable) when the fallback fetch hits an upstream 4xx instead of summarizing the error page", async () => {
		(kagiTool as any).mockRejectedValueOnce(new Error("kagi down"));
		(textFromUrlOr as any).mockRejectedValueOnce(new Error("Upstream fetch failed: HTTP 403 — https://example.com"));
		const r = await summarize.run({ ...env, KAGI_API_KEY: "k" }, { url: "https://example.com" });
		expect(r.isError).toBe(true); // isError results never enter the KV cache
		expect(r.content[0].text).toMatch(/HTTP 403/);
		expect(llm).not.toHaveBeenCalled(); // no confident summary of a 403 page
	});

	it("fails (uncacheable) when the Workers-AI model returns an empty summary instead of caching a sentinel", async () => {
		(llm as any).mockResolvedValueOnce("   ");
		const r = await summarize.run(env, { text: "some long article body" });
		expect(r.isError).toBe(true); // isError results never enter the KV cache
		expect(r.content[0].text).toMatch(/empty result/);
	});

	it("tags the Kagi backend in the structured log line", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await summarize.run({ ...env, KAGI_API_KEY: "k" }, { url: "https://example.com" });
		expect(log).toHaveBeenCalledWith("summarize: backend=kagi url=https://example.com");
	});

	it("tags the Workers-AI backend in the structured log line", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await summarize.run(env, { text: "some long article body" });
		expect(log).toHaveBeenCalledWith("summarize: backend=workers-ai");
	});

	it("warns (proxy.ts-style) when Kagi throws before falling back", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		(kagiTool as any).mockRejectedValueOnce(new Error("kagi down"));
		await summarize.run({ ...env, KAGI_API_KEY: "k" }, { url: "https://example.com" });
		expect(warn).toHaveBeenCalledWith("summarize: Kagi failed, falling back to Workers AI — kagi down");
		expect(log).toHaveBeenCalledWith("summarize: backend=workers-ai url=https://example.com");
	});

	it("warns when Kagi resolves with isError before falling back", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		(kagiTool as any).mockResolvedValueOnce({ content: [{ type: "text", text: "kagi_summarizer failed: 502" }], isError: true });
		await summarize.run({ ...env, KAGI_API_KEY: "k" }, { url: "https://example.com" });
		expect(warn).toHaveBeenCalledWith(
			"summarize: Kagi returned an error — kagi_summarizer failed: 502, falling back to Workers AI — https://example.com",
		);
	});

	it("warns when Kagi resolves with empty text before falling back", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		(kagiTool as any).mockResolvedValueOnce({ content: [{ type: "text", text: "   \n  " }] });
		await summarize.run({ ...env, KAGI_API_KEY: "k" }, { url: "https://example.com" });
		expect(warn).toHaveBeenCalledWith("summarize: Kagi returned an empty summary, falling back to Workers AI — https://example.com");
	});

	it("text input never routes to Kagi", async () => {
		const r = await summarize.run({ ...env, KAGI_API_KEY: "k" }, { text: "some text" });
		expect(r.isError).toBeFalsy();
		expect(kagiTool).not.toHaveBeenCalled();
	});
});
