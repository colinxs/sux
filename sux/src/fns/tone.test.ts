import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({
	hasAI: (env: any) => typeof env?.AI?.run === "function",
	llm: vi.fn(async () => "rewritten text"),
}));

import { tone } from "./tone";
import { llm } from "../ai";

const env = { AI: { run: vi.fn() } } as any;
afterEach(() => vi.clearAllMocks());

describe("tone", () => {
	it("fails without the AI binding", async () => {
		const r = await tone.run({} as any, { text: "you always do this" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Workers AI/);
	});

	it("requires non-empty text", async () => {
		expect((await tone.run(env, { text: "   " })).isError).toBe(true);
	});

	it("defaults to the nonviolent tone", async () => {
		const r = await tone.run(env, { text: "you always do this" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("rewritten text");
		const [, system] = (llm as any).mock.calls[0];
		expect(system).toMatch(/Nonviolent Communication/);
	});

	it("uses a free-form tone verbatim", async () => {
		await tone.run(env, { text: "hi", tone: "pirate" });
		const [, system] = (llm as any).mock.calls[0];
		expect(system).toMatch(/a pirate tone/);
	});

	it("surfaces model errors", async () => {
		(llm as any).mockImplementationOnce(async () => {
			throw new Error("boom");
		});
		const r = await tone.run(env, { text: "hi" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/tone failed: boom/);
	});
});
