import { beforeEach, describe, expect, it, vi } from "vitest";
import { mychart_reconcile_plan } from "./mychart_reconcile_plan";

const runVerb = vi.fn();
vi.mock("./run", () => ({ runVerb: (...args: unknown[]) => runVerb(...args) }));

const CONFLICT = { medOrg: "uwmedicine", medId: "med1", medName: "Penicillin V", allergyOrg: "swedish", allergyId: "al1", allergySubstance: "Penicillin" };

describe("mychart_reconcile_plan", () => {
	beforeEach(() => {
		runVerb.mockReset();
	});

	it("is disabled unless MYCHART_RECONCILE_ENABLED (+ AGENDA_ENABLED) is set", async () => {
		const res = await mychart_reconcile_plan.run({} as any, {});
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("MYCHART_RECONCILE_ENABLED");
		expect(runVerb).not.toHaveBeenCalled();
	});

	it("stays disabled with only MYCHART_RECONCILE_ENABLED set, no AGENDA_ENABLED (fail-closed, mirrors _agenda.ts's hasMychartReconcile)", async () => {
		const res = await mychart_reconcile_plan.run({ MYCHART_RECONCILE_ENABLED: "1" } as any, {});
		expect(res.isError).toBe(true);
		expect(runVerb).not.toHaveBeenCalled();
	});

	it("detects conflicts and starts a durable run", async () => {
		vi.doMock("../mychart", () => ({ crossOrgMedicationAllergyConflicts: async () => [CONFLICT] }));
		vi.resetModules();
		const { mychart_reconcile_plan: freshFn } = await import("./mychart_reconcile_plan");
		runVerb.mockResolvedValueOnce({ instanceId: "abc123" });

		const res = await freshFn.run({ AGENDA_ENABLED: "1", MYCHART_RECONCILE_ENABLED: "1" } as any, {});

		expect(runVerb).toHaveBeenCalledTimes(1);
		const call = runVerb.mock.calls[0][0];
		expect(call.op).toBe("mychart-reconcile-plan");
		expect(call.mode).toBe("durable");
		expect(call.input).toEqual([CONFLICT]);
		expect(res.isError).toBeUndefined();
		const body = JSON.parse(res.content[0].text);
		expect(body).toMatchObject({ scanned: 1, total_conflicts: 1, instanceId: "abc123" });
	});

	it("caps the batch at `max` but reports the true total_conflicts", async () => {
		const conflicts = [CONFLICT, { ...CONFLICT, medId: "med2" }, { ...CONFLICT, medId: "med3" }];
		vi.doMock("../mychart", () => ({ crossOrgMedicationAllergyConflicts: async () => conflicts }));
		vi.resetModules();
		const { mychart_reconcile_plan: freshFn } = await import("./mychart_reconcile_plan");
		runVerb.mockResolvedValueOnce({ instanceId: "abc123" });

		const res = await freshFn.run({ AGENDA_ENABLED: "1", MYCHART_RECONCILE_ENABLED: "1" } as any, { max: 2 });

		const call = runVerb.mock.calls[0][0];
		expect(call.input).toHaveLength(2);
		const body = JSON.parse(res.content[0].text);
		expect(body).toMatchObject({ scanned: 2, total_conflicts: 3 });
	});

	it("skips starting a run when there are no conflicts", async () => {
		vi.doMock("../mychart", () => ({ crossOrgMedicationAllergyConflicts: async () => [] }));
		vi.resetModules();
		const { mychart_reconcile_plan: freshFn } = await import("./mychart_reconcile_plan");

		const res = await freshFn.run({ AGENDA_ENABLED: "1", MYCHART_RECONCILE_ENABLED: "1" } as any, {});

		expect(runVerb).not.toHaveBeenCalled();
		const body = JSON.parse(res.content[0].text);
		expect(body).toEqual({ scanned: 0, note: "no cross-org conflicts found — nothing to draft" });
	});
});
