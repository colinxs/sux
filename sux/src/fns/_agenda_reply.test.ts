import { describe, expect, it, vi } from "vitest";

// The proposal kernel's approveProposal dispatches the payload fn via `await
// import("./fns")` (proposals.ts) — same barrel as sux/src/fns/index.ts, mocked here the
// same way proposals.test.ts does, with a `todoist` stub standing in for the real fn
// (which needs a TODOIST_TOKEN this test env doesn't have).
vi.mock("./index", () => ({
	FUNCTIONS: [{ name: "todoist", description: "", inputSchema: {}, run: vi.fn(async (_e: any, a: any) => ({ content: [{ type: "text", text: JSON.stringify({ ran: "todoist", got: a }) }] })) }],
}));

import { type AgendaReplyDeps, durationMs, extractEmail, looksLikeDigestReply, parseCommands, resolveShortId, runAgendaReply } from "./_agenda_reply";
import { listProposals, propose } from "../proposals";
import type { MailRef } from "./_agenda";

function kvStub() {
	const map = new Map<string, string>();
	return { map, get: vi.fn(async (k: string) => map.get(k) ?? null), put: vi.fn(async (k: string, v: string) => void map.set(k, v)), delete: vi.fn(async (k: string) => void map.delete(k)) };
}
const env = (extra: Record<string, unknown> = {}) => ({ AGENDA_ENABLED: "1", AGENDA_REPLY_ENABLED: "1", VAULT_TZ: "UTC", OAUTH_KV: kvStub(), ...extra }) as any;

const SELF = "colin@example.com";
const deps = (mail: MailRef[], over: Partial<AgendaReplyDeps> = {}): AgendaReplyDeps => ({
	mailSearch: vi.fn(async () => mail),
	identities: vi.fn(async () => [SELF]),
	...over,
});

describe("agenda_reply — command grammar", () => {
	it("parses approve with multiple ids", () => {
		const cmds = parseCommands("approve 1a2b3c4d 5e6f7a8b thanks");
		expect(cmds).toEqual([{ verb: "approve", ids: ["1a2b3c4d", "5e6f7a8b"] }]);
	});

	it("parses snooze with a duration", () => {
		const cmds = parseCommands("snooze 1a2b3c4d 3d please");
		expect(cmds).toEqual([{ verb: "snooze", ids: ["1a2b3c4d"], duration: { n: 3, unit: "d" } }]);
	});

	it("parses multiple commands in one message, case-insensitively", () => {
		const cmds = parseCommands("Approve 1a2b3c4d\nREJECT 5e6f7a8b — not this one");
		expect(cmds).toEqual([
			{ verb: "approve", ids: ["1a2b3c4d"] },
			{ verb: "reject", ids: ["5e6f7a8b"] },
		]);
	});

	it("ignores prose with no command tokens", () => {
		expect(parseCommands("Thanks for the heads up, I'll deal with it later.")).toEqual([]);
	});

	it("strips trailing punctuation off ids", () => {
		expect(parseCommands("approve 1a2b3c4d.")).toEqual([{ verb: "approve", ids: ["1a2b3c4d"] }]);
	});
});

describe("agenda_reply — auth heuristics", () => {
	it("recognizes a digest reply subject under any number of Re:/Fwd: hops", () => {
		expect(looksLikeDigestReply("sux · 3 things need you (2026-07-13)")).toBe(true);
		expect(looksLikeDigestReply("Re: sux · 3 things need you (2026-07-13)")).toBe(true);
		expect(looksLikeDigestReply("Fwd: Re: sux · 3 things need you (2026-07-13)")).toBe(true);
		expect(looksLikeDigestReply("Re: your prescription is ready")).toBe(false);
	});

	it("extracts the bare address from a display-name From header", () => {
		expect(extractEmail(`"Colin" <${SELF}>`)).toBe(SELF);
		expect(extractEmail(SELF)).toBe(SELF);
	});

	it("resolveShortId: unique prefix, ambiguous, and not-found", () => {
		const open = [{ id: "1a2b3c4d5e6f" }, { id: "1a2b3c999999" }, { id: "abcdefabcdef" }];
		expect(resolveShortId(open, "abcdef")).toBe("abcdefabcdef");
		expect(resolveShortId(open, "1a2b3c")).toBe("ambiguous");
		expect(resolveShortId(open, "ffffff")).toBeUndefined();
	});

	it("durationMs converts h/d/w, defaulting unknown units to a day", () => {
		expect(durationMs(2, "h")).toBe(2 * 3_600_000);
		expect(durationMs(3, "d")).toBe(3 * 86_400_000);
		expect(durationMs(1, "w")).toBe(7 * 86_400_000);
	});
});

