import { describe, expect, it, vi } from "vitest";
import { AUTO_SCRAPED_ENGINES, SEARCH_PROBE_QUERY, runWebSearchSelftest, type WebSearchSelftestDeps } from "./_web_search_selftest";

const ok = (text = "1. Wikipedia — https://en.wikipedia.org/wiki/Test") => ({ content: [{ type: "text" as const, text }] });
const fail = (text = 'No results for "..." from engine \'ddg\'.') => ({ content: [{ type: "text" as const, text }], isError: true });

const mkDeps = (runEngine: WebSearchSelftestDeps["runEngine"]): WebSearchSelftestDeps => ({ runEngine });

describe("runWebSearchSelftest", () => {
	it("reports ok with no error when every auto-probed engine finds hits", async () => {
		const runEngine = vi.fn(async (_env: any, args: any) => ok());
		const report = await runWebSearchSelftest({ KAGI_SESSION: "s" } as any, mkDeps(runEngine));
		expect(report.error).toBeUndefined();
		expect(report.probes.every((p) => p.ok)).toBe(true);
		expect(runEngine).toHaveBeenCalledTimes(AUTO_SCRAPED_ENGINES.length);
		for (const call of runEngine.mock.calls) {
			expect(call[1]).toMatchObject({ query: SEARCH_PROBE_QUERY });
		}
	});

	it("flags a 0-hit scraped engine as a soft failure (markup drift)", async () => {
		const runEngine = vi.fn(async (_env: any, args: any) => (args.engine === "ddg" ? fail() : ok()));
		const report = await runWebSearchSelftest({ KAGI_SESSION: "s" } as any, mkDeps(runEngine));
		expect(report.error).toMatch(/ddg/);
		const ddg = report.probes.find((p) => p.engine === "ddg");
		expect(ddg?.ok).toBe(false);
		expect(ddg?.skipped).toBeUndefined();
	});

	it("skips kagi_session (not a failure) when KAGI_SESSION is unset", async () => {
		const runEngine = vi.fn(async () => ok());
		const report = await runWebSearchSelftest({} as any, mkDeps(runEngine));
		expect(report.error).toBeUndefined();
		expect(report.probes.find((p) => p.engine === "kagi_session")).toMatchObject({ ok: false, skipped: true });
		expect(runEngine).toHaveBeenCalledTimes(AUTO_SCRAPED_ENGINES.length - 1);
	});

	it("excludes google from the automatic cron probe (opt-in cf-residential render path elsewhere)", () => {
		expect(AUTO_SCRAPED_ENGINES).not.toContain("google");
	});
});
