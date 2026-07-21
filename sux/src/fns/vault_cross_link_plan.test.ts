import { beforeEach, describe, expect, it, vi } from "vitest";

const runVerb = vi.fn();
vi.mock("./run", () => ({ runVerb: (...args: unknown[]) => runVerb(...args) }));

const obsidianRun = vi.fn();
vi.mock("./obsidian", () => ({
	obsidian: { run: (...args: unknown[]) => obsidianRun(...args) },
	vaultCfg: (env: any) => (env.VAULT_REPO ? { repo: env.VAULT_REPO, branch: "main", dir: "", inVault: (p: string) => p } : { error: "vault not configured" }),
	vaultHead: async () => "sha1",
	readVaultSemanticBlob: async () => null,
	writeVaultSemanticBlob: async () => true,
}));

// A keyword-bucketed embed stand-in: text containing "alpha" embeds to [1,0] (the vault note's
// own bucket); "closematch" embeds to [0.6,0.8] (cosine 0.6 against [1,0] — below the fn's
// default 0.75 threshold, above a caller-lowered one); anything else embeds to [0,1] (orthogonal,
// never matches). Deterministic and keyword-driven rather than a real model, so each test can
// pick which bucket a chunk's text lands in just by what words it contains.
vi.mock("./_embed", () => ({
	embed: async (_env: any, texts: string[]) =>
		texts.map((t) => {
			const s = String(t).toLowerCase();
			if (s.includes("closematch")) return [0.6, 0.8];
			if (s.includes("alpha")) return [1, 0];
			return [0, 1];
		}),
	cosine: (a: number[], b: number[]) => {
		const n = Math.min(a.length, b.length);
		if (!n) return 0;
		let dot = 0;
		let na = 0;
		let nb = 0;
		for (let i = 0; i < n; i++) {
			dot += a[i] * b[i];
			na += a[i] * a[i];
			nb += b[i] * b[i];
		}
		if (na === 0 || nb === 0) return 0;
		return dot / (Math.sqrt(na) * Math.sqrt(nb));
	},
	encodeEmbedding: (v: number[]) => JSON.stringify(v),
	decodeEmbedding: (s: string) => JSON.parse(s),
}));

const jmapRun = vi.fn();
vi.mock("./jmap", () => ({ jmap: { run: (...args: unknown[]) => jmapRun(...args) } }));

const hasDropboxFull = vi.fn((..._args: unknown[]) => false);
vi.mock("./_dropbox-full", () => ({ hasDropboxFull: (...args: unknown[]) => hasDropboxFull(...args), listFullChanges: vi.fn(), readFull: vi.fn() }));

// Mail/files semantic indices read/write env.OAUTH_KV directly (not through the mocked
// obsidian.ts), so they need a working get/put, not just a truthy presence check.
const fakeKV = { get: async () => null, put: async () => {} };

