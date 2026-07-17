import { test, expect } from "vitest";
import { MemoryStore, type Caps } from "@suxos/lib";
import { interpretDurable, AskRejectedError } from "./durable.js";
import { registry } from "./registry.js";

// A FAKE WorkflowStep mirroring durable.test.ts: `do` runs inline, `waitForEvent` records
// the event type it waited on and returns a caller-supplied payload (default: approve).
const fakeStep = (rec: { events: string[] }, payload: any = { approved: true }): any => ({
	do: async (_name: string, fn: any) => fn(),
	waitForEvent: async (_name: string, opts: { type: string }) => {
		rec.events.push(opts.type);
		return { payload };
	},
	sleep: async () => {},
});

test("mail-triage-plan: classifies, asks for approval, and sinks only the compacted, approved batch", async () => {
	const rec = { events: [] as string[] };
	const written: unknown[] = [];
	const caps = {
		store: new MemoryStore(),
		llm: {},
		clock: { now: () => 0 },
		sinks: { "mail-labels": { name: "mail-labels", write: async (input: any) => (written.push(input), { labeled: input.length, groups: 1 }) } },
	} as unknown as Caps;

	const messages = [
		{ id: "1", from: "prize@sketchy.tld", subject: "You WON the lottery! Claim your prize now" }, // junk -> proposed
		{ id: "2", from: "someone@randomcorp.example", subject: "Quick question" }, // unknown -> dropped
	];

	const out = await interpretDurable(registry["mail-triage-plan"](), messages, fakeStep(rec), caps, "root");

	expect(rec.events).toEqual(["ask:apply these label changes?"]);
	expect(written).toHaveLength(1);
	expect(written[0]).toEqual([{ id: "1", label: "junk", add: true, confidence: 0.9, reason: "spam-signal subject/body" }]);
	expect(out).toEqual([{ id: "1", label: "junk", add: true, confidence: 0.9, reason: "spam-signal subject/body" }]);
});

test("mail-triage-plan: a veto ({approved:false}) rejects the gate and never reaches the sink", async () => {
	const rec = { events: [] as string[] };
	const written: unknown[] = [];
	const caps = {
		store: new MemoryStore(),
		llm: {},
		clock: { now: () => 0 },
		sinks: { "mail-labels": { name: "mail-labels", write: async (input: any) => (written.push(input), input) } },
	} as unknown as Caps;

	const messages = [{ id: "1", from: "prize@sketchy.tld", subject: "You WON the lottery! Claim your prize now" }];

	await expect(interpretDurable(registry["mail-triage-plan"](), messages, fakeStep(rec, { approved: false }), caps, "root")).rejects.toThrow(AskRejectedError);
	expect(written).toHaveLength(0);
});
