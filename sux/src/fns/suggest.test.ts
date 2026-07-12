import { describe, expect, it } from "vitest";
import { readFeedback } from "./_feedback";
import { suggest } from "./suggest";

function fakeEnv() {
	const store = new Map<string, string>();
	return { OAUTH_KV: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) } } as any;
}

describe("suggest", () => {
	it("rejects empty text", async () => {
		const r = await suggest.run(fakeEnv(), { text: "  " });
		expect(r.isError).toBe(true);
	});

	it("appends a suggestion to the feedback log", async () => {
		const env = fakeEnv();
		const r = await suggest.run(env, { text: "add a whois tool" });
		expect(r.content[0].text).toMatch(/Logged suggestion #1/);
		const items = await readFeedback(env, "suggest");
		expect(items[0]).toMatchObject({ kind: "suggest", text: "add a whois tool" });
	});

	it("increments the number across calls, newest first", async () => {
		const env = fakeEnv();
		await suggest.run(env, { text: "first" });
		const r2 = await suggest.run(env, { text: "second" });
		expect(r2.content[0].text).toMatch(/#2/);
		expect((await readFeedback(env))[0].text).toBe("second");
	});

	it("tags a suggestion with an optional tool and filters by it", async () => {
		const env = fakeEnv();
		await suggest.run(env, { text: "add pagination", tool: "search" });
		await suggest.run(env, { text: "untagged" });
		expect(await readFeedback(env, "suggest", 50, "search")).toHaveLength(1);
		expect(await readFeedback(env, "suggest", 50, "whois")).toHaveLength(0);
	});

	it("does not surface under the issue kind", async () => {
		const env = fakeEnv();
		await suggest.run(env, { text: "add a tool" });
		expect(await readFeedback(env, "issue")).toHaveLength(0);
		expect(await readFeedback(env, "suggest")).toHaveLength(1);
	});
});