describe("vault_cross_link_plan", () => {
	beforeEach(() => {
		runVerb.mockReset();
		obsidianRun.mockReset();
		jmapRun.mockReset();
		hasDropboxFull.mockReset().mockReturnValue(false);
	});

	it("is disabled unless CROSS_SEMANTIC_ENABLED is set", async () => {
		const { vault_cross_link_plan } = await import("./vault_cross_link_plan");
		const res = await vault_cross_link_plan.run({} as any, {});
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("CROSS_SEMANTIC_ENABLED");
		expect(runVerb).not.toHaveBeenCalled();
	});

	it("fails with not_configured when the vault itself isn't configured", async () => {
		const { vault_cross_link_plan } = await import("./vault_cross_link_plan");
		const res = await vault_cross_link_plan.run({ CROSS_SEMANTIC_ENABLED: "1" } as any, {});
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("vault not configured");
		expect(runVerb).not.toHaveBeenCalled();
	});

	it("reports nothing to cross-link when neither mail nor files semantic indices are configured", async () => {
		obsidianRun.mockImplementation(async (_env: any, a: any) => {
			if (a.action === "list") return { content: [{ type: "text", text: JSON.stringify({ notes: ["Projects/alpha.md"] }) }] };
			if (a.action === "read") return { content: [{ type: "text", text: "alpha body" }] };
			throw new Error(`unexpected action ${a.action}`);
		});
		const { vault_cross_link_plan } = await import("./vault_cross_link_plan");
		const res = await vault_cross_link_plan.run({ CROSS_SEMANTIC_ENABLED: "1", VAULT_REPO: "me/vault", AI: {}, OAUTH_KV: fakeKV } as any, {});
		expect(res.isError).toBeUndefined();
		const body = JSON.parse(res.content[0].text);
		expect(body).toEqual({ candidates: 0, note: "no mail, files, or contacts semantic index is configured — nothing to cross-link against" });
		expect(runVerb).not.toHaveBeenCalled();
	});

	it("ranks the vault semantic index against mail's, and starts a durable run when a match clears the threshold", async () => {
		obsidianRun.mockImplementation(async (_env: any, a: any) => {
			if (a.action === "list") return { content: [{ type: "text", text: JSON.stringify({ notes: ["Projects/alpha.md"] }) }] };
			if (a.action === "read") return { content: [{ type: "text", text: "alpha project body" }] };
			throw new Error(`unexpected action ${a.action}`);
		});
		jmapRun.mockResolvedValue({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						methodResponses: [
							["Email/query", { ids: ["m1"], total: 1 }, "q"],
							["Email/get", { list: [{ id: "m1", subject: "Re: alpha kickoff", from: [{ email: "a@b.com" }], receivedAt: "2024-01-01T00:00:00Z", preview: "alpha stuff" }], state: "s1" }, "g"],
						],
					}),
				},
			],
		});
		runVerb.mockResolvedValueOnce({ instanceId: "xyz789" });

		const { vault_cross_link_plan } = await import("./vault_cross_link_plan");
		const res = await vault_cross_link_plan.run({ CROSS_SEMANTIC_ENABLED: "1", VAULT_REPO: "me/vault", AI: {}, FASTMAIL_TOKEN: "tok", OAUTH_KV: fakeKV } as any, {});

		expect(runVerb).toHaveBeenCalledTimes(1);
		const call = runVerb.mock.calls[0][0];
		expect(call.op).toBe("cross-semantic-plan");
		expect(call.mode).toBe("durable");
		expect(call.input).toEqual([{ vaultPath: "Projects/alpha.md", domain: "mail", key: "m1", label: "Re: alpha kickoff", score: 1 }]);
		expect(res.isError).toBeUndefined();
		const body = JSON.parse(res.content[0].text);
		expect(body).toMatchObject({ candidates: 1, instanceId: "xyz789" });
	});

	it("drops a match below the default threshold, but includes it once the caller lowers minScore", async () => {
		obsidianRun.mockImplementation(async (_env: any, a: any) => {
			if (a.action === "list") return { content: [{ type: "text", text: JSON.stringify({ notes: ["Projects/alpha.md"] }) }] };
			if (a.action === "read") return { content: [{ type: "text", text: "alpha project body" }] };
			throw new Error(`unexpected action ${a.action}`);
		});
		jmapRun.mockResolvedValue({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						methodResponses: [
							["Email/query", { ids: ["m1"], total: 1 }, "q"],
							["Email/get", { list: [{ id: "m1", subject: "closematch subject", from: [{ email: "a@b.com" }], receivedAt: "2024-01-01T00:00:00Z", preview: "x" }], state: "s1" }, "g"],
						],
					}),
				},
			],
		});
		const { vault_cross_link_plan } = await import("./vault_cross_link_plan");
		const env = { CROSS_SEMANTIC_ENABLED: "1", VAULT_REPO: "me/vault", AI: {}, FASTMAIL_TOKEN: "tok", OAUTH_KV: fakeKV } as any;

		const belowThreshold = await vault_cross_link_plan.run(env, {});
		expect(runVerb).not.toHaveBeenCalled();
		expect(JSON.parse(belowThreshold.content[0].text)).toEqual({ candidates: 0, note: "no cross-domain matches above threshold — nothing to link" });

		runVerb.mockResolvedValueOnce({ instanceId: "low1" });
		const aboveLoweredThreshold = await vault_cross_link_plan.run(env, { minScore: 0.5 });
		expect(runVerb).toHaveBeenCalledTimes(1);
		expect(runVerb.mock.calls[0][0].input).toEqual([{ vaultPath: "Projects/alpha.md", domain: "mail", key: "m1", label: "closematch subject", score: 0.6 }]);
		expect(JSON.parse(aboveLoweredThreshold.content[0].text)).toMatchObject({ candidates: 1, instanceId: "low1" });
	});

	it("ranks the vault semantic index against contacts too, and starts a durable run when a match clears the threshold", async () => {
		obsidianRun.mockImplementation(async (_env: any, a: any) => {
			if (a.action === "list") return { content: [{ type: "text", text: JSON.stringify({ notes: ["Projects/alpha.md"] }) }] };
			if (a.action === "read") return { content: [{ type: "text", text: "alpha project body" }] };
			throw new Error(`unexpected action ${a.action}`);
		});
		jmapRun.mockImplementation(async (_env: any, args: any) => {
			const calls = args.calls as [string, any, string][];
			const methodResponses = calls.map(([method, , callId]) => {
				if (method === "ContactCard/query") return ["ContactCard/query", { ids: ["c1"], total: 1 }, callId];
				if (method === "ContactCard/get") return ["ContactCard/get", { state: "s1", list: [{ id: "c1", name: { full: "alpha contact" }, organizations: {}, emails: {}, phones: {} }] }, callId];
				if (method === "Email/query") return ["Email/query", { ids: [], total: 0 }, callId];
				if (method === "Email/get") return ["Email/get", { state: "s0", list: [] }, callId];
				return ["error", { type: "unknownMethod" }, callId];
			});
			return { content: [{ type: "text", text: JSON.stringify({ methodResponses }) }] };
		});
		runVerb.mockResolvedValueOnce({ instanceId: "contact1" });

		const { vault_cross_link_plan } = await import("./vault_cross_link_plan");
		const res = await vault_cross_link_plan.run({ CROSS_SEMANTIC_ENABLED: "1", VAULT_REPO: "me/vault", AI: {}, FASTMAIL_TOKEN: "tok", OAUTH_KV: fakeKV } as any, {});

		expect(runVerb).toHaveBeenCalledTimes(1);
		const call = runVerb.mock.calls[0][0];
		expect(call.input).toEqual([{ vaultPath: "Projects/alpha.md", domain: "contacts", key: "c1", label: "alpha contact", score: 1 }]);
		expect(res.isError).toBeUndefined();
		const body = JSON.parse(res.content[0].text);
		expect(body).toMatchObject({ candidates: 1, instanceId: "contact1" });
	});
});
