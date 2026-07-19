import { beforeEach, describe, expect, it, vi } from "vitest";
import { vault_consolidate_plan } from "./vault_consolidate_plan";

const runVerb = vi.fn();
vi.mock("./run", () => ({ runVerb: (...args: unknown[]) => runVerb(...args) }));

const fm = (extra: string): string => `---\n${extra}\n---\nbody`;

describe("vault_consolidate_plan", () => {
	beforeEach(() => {
		runVerb.mockReset();
	});

	it("is disabled unless CONSOLIDATE_ENABLED is set", async () => {
		const res = await vault_consolidate_plan.run({} as any, {});
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("CONSOLIDATE_ENABLED");
		expect(runVerb).not.toHaveBeenCalled();
	});

	it("lists+reads notes, finds duplicate clusters, and starts a durable run", async () => {
		const notes: Record<string, string> = {
			"Projects/project-alpha.md": fm("title: alpha"),
			"Archive/Project Alpha (2).md": fm("title: alpha 2"),
			"Projects/beta.md": fm("title: beta"),
		};
		vi.doMock("./obsidian", () => ({
			obsidian: {
				run: async (_env: any, a: any) => {
					if (a.action === "list") return { content: [{ type: "text", text: JSON.stringify({ notes: Object.keys(notes) }) }] };
					if (a.action === "read") return { content: [{ type: "text", text: notes[a.path] }] };
					throw new Error(`unexpected action ${a.action}`);
				},
			},
		}));
		vi.resetModules();
		const { vault_consolidate_plan: freshFn } = await import("./vault_consolidate_plan");
		runVerb.mockResolvedValueOnce({ instanceId: "abc123" });

		const res = await freshFn.run({ CONSOLIDATE_ENABLED: "1" } as any, {});

		expect(runVerb).toHaveBeenCalledTimes(1);
		const call = runVerb.mock.calls[0][0];
		expect(call.op).toBe("vault-consolidate-plan");
		expect(call.mode).toBe("durable");
		expect(call.input).toHaveLength(1);
		expect(call.input[0].key).toBe("project alpha");
		expect(new Set(call.input[0].paths)).toEqual(new Set(["Projects/project-alpha.md", "Archive/Project Alpha (2).md"]));
		expect(res.isError).toBeUndefined();
		const body = JSON.parse(res.content[0].text);
		expect(body).toMatchObject({ scanned: 3, candidates: 1, instanceId: "abc123" });
	});

	it("collapses a 3+ note duplicate group into ONE cluster instead of one per pair", async () => {
		const notes: Record<string, string> = {
			"Project.md": fm("title: project"),
			"Project (1).md": fm("title: project 1"),
			"Project (2).md": fm("title: project 2"),
		};
		vi.doMock("./obsidian", () => ({
			obsidian: {
				run: async (_env: any, a: any) => {
					if (a.action === "list") return { content: [{ type: "text", text: JSON.stringify({ notes: Object.keys(notes) }) }] };
					if (a.action === "read") return { content: [{ type: "text", text: notes[a.path] }] };
					throw new Error(`unexpected action ${a.action}`);
				},
			},
		}));
		vi.resetModules();
		const { vault_consolidate_plan: freshFn } = await import("./vault_consolidate_plan");
		runVerb.mockResolvedValueOnce({ instanceId: "grp1" });

		const res = await freshFn.run({ CONSOLIDATE_ENABLED: "1" } as any, {});

		expect(runVerb).toHaveBeenCalledTimes(1);
		const call = runVerb.mock.calls[0][0];
		expect(call.input).toHaveLength(1); // one cluster for the whole group, not 3 pairs
		expect(new Set(call.input[0].paths)).toEqual(new Set(Object.keys(notes)));
		const body = JSON.parse(res.content[0].text);
		expect(body).toMatchObject({ scanned: 3, candidates: 1, instanceId: "grp1" });
	});

	it("skips starting a run when there are no duplicate candidates", async () => {
		const notes: Record<string, string> = { "A.md": fm("title: a"), "B.md": fm("title: b") };
		vi.doMock("./obsidian", () => ({
			obsidian: {
				run: async (_env: any, a: any) => {
					if (a.action === "list") return { content: [{ type: "text", text: JSON.stringify({ notes: Object.keys(notes) }) }] };
					if (a.action === "read") return { content: [{ type: "text", text: notes[a.path] }] };
					throw new Error(`unexpected action ${a.action}`);
				},
			},
		}));
		vi.resetModules();
		const { vault_consolidate_plan: freshFn } = await import("./vault_consolidate_plan");

		const res = await freshFn.run({ CONSOLIDATE_ENABLED: "1" } as any, {});

		expect(runVerb).not.toHaveBeenCalled();
		const body = JSON.parse(res.content[0].text);
		expect(body).toEqual({ scanned: 2, candidates: 0, note: "no duplicate candidates found — nothing to merge" });
	});

	it("reads in bounded batches without dropping notes past the first batch", async () => {
		const notes: Record<string, string> = {};
		for (let i = 0; i < 25; i++) notes[`Note${i}.md`] = fm(`title: note ${i}`); // > READ_CONCURRENCY (20)
		vi.doMock("./obsidian", () => ({
			obsidian: {
				run: async (_env: any, a: any) => {
					if (a.action === "list") return { content: [{ type: "text", text: JSON.stringify({ notes: Object.keys(notes) }) }] };
					if (a.action === "read") return { content: [{ type: "text", text: notes[a.path] }] };
					throw new Error(`unexpected action ${a.action}`);
				},
			},
		}));
		vi.resetModules();
		const { vault_consolidate_plan: freshFn } = await import("./vault_consolidate_plan");

		const res = await freshFn.run({ CONSOLIDATE_ENABLED: "1" } as any, {});

		expect(runVerb).not.toHaveBeenCalled();
		const body = JSON.parse(res.content[0].text);
		expect(body).toMatchObject({ scanned: 25, candidates: 0 });
	});

	it("surfaces a vault list failure as an upstream_error", async () => {
		vi.doMock("./obsidian", () => ({
			obsidian: {
				run: async (_env: any, a: any) => {
					if (a.action === "list") return { isError: true, content: [{ type: "text", text: "vault down" }] };
					throw new Error(`unexpected action ${a.action}`);
				},
			},
		}));
		vi.resetModules();
		const { vault_consolidate_plan: freshFn } = await import("./vault_consolidate_plan");

		const res = await freshFn.run({ CONSOLIDATE_ENABLED: "1" } as any, {});

		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("vault down");
	});
});
