import { describe, expect, it, vi } from "vitest";

// approveProposal dispatches the payload fn via `await import("./fns")` (proposals.ts) —
// same barrel as sux/src/fns/index.ts, mocked the same way _agenda_reply.test.ts does.
vi.mock("./index", () => ({
	FUNCTIONS: [{ name: "todoist", description: "", inputSchema: {}, run: vi.fn(async (_e: any, a: any) => ({ content: [{ type: "text", text: JSON.stringify({ ran: "todoist", got: a }) }] })) }],
}));

import { type ImessageMessageRef, type ImessageReplyDeps, type ImessageThreadRef, normalizeHandle, runImessageReply, trustedHandles } from "./_imessage_reply";
import { listProposals, propose } from "../proposals";

function kvStub() {
	const map = new Map<string, string>();
	return { map, get: vi.fn(async (k: string) => map.get(k) ?? null), put: vi.fn(async (k: string, v: string) => void map.set(k, v)), delete: vi.fn(async (k: string) => void map.delete(k)) };
}
const TRUSTED = "+15551234567";
const env = (extra: Record<string, unknown> = {}) => ({ AGENDA_ENABLED: "1", IMESSAGE_REPLY_ENABLED: "1", IMESSAGE_TRUSTED_HANDLES: TRUSTED, VAULT_TZ: "UTC", OAUTH_KV: kvStub(), ...extra }) as any;

const deps = (threads: ImessageThreadRef[], messagesByThread: Record<string, ImessageMessageRef[]>, over: Partial<ImessageReplyDeps> = {}): ImessageReplyDeps => ({
	threads: vi.fn(async () => threads),
	messages: vi.fn(async (_e, o) => messagesByThread[o.thread] ?? []),
	send: vi.fn(async () => {}),
	...over,
});

describe("imessage_reply — handle matching", () => {
	it("normalizes phone-number formatting differences", () => {
		expect(normalizeHandle("+1 (555) 123-4567")).toBe(normalizeHandle("+15551234567"));
	});

	it("trustedHandles parses a comma-separated, normalized allow-list", () => {
		const set = trustedHandles(env({ IMESSAGE_TRUSTED_HANDLES: "+1 (555) 123-4567, colin@example.com" }));
		expect(set.has(normalizeHandle("+15551234567"))).toBe(true);
		expect(set.has("colin@example.com")).toBe(true);
	});

	it("is empty when unset", () => {
		expect(trustedHandles(env({ IMESSAGE_TRUSTED_HANDLES: undefined })).size).toBe(0);
	});
});

