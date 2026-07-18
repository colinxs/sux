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
import { getKindWeight } from "./fns/_learning";

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

	it("reject after commit throws and does not overwrite the committed record", async () => {
		const e = env();
		const p = await propose(e, { ...base, payload: { fn: "obsidian", args: {} } });
		await approveProposal(e, p.id);
		await expect(rejectProposal(e, p.id)).rejects.toThrow(/committed/);
		const list = await listProposals(e);
		expect(list.find((x) => x.id === p.id)?.status).toBe("committed");
	});

	it("double reject is a no-op and only records the learning signal once", async () => {
		const e = env();
		const before = await getKindWeight(e, "double_reject_kind");
		const p = await propose(e, { ...base, kind: "double_reject_kind", payload: { fn: "obsidian", args: {} } });
		await rejectProposal(e, p.id);
		const afterFirst = await getKindWeight(e, "double_reject_kind");
		expect(afterFirst).toBeLessThan(before);
		const second = await rejectProposal(e, p.id);
		expect(second.status).toBe("rejected");
		expect(await getKindWeight(e, "double_reject_kind")).toBe(afterFirst); // unchanged — no double-count
	});

	it("a successful approve raises the kind's learned weight, a reject lowers it (W8)", async () => {
		const e = env();
		const before = await getKindWeight(e, base.kind);
		const p = await propose(e, { ...base, payload: { fn: "obsidian", args: {} } });
		await approveProposal(e, p.id);
		expect(await getKindWeight(e, base.kind)).toBeGreaterThan(before);

		const p2 = await propose(e, { ...base, kind: "noisy_kind", payload: { fn: "obsidian", args: {} } });
		const beforeReject = await getKindWeight(e, "noisy_kind");
		await rejectProposal(e, p2.id);
		expect(await getKindWeight(e, "noisy_kind")).toBeLessThan(beforeReject);
	});

	it("a `failed` approve (fn returned isError) does NOT count as an approval learning signal", async () => {
		const e = env();
		const p = await propose(e, { ...base, kind: "flaky_kind", payload: { fn: "mail", args: { action: "archive" } } });
		await approveProposal(e, p.id);
		expect(await getKindWeight(e, "flaky_kind")).toBe(1); // neutral — not bumped by a failed run
	});

	it("snooze hides from the default list, shows with include_snoozed", async () => {
		const e = env();
		const p = await propose(e, { ...base, payload: { fn: "obsidian", args: {} } });
		await snoozeProposal(e, p.id);
		expect((await listProposals(e)).find((x) => x.id === p.id)).toBeUndefined();
		expect((await listProposals(e, { includeSnoozed: true })).find((x) => x.id === p.id)).toBeDefined();
	});

	it("double snooze is a no-op (idempotent)", async () => {
		const e = env();
		const p = await propose(e, { ...base, payload: { fn: "obsidian", args: {} } });
		const first = await snoozeProposal(e, p.id);
		const second = await snoozeProposal(e, p.id);
		expect(second.status).toBe("snoozed");
		expect(second.snoozedUntil).toBe(first.snoozedUntil);
	});

	it("snooze after commit/reject throws and does not overwrite the terminal record (#833)", async () => {
		const e = env();
		const committed = await propose(e, { ...base, payload: { fn: "obsidian", args: {} } });
		await approveProposal(e, committed.id);
		await expect(snoozeProposal(e, committed.id)).rejects.toThrow(/committed/);
		expect((await listProposals(e, { includeSnoozed: true })).find((x) => x.id === committed.id)?.status).toBe("committed");

		const rejected = await propose(e, { ...base, payload: { fn: "obsidian", args: {} } });
		await rejectProposal(e, rejected.id);
		await expect(snoozeProposal(e, rejected.id)).rejects.toThrow(/rejected/);
		expect((await listProposals(e, { includeSnoozed: true })).find((x) => x.id === rejected.id)?.status).toBe("rejected");
	});

	it("approve on an unknown/expired id throws", async () => {
		await expect(approveProposal(env(), "nope")).rejects.toThrow(/no proposal/);
	});

	it("strips force/confirm/commit_token from a proposal's stored payload args (#559)", async () => {
		const e = env();
		const p = await propose(e, {
			...base,
			payload: { fn: "obsidian", args: { action: "append", path: "x.md", force: true, confirm: true, commit_token: "abc" } },
		});
		expect(p.payload.args).toEqual({ action: "append", path: "x.md" });
		const done = await approveProposal(e, p.id);
		expect(JSON.parse(String(done.result)).got).toEqual({ action: "append", path: "x.md" });
	});

	it("also strips those keys at dispatch time, defending proposals stored before this stripping existed", async () => {
		const e = env();
		const legacy = {
			id: "legacy-1",
			source: "mail",
			kind: "archive_newsletters",
			intent: "x",
			payload: { fn: "obsidian", args: { action: "append", force: true } },
			reversible: true,
			stakes: "low",
			status: "proposed",
			createdAt: Date.now(),
			expiresAt: Date.now() + 1_000_000,
		};
		await e.OAUTH_KV.put("sux:proposal:legacy-1", JSON.stringify(legacy));
		const done = await approveProposal(e, "legacy-1");
		expect(JSON.parse(String(done.result)).got).toEqual({ action: "append" });
	});

	it("concurrent propose() calls both land in the index — neither silently drops the other (#846)", async () => {
		const e = env();
		const [p1, p2] = await Promise.all([
			propose(e, { ...base, kind: "race_a", payload: { fn: "obsidian", args: {} } }),
			propose(e, { ...base, kind: "race_b", payload: { fn: "mail", args: {} } }),
		]);
		const list = await listProposals(e);
		expect(list.map((x) => x.id).sort()).toEqual([p1.id, p2.id].sort());
	});

	it("concurrent approvals of the same proposal execute the payload only once", async () => {
		const e = env();
		const p = await propose(e, { ...base, payload: { fn: "obsidian", args: { action: "append", path: "x.md" } } });
		const { FUNCTIONS } = await import("./fns");
		const obsidianRun = FUNCTIONS.find((f: any) => f.name === "obsidian")!.run as ReturnType<typeof vi.fn>;
		obsidianRun.mockClear();
		const [a, b] = await Promise.all([approveProposal(e, p.id), approveProposal(e, p.id)]);
		expect(a.status).toBe("committed");
		expect(b.status).toBe("committed");
		expect(obsidianRun).toHaveBeenCalledTimes(1);
	});
});
