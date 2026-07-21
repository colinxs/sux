import { test, expect } from "vitest";
import { MemoryCache, MemoryStore, fixed, op, pipe, map, mapField, reconcile, sink, ask, catchOp, cond, parallel, stamp, type Caps } from "@suxos/lib";
import { AskRejectedError, interpretDurable } from "./durable.js";

// A FAKE WorkflowStep: `do` runs the callback inline (so the interpreter's step
// bodies execute in plain node vitest, no workerd), and `waitForEvent` records the
// event `type` it was asked to wait on. This is exactly the seam a real workflow
// runtime provides — memoized `do`, event-driven `waitForEvent` — minus durability.
// `do` accepts both the real API's 2-arg (name, fn) and 3-arg (name, config, fn)
// overloads — `configs` records every config a 3-arg call was given, keyed by step
// name, so a test can assert what retries/etc. the interpreter actually threaded
// through without needing a real workerd Workflow instance.
const fakeStep = (rec: { events: string[]; sinks?: string[]; configs?: Record<string, unknown> }): any => ({
	do: async (name: string, a: any, b?: any) => {
		if (typeof a === "function") return a();
		if (rec.configs) rec.configs[name] = a;
		return b();
	},
	// Real API is waitForEvent(name, { type, timeout }) — the type is on the 2nd arg.
	waitForEvent: async (_name: string, opts: { type: string }) => {
		rec.events.push(opts.type);
		return { payload: {} };
	},
	sleep: async () => {},
});

// A fake WorkflowStep whose waitForEvent always rejects — the seam an `ask` node's
// try/catch is built to handle (a real Workflow throws once a wait's timeout elapses).
const rejectingStep = (message = "waitForEvent timed out"): any => ({
	do: async (_name: string, a: any, b?: any) => (typeof a === "function" ? a() : b()),
	waitForEvent: async (_name: string, _opts: { type: string }) => {
		throw new Error(message);
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

test("interpretDurable's ask swallows a waitForEvent timeout when onTimeout is 'proceed', but rethrows when onTimeout is 'fail'", async () => {
	const caps = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} } as unknown as Caps;
	const step = rejectingStep();

	const proceed = ask("ok?", { timeout: "1 hour", onTimeout: "proceed" });
	await expect(interpretDurable(proceed, "unchanged", step, caps, "op3")).resolves.toBe("unchanged");

	const fail = ask("ok?", { timeout: "1 hour", onTimeout: "fail" });
	await expect(interpretDurable(fail, "unchanged", step, caps, "op4")).rejects.toThrow("waitForEvent timed out");
});

test("interpretDurable's ask rethrows a non-timeout waitForEvent error even when onTimeout is 'proceed'", async () => {
	const caps = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} } as unknown as Caps;
	const step = rejectingStep("RPC transport disconnected");

	const proceed = ask("ok?", { timeout: "1 hour", onTimeout: "proceed" });
	await expect(interpretDurable(proceed, "unchanged", step, caps, "op7")).rejects.toThrow("RPC transport disconnected");
});

test("interpretDurable's ask throws AskRejectedError when answered with {approved: false}, even under onTimeout: 'proceed'", async () => {
	const caps = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} } as unknown as Caps;
	const step: any = {
		do: async (_name: string, fn: any) => fn(),
		waitForEvent: async () => ({ payload: { approved: false, reason: "not ready" } }),
		sleep: async () => {},
	};

	const proceed = ask("ok?", { timeout: "1 hour", onTimeout: "proceed" });
	await expect(interpretDurable(proceed, "unchanged", step, caps, "op8")).rejects.toThrow(AskRejectedError);
});

test("interpretDurable's ask proceeds normally when answered with a payload that doesn't explicitly reject", async () => {
	const caps = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} } as unknown as Caps;
	const step: any = {
		do: async (_name: string, fn: any) => fn(),
		waitForEvent: async () => ({ payload: { approved: true } }),
		sleep: async () => {},
	};

	const proceed = ask("ok?", { timeout: "1 hour", onTimeout: "proceed" });
	await expect(interpretDurable(proceed, "unchanged", step, caps, "op9")).resolves.toBe("unchanged");
});

test("interpretDurable propagates a map item's error and releases the concurrency limiter", async () => {
	const caps = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} } as unknown as Caps;

	let goodRan!: () => void;
	const goodRanPromise = new Promise<void>((resolve) => (goodRan = resolve));
	const boom = op(
		"boom",
		async (s: string) => {
			if (s === "bad") throw new Error("leaf blew up");
			goodRan();
			return s;
		},
		{ kind: "pure" },
	);
	// concurrency 1 forces "good" to queue behind "bad" — it only runs if the
	// catch branch's release(false) actually frees the slot back up.
	const tree = map(boom, { concurrency: fixed(1) });

	await expect(interpretDurable(tree, ["bad", "good"], fakeStep({ events: [] }), caps, "op5")).rejects.toThrow("leaf blew up");
	await goodRanPromise;
});

