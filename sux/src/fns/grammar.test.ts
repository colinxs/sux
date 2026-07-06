import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({
	hasAI: (env: any) => typeof env?.AI?.run === "function",
	llm: vi.fn(async () => "corrected text"),
}));

import { grammar } from "./grammar";
import { llm } from "../ai";

const env = { AI: { run: vi.fn() } } as any;
afterEach(() => vi.clearAllMocks());

describe("grammar", () => {
	it("fails without the AI binding", async () => {
		const r = await grammar.run({} as any, { text: "he go to school" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Workers AI/);
	});

	it("requires non-empty text", async () => {
		expect((await grammar.run(env, { text: "" })).isError).toBe(true);
	});

	it("returns only the corrected text by default", async () => {
		const r = await grammar.run(env, { text: "he go to school" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("corrected text");
		const [, system] = (llm as any).mock.calls[0];
		expect(system).toMatch(/ONLY the corrected text/);
	});

	it("asks for a change list when explain is true", async () => {
		await grammar.run(env, { text: "he go", explain: true });
		const [, system] = (llm as any).mock.calls[0];
		expect(system).toMatch(/list of the changes/);
	});

	it("surfaces model errors", async () => {
		(llm as any).mockImplementationOnce(async () => {
			throw new Error("boom");
		});
		const r = await grammar.run(env, { text: "hi" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/grammar failed: boom/);
	});
});
