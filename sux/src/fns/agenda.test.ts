import { beforeEach, describe, expect, it, vi } from "vitest";
import { agenda } from "./agenda";

const hasAgenda = vi.fn();
const defaultDeps = vi.fn();
const runAgenda = vi.fn();
vi.mock("./_agenda", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./_agenda")>();
	return { ...actual, hasAgenda: (...a: unknown[]) => hasAgenda(...a), defaultDeps: (...a: unknown[]) => defaultDeps(...a), runAgenda: (...a: unknown[]) => runAgenda(...a) };
});

const parse = (r: any) => JSON.parse(r.content[0].text);

describe("agenda (front verb)", () => {
	beforeEach(() => {
		hasAgenda.mockReset();
		defaultDeps.mockReset();
		runAgenda.mockReset();
	});

	it("is inert (not_configured) unless AGENDA_ENABLED, never touching deps/runAgenda", async () => {
		hasAgenda.mockReturnValue(false);
		const r = await agenda.run({} as any, {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("[not_configured]");
		expect(r.content[0].text).toMatch(/AGENDA_ENABLED/);
		expect(defaultDeps).not.toHaveBeenCalled();
		expect(runAgenda).not.toHaveBeenCalled();
	});

	it("armed: runs a cycle and returns the report as JSON", async () => {
		hasAgenda.mockReturnValue(true);
		defaultDeps.mockResolvedValue({ fake: "deps" });
		runAgenda.mockResolvedValue({ cycle: "agenda::2026-07-18", date: "2026-07-18", proposed: 2, digest_written: true, emailed: false });

		const r = await agenda.run({ AGENDA_ENABLED: "1" } as any, { date: "2026-07-18" });

		expect(r.isError).toBeUndefined();
		expect(parse(r)).toMatchObject({ proposed: 2, digest_written: true });
		expect(runAgenda).toHaveBeenCalledWith({ AGENDA_ENABLED: "1" }, { date: "2026-07-18", max_mail: undefined, horizon_days: undefined, dry_run: false }, { fake: "deps" });
	});

	it("passes dry_run:true through as a boolean, coercing any truthy-but-not-true value to false", async () => {
		hasAgenda.mockReturnValue(true);
		defaultDeps.mockResolvedValue({});
		runAgenda.mockResolvedValue({ dormant: false });

		await agenda.run({} as any, { dry_run: true });
		expect(runAgenda).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dry_run: true }), expect.anything());

		runAgenda.mockClear();
		await agenda.run({} as any, { dry_run: "yes" });
		expect(runAgenda).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dry_run: false }), expect.anything());
	});

	it("catches a thrown error from the cycle and reports upstream_error", async () => {
		hasAgenda.mockReturnValue(true);
		defaultDeps.mockResolvedValue({});
		runAgenda.mockRejectedValue(new Error("caldav exploded"));

		const r = await agenda.run({} as any, {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("[upstream_error]");
		expect(r.content[0].text).toMatch(/caldav exploded/);
	});

	it("catches a defaultDeps() failure the same way", async () => {
		hasAgenda.mockReturnValue(true);
		defaultDeps.mockRejectedValue(new Error("could not load mail-mcp"));

		const r = await agenda.run({} as any, {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("[upstream_error]");
		expect(r.content[0].text).toMatch(/could not load mail-mcp/);
	});
});