test("interpretDurable runs mapField over one named field of each array element, passing the rest through and renaming the array field", async () => {
	const caps = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} } as unknown as Caps;
	const double = op("double", async (n: number) => n * 2, { kind: "pure" });
	const tree = mapField("entries", "handle", double, { concurrency: fixed(2), renameTo: "files" });

	const out = await interpretDurable(
		tree,
		{ entries: [{ handle: 1, name: "a" }, { handle: 2, name: "b" }] },
		fakeStep({ events: [] }),
		caps,
		"op10",
	);

	expect(out).toEqual({ files: [{ handle: 2, name: "a" }, { handle: 4, name: "b" }] });
});

test("interpretDurable's mapField throws before fanning out when the array field exceeds the MVP ceiling", async () => {
	const caps = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} } as unknown as Caps;
	const double = op("double", async (n: number) => n * 2, { kind: "pure" });
	const tree = mapField("entries", "handle", double, { concurrency: fixed(2) });
	const entries = new Array(20_001).fill(0).map((_, i) => ({ handle: i }));

	await expect(interpretDurable(tree, { entries }, fakeStep({ events: [] }), caps, "op11")).rejects.toThrow(
		/mapField fan-out of 20001 exceeds the MVP ceiling/,
	);
});

test("interpretDurable's catch runs only try when try succeeds", async () => {
	const caps = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} } as unknown as Caps;
	let catchRan = false;
	const tryOp = op("try", async (n: number) => n + 1, { kind: "pure" });
	const catchBranch = op(
		"catch",
		async (n: number) => {
			catchRan = true;
			return n;
		},
		{ kind: "pure" },
	);
	const out = await interpretDurable(catchOp(tryOp, catchBranch), 1, fakeStep({ events: [] }), caps, "op12");
	expect(out).toBe(2);
	expect(catchRan).toBe(false);
});

test("interpretDurable's catch runs the catch branch with the original input when try throws", async () => {
	const caps = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} } as unknown as Caps;
	const tryOp = op(
		"try",
		async (_n: number) => {
			throw new Error("try blew up");
		},
		{ kind: "pure" },
	);
	const catchBranch = op("catch", async (n: number) => n * 10, { kind: "pure" });
	const out = await interpretDurable(catchOp(tryOp, catchBranch), 3, fakeStep({ events: [] }), caps, "op13");
	expect(out).toBe(30);
});

test("interpretDurable dispatches reconcile modes — last-write-wins selects the newest stamped handle", async () => {
	const store = new MemoryStore();
	const caps = { store, llm: {}, clock: { now: () => 0 }, sinks: {} } as unknown as Caps;
	const put = async (s: string, at: number) =>
		stamp(await store.put(new TextEncoder().encode(s), "text/plain"), { now: () => at });
	const older = await put("older", 100);
	const newer = await put("newer", 200);
	const out = await interpretDurable(reconcile({ mode: "last-write-wins" }), [older, newer], fakeStep({ events: [] }), caps, "op6");
	expect(out.sha256).toBe(newer.sha256);
	expect(new TextDecoder().decode(await store.get(out))).toBe("newer");
});

test("interpretDurable threads a leaf's declared retries into step.do's WorkflowStepConfig", async () => {
	const caps = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} } as unknown as Caps;
	const rec = { events: [] as string[], configs: {} as Record<string, unknown> };
	const flaky = op("flaky", async (n: number) => n + 1, { kind: "effect", retries: 5 });
	const out = await interpretDurable(flaky, 1, fakeStep(rec), caps, "op14");
	expect(out).toBe(2);
	expect(rec.configs["op14:flaky"]).toEqual({ retries: { limit: 5, delay: "10 seconds", backoff: "exponential" } });
});

test("interpretDurable calls step.do with no config for a leaf that never declares retries", async () => {
	const caps = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} } as unknown as Caps;
	const rec = { events: [] as string[], configs: {} as Record<string, unknown> };
	const plain = op("plain", async (n: number) => n + 1, { kind: "effect" });
	await interpretDurable(plain, 1, fakeStep(rec), caps, "op15");
	expect(rec.configs["op15:plain"]).toBeUndefined();
});

