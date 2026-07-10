import { afterEach, describe, expect, it, vi } from "vitest";

// Test vault_batch_append's WRAPPER logic (fan-out + idempotency + dry-run + per-item
// error capture) with the obsidian fn mocked — the git append itself is covered elsewhere.
vi.mock("./fns/obsidian", () => ({ obsidian: { run: vi.fn(async () => ({ content: [{ type: "text", text: "{}" }] })) } }));

import { obsidian } from "./fns/obsidian";
import { VAULT_TOOLS } from "./vault-mcp";

const tool = (n: string) => VAULT_TOOLS.find((t) => t.name === n)!;
const fakeKV = () => {
	const s = new Map<string, string>();
	return { get: async (k: string) => s.get(k) ?? null, put: async (k: string, v: string) => void s.set(k, v), delete: async (k: string) => void s.delete(k) };
};
const parse = (r: any) => JSON.parse(r.content[0].text);
const obs = obsidian.run as unknown as ReturnType<typeof vi.fn>;
afterEach(() => vi.clearAllMocks());

describe("vault_batch_append", () => {
	it("fans out the appends and reports per item", async () => {
		const env = { OAUTH_KV: fakeKV() } as any;
		const out = parse(await tool("vault_batch_append").run(env, { items: [{ path: "a.md", content: "x" }, { path: "b.md", content: "y" }] }));
		expect(out.count).toBe(2);
		expect(out.results).toEqual([{ path: "a.md", appended: true }, { path: "b.md", appended: true }]);
		expect(obs).toHaveBeenCalledTimes(2);
	});

	it("is idempotent — a re-run with the same path+content skips, no re-append", async () => {
		const env = { OAUTH_KV: fakeKV() } as any;
		await tool("vault_batch_append").run(env, { items: [{ path: "a.md", content: "x" }] });
		obs.mockClear();
		const out = parse(await tool("vault_batch_append").run(env, { items: [{ path: "a.md", content: "x" }] }));
		expect(out.results[0].skipped).toMatch(/idempotent/);
		expect(obs).not.toHaveBeenCalled();
	});

	it("dry_run previews the intended appends without writing", async () => {
		const env = { OAUTH_KV: fakeKV() } as any;
		const out = parse(await tool("vault_batch_append").run(env, { items: [{ path: "a.md", content: "hello" }], dry_run: true }));
		expect(out.dry_run).toBe(true);
		expect(out.results[0]).toMatchObject({ path: "a.md", would_append_chars: 5 });
		expect(obs).not.toHaveBeenCalled();
	});

	it("captures a per-item error without failing the whole batch (and doesn't mark it done)", async () => {
		obs.mockResolvedValueOnce({ content: [{ type: "text", text: "boom" }], isError: true });
		const env = { OAUTH_KV: fakeKV() } as any;
		const out = parse(await tool("vault_batch_append").run(env, { items: [{ path: "a.md", content: "x" }, { path: "b.md", content: "y" }] }));
		expect(out.results[0].error).toContain("boom");
		expect(out.results[1]).toMatchObject({ appended: true });
	});

	it("rejects an empty items list", async () => {
		expect((await tool("vault_batch_append").run({ OAUTH_KV: fakeKV() } as any, { items: [] })).isError).toBe(true);
	});
});
