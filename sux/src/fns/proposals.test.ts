import { describe, expect, it, vi } from "vitest";

vi.mock("../fns", () => ({
	FUNCTIONS: [{ name: "obsidian", description: "", inputSchema: {}, run: vi.fn(async (_e: any, a: any) => ({ content: [{ type: "text", text: JSON.stringify({ ran: "obsidian", got: a }) }] })) }],
}));

import { proposals } from "./proposals";
import { propose, approveProposal, rejectProposal } from "../proposals";

function kvStub() {
	const map = new Map<string, string>();
	return { map, get: vi.fn(async (k: string) => map.get(k) ?? null), put: vi.fn(async (k: string, v: string) => void map.set(k, v)), delete: vi.fn(async (k: string) => void map.delete(k)) };
}
const env = () => ({ OAUTH_KV: kvStub() }) as any;
const base = { source: "mail", kind: "archive_newsletters", intent: "Archive 3 newsletters", reversible: true as const, stakes: "low" as const };

const text = (r: any) => JSON.parse(r.content[0].text);

describe("proposals fn — insights (W8)", () => {
	it("reports a learned weight per kind that has been approved/rejected", async () => {
		const e = env();
		const p1 = await propose(e, { ...base, payload: { fn: "obsidian", args: {} } });
		await approveProposal(e, p1.id);
		const p2 = await propose(e, { ...base, kind: "unanswered", payload: { fn: "obsidian", args: {} } });
		await rejectProposal(e, p2.id);

		const r = await proposals.run(e, { action: "insights" });
		expect(r.isError).toBeFalsy();
		const body = text(r);
		const byKind = Object.fromEntries(body.kinds.map((k: any) => [k.kind, k]));
		expect(byKind.archive_newsletters.weight).toBeGreaterThan(1);
		expect(byKind.unanswered.weight).toBeLessThan(1);
	});

	it("insights on an empty queue returns an empty list, never errors", async () => {
		const r = await proposals.run(env(), { action: "insights" });
		expect(r.isError).toBeFalsy();
		expect(text(r).count).toBe(0);
	});
});
