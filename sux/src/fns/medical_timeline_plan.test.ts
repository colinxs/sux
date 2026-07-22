import { beforeEach, describe, expect, it, vi } from "vitest";
import { medical_timeline_plan } from "./medical_timeline_plan";

const runVerb = vi.fn();
vi.mock("./run", () => ({ runVerb: (...args: unknown[]) => runVerb(...args) }));

describe("medical_timeline_plan", () => {
	beforeEach(() => {
		runVerb.mockReset();
	});

	it("is disabled unless MEDICAL_TIMELINE_ENABLED is set", async () => {
		const res = await medical_timeline_plan.run({} as any, {});
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("MEDICAL_TIMELINE_ENABLED");
		expect(runVerb).not.toHaveBeenCalled();
	});

	it("gathers dated vault Health/ notes and starts a durable run", async () => {
		vi.doMock("../vault-mcp", () => ({
			scanVault: async () => ({
				records: [
					{ path: "Health/2026-03-05-cardio.md", fm: { date: "2026-03-05", kind: "appointment", title: "Cardiology" }, excerpt: "BP check" },
					{ path: "Health/no-date.md", fm: {}, excerpt: "" },
				],
				total: 2,
				truncated: false,
			}),
		}));
		vi.resetModules();
		const { medical_timeline_plan: freshFn } = await import("./medical_timeline_plan");
		runVerb.mockResolvedValueOnce({ instanceId: "abc123" });

		const res = await freshFn.run({ MEDICAL_TIMELINE_ENABLED: "1" } as any, {});

		expect(runVerb).toHaveBeenCalledTimes(1);
		const call = runVerb.mock.calls[0][0];
		expect(call.op).toBe("medical-timeline-plan");
		expect(call.mode).toBe("durable");
		expect(call.input).toEqual([{ date: "2026-03-05", kind: "appointment", title: "Cardiology", detail: "BP check", source: "Health/2026-03-05-cardio.md" }]);
		const body = JSON.parse(res.content[0].text);
		expect(body).toMatchObject({ scanned: 1, instanceId: "abc123" });
	});

	it("merges caller-supplied records with vault-gathered ones", async () => {
		vi.doMock("../vault-mcp", () => ({ scanVault: async () => ({ records: [], total: 0, truncated: false }) }));
		vi.resetModules();
		const { medical_timeline_plan: freshFn } = await import("./medical_timeline_plan");
		runVerb.mockResolvedValueOnce({ instanceId: "xyz" });

		const record = { date: "2026-02-01", kind: "result", title: "Lab panel", source: "mychart:uwmedicine:res1" };
		const res = await freshFn.run({ MEDICAL_TIMELINE_ENABLED: "1" } as any, { records: [record] });

		const call = runVerb.mock.calls[0][0];
		expect(call.input).toEqual([record]);
		expect(res.isError).toBeUndefined();
	});

	it("skips starting a run when there are no events", async () => {
		vi.doMock("../vault-mcp", () => ({ scanVault: async () => ({ records: [], total: 0, truncated: false }) }));
		vi.resetModules();
		const { medical_timeline_plan: freshFn } = await import("./medical_timeline_plan");

		const res = await freshFn.run({ MEDICAL_TIMELINE_ENABLED: "1" } as any, {});

		expect(runVerb).not.toHaveBeenCalled();
		const body = JSON.parse(res.content[0].text);
		expect(body.scanned).toBe(0);
	});
});