describe("imessage_reply — loop", () => {
	it("is dormant unless IMESSAGE_REPLY_ENABLED (and AGENDA_ENABLED and a trusted handle)", async () => {
		const r1 = await runImessageReply({ VAULT_TZ: "UTC", OAUTH_KV: kvStub() } as any, {}, deps([], {}));
		expect(r1.dormant).toBe(true);
		const r2 = await runImessageReply(env({ AGENDA_ENABLED: "0" }), {}, deps([], {}));
		expect(r2.dormant).toBe(true);
		const r3 = await runImessageReply(env({ IMESSAGE_TRUSTED_HANDLES: "" }), {}, deps([], {}));
		expect(r3.dormant).toBe(true);
	});

	it("approves + rejects proposals named by a trusted-contact text, then confirms", async () => {
		const e = env();
		const p1 = await propose(e, { source: "agenda", kind: "bill_due", intent: "pay the thing", payload: { fn: "todoist", args: { action: "add", content: "pay" } }, reversible: true, stakes: "low" });
		const p2 = await propose(e, { source: "agenda", kind: "rx_ready", intent: "pick up rx", payload: { fn: "todoist", args: { action: "add", content: "rx" } }, reversible: true, stakes: "low" });
		const short = (id: string) => id.slice(0, 8);
		const threads: ImessageThreadRef[] = [{ id: "t1", contact: TRUSTED, name: "Colin" }];
		const msgs: ImessageMessageRef[] = [{ id: "m1", from_me: false, handle: TRUSTED, text: `approve ${short(p1.id)} reject ${short(p2.id)}`, at: "2026-07-19T00:00:00Z" }];
		const d = deps(threads, { t1: msgs });
		const r = await runImessageReply(e, {}, d);
		expect(r.approved).toEqual([p1.id]);
		expect(r.rejected).toEqual([p2.id]);
		expect(d.send).toHaveBeenCalledTimes(1);
		const [, sendOpts] = (d.send as any).mock.calls[0];
		expect(sendOpts.to).toBe(TRUSTED);
		expect(sendOpts.text).toContain("approved");
		expect(sendOpts.text).toContain("rejected");
		const live = await listProposals(e, { includeSnoozed: true });
		const byId = Object.fromEntries(live.map((p) => [p.id, p.status]));
		expect(byId[p1.id]).toBe("committed");
		expect(byId[p2.id]).toBe("rejected");
	});

	it("snoozes with a parsed duration", async () => {
		const e = env();
		const p = await propose(e, { source: "agenda", kind: "bill_due", intent: "pay the thing", payload: { fn: "todoist", args: { action: "add", content: "pay" } }, reversible: true, stakes: "low" });
		const threads: ImessageThreadRef[] = [{ id: "t1", contact: TRUSTED }];
		const msgs: ImessageMessageRef[] = [{ id: "m1", from_me: false, text: `snooze ${p.id.slice(0, 8)} 3d`, at: "2026-07-19T00:00:00Z" }];
		const before = Date.now();
		const r = await runImessageReply(e, {}, deps(threads, { t1: msgs }));
		expect(r.snoozed).toEqual([p.id]);
		const [live] = await listProposals(e, { includeSnoozed: true });
		expect(live.status).toBe("snoozed");
		expect(live.snoozedUntil).toBeGreaterThanOrEqual(before + 3 * 86_400_000 - 5000);
	});

	it("ignores texts from an untrusted contact's thread", async () => {
		const e = env();
		const p = await propose(e, { source: "agenda", kind: "bill_due", intent: "pay", payload: { fn: "todoist", args: { action: "add", content: "pay" } }, reversible: true, stakes: "low" });
		const threads: ImessageThreadRef[] = [{ id: "t1", contact: "+19995550000" }];
		const msgs: ImessageMessageRef[] = [{ id: "m1", from_me: false, text: `approve ${p.id.slice(0, 8)}`, at: "2026-07-19T00:00:00Z" }];
		const d = deps(threads, { t1: msgs });
		const r = await runImessageReply(e, {}, d);
		expect(r.untrusted_threads).toBe(1);
		expect(r.approved).toEqual([]);
		expect(d.send).not.toHaveBeenCalled();
		const [live] = await listProposals(e, { includeSnoozed: true });
		expect(live.status).toBe("proposed"); // untouched
	});

	it("ignores sux's own outbound messages (from_me) even on a trusted thread", async () => {
		const e = env();
		const p = await propose(e, { source: "agenda", kind: "bill_due", intent: "pay", payload: { fn: "todoist", args: { action: "add", content: "pay" } }, reversible: true, stakes: "low" });
		const threads: ImessageThreadRef[] = [{ id: "t1", contact: TRUSTED }];
		const msgs: ImessageMessageRef[] = [{ id: "m1", from_me: true, text: `approve ${p.id.slice(0, 8)}`, at: "2026-07-19T00:00:00Z" }];
		const r = await runImessageReply(e, {}, deps(threads, { t1: msgs }));
		expect(r.approved).toEqual([]);
		expect(r.processed ?? 0).toBe(0);
	});

	it("an unresolved / ambiguous short id is reported, never thrown", async () => {
		const e = env();
		const threads: ImessageThreadRef[] = [{ id: "t1", contact: TRUSTED }];
		const msgs: ImessageMessageRef[] = [{ id: "m1", from_me: false, text: "approve ffffffff", at: "2026-07-19T00:00:00Z" }];
		const r = await runImessageReply(e, {}, deps(threads, { t1: msgs }));
		expect(r.unresolved).toEqual(["ffffffff"]);
	});

	it("is idempotent — a re-scanned message is never reprocessed", async () => {
		const e = env();
		const p = await propose(e, { source: "agenda", kind: "bill_due", intent: "pay", payload: { fn: "todoist", args: { action: "add", content: "pay" } }, reversible: true, stakes: "low" });
		const threads: ImessageThreadRef[] = [{ id: "t1", contact: TRUSTED }];
		const msgs: ImessageMessageRef[] = [{ id: "m1", from_me: false, text: `approve ${p.id.slice(0, 8)}`, at: "2026-07-19T00:00:00Z" }];
		const d = deps(threads, { t1: msgs });
		await runImessageReply(e, {}, d);
		const second = await runImessageReply(e, {}, d);
		expect(second.approved).toEqual([]);
		expect(second.processed).toBe(0);
	});

	it("ignores prose with no command tokens (marks it seen, no confirmation sent)", async () => {
		const e = env();
		const threads: ImessageThreadRef[] = [{ id: "t1", contact: TRUSTED }];
		const msgs: ImessageMessageRef[] = [{ id: "m1", from_me: false, text: "hey are we still on for dinner?", at: "2026-07-19T00:00:00Z" }];
		const d = deps(threads, { t1: msgs });
		const r = await runImessageReply(e, {}, d);
		expect(r.processed).toBe(0);
		expect(d.send).not.toHaveBeenCalled();
	});
});
