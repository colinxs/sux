import { test, expect, vi } from "vitest";
import { listDurableRuns, runVerb } from "./run.js";

// A minimal in-memory KVNamespace — just enough of put/get/list for the run index.
function fakeKv() {
	const store = new Map<string, string>();
	return {
		put: async (key: string, value: string) => {
			store.set(key, value);
		},
		get: async (key: string) => store.get(key) ?? null,
		list: async ({ prefix }: { prefix: string }) => ({
			keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
			list_complete: true,
			cursor: undefined,
		}),
	} as any;
}

// A fake OP_WORKFLOW binding whose create() mints incrementing ids and whose get(id)
// resolves a fixed status — enough to exercise indexing + list's status enrichment.
function fakeWorkflow(status: string) {
	let n = 0;
	return {
		create: async () => ({ id: `instance-${++n}` }),
		get: async (id: string) => ({ id, status: async () => ({ status }) }),
	} as any;
}

// The inline path needs no bindings (echo is a pure leaf), so an empty env exercises
// the whole runVerb → runInline → op path in plain node vitest.
test("run executes a registered op inline", async () => {
	const res = await runVerb({ op: "echo", input: "hi", mode: "inline" }, {} as any);
	expect(res).toBe("hi");
});

test("run auto-routes a simple (no fan-out / no ask) op to the inline path", async () => {
	const res = await runVerb({ op: "echo", input: { a: 1 }, mode: "auto" }, {} as any);
	expect(res).toEqual({ a: 1 });
});

test("run rejects an unknown op", async () => {
	await expect(runVerb({ op: "nope", input: 1, mode: "inline" }, {} as any)).rejects.toThrow(/unknown op/);
});

test("a durable run gets indexed in KV, and listDurableRuns surfaces it with live status", async () => {
	const env = { OAUTH_KV: fakeKv(), OP_WORKFLOW: fakeWorkflow("waiting") } as any;
	const { instanceId } = await runVerb({ op: "assimilate-pdfs", input: {}, mode: "durable" }, env);

	const runs = await listDurableRuns(env);
	expect(runs).toHaveLength(1);
	expect(runs[0]).toMatchObject({ instanceId, opId: "assimilate-pdfs", status: "waiting" });
	expect(runs[0].startedAt).toBeGreaterThan(0);
});

test("listDurableRuns returns the newest run first and reports 'unknown' when a status lookup fails", async () => {
	const kv = fakeKv();
	const workflow = {
		create: async () => ({ id: `run-${Date.now()}` }),
		get: async (id: string) => {
			if (id === "run-100") throw new Error("instance aged past retention");
			return { id, status: async () => ({ status: "complete" }) };
		},
	} as any;
	const env = { OAUTH_KV: kv, OP_WORKFLOW: workflow } as any;

	const now = vi.spyOn(Date, "now");
	now.mockReturnValue(100);
	await runVerb({ op: "assimilate-pdfs", input: {}, mode: "durable" }, env); // run-100, older
	now.mockReturnValue(200);
	await runVerb({ op: "assimilate-pdfs", input: {}, mode: "durable" }, env); // run-200, newer
	now.mockRestore();

	const runs = await listDurableRuns(env);
	expect(runs.map((r) => r.instanceId)).toEqual(["run-200", "run-100"]);
	expect(runs[0].status).toBe("complete");
	expect(runs[1].status).toBe("unknown");
});
