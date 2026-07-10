import { describe, expect, it, vi } from "vitest";
import { commit, stage, staged } from "./stage";

const fakeKV = () => {
	const s = new Map<string, string>();
	return { s, get: async (k: string) => s.get(k) ?? null, put: async (k: string, v: string) => void s.set(k, v), delete: async (k: string) => void s.delete(k) };
};

describe("stage-then-commit", () => {
	it("stage mints a payload-bound token and mutates nothing; commit consumes it once", async () => {
		const env = { OAUTH_KV: fakeKV() } as any;
		const payload = { to: ["x@y.com"], subject: "hi" };
		const s = await stage(env, "mail_send", payload, { preview: "would send to x@y.com" });
		expect(s).toMatchObject({ staged: true, kind: "mail_send" });
		expect(s.commit_token).toMatch(/^[0-9a-f]{36}$/);
		await expect(commit(env, "mail_send", s.commit_token, payload)).resolves.toBeUndefined(); // valid → ok
		await expect(commit(env, "mail_send", s.commit_token, payload)).rejects.toThrow(/spent|invalid|expired/); // single-use
	});

	it("commit rejects a changed payload (token is bound to the exact previewed action)", async () => {
		const env = { OAUTH_KV: fakeKV() } as any;
		const s = await stage(env, "mail_send", { to: ["a@b.com"] }, {});
		await expect(commit(env, "mail_send", s.commit_token, { to: ["EVIL@b.com"] })).rejects.toThrow(/payload changed/);
	});

	it("commit rejects a token minted for a different verb kind", async () => {
		const env = { OAUTH_KV: fakeKV() } as any;
		const s = await stage(env, "cal_delete", { id: "1" }, {});
		await expect(commit(env, "mail_send", s.commit_token, { id: "1" })).rejects.toThrow(/staged for 'cal_delete'/);
	});

	it("staged() dispatches: stage→preview, token→mutate, neither→mutate", async () => {
		const env = { OAUTH_KV: fakeKV() } as any;
		const mutate = vi.fn(async () => "DONE");
		const p = { x: 1 };

		const stageOut = await staged(env, "op", { stage: true }, p, { preview: "y" }, mutate);
		expect("stageResult" in stageOut && stageOut.stageResult.staged).toBe(true);
		expect(mutate).not.toHaveBeenCalled(); // stage never mutates

		const token = (stageOut as any).stageResult.commit_token;
		const commitOut = await staged(env, "op", { commit_token: token }, p, {}, mutate);
		expect("result" in commitOut && commitOut.result).toBe("DONE");
		expect(mutate).toHaveBeenCalledTimes(1);

		mutate.mockClear();
		const directOut = await staged(env, "op", {}, p, {}, mutate); // opt-out → direct mutate
		expect("result" in directOut && directOut.result).toBe("DONE");
		expect(mutate).toHaveBeenCalledTimes(1);
	});
});
