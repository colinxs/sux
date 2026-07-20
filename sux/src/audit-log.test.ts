import { describe, expect, it } from "vitest";
import { readAuditEntries, recordAudit } from "./audit-log";

const fakeKV = () => {
	const s = new Map<string, string>();
	return { s, get: async (k: string) => s.get(k) ?? null, put: async (k: string, v: string) => void s.set(k, v), delete: async (k: string) => void s.delete(k) };
};

describe("audit-log (forensic record of committed actions, distinct from ledger.ts's dedup store)", () => {
	it("records an entry with kind/at/preview/result and reads it back newest-first", async () => {
		const env = { OAUTH_KV: fakeKV() } as any;
		await recordAudit(env, "mail_send", { action: "send", to: ["a@b.com"] }, { submissionId: "s1" });
		await recordAudit(env, "vault_delete", { path: "Daily/x.md" }, { sha: "abc123" });
		const entries = await readAuditEntries(env);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ kind: "vault_delete", preview: { path: "Daily/x.md" }, result: { sha: "abc123" } });
		expect(entries[1]).toMatchObject({ kind: "mail_send", result: { submissionId: "s1" } });
		expect(typeof entries[0].at).toBe("number");
	});

	it("omits `result` entirely when mutate() resolved to undefined", async () => {
		const env = { OAUTH_KV: fakeKV() } as any;
		await recordAudit(env, "kv_delete", { key: "x" }, undefined);
		const entries = await readAuditEntries(env);
		expect(entries).toHaveLength(1);
		expect("result" in entries[0]).toBe(false);
	});

	it("filters by kind", async () => {
		const env = { OAUTH_KV: fakeKV() } as any;
		await recordAudit(env, "mail_send", {}, {});
		await recordAudit(env, "cal_delete", {}, {});
		await recordAudit(env, "mail_send", {}, {});
		const entries = await readAuditEntries(env, { kind: "mail_send" });
		expect(entries).toHaveLength(2);
		expect(entries.every((e) => e.kind === "mail_send")).toBe(true);
	});

	it("filters by since (ms epoch floor)", async () => {
		const env = { OAUTH_KV: fakeKV() } as any;
		await recordAudit(env, "cal_delete", {}, {});
		const entries = await readAuditEntries(env, { since: Date.now() + 60_000 }); // a floor in the future excludes everything
		expect(entries).toHaveLength(0);
		expect(await readAuditEntries(env, { since: 0 })).toHaveLength(1);
	});

	it("respects limit, defaulting to 100", async () => {
		const env = { OAUTH_KV: fakeKV() } as any;
		for (let i = 0; i < 5; i++) await recordAudit(env, "kv_delete", { i }, {});
		expect(await readAuditEntries(env, { limit: 2 })).toHaveLength(2);
		expect(await readAuditEntries(env)).toHaveLength(5);
	});

	it("degrades to a no-op with no KV binding — never throws", async () => {
		const env = {} as any;
		await expect(recordAudit(env, "mail_send", {}, {})).resolves.toBeUndefined();
	});

	it("recordAudit never throws even when the KV write itself fails", async () => {
		const env = { OAUTH_KV: { get: async () => null, put: async () => { throw new Error("kv down"); }, delete: async () => {} } } as any;
		await expect(recordAudit(env, "mail_send", {}, {})).resolves.toBeUndefined();
	});
});
