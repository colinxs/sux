import { test, expect } from "vitest";
import { MemoryStore, fixed, op, pipe, map, reconcile, sink, ask, type Caps } from "@suxos/lib";
import { interpretDurable } from "./durable.js";

// A FAKE WorkflowStep: `do` runs the callback inline (so the interpreter's step
// bodies execute in plain node vitest, no workerd), and `waitForEvent` records the
// event `type` it was asked to wait on. This is exactly the seam a real workflow
// runtime provides — memoized `do`, event-driven `waitForEvent` — minus durability.
const fakeStep = (rec: { events: string[]; sinks?: string[] }): any => ({
	do: async (_name: string, fn: any) => fn(),
	// Real API is waitForEvent(name, { type, timeout }) — the type is on the 2nd arg.
	waitForEvent: async (_name: string, opts: { type: string }) => {
		rec.events.push(opts.type);
		return { payload: {} };
	},
	sleep: async () => {},
});

test("interpretDurable runs leaves through step.do and resolves ask via an event", async () => {
	const rec = { events: [] as string[] };
	const caps = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} } as unknown as Caps;
	const tree = pipe(
		op("inc", async (n: number) => n + 1, { kind: "pure" }),
		ask("ok?", { timeout: "1 hour", onTimeout: "proceed" }),
	);
	const out = await interpretDurable(tree, 1, fakeStep(rec), caps, "op1");
	expect(out).toBe(2);
	expect(rec.events).toEqual(["ask:ok?"]);
});

test("interpretDurable fans out a map, reconciles the handles, and writes each sink", async () => {
	const rec = { events: [] as string[], sinks: [] as string[] };
	const store = new MemoryStore();
	const caps = {
		store,
		llm: {},
		clock: { now: () => 0 },
		sinks: {
			r2: { name: "r2", write: async (h: any) => (rec.sinks!.push(h.r2Key), h) },
		},
	} as unknown as Caps;

	// map: store each string as a Handle → reconcile the Handles into one master →
	// write it to the r2 sink. Exercises leaf + map (bounded by the limiter) +
	// reconcile (faithfulUnion) + sink, so all six Op tags are covered across the two tests.
	const putLeaf = op("put", async (s: string, c: Caps) => c.store.put(new TextEncoder().encode(s), "text/plain"), { kind: "effect" });
	const tree = pipe(map(putLeaf, { concurrency: fixed(2) }), reconcile({ mode: "faithful-union" }), sink("r2"));

	const out = await interpretDurable(tree, ["alpha", "beta"], fakeStep(rec), caps, "op2");

	// sink returns its piped input — the reconciled master handle.
	expect(out.type).toBe("text/markdown");
	expect(rec.sinks).toHaveLength(1);
	const text = new TextDecoder().decode(await store.get(out));
	expect(text).toContain("alpha");
	expect(text).toContain("beta");
});