test("interpretDurable's sink fanout threads per-target retries and resolves an object-shaped { name, opts } target", async () => {
	const caps = {
		store: new MemoryStore(),
		llm: {},
		clock: { now: () => 0 },
		sinks: {
			a: { name: "a", write: async (v: any) => v },
			b: { name: "b", write: async (v: any) => v },
		},
	} as unknown as Caps;
	const rec = { events: [] as string[], configs: {} as Record<string, unknown> };
	// target "a" is a bare string (falls back to the fanout's own opts: retries 2);
	// target "b" overrides with its own retries: 0.
	const tree = sink.fanout(["a", { name: "b", opts: { retries: 0 } }], { retries: 2 });
	await interpretDurable(tree, "payload", fakeStep(rec), caps, "op16");
	expect(rec.configs["op16:sink:a"]).toEqual({ retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } });
	expect(rec.configs["op16:sink:b"]).toEqual({ retries: { limit: 0, delay: "10 seconds", backoff: "exponential" } });
});

test("interpretDurable memoizes a leaf's result via caps.cache when opts.memo is set", async () => {
	const cache = new MemoryCache();
	const caps = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {}, cache } as unknown as Caps;
	let calls = 0;
	const memoLeaf = op(
		"memo-leaf",
		async (n: number) => {
			calls++;
			return n * 2;
		},
		{ kind: "effect", memo: true },
	);
	const first = await interpretDurable(memoLeaf, 21, fakeStep({ events: [] }), caps, "opA");
	const second = await interpretDurable(memoLeaf, 21, fakeStep({ events: [] }), caps, "opB");
	expect(first).toBe(42);
	expect(second).toBe(42);
	expect(calls).toBe(1);
});

test("interpretDurable gates a heavy leaf's concurrency through caps.governors' heavyConcurrency limiter", async () => {
	const caps = {
		store: new MemoryStore(),
		llm: {},
		clock: { now: () => 0 },
		sinks: {},
		governors: { "heavy-leaf": { heavyConcurrency: fixed(1) } },
	} as unknown as Caps;

	let inflight = 0;
	let maxInflight = 0;
	const heavyLeaf = op(
		"heavy-leaf",
		async (n: number) => {
			inflight++;
			maxInflight = Math.max(maxInflight, inflight);
			await new Promise((r) => setTimeout(r, 0));
			inflight--;
			return n;
		},
		{ kind: "effect", heavy: true },
	);
	const tree = map(heavyLeaf, { concurrency: fixed(2) });
	await interpretDurable(tree, [1, 2, 3], fakeStep({ events: [] }), caps, "op17");
	expect(maxInflight).toBe(1);
});

test("interpretDurable's cond picks the first matching case, falling back to default", async () => {
	const caps = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} } as unknown as Caps;
	const tree = cond(
		[
			{ when: { field: "kind", equals: "a" }, then: op("a", async () => "A", { kind: "pure" }) },
			{ when: { field: "kind", equals: "b" }, then: op("b", async () => "B", { kind: "pure" }) },
		],
		op("fallback", async () => "F", { kind: "pure" }),
	);
	expect(await interpretDurable(tree, { kind: "b" }, fakeStep({ events: [] }), caps, "op18")).toBe("B");
	expect(await interpretDurable(tree, { kind: "z" }, fakeStep({ events: [] }), caps, "op19")).toBe("F");
});

test("interpretDurable's cond throws when no case matches and there's no default", async () => {
	const caps = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} } as unknown as Caps;
	const tree = cond([{ when: { field: "kind", equals: "a" }, then: op("a", async () => "A", { kind: "pure" }) }]);
	await expect(interpretDurable(tree, { kind: "z" }, fakeStep({ events: [] }), caps, "op20")).rejects.toThrow(/no case matched/);
});

test("interpretDurable's parallel runs every branch concurrently and collects results by index", async () => {
	const caps = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} } as unknown as Caps;
	const tree = parallel([op("double", async (n: number) => n * 2, { kind: "pure" }), op("square", async (n: number) => n * n, { kind: "pure" })]);
	expect(await interpretDurable(tree, 3, fakeStep({ events: [] }), caps, "op21")).toEqual([6, 9]);
});

test("interpretDurable's parallel propagates a branch's error", async () => {
	const caps = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} } as unknown as Caps;
	const tree = parallel([
		op("ok", async (n: number) => n, { kind: "pure" }),
		op("boom", async () => {
			throw new Error("branch failed");
		}, { kind: "pure" }),
	]);
	await expect(interpretDurable(tree, 1, fakeStep({ events: [] }), caps, "op22")).rejects.toThrow("branch failed");
});
