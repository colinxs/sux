import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({
	hasAI: (env: any) => typeof env?.AI?.run === "function",
	MODELS: { translate: "@cf/meta/m2m100-1.2b" },
}));

import { translate } from "./translate";

afterEach(() => vi.clearAllMocks());

describe("translate", () => {
	it("fails without the AI binding", async () => {
		const r = await translate.run({} as any, { text: "hi", to: "es" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Workers AI/);
	});

	it("requires text and a target language", async () => {
		const env = { AI: { run: vi.fn() } } as any;
		expect((await translate.run(env, { to: "es" })).isError).toBe(true);
		expect((await translate.run(env, { text: "hi" })).isError).toBe(true);
	});

	it("translates and passes model + langs", async () => {
		const run = vi.fn(async () => ({ translated_text: "hola" }));
		const env = { AI: { run } } as any;
		const r = await translate.run(env, { text: "hi", to: "es", from: "en" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("hola");
		expect(run).toHaveBeenCalledWith("@cf/meta/m2m100-1.2b", expect.objectContaining({ text: "hi", target_lang: "es", source_lang: "en" }));
	});

	it("fails (uncacheable) when the model returns an empty translation instead of caching a sentinel", async () => {
		const env = { AI: { run: vi.fn(async () => ({ translated_text: "   " })) } } as any;
		const r = await translate.run(env, { text: "hi", to: "es" });
		expect(r.isError).toBe(true); // isError results never enter the KV cache
		expect(r.content[0].text).toMatch(/empty result/);
	});

	it("surfaces model errors", async () => {
		const env = { AI: { run: vi.fn(async () => { throw new Error("boom"); }) } } as any;
		const r = await translate.run(env, { text: "hi", to: "es" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/translate failed: boom/);
	});
});
