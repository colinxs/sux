import { test, expect, vi } from "vitest";
import { ask, catchOp, cond, fixed, map, mapField, op, parallel } from "@suxos/lib";
import { answerVerb, cancelVerb, collectAskGates, describeOp, listDurableRuns, needsDurable, run, runVerb, statusVerb } from "./run.js";

// A minimal in-memory KVNamespace — just enough of put/get/list for the run index.
// Records the opts each put() was called with so tests can assert on expirationTtl.
function fakeKv() {
	const store = new Map<string, string>();
	const putCalls: Array<{ key: string; opts?: { expirationTtl?: number } }> = [];
	return {
		put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
			store.set(key, value);
			putCalls.push({ key, opts });
		},
		get: async (key: string) => store.get(key) ?? null,
		list: async ({ prefix }: { prefix: string }) => ({
			keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
			list_complete: true,
			cursor: undefined,
		}),
		putCalls,
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

test("indexing a durable run sets an expirationTtl so the index self-evicts instead of growing forever", async () => {
	const kv = fakeKv();
	const env = { OAUTH_KV: kv, OP_WORKFLOW: fakeWorkflow("waiting") } as any;
	await runVerb({ op: "assimilate-pdfs", input: {}, mode: "durable" }, env);

	expect(kv.putCalls).toHaveLength(1);
	expect(kv.putCalls[0].opts?.expirationTtl).toBeGreaterThan(0);
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

// A fake OP_WORKFLOW.get() result exposing just the instance methods the control
// surface needs (status/sendEvent/terminate), recording calls for assertions.
function fakeInstance(status: any, rec: { events: Array<{ type: string; payload: unknown }>; terminated: boolean }) {
	return {
		status: async () => status,
		sendEvent: async ({ type, payload }: { type: string; payload: unknown }) => {
			rec.events.push({ type, payload });
		},
		terminate: async () => {
			rec.terminated = true;
		},
	};
}

test("statusVerb returns the instance's live status", async () => {
	const env = { OP_WORKFLOW: { get: async () => fakeInstance({ status: "waiting" }, { events: [], terminated: false }) } } as any;
	await expect(statusVerb("instance-1", env)).resolves.toEqual({ status: "waiting" });
});

test("statusVerb throws without the OP_WORKFLOW binding", async () => {
	await expect(statusVerb("instance-1", {} as any)).rejects.toThrow(/OP_WORKFLOW binding/);
});

test("answerVerb sends an ask:<prompt> event, defaulting payload to {approved: true}", async () => {
	const rec = { events: [] as Array<{ type: string; payload: unknown }>, terminated: false };
	const env = { OP_WORKFLOW: { get: async () => fakeInstance({ status: "waiting" }, rec) } } as any;
	await answerVerb("instance-1", "review master?", undefined, env);
	expect(rec.events).toEqual([{ type: "ask:review master?", payload: { approved: true } }]);
});

test("answerVerb passes an explicit payload through unchanged (e.g. a rejection)", async () => {
	const rec = { events: [] as Array<{ type: string; payload: unknown }>, terminated: false };
	const env = { OP_WORKFLOW: { get: async () => fakeInstance({ status: "waiting" }, rec) } } as any;
	await answerVerb("instance-1", "review master?", { approved: false, reason: "nope" }, env);
	expect(rec.events).toEqual([{ type: "ask:review master?", payload: { approved: false, reason: "nope" } }]);
});

test("cancelVerb terminates the instance", async () => {
	const rec = { events: [] as Array<{ type: string; payload: unknown }>, terminated: false };
	const env = { OP_WORKFLOW: { get: async () => fakeInstance({ status: "running" }, rec) } } as any;
	await cancelVerb("instance-1", env);
	expect(rec.terminated).toBe(true);
});

test("run fn's status/answer/cancel actions require an instanceId", async () => {
	for (const action of ["status", "answer", "cancel"]) {
		const res = await run.run({} as any, { action });
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("instanceId");
	}
});

test("run fn's answer action requires a prompt", async () => {
	const env = { OP_WORKFLOW: { get: async () => fakeInstance({ status: "waiting" }, { events: [], terminated: false }) } } as any;
	const res = await run.run(env, { action: "answer", instanceId: "instance-1" });
	expect(res.isError).toBe(true);
	expect(res.content[0].text).toContain("prompt");
});

test("run fn's answer action rejects a prompt that matches no gate on the instance's own op — no event sent (#726)", async () => {
	const kv = fakeKv();
	await kv.put("sux:run:idx:instance-1", JSON.stringify({ instanceId: "instance-1", opId: "assimilate-pdfs", startedAt: 1 }));
	const rec = { events: [] as Array<{ type: string; payload: unknown }>, terminated: false };
	const env = { OAUTH_KV: kv, OP_WORKFLOW: { get: async () => fakeInstance({ status: "waiting" }, rec) } } as any;

	const res = await run.run(env, { action: "answer", instanceId: "instance-1", prompt: "totally wrong prompt" });
	expect(res.isError).toBe(true);
	expect(res.content[0].text).toContain("review master?"); // lists the valid prompt(s)
	expect(rec.events).toEqual([]); // never sent — no false sent:true
});

test("run fn's answer action rejects EVERY prompt when the instance's op resolves with ZERO ask gates — no false sent:true (#817)", async () => {
	const kv = fakeKv();
	await kv.put("sux:run:idx:instance-1", JSON.stringify({ instanceId: "instance-1", opId: "echo", startedAt: 1 }));
	const rec = { events: [] as Array<{ type: string; payload: unknown }>, terminated: false };
	const env = { OAUTH_KV: kv, OP_WORKFLOW: { get: async () => fakeInstance({ status: "waiting" }, rec) } } as any;

	const res = await run.run(env, { action: "answer", instanceId: "instance-1", prompt: "anything" });
	expect(res.isError).toBe(true);
	expect(rec.events).toEqual([]); // never sent — no false sent:true
});

test("run fn's answer action sends the event when the prompt matches the instance's op's ask gate", async () => {
	const kv = fakeKv();
	await kv.put("sux:run:idx:instance-1", JSON.stringify({ instanceId: "instance-1", opId: "assimilate-pdfs", startedAt: 1 }));
	const rec = { events: [] as Array<{ type: string; payload: unknown }>, terminated: false };
	const env = { OAUTH_KV: kv, OP_WORKFLOW: { get: async () => fakeInstance({ status: "waiting" }, rec) } } as any;

	const res = await run.run(env, { action: "answer", instanceId: "instance-1", prompt: "review master?" });
	expect(res.isError).toBeUndefined();
	expect(JSON.parse(res.content[0].text)).toMatchObject({ sent: true });
	expect(rec.events).toEqual([{ type: "ask:review master?", payload: { approved: true } }]);
});

test("run fn's answer action sends unvalidated when the instance isn't in the run index (can't tell, not reject)", async () => {
	const rec = { events: [] as Array<{ type: string; payload: unknown }>, terminated: false };
	const env = { OP_WORKFLOW: { get: async () => fakeInstance({ status: "waiting" }, rec) } } as any;

	const res = await run.run(env, { action: "answer", instanceId: "unindexed-instance", prompt: "anything" });
	expect(res.isError).toBeUndefined();
	expect(rec.events).toEqual([{ type: "ask:anything", payload: { approved: true } }]);
});

test("describeOp finds an op tree's ask gates without running it", () => {
	expect(describeOp("assimilate-pdfs")).toEqual({
		opId: "assimilate-pdfs",
		asks: [{ prompt: "review master?", timeout: "24 hour", onTimeout: "proceed" }],
	});
	expect(describeOp("echo")).toEqual({ opId: "echo", asks: [] });
});

test("describeOp throws on an unknown op", () => {
	expect(() => describeOp("nope")).toThrow(/unknown op/);
});

// No op in registry.ts currently nests an `ask` under `mapField`/`catch`, so these
// synthetic trees are the only coverage of that shape (#963) — needsDurable/
// collectAskGates must recurse into it exactly like durable.ts's interpreter does.
test("needsDurable/collectAskGates recurse into an ask nested under mapField", () => {
	const gated = mapField("items", "value", ask("approve item?", { timeout: "1 hour", onTimeout: "fail" }), { concurrency: fixed(1) });
	expect(needsDurable(gated)).toBe(true);
	expect(collectAskGates(gated)).toEqual([{ prompt: "approve item?", timeout: "1 hour", onTimeout: "fail" }]);
});

test("needsDurable/collectAskGates recurse into an ask nested under catch's try and catch branches", () => {
	const tryAsk = ask("try approve?", { timeout: "1 hour", onTimeout: "proceed" });
	const catchAsk = ask("catch approve?", { timeout: "1 hour", onTimeout: "proceed" });
	const gated = catchOp(tryAsk, catchAsk);
	expect(needsDurable(gated)).toBe(true);
	expect(collectAskGates(gated)).toEqual([
		{ prompt: "try approve?", timeout: "1 hour", onTimeout: "proceed" },
		{ prompt: "catch approve?", timeout: "1 hour", onTimeout: "proceed" },
	]);
});

test("needsDurable is false for a plain leaf/reconcile/sink pipe with no map/ask anywhere", () => {
	const plain = mapField("items", "value", op("double", async (n: number) => n * 2, { kind: "pure" }), { concurrency: fixed(1) });
	expect(needsDurable(plain)).toBe(false);
	expect(collectAskGates(plain)).toEqual([]);
});

test("needsDurable is true for a map fanning out an ask (existing map recursion, unchanged)", () => {
	const gated = map(ask("approve each?", { timeout: "1 hour", onTimeout: "fail" }), { concurrency: fixed(1) });
	expect(needsDurable(gated)).toBe(true);
	expect(collectAskGates(gated)).toEqual([{ prompt: "approve each?", timeout: "1 hour", onTimeout: "fail" }]);
});

test("needsDurable/collectAskGates recurse into an ask nested under cond's cases and default", () => {
	const caseAsk = ask("case approve?", { timeout: "1 hour", onTimeout: "proceed" });
	const defaultAsk = ask("default approve?", { timeout: "1 hour", onTimeout: "proceed" });
	const gated = cond([{ when: { field: "kind", equals: "a" }, then: caseAsk }], defaultAsk);
	expect(needsDurable(gated)).toBe(true);
	expect(collectAskGates(gated)).toEqual([
		{ prompt: "case approve?", timeout: "1 hour", onTimeout: "proceed" },
		{ prompt: "default approve?", timeout: "1 hour", onTimeout: "proceed" },
	]);
});

test("needsDurable is false for a cond whose cases/default are all plain leaves", () => {
	const plain = cond(
		[{ when: { field: "kind", equals: "a" }, then: op("a", async () => "A", { kind: "pure" }) }],
		op("fallback", async () => "F", { kind: "pure" }),
	);
	expect(needsDurable(plain)).toBe(false);
	expect(collectAskGates(plain)).toEqual([]);
});

test("needsDurable/collectAskGates recurse into an ask nested under a parallel branch", () => {
	const gated = parallel([op("plain", async (n: number) => n, { kind: "pure" }), ask("approve branch?", { timeout: "1 hour", onTimeout: "fail" })]);
	expect(needsDurable(gated)).toBe(true);
	expect(collectAskGates(gated)).toEqual([{ prompt: "approve branch?", timeout: "1 hour", onTimeout: "fail" }]);
});

test("run fn's describe action returns the op's ask gates without an instanceId", async () => {
	const res = await run.run({} as any, { action: "describe", op: "assimilate-pdfs" });
	expect(res.isError).toBeUndefined();
	expect(JSON.parse(res.content[0].text)).toMatchObject({
		action: "describe",
		opId: "assimilate-pdfs",
		asks: [{ prompt: "review master?", timeout: "24 hour", onTimeout: "proceed" }],
	});
});

test("run fn's describe action requires an op and rejects an unknown one", async () => {
	const missing = await run.run({} as any, { action: "describe" });
	expect(missing.isError).toBe(true);
	expect(missing.content[0].text).toContain("op");

	const unknown = await run.run({} as any, { action: "describe", op: "nope" });
	expect(unknown.isError).toBe(true);
	expect(unknown.content[0].text).toMatch(/unknown op/);
});

test("run fn's status action round-trips through the Fn surface", async () => {
	const env = { OP_WORKFLOW: { get: async () => fakeInstance({ status: "complete", output: 42 }, { events: [], terminated: false }) } } as any;
	const res = await run.run(env, { action: "status", instanceId: "instance-1" });
	expect(res.isError).toBeUndefined();
	expect(JSON.parse(res.content[0].text)).toMatchObject({ action: "status", instanceId: "instance-1", status: "complete", output: 42 });
});