describe("agenda_reply — loop", () => {
	it("is dormant unless AGENDA_REPLY_ENABLED (and AGENDA_ENABLED)", async () => {
		const r1 = await runAgendaReply({ VAULT_TZ: "UTC", OAUTH_KV: kvStub() } as any, {}, deps([]));
		expect(r1.dormant).toBe(true);
		const r2 = await runAgendaReply(env({ AGENDA_ENABLED: "0" }), {}, deps([]));
		expect(r2.dormant).toBe(true);
	});

	it("approves + rejects proposals named by a trusted digest-reply", async () => {
		const e = env();
		const p1 = await propose(e, { source: "agenda", kind: "bill_due", intent: "pay the thing", payload: { fn: "todoist", args: { action: "add", content: "pay" } }, reversible: true, stakes: "low" });
		const p2 = await propose(e, { source: "agenda", kind: "rx_ready", intent: "pick up rx", payload: { fn: "todoist", args: { action: "add", content: "rx" } }, reversible: true, stakes: "low" });
		const short = (id: string) => id.slice(0, 8);
		const mail: MailRef[] = [{ id: "m1", from: `"Colin" <${SELF}>`, subject: "Re: sux · 2 things need you (2026-07-13)", preview: `approve ${short(p1.id)} reject ${short(p2.id)}` }];
		const r = await runAgendaReply(e, {}, deps(mail));
		expect(r.approved).toEqual([p1.id]);
		expect(r.rejected).toEqual([p2.id]);
		const live = await listProposals(e, { includeSnoozed: true });
		const byId = Object.fromEntries(live.map((p) => [p.id, p.status]));
		expect(byId[p1.id]).toBe("committed");
		expect(byId[p2.id]).toBe("rejected");
	});

	it("snoozes with a parsed duration", async () => {
		const e = env();
		const p = await propose(e, { source: "agenda", kind: "bill_due", intent: "pay the thing", payload: { fn: "todoist", args: { action: "add", content: "pay" } }, reversible: true, stakes: "low" });
		const mail: MailRef[] = [{ id: "m1", from: SELF, subject: "sux · 1 thing needs you (2026-07-13)", preview: `snooze ${p.id.slice(0, 8)} 3d` }];
		const before = Date.now();
		const r = await runAgendaReply(e, {}, deps(mail));
		expect(r.snoozed).toEqual([p.id]);
		const [live] = await listProposals(e, { includeSnoozed: true });
		expect(live.status).toBe("snoozed");
		expect(live.snoozedUntil).toBeGreaterThanOrEqual(before + 3 * 86_400_000 - 5000);
	});

	it("ignores commands from a sender that isn't a verified identity", async () => {
		const e = env();
		const p = await propose(e, { source: "agenda", kind: "bill_due", intent: "pay", payload: { fn: "todoist", args: { action: "add", content: "pay" } }, reversible: true, stakes: "low" });
		const mail: MailRef[] = [{ id: "m1", from: "spammer@evil.example", subject: "Re: sux · 1 thing needs you (2026-07-13)", preview: `approve ${p.id.slice(0, 8)}` }];
		const r = await runAgendaReply(e, {}, deps(mail));
		expect(r.untrusted).toBe(1);
		expect(r.approved).toEqual([]);
		const [live] = await listProposals(e, { includeSnoozed: true });
		expect(live.status).toBe("proposed"); // untouched
	});

	it("ignores commands from a verified sender whose subject isn't a digest reply", async () => {
		const e = env();
		const p = await propose(e, { source: "agenda", kind: "bill_due", intent: "pay", payload: { fn: "todoist", args: { action: "add", content: "pay" } }, reversible: true, stakes: "low" });
		const mail: MailRef[] = [{ id: "m1", from: SELF, subject: "Re: dinner tonight?", preview: `approve ${p.id.slice(0, 8)}` }];
		const r = await runAgendaReply(e, {}, deps(mail));
		expect(r.not_a_reply).toBe(1);
		expect(r.approved).toEqual([]);
	});

	it("an unresolved / ambiguous short id is reported, never thrown", async () => {
		const e = env();
		const mail: MailRef[] = [{ id: "m1", from: SELF, subject: "sux · nothing pressing (2026-07-13)", preview: "approve ffffffff" }];
		const r = await runAgendaReply(e, {}, deps(mail));
		expect(r.unresolved).toEqual(["ffffffff"]);
	});

	it("is idempotent — a re-scanned message is never reprocessed", async () => {
		const e = env();
		const p = await propose(e, { source: "agenda", kind: "bill_due", intent: "pay", payload: { fn: "todoist", args: { action: "add", content: "pay" } }, reversible: true, stakes: "low" });
		const mail: MailRef[] = [{ id: "m1", from: SELF, subject: "Re: sux · 1 thing needs you (2026-07-13)", preview: `approve ${p.id.slice(0, 8)}` }];
		const d = deps(mail);
		await runAgendaReply(e, {}, d);
		const second = await runAgendaReply(e, {}, d);
		expect(second.approved).toEqual([]);
		expect(second.processed).toBe(0);
	});
});
