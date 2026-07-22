import { describe, expect, it } from "vitest";
import { compactMedicalTimelinePlan, proposeMedicalEvent } from "./_medical_timeline_plan";

describe("proposeMedicalEvent", () => {
	it("normalizes a well-formed event", () => {
		const r = proposeMedicalEvent({ date: "2026-03-05", kind: "appointment", title: "Cardiology follow-up", detail: "BP check", source: "Health/2026-03-05-cardio.md" });
		expect(r).toEqual({ date: "2026-03-05", kind: "appointment", title: "Cardiology follow-up", detail: "BP check", source: "Health/2026-03-05-cardio.md" });
	});

	it("defaults kind to 'event' and drops empty detail", () => {
		const r = proposeMedicalEvent({ date: "2026-03-05", kind: "", title: "Flu shot", source: "Health/flu.md" });
		expect(r).toEqual({ date: "2026-03-05", kind: "event", title: "Flu shot", detail: undefined, source: "Health/flu.md" });
	});

	it("rejects a missing/unparseable date", () => {
		expect(proposeMedicalEvent({ date: "", kind: "event", title: "x", source: "y" })).toBeNull();
		expect(proposeMedicalEvent({ date: "not-a-date", kind: "event", title: "x", source: "y" })).toBeNull();
	});

	it("rejects an empty title or source", () => {
		expect(proposeMedicalEvent({ date: "2026-03-05", kind: "event", title: "  ", source: "y" })).toBeNull();
		expect(proposeMedicalEvent({ date: "2026-03-05", kind: "event", title: "x", source: "" })).toBeNull();
	});
});

describe("compactMedicalTimelinePlan", () => {
	it("drops nulls and sorts chronologically", () => {
		const a = { date: "2026-05-01", kind: "event", title: "later", source: "a" };
		const b = { date: "2026-01-01", kind: "event", title: "earlier", source: "b" };
		expect(compactMedicalTimelinePlan([a, null, b])).toEqual([b, a]);
	});

	it("returns an empty array for an all-null batch", () => {
		expect(compactMedicalTimelinePlan([null, null])).toEqual([]);
	});
});
