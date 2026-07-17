import { describe, expect, it } from "vitest";
import { classifyForLabelPlan, compactLabelPlan } from "./_mail_triage_plan";

describe("classifyForLabelPlan", () => {
	it("proposes a reversible label:add for a confidently-classified message", () => {
		const item = classifyForLabelPlan({ id: "1", from: "prize@sketchy.tld", subject: "You WON the lottery! Claim your prize now" });
		expect(item).toEqual({ id: "1", label: "junk", add: true, confidence: 0.9, reason: "spam-signal subject/body" });
	});

	it("proposes a service-notification's per-message label override, not the generic 'notification' tag", () => {
		const item = classifyForLabelPlan({ id: "2", from: "notifications@github.com", subject: "Your run failed" });
		expect(item).toEqual({ id: "2", label: "gh:ci-fail", add: true, confidence: 0.9, reason: "gh ci-fail notification" });
	});

	it("returns null below the confidence bar (unknown label)", () => {
		expect(classifyForLabelPlan({ id: "3", from: "someone@randomcorp.example", subject: "Quick question" })).toBeNull();
	});

	it("returns null for a sensitive sender even when the category would otherwise clear the bar", () => {
		expect(classifyForLabelPlan({ id: "4", from: "alerts@chase.com", subject: "Your statement is ready" })).toBeNull();
	});

	it("does NOT exempt 'important' from the sensitive-sender guard when the sender isn't personal (still label-eligible via ACTION_FOR)", () => {
		// A sensitive sender flagged 'important' is the one exempted category — still proposed.
		const item = classifyForLabelPlan({ id: "5", from: "friend@gmail.com", subject: "Please reply — need your answer by tomorrow" });
		expect(item).toEqual({ id: "5", label: "important", add: true, confidence: 0.8, reason: "personal sender + reply/urgent cue" });
	});

	it("returns null without an id", () => {
		expect(classifyForLabelPlan({ id: "", from: "friend@gmail.com", subject: "lunch tomorrow?" })).toBeNull();
	});
});

describe("compactLabelPlan", () => {
	it("drops nulls and keeps order", () => {
		const a = { id: "1", label: "junk", add: true, confidence: 0.9, reason: "x" };
		const b = { id: "2", label: "receipt", add: true, confidence: 0.85, reason: "y" };
		expect(compactLabelPlan([a, null, b, null])).toEqual([a, b]);
	});

	it("returns an empty array for an all-null batch", () => {
		expect(compactLabelPlan([null, null])).toEqual([]);
	});
});
