import { describe, expect, it } from "vitest";
import { readFeedback } from "./_feedback";
import { suggest } from "./suggest";

function fakeEnv() {
	const store = new Map<string, string>();
	return { OAUTH_KV: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) } } as any;
}

describe("suggest", () => {
	it("rejects empty text", async () => {
		const r = await suggest.run(fakeEnv(), { text: "" });
		expect(r.isError).toBe(true);
	});

	it("appends a suggestion to the feedback log", async () => {
		const env = fakeEnv();
		const r = await suggest.run(env, { text: "add an arxiv wrapper" });
		expect(r.content[0].text).toMatch(/Logged suggestion #1/);
		const items = await readFeedback(env, "suggest");
		expect(items[0]).toMatchObject({ kind: "suggest", text: "add an arxiv wrapper" });
	});

	it("shares the log with issues but is filterable by kind", async () => {
		const env = fakeEnv();
		await suggest.run(env, { text: "idea A" });
		await suggest.run(env, { text: "idea B" });
		expect(await readFeedback(env, "suggest")).toHaveLength(2);
		expect(await readFeedback(env, "issue")).toHaveLength(0);
	});

	it("keeps newest first", async () => {
		const env = fakeEnv();
		await suggest.run(env, { text: "old" });
		await suggest.run(env, { text: "new" });
		expect((await readFeedback(env))[0].text).toBe("new");
	});
});
