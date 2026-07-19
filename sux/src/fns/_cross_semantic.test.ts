import { describe, expect, it, vi } from "vitest";
import { crossDomainLinks, filesToCrossItems, hasCrossSemantic, lastCrossSemanticFindings, mailToCrossItems, runCrossSemanticSweep, type CrossDomainItem, type CrossSemanticSweepDeps } from "./_cross_semantic";
import type { SemanticChunk } from "./_vault_semantic";
import type { MailSemanticChunk } from "./_mail_semantic";
import type { FilesSemanticChunk } from "./_files_semantic";

const vaultChunk = (path: string, embedding: number[], title = path): SemanticChunk => ({ path, title, text: `text of ${path}`, embedding });

// A single OAUTH_KV stub for the ledger — mirrors _consolidate.test.ts's fakeKV. The whole
// sweep is exercised through injected deps: no real semantic indices.
const fakeKV = (init: Record<string, string> = {}) => {
	const store = new Map(Object.entries(init));
	return { store, get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) };
};
const envWith = (flags: Record<string, string | undefined> = {}) => ({ OAUTH_KV: fakeKV(), ...flags }) as any;

const mkDeps = (over: Partial<CrossSemanticSweepDeps> = {}): CrossSemanticSweepDeps => ({
	vaultChunks: vi.fn(async () => [vaultChunk("Projects/alpha.md", [1, 0, 0])]),
	mailChunks: vi.fn(async () => [{ id: "m1", subject: "Re: alpha kickoff", from: "a@b.com", receivedAt: "2024-01-01", text: "x", embedding: [1, 0, 0] } as MailSemanticChunk]),
	filesChunks: vi.fn(async () => []),
	...over,
});

describe("hasCrossSemantic", () => {
	it("is disabled unless CROSS_SEMANTIC_ENABLED is truthy", () => {
		expect(hasCrossSemantic({} as any)).toBe(false);
		expect(hasCrossSemantic({ CROSS_SEMANTIC_ENABLED: "0" } as any)).toBe(false);
		expect(hasCrossSemantic({ CROSS_SEMANTIC_ENABLED: "false" } as any)).toBe(false);
		expect(hasCrossSemantic({ CROSS_SEMANTIC_ENABLED: "1" } as any)).toBe(true);
	});
});

describe("mailToCrossItems / filesToCrossItems", () => {
	it("pools mail chunks into domain-tagged items and drops ones that never embedded", () => {
		const chunks: MailSemanticChunk[] = [
			{ id: "m1", subject: "Invoice", from: "a@b.com", receivedAt: "2024-01-01", text: "preview", embedding: [1, 0] },
			{ id: "m2", subject: "empty", from: "", receivedAt: "", text: "", embedding: [] },
		];
		expect(mailToCrossItems(chunks)).toEqual([{ domain: "mail", key: "m1", label: "Invoice", embedding: [1, 0] }]);
	});

	it("pools files chunks with path doubling as both key and label", () => {
		const chunks: FilesSemanticChunk[] = [{ path: "notes/a.md", text: "x", embedding: [0, 1] }];
		expect(filesToCrossItems(chunks)).toEqual([{ domain: "files", key: "notes/a.md", label: "notes/a.md", embedding: [0, 1] }]);
	});
});

describe("crossDomainLinks", () => {
	it("matches a vault note against its nearest mail/files targets above the threshold", () => {
		const vaultChunks = [vaultChunk("Projects/alpha.md", [1, 0, 0])];
		const targets: CrossDomainItem[] = [
			{ domain: "mail", key: "m1", label: "Re: alpha kickoff", embedding: [1, 0, 0] },
			{ domain: "files", key: "alpha/spec.md", label: "alpha/spec.md", embedding: [0, 1, 0] },
		];
		const links = crossDomainLinks(vaultChunks, targets);
		expect(links).toEqual([{ vaultPath: "Projects/alpha.md", domain: "mail", key: "m1", label: "Re: alpha kickoff", score: 1 }]);
	});

	it("returns nothing when every target scores below minScore", () => {
		const vaultChunks = [vaultChunk("A.md", [1, 0])];
		const targets: CrossDomainItem[] = [{ domain: "mail", key: "m1", label: "unrelated", embedding: [0, 1] }];
		expect(crossDomainLinks(vaultChunks, targets)).toEqual([]);
	});

	it("caps matches per note at maxPerNote, keeping the highest scores", () => {
		const vaultChunks = [vaultChunk("A.md", [1, 0])];
		const targets: CrossDomainItem[] = [
			{ domain: "mail", key: "m1", label: "closest", embedding: [1, 0] },
			{ domain: "mail", key: "m2", label: "close", embedding: [0.99, 0.01] },
			{ domain: "mail", key: "m3", label: "less close", embedding: [0.9, 0.1] },
		];
		const links = crossDomainLinks(vaultChunks, targets, { minScore: 0.5, maxPerNote: 2 });
		expect(links).toHaveLength(2);
		expect(links.map((l) => l.key)).toEqual(["m1", "m2"]);
	});

	it("caps total matches across notes at maxTotal, ranked by score", () => {
		const vaultChunks = [vaultChunk("A.md", [1, 0]), vaultChunk("B.md", [0, 1])];
		const targets: CrossDomainItem[] = [
			{ domain: "mail", key: "m1", label: "matches A well", embedding: [1, 0] },
			{ domain: "files", key: "f1", label: "matches B well", embedding: [0, 1] },
		];
		const links = crossDomainLinks(vaultChunks, targets, { minScore: 0.5, maxTotal: 1 });
		expect(links).toHaveLength(1);
		expect(links[0].score).toBeCloseTo(1);
	});

	it("dedupes a note matching the same target through more than one of its own chunks, keeping the best score", () => {
		const vaultChunks = [vaultChunk("A.md", [1, 0]), vaultChunk("A.md", [0.95, 0.05])];
		const targets: CrossDomainItem[] = [{ domain: "mail", key: "m1", label: "x", embedding: [1, 0] }];
		const links = crossDomainLinks(vaultChunks, targets, { minScore: 0.5 });
		expect(links).toHaveLength(1);
		expect(links[0].score).toBe(1);
	});

	it("skips vault chunks with no embedding and returns [] when there are no targets", () => {
		const vaultChunks = [{ ...vaultChunk("A.md", []), embedding: [] }];
		expect(crossDomainLinks(vaultChunks, [{ domain: "mail", key: "m1", label: "x", embedding: [1, 0] }])).toEqual([]);
		expect(crossDomainLinks([vaultChunk("A.md", [1, 0])], [])).toEqual([]);
	});
});

