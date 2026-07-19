import { describe, expect, it } from "vitest";
import { kv_delete } from "./kv_delete";

function fakeEnv(seed: Record<string, string> = {}) {
	const store = new Map(Object.entries(seed));
	const kvKv = new Map<string, string>();
	const env = {
		OAUTH_KV: {
			get: async (k: string) => store.get(k) ?? kvKv.get(k) ?? null,
			put: async (k: string, v: string) => void kvKv.set(k, v),
			delete: async (k: string) => (store.delete(k), void kvKv.delete(k)),
			list: async ({ prefix }: { prefix?: string } = {}) => ({
				keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })),
			}),
		},
	} as any;
	return { env, store };
}

describe("kv_delete", () => {
	it("deletes a reserved-looking key namespaced under kv: with force:true (only the internal kv:-prefix collision is guarded)", async () => {
		const { env, store } = fakeEnv({ "kv:sux:internal": "keep" });
		const r = await kv_delete.run(env, { key: "sux:internal", force: true });
		expect(r.isError).toBeFalsy();
		expect(store.has("kv:sux:internal")).toBe(false);
	});

	it("deletes a namespaced key with force:true", async () => {
		const { env, store } = fakeEnv({ "kv:doomed": "bye" });
		const r = await kv_delete.run(env, { key: "doomed", force: true });
		expect(r.isError).toBeFalsy();
		expect(store.has("kv:doomed")).toBe(false);
		expect(r.content[0].text).toMatch(/Deleted 'doomed'/);
	});

	it("stages by default without deleting (KV is irreversible)", async () => {
		const { env, store } = fakeEnv({ "kv:doomed": "bye" });
		const r = await kv_delete.run(env, { key: "doomed" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toMatch(/commit_token/);
		expect(store.get("kv:doomed")).toBe("bye");
	});

	it("stage:true previews an existing key without deleting it", async () => {
		const { env, store } = fakeEnv({ "kv:doomed": "bye" });
		const r = await kv_delete.run(env, { key: "doomed", stage: true });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toMatch(/"exists":true/);
		expect(store.get("kv:doomed")).toBe("bye");
	});

	it("stage:true reports a missing key as not existing", async () => {
		const { env } = fakeEnv();
		const r = await kv_delete.run(env, { key: "ghost", stage: true });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toMatch(/"exists":false/);
	});

	it("commit_token from a staged preview applies the delete", async () => {
		const { env, store } = fakeEnv({ "kv:doomed": "bye" });
		const staged = await kv_delete.run(env, { key: "doomed", stage: true });
		const token = JSON.parse(staged.content[0].text).commit_token;
		const r = await kv_delete.run(env, { key: "doomed", commit_token: token });
		expect(r.isError).toBeFalsy();
		expect(store.has("kv:doomed")).toBe(false);
		expect(r.content[0].text).toMatch(/Deleted 'doomed'/);
	});

	it("is idempotent — deleting a missing key still confirms", async () => {
		const { env } = fakeEnv();
		const r = await kv_delete.run(env, { key: "ghost", force: true });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toMatch(/Deleted 'ghost'/);
	});

	it("rejects an empty key", async () => {
		const { env } = fakeEnv();
		const r = await kv_delete.run(env, { key: "   ", force: true });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/non-empty/);
	});
});
