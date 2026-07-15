import { describe, expect, it, vi } from "vitest";

// Mock the fn registry the kernel dispatches into on approve — two stub allow-listed
// fns: `obsidian` returns ok (→ committed), `mail` returns isError (→ failed). The
// kernel's runProposalFn does `await import("./fns")`, which vitest intercepts here.
vi.mock("./fns", () => ({
	FUNCTIONS: [
		{ name: "obsidian", description: "", inputSchema: {}, run: vi.fn(async (_e: any, a: any) => ({ content: [{ type: "text", text: JSON.stringify({ ran: "obsidian", got: a }) }] })) },
		{ name: "mail", description: "", inputSchema: {}, run: vi.fn(async () => ({ isError: true, content: [{ type: "text", text: "[not_configured] no token" }] })) },
	],
}));

import { approveProposal, listProposals, propose, rejectProposal, snoozeProposal } from "./proposals";

function kvStub() {
	const map = new Map<string, string>();
	return { map, get: vi.fn(async (k: string) => map.get(k) ?? null), put: vi.fn(async (k: string, v: string) => void map.set(k, v)), delete: vi.fn(async (k: string) => void map.delete(k)) };
}
const env = () => ({ OAUTH_KV: kvStub() }) as any;
const base = { source: "mail", kind: "archive_newsletters", intent: "Archive 3 newsletters", reversible: true as const, stakes: "low" as const };

describe("proposal kernel", () => {
	it("propose refuses a fn not on the allow-list (fail-closed lock #1)", async () => {
		await expect(propose(env(), { ...base, payload: { fn: "shell", args: {} } })).rejects.toThrow(/allow-list/);
	});

	it("propose refuses a non-reversible proposal (lock #2)", async () => {
		await expect(propose(env(), { ...base, reversible: false as any, payload: { fn: "mail", args: {} } })).rejects.toThrow(/reversible/);
	});

	it("propose records and list returns newest-first, projected", async () => {
		const e = env();
		const p1 = await propose(e, { ...base, payload: { fn: "obsidian", args: { action: "append" } } });
		const p2 = await propose(e, { ...base, kind: "file_receipt", payload: { fn: "mail", args: { action: "archive" } } });
		const list = await listProposals(e);
		expect(list.map((x) => x.id)).toEqual([p2.id, p1.id]);
		expect(list[0]).toMatchObject({ status: "proposed", source: "mail", kind: "file_receipt" });
	});

	it("approve runs the allow-listed fn and marks committed (idempotent)", async () => {
		const e = env();
		const p = await propose(e, { ...base, payload: { fn: "obsidian", args: { action: "append", path: "x.md" } } });
		const done = await approveProposal(e, p.id);
		expect(done.status).toBe("committed");
		expect(String(done.result)).toContain("obsidian");
		expect((await approveProposal(e, p.id)).status).toBe("committed"); // idempotent
	});

	it("approve records `failed` when the fn returns isError (never throws through)", async () => {
		const e = env();
		const p = await propose(e, { ...base, payload: { fn: "mail", args: { action: "archive" } } });
		const done = await approveProposal(e, p.id);
		expect(done.status).toBe("failed");
		expect(String(done.result)).toContain("not_configured");
	});

	it("reject records the disposition; approve after reject throws (learning-signal preserved)", async () => {
		const e = env();
		const p = await propose(e, { ...base, payload: { fn: "obsidian", args: {} } });
		expect((await rejectProposal(e, p.id)).status).toBe("rejected");
		await expect(approveProposal(e, p.id)).rejects.toThrow(/rejected/);
	});

	it("snooze hides from the default list, shows with include_snoozed", async () => {
		const e = env();
		const p = await propose(e, { ...base, payload: { fn: "obsidian", args: {} } });
		await snoozeProposal(e, p.id);
		expect((await listProposals(e)).find((x) => x.id === p.id)).toBeUndefined();
		expect((await listProposals(e, { includeSnoozed: true })).find((x) => x.id === p.id)).toBeDefined();
	});

	it("approve on an unknown/expired id throws", async () => {
		await expect(approveProposal(env(), "nope")).rejects.toThrow(/no proposal/);
	});
});