describe("runCrossSemanticSweep (#948)", () => {
	it("is a dormant no-op unless enabled — no index fetch", async () => {
		const deps = mkDeps();
		const report = await runCrossSemanticSweep(envWith(), { week: "2026-W01" }, deps);
		expect(report.dormant).toBe(true);
		expect(deps.vaultChunks).not.toHaveBeenCalled();
	});

	it("ranks the vault against pooled mail+files targets and caches the findings", async () => {
		const env = envWith({ CROSS_SEMANTIC_ENABLED: "1" });
		const report = await runCrossSemanticSweep(env, { week: "2026-W10" }, mkDeps());
		expect(report.dormant).toBeUndefined();
		expect(report.count).toBe(1);
		expect(report.links).toEqual([{ vaultPath: "Projects/alpha.md", domain: "mail", key: "m1", label: "Re: alpha kickoff", score: 1 }]);

		const cached = await lastCrossSemanticFindings(env);
		expect(cached).toEqual({ week: "2026-W10", count: 1, links: report.links });
	});

	it("skips ranking when the vault semantic index isn't configured", async () => {
		const env = envWith({ CROSS_SEMANTIC_ENABLED: "1" });
		const deps = mkDeps({ vaultChunks: vi.fn(async () => null) });
		const report = await runCrossSemanticSweep(env, { week: "2026-W11" }, deps);
		expect(report.skipped).toBe(true);
		expect(deps.mailChunks).not.toHaveBeenCalled();
	});

	it("is idempotent per ISO week — a second same-week tick skips without re-ranking", async () => {
		const env = envWith({ CROSS_SEMANTIC_ENABLED: "1" });
		const d1 = mkDeps();
		await runCrossSemanticSweep(env, { week: "2026-W20" }, d1);
		const d2 = mkDeps();
		const report2 = await runCrossSemanticSweep(env, { week: "2026-W20" }, d2);
		expect(report2.skipped).toBe(true);
		expect(d2.vaultChunks).not.toHaveBeenCalled();
	});

	it("force re-runs even a marked week", async () => {
		const env = envWith({ CROSS_SEMANTIC_ENABLED: "1" });
		await runCrossSemanticSweep(env, { week: "2026-W30" }, mkDeps());
		const d2 = mkDeps();
		const report = await runCrossSemanticSweep(env, { week: "2026-W30", force: true }, d2);
		expect(report.skipped).toBeUndefined();
		expect(d2.vaultChunks).toHaveBeenCalledTimes(1);
	});

	it("a failed vault-index fetch leaves the week UNMARKED so the next tick retries", async () => {
		const env = envWith({ CROSS_SEMANTIC_ENABLED: "1" });
		const failing = mkDeps({ vaultChunks: vi.fn(async () => { throw new Error("boom"); }) });
		const report1 = await runCrossSemanticSweep(env, { week: "2026-W40" }, failing);
		expect(report1.error).toContain("boom");
		const report2 = await runCrossSemanticSweep(env, { week: "2026-W40" }, mkDeps());
		expect(report2.skipped).toBeUndefined();
		expect(report2.count).toBe(1);
	});

	it("a missing mail/files leg is not fatal — just fewer targets to rank against", async () => {
		const env = envWith({ CROSS_SEMANTIC_ENABLED: "1" });
		const deps = mkDeps({ mailChunks: vi.fn(async () => { throw new Error("jmap down"); }) });
		const report = await runCrossSemanticSweep(env, { week: "2026-W41" }, deps);
		expect(report.error).toBeUndefined();
		expect(report.count).toBe(0);
	});
});

describe("lastCrossSemanticFindings", () => {
	it("returns null when the sweep has never completed a cycle", async () => {
		expect(await lastCrossSemanticFindings(envWith())).toBeNull();
	});
});
