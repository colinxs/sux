import { describe, expect, it } from "vitest";
import { readFeedback } from "./_feedback";
import { feedback_resolve } from "./feedback_resolve";
import { issue } from "./issue";

function fakeEnv() {
	const store = new Map<string, string>();
	return { OAUTH_KV: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) } } as any;
}

describe("feedback_resolve", () => {
	it("rejects a bad kind", async () => {
		const r = await feedback_resolve.run(fakeEnv(), { kind: "bogus", at: 1 });
		expect(r.isError).toBe(true);
	});

	it("rejects a missing/unparseable at", async () => {
		const r = await feedback_resolve.run(fakeEnv(), { kind: "issue", at: "not a date" });
		expect(r.isError).toBe(true);
	});

	it("resolves an entry addressed by its raw epoch at, optionally stamping tracked_by", async () => {
		const env = fakeEnv();
		await issue.run(env, { text: "dns returns 500" });
		const entry = (await readFeedback(env, "issue"))[0];

		const r = await feedback_resolve.run(env, { kind: "issue", at: entry.at, tracked_by: "https://github.com/x/y/issues/9" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toMatch(/Resolved issue entry/);

		const after = (await readFeedback(env, "issue"))[0];
		expect(after.resolved).toBe(true);
		expect(after.tracked_by).toBe("https://github.com/x/y/issues/9");
	});

	it("also accepts the ISO string GET /feedback prints for at", async () => {
		const env = fakeEnv();
		await issue.run(env, { text: "dns returns 500" });
		const entry = (await readFeedback(env, "issue"))[0];

		const r = await feedback_resolve.run(env, { kind: "issue", at: new Date(entry.at).toISOString() });
		expect(r.isError).toBeFalsy();
	});

	it("fails when no matching unresolved entry exists", async () => {
		const env = fakeEnv();
		const r = await feedback_resolve.run(env, { kind: "issue", at: Date.now() });
		expect(r.isError).toBe(true);
	});
});
