import { describe, expect, it, vi } from "vitest";
import { proposeMychartOutreach, compactMychartOutreachPlan, type MychartOutreachPlanItem } from "./_mychart_reconcile_plan";

const CONFLICT = { medOrg: "uwmedicine", medId: "med1", medName: "Penicillin V", allergyOrg: "swedish", allergyId: "al1", allergySubstance: "Penicillin" };

function capsStub(summarizeImpl: (text: string) => Promise<string> = async (t) => `summarized: ${t}`) {
	return { store: {} as any, llm: { markdownFromPdf: vi.fn(), summarize: vi.fn(summarizeImpl) }, clock: { now: () => 0 }, sinks: {} } as any;
}

describe("proposeMychartOutreach — LLM-drafted outreach for one cross-org conflict (#1008)", () => {
	it("drafts a summary via caps.llm.summarize and a non-diagnostic outreach message", async () => {
		const caps = capsStub(async (t) => `Penicillin V (uwmedicine) may overlap a Penicillin allergy (swedish).`);
		const item = await proposeMychartOutreach(CONFLICT, caps);
		expect(item).not.toBeNull();
		expect(caps.llm.summarize).toHaveBeenCalledTimes(1);
		expect(item?.summary).toContain("Penicillin");
		expect(item?.draftMessage).toContain(item!.summary);
		expect(item?.draftMessage).toMatch(/confirm/i);
		expect(item).toMatchObject(CONFLICT);
	});

	it("falls back to the plain facts text when summarize returns empty", async () => {
		const caps = capsStub(async () => "");
		const item = await proposeMychartOutreach(CONFLICT, caps);
		expect(item?.summary).toContain("Penicillin V");
		expect(item?.summary).toContain("uwmedicine");
	});

	it("returns null for a malformed conflict rather than throwing", async () => {
		const caps = capsStub();
		expect(await proposeMychartOutreach({ ...CONFLICT, medName: "" }, caps)).toBeNull();
		expect(await proposeMychartOutreach({} as any, caps)).toBeNull();
	});
});

describe("compactMychartOutreachPlan", () => {
	it("drops nulls, keeps drafted items", () => {
		const item: MychartOutreachPlanItem = { ...CONFLICT, summary: "s", draftMessage: "m" };
		expect(compactMychartOutreachPlan([item, null])).toEqual([item]);
	});
});
