import { describe, expect, it } from "vitest";
import { recordAudit } from "../audit-log";
import { audit_log } from "./audit_log";

const fakeEnv = () => {
	const s = new Map<string, string>();
	return { OAUTH_KV: { get: async (k: string) => s.get(k) ?? null, put: async (k: string, v: string) => void s.set(k, v), delete: async (k: string) => void s.delete(k) } } as any;
};

describe("audit_log.run", () => {
	it("returns recorded entries newest-first", async () => {
		const env = fakeEnv();
		await recordAudit(env, "mail_send", { to: ["a@b.com"] }, { submissionId: "s1" });
		await recordAudit(env, "vault_delete", { path: "x.md" }, { sha: "abc" });
		const r = await audit_log.run(env, {});
		expect(r.isError).toBeFalsy();
		const body = JSON.parse(r.content[0].text);
		expect(body.count).toBe(2);
		expect(body.entries[0].kind).toBe("vault_delete");
		expect(body.entries[1].kind).toBe("mail_send");
	});

	it("filters by kind", async () => {
		const env = fakeEnv();
		await recordAudit(env, "mail_send", {}, {});
		await recordAudit(env, "cal_delete", {}, {});
		const r = await audit_log.run(env, { kind: "cal_delete" });
		const body = JSON.parse(r.content[0].text);
		expect(body.count).toBe(1);
		expect(body.entries[0].kind).toBe("cal_delete");
	});

	it("rejects a malformed `since`", async () => {
		const env = fakeEnv();
		const r = await audit_log.run(env, { since: "not-a-date" });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("bad_input");
	});

	it("returns an empty log when nothing has been recorded", async () => {
		const r = await audit_log.run(fakeEnv(), {});
		expect(r.isError).toBeFalsy();
		expect(JSON.parse(r.content[0].text)).toEqual({ count: 0, entries: [] });
	});
});
