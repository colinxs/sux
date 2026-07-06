import { describe, expect, it } from "vitest";
import { readFeedback } from "./_feedback";
import { issue } from "./issue";

function fakeEnv() {
	const store = new Map<string, string>();
	return { OAUTH_KV: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) } } as any;
}

describe("issue", () => {
	it("rejects empty text", async () => {
		const r = await issue.run(fakeEnv(), { text: "  " });
		expect(r.isError).toBe(true);
	});

	it("appends an issue to the feedback log", async () => {
		const env = fakeEnv();
		const r = await issue.run(env, { text: "dns returns 500" });
		expect(r.content[0].text).toMatch(/Logged issue #1/);
		const items = await readFeedback(env, "issue");
		expect(items[0]).toMatchObject({ kind: "issue", text: "dns returns 500" });
	});

	it("increments the number across calls, newest first", async () => {
		const env = fakeEnv();
		await issue.run(env, { text: "first" });
		const r2 = await issue.run(env, { text: "second" });
		expect(r2.content[0].text).toMatch(/#2/);
		expect((await readFeedback(env))[0].text).toBe("second");
	});

	it("does not surface under the suggest kind", async () => {
		const env = fakeEnv();
		await issue.run(env, { text: "bug" });
		expect(await readFeedback(env, "suggest")).toHaveLength(0);
	});
});
