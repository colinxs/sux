import { beforeEach, describe, expect, it, vi } from "vitest";
import { contact_consolidate_plan } from "./contact_consolidate_plan";

const runVerb = vi.fn();
vi.mock("./run", () => ({ runVerb: (...args: unknown[]) => runVerb(...args) }));

describe("contact_consolidate_plan", () => {
	beforeEach(() => {
		runVerb.mockReset();
	});

	it("is disabled unless CONTACT_CONSOLIDATE_ENABLED is set", async () => {
		const res = await contact_consolidate_plan.run({} as any, {});
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("CONTACT_CONSOLIDATE_ENABLED");
		expect(runVerb).not.toHaveBeenCalled();
	});

	it("searches contacts, finds duplicate clusters, and starts a durable run", async () => {
		const contacts = [
			{ id: "1", name: "Ada Lovelace", emails: ["ada@example.com"], phones: [] },
			{ id: "2", name: "Ada L", emails: ["ada@example.com"], phones: [] },
			{ id: "3", name: "Bob Smith", emails: ["bob@example.com"], phones: [] },
		];
		vi.doMock("./contact", () => ({
			contact: {
				run: async (_env: any, a: any) => {
					if (a.action === "search") return { content: [{ type: "text", text: JSON.stringify({ count: contacts.length, contacts }) }] };
					throw new Error(`unexpected action ${a.action}`);
				},
			},
		}));
		vi.resetModules();
		const { contact_consolidate_plan: freshFn } = await import("./contact_consolidate_plan");
		runVerb.mockResolvedValueOnce({ instanceId: "abc123" });

		const res = await freshFn.run({ CONTACT_CONSOLIDATE_ENABLED: "1" } as any, {});

		expect(runVerb).toHaveBeenCalledTimes(1);
		const call = runVerb.mock.calls[0][0];
		expect(call.op).toBe("contacts-consolidate-plan");
		expect(call.mode).toBe("durable");
		expect(call.input).toHaveLength(1);
		expect(new Set(call.input[0].ids)).toEqual(new Set(["1", "2"]));
		expect(res.isError).toBeUndefined();
		const body = JSON.parse(res.content[0].text);
		expect(body).toMatchObject({ scanned: 3, candidates: 1, instanceId: "abc123" });
	});

	it("skips starting a run when there are no duplicate candidates", async () => {
		const contacts = [
			{ id: "1", name: "Ada Lovelace", emails: ["ada@example.com"], phones: [] },
			{ id: "2", name: "Bob Smith", emails: ["bob@example.com"], phones: [] },
		];
		vi.doMock("./contact", () => ({
			contact: { run: async (_env: any, a: any) => (a.action === "search" ? { content: [{ type: "text", text: JSON.stringify({ count: contacts.length, contacts }) }] } : Promise.reject(new Error("unexpected"))) },
		}));
		vi.resetModules();
		const { contact_consolidate_plan: freshFn } = await import("./contact_consolidate_plan");

		const res = await freshFn.run({ CONTACT_CONSOLIDATE_ENABLED: "1" } as any, {});

		expect(runVerb).not.toHaveBeenCalled();
		const body = JSON.parse(res.content[0].text);
		expect(body).toEqual({ scanned: 2, position: 0, total: 2, candidates: 0, note: "no duplicate candidates found — nothing to merge" });
	});

	it("pages a larger address book: passes `position` through to contact_search and surfaces next_position from its total", async () => {
		const contacts = [{ id: "1", name: "Ada Lovelace", emails: ["ada@example.com"], phones: [] }];
		const searchArgs: unknown[] = [];
		vi.doMock("./contact", () => ({
			contact: {
				run: async (_env: any, a: any) => {
					searchArgs.push(a);
					return { content: [{ type: "text", text: JSON.stringify({ count: contacts.length, total: 150, contacts }) }] };
				},
			},
		}));
		vi.resetModules();
		const { contact_consolidate_plan: freshFn } = await import("./contact_consolidate_plan");

		const res = await freshFn.run({ CONTACT_CONSOLIDATE_ENABLED: "1" } as any, { position: 100, max: 1 });

		expect(searchArgs[0]).toMatchObject({ action: "search", limit: 1, position: 100 });
		expect(runVerb).not.toHaveBeenCalled();
		const body = JSON.parse(res.content[0].text);
		expect(body).toEqual({ scanned: 1, position: 100, total: 150, next_position: 101, candidates: 0, note: "no duplicate candidates found — nothing to merge" });
	});

	it("surfaces a contact search failure as an upstream_error", async () => {
		vi.doMock("./contact", () => ({
			contact: { run: async (_env: any, a: any) => (a.action === "search" ? { isError: true, content: [{ type: "text", text: "JMAP down" }] } : Promise.reject(new Error("unexpected"))) },
		}));
		vi.resetModules();
		const { contact_consolidate_plan: freshFn } = await import("./contact_consolidate_plan");

		const res = await freshFn.run({ CONTACT_CONSOLIDATE_ENABLED: "1" } as any, {});

		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("JMAP down");
	});
});
