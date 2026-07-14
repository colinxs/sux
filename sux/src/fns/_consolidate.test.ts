import { describe, expect, it, vi } from "vitest";
import { DEFAULT_STALE_DAYS, hasConsolidate, runConsolidate, staleDays, type ConsolidateDeps } from "./_consolidate";

// A single OAUTH_KV stub for the ledger — mirrors _weekly_recall.test.ts's fakeKV. The whole
// feature is exercised through injected deps: no real vault, no real obsidian fn.
const fakeKV = (init: Record<string, string> = {}) => {
	const store = new Map(Object.entries(init));
	return { store, get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) };
};
const envWith = (flags: Record<string, string | undefined> = {}) => ({ OAUTH_KV: fakeKV(), ...flags }) as any;

const fm = (extra: string): string => `---\n${extra}\n---\nbody`;

const mkDeps = (notes: Record<string, string>): ConsolidateDeps & { digested: ReturnType<typeof vi.fn> } => {
	const digested = vi.fn(async () => {});
	return {
		listNotes: async () => Object.keys(notes),
		readNote: async (_env, path) => {
			if (!(path in notes)) throw new Error(`no such note: ${path}`);
			return notes[path];
		},
		digestAppend: digested,
		digested,
	};
};

describe("gate — fail-closed", () => {
	it("hasConsolidate is off unless CONSOLIDATE_ENABLED is truthy", () => {
		for (const v of [undefined, "", "0", "false", "no", "off"]) expect(hasConsolidate({ CONSOLIDATE_ENABLED: v } as any)).toBe(false);
		for (const v of ["1", "true", "on", "yes"]) expect(hasConsolidate({ CONSOLIDATE_ENABLED: v } as any)).toBe(true);
	});
});

describe("staleDays", () => {
	it("defaults to DEFAULT_STALE_DAYS when unset or invalid", () => {
		expect(staleDays(envWith())).toBe(DEFAULT_STALE_DAYS);
		expect(staleDays(envWith({ CONSOLIDATE_STALE_DAYS: "not-a-number" }))).toBe(DEFAULT_STALE_DAYS);
		expect(staleDays(envWith({ CONSOLIDATE_STALE_DAYS: "-5" }))).toBe(DEFAULT_STALE_DAYS);
	});
	it("honors a valid override", () => {
		expect(staleDays(envWith({ CONSOLIDATE_STALE_DAYS: "30" }))).toBe(30);
	});
});

describe("runConsolidate", () => {
	it("is a dormant no-op unless enabled — no vault read, no vault write", async () => {
		const deps = mkDeps({});
		const report = await runConsolidate(envWith(), { week: "2026-W01" }, deps);
		expect(report.dormant).toBe(true);
		expect(deps.digested).not.toHaveBeenCalled();
	});

	it("flags a note with no last_verified as stale", async () => {
		const env = envWith({ CONSOLIDATE_ENABLED: "1" });
		const deps = mkDeps({ "Areas/Health.md": fm("title: Health") });
		const report = await runConsolidate(env, { week: "2026-W10" }, deps);
		expect(report.dormant).toBeUndefined();
		expect(report.digest_written).toBe(true);
		expect(report.stale).toEqual([{ path: "Areas/Health.md", reason: "no last_verified marker" }]);
	});

	it("flags a note verified more than the threshold ago as stale, and a recent one as fresh", async () => {
		const env = envWith({ CONSOLIDATE_ENABLED: "1" });
		const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
		const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
		const deps = mkDeps({
			"Old.md": fm(`last_verified: ${old}`),
			"Recent.md": fm(`last_verified: ${recent}`),
		});
		const report = await runConsolidate(env, { week: "2026-W11" }, deps);
		expect(report.stale?.map((s) => s.path)).toEqual(["Old.md"]);
	});

	it("flags same-looking titles as duplicate candidates, not exact-different ones", async () => {
		const env = envWith({ CONSOLIDATE_ENABLED: "1" });
		const recent = new Date().toISOString().slice(0, 10);
		const deps = mkDeps({
			"Projects/project-alpha.md": fm(`last_verified: ${recent}`),
			"Archive/Project Alpha (2).md": fm(`last_verified: ${recent}`),
			"Projects/beta.md": fm(`last_verified: ${recent}`),
		});
		const report = await runConsolidate(env, { week: "2026-W12" }, deps);
		expect(report.duplicate_candidates).toEqual([{ a: "Projects/project-alpha.md", b: "Archive/Project Alpha (2).md", key: "project alpha" }]);
	});

	it("is idempotent per ISO week — a second same-week tick skips", async () => {
		const env = envWith({ CONSOLIDATE_ENABLED: "1" });
		const d1 = mkDeps({ "A.md": fm("title: A") });
		await runConsolidate(env, { week: "2026-W20" }, d1);
		expect(d1.digested).toHaveBeenCalledTimes(1);
		const d2 = mkDeps({ "A.md": fm("title: A") });
		const report2 = await runConsolidate(env, { week: "2026-W20" }, d2);
		expect(report2.skipped).toBe(true);
		expect(d2.digested).not.toHaveBeenCalled();
	});

	it("force re-runs even a marked week", async () => {
		const env = envWith({ CONSOLIDATE_ENABLED: "1" });
		const d1 = mkDeps({ "A.md": fm("title: A") });
		await runConsolidate(env, { week: "2026-W30" }, d1);
		const d2 = mkDeps({ "A.md": fm("title: A") });
		const report = await runConsolidate(env, { week: "2026-W30", force: true }, d2);
		expect(report.skipped).toBeUndefined();
		expect(d2.digested).toHaveBeenCalledTimes(1);
	});

	it("a failed vault append leaves the week UNMARKED so the next tick retries", async () => {
		const env = envWith({ CONSOLIDATE_ENABLED: "1" });
		const failing = mkDeps({ "A.md": fm("title: A") });
		failing.digestAppend = vi.fn(async () => {
			throw new Error("vault down");
		});
		const r1 = await runConsolidate(env, { week: "2026-W40" }, failing);
		expect(r1.digest_written).toBe(false);
		const ok = mkDeps({ "A.md": fm("title: A") });
		const r2 = await runConsolidate(env, { week: "2026-W40" }, ok);
		expect(r2.skipped).toBeUndefined();
		expect(r2.digest_written).toBe(true);
	});

	it("one unreadable note doesn't sink the sweep", async () => {
		const env = envWith({ CONSOLIDATE_ENABLED: "1" });
		const deps = mkDeps({ "Good.md": fm("title: Good") });
		deps.listNotes = async () => ["Good.md", "Missing.md"];
		const report = await runConsolidate(env, { week: "2026-W50" }, deps);
		expect(report.digest_written).toBe(true);
		expect(report.scanned).toBe(1);
	});

	it("writes the digest to Consolidation/<week>.md", async () => {
		const env = envWith({ CONSOLIDATE_ENABLED: "1" });
		const deps = mkDeps({ "A.md": fm("title: A") });
		await runConsolidate(env, { week: "2026-W15" }, deps);
		const [, path, content] = deps.digested.mock.calls[0];
		expect(path).toBe("Consolidation/2026-W15.md");
		expect(content).toContain("Consolidation sweep");
		expect(content).toContain("never verified");
	});
});
