import { beforeEach, describe, expect, it, vi } from "vitest";
import { consolidate } from "./consolidate";

const hasConsolidate = vi.fn();
const defaultDeps = vi.fn();
const runConsolidate = vi.fn();
vi.mock("./_consolidate", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./_consolidate")>();
	return { ...actual, hasConsolidate: (...a: unknown[]) => hasConsolidate(...a), defaultDeps: (...a: unknown[]) => defaultDeps(...a), runConsolidate: (...a: unknown[]) => runConsolidate(...a) };
});

const parse = (r: any) => JSON.parse(r.content[0].text);

describe("consolidate (front verb)", () => {
	beforeEach(() => {
		hasConsolidate.mockReset();
		defaultDeps.mockReset();
		runConsolidate.mockReset();
	});

	it("is inert (not_configured) unless CONSOLIDATE_ENABLED, never touching deps/runConsolidate", async () => {
		hasConsolidate.mockReturnValue(false);
		const r = await consolidate.run({} as any, {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("[not_configured]");
		expect(r.content[0].text).toMatch(/CONSOLIDATE_ENABLED/);
		expect(defaultDeps).not.toHaveBeenCalled();
		expect(runConsolidate).not.toHaveBeenCalled();
	});

	it("armed, no force: runs the scan with force:false so the weekly ledger gate applies", async () => {
		hasConsolidate.mockReturnValue(true);
		defaultDeps.mockResolvedValue({ fake: "deps" });
		runConsolidate.mockResolvedValue({ week: "2026-W29", ran: true, stale: [], duplicate_candidates: [] });

		const r = await consolidate.run({ CONSOLIDATE_ENABLED: "1" } as any, {});

		expect(r.isError).toBeUndefined();
		expect(parse(r)).toMatchObject({ week: "2026-W29", ran: true });
		expect(runConsolidate).toHaveBeenCalledWith({ CONSOLIDATE_ENABLED: "1" }, { force: false }, { fake: "deps" });
	});

	it("force:true bypasses only the weekly ledger, not the CONSOLIDATE_ENABLED gate", async () => {
		hasConsolidate.mockReturnValue(true);
		defaultDeps.mockResolvedValue({});
		runConsolidate.mockResolvedValue({ week: "2026-W29", ran: true });

		await consolidate.run({} as any, { force: true });
		expect(runConsolidate).toHaveBeenCalledWith(expect.anything(), { force: true }, expect.anything());
	});

	it("coerces a non-boolean force to false rather than passing it through", async () => {
		hasConsolidate.mockReturnValue(true);
		defaultDeps.mockResolvedValue({});
		runConsolidate.mockResolvedValue({});

		await consolidate.run({} as any, { force: "yes" });
		expect(runConsolidate).toHaveBeenCalledWith(expect.anything(), { force: false }, expect.anything());
	});

	it("catches a thrown error from the scan and reports upstream_error", async () => {
		hasConsolidate.mockReturnValue(true);
		defaultDeps.mockResolvedValue({});
		runConsolidate.mockRejectedValue(new Error("vault unreachable"));

		const r = await consolidate.run({} as any, {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("[upstream_error]");
		expect(r.content[0].text).toMatch(/vault unreachable/);
	});

	it("catches a defaultDeps() failure the same way", async () => {
		hasConsolidate.mockReturnValue(true);
		defaultDeps.mockRejectedValue(new Error("could not load obsidian"));

		const r = await consolidate.run({} as any, {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("[upstream_error]");
		expect(r.content[0].text).toMatch(/could not load obsidian/);
	});
});
