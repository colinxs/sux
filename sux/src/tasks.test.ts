import { describe, expect, it } from "vitest";
import type { RtEnv, ToolResult } from "./registry";
import {
	cancelTask,
	clampTaskTtl,
	createTask,
	getTask,
	isTerminal,
	listTasks,
	TASK_POLL_INTERVAL_MS,
	toPublicTask,
	toTaskResult,
	waitForTerminal,
} from "./tasks";

// In-memory KV mirroring the slice of the KVNamespace surface tasks.ts touches:
// get/put/delete plus list (cursor-paginated) for tasks/list.
function makeKv() {
	const store = new Map<string, { value: string; expirationTtl?: number }>();
	return {
		store,
		get: async (key: string) => store.get(key)?.value ?? null,
		put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
			store.set(key, { value, expirationTtl: opts?.expirationTtl });
		},
		delete: async (key: string) => void store.delete(key),
		list: async (opts?: { prefix?: string; cursor?: string; limit?: number }) => {
			const prefix = opts?.prefix ?? "";
			const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
			const limit = opts?.limit ?? 1000;
			const start = opts?.cursor ? Number(opts.cursor) : 0;
			const page = all.slice(start, start + limit);
			const list_complete = start + limit >= all.length;
			return { keys: page.map((name) => ({ name })), list_complete, cursor: list_complete ? undefined : String(start + limit) };
		},
	};
}

function makeEnv(kv: ReturnType<typeof makeKv>): RtEnv {
	return { OAUTH_KV: kv } as unknown as RtEnv;
}

function makeCtx() {
	const deferred: Promise<unknown>[] = [];
	return { deferred, ctx: { waitUntil: (p: Promise<unknown>) => void deferred.push(p) } as unknown as ExecutionContext };
}

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

describe("clampTaskTtl", () => {
	it("clamps to [60s, 24h] and defaults to 10min when unset/invalid", () => {
		expect(clampTaskTtl(undefined)).toBe(10 * 60 * 1000);
		expect(clampTaskTtl(0)).toBe(10 * 60 * 1000);
		expect(clampTaskTtl(-5)).toBe(10 * 60 * 1000);
		expect(clampTaskTtl("nope")).toBe(10 * 60 * 1000);
		expect(clampTaskTtl(1)).toBe(60_000);
		expect(clampTaskTtl(999 * 24 * 60 * 60 * 1000)).toBe(24 * 60 * 60 * 1000);
		expect(clampTaskTtl(5 * 60 * 1000)).toBe(5 * 60 * 1000);
	});
});

describe("createTask / getTask", () => {
	it("creates a working task immediately and lands the completed result once run() settles", async () => {
		const kv = makeKv();
		const env = makeEnv(kv);
		const { ctx, deferred } = makeCtx();

		let resolveRun!: (r: ToolResult) => void;
		const runPromise = new Promise<ToolResult>((r) => (resolveRun = r));
		const rec = createTask(env, ctx, "pipe", undefined, () => runPromise);

		expect(rec.status).toBe("working");
		expect(rec.tool).toBe("pipe");
		expect(rec.pollInterval).toBe(TASK_POLL_INTERVAL_MS);
		expect(typeof rec.taskId).toBe("string");

		// The public shape never leaks `tool`/`result`.
		const pub = toPublicTask(rec);
		expect(pub).not.toHaveProperty("tool");
		expect(pub).not.toHaveProperty("result");

		// Await only the initial write (deferred[1], the run()-completion promise,
		// is still pending until resolveRun below — don't splice/await the whole
		// array or Promise.all would hang on it).
		await deferred[0];
		const stored = await getTask(env, rec.taskId);
		expect(stored?.status).toBe("working");

		resolveRun(ok("done"));
		await Promise.all(deferred.splice(0)); // the finish-task write

		const finished = await getTask(env, rec.taskId);
		expect(finished?.status).toBe("completed");
		expect(finished?.result?.content[0].text).toBe("done");
	});

	it("a tool result with isError:true lands the task as failed", async () => {
		const kv = makeKv();
		const env = makeEnv(kv);
		const { ctx, deferred } = makeCtx();

		const rec = createTask(env, ctx, "render", undefined, async () => fail("upstream blocked"));
		await Promise.all(deferred.splice(0));

		const finished = await getTask(env, rec.taskId);
		expect(finished?.status).toBe("failed");
		expect(finished?.statusMessage).toBe("upstream blocked");
	});

	it("a thrown error in run() is caught and lands the task as failed", async () => {
		const kv = makeKv();
		const env = makeEnv(kv);
		const { ctx, deferred } = makeCtx();

		const rec = createTask(env, ctx, "batch", undefined, async () => {
			throw new Error("boom");
		});
		await Promise.all(deferred.splice(0));

		const finished = await getTask(env, rec.taskId);
		expect(finished?.status).toBe("failed");
		expect(finished?.statusMessage).toContain("boom");
	});

	it("getTask returns null for an unknown id", async () => {
		const env = makeEnv(makeKv());
		expect(await getTask(env, "nope")).toBeNull();
	});
});

describe("cancelTask", () => {
	it("flips a working task to cancelled", async () => {
		const kv = makeKv();
		const env = makeEnv(kv);
		const { ctx, deferred } = makeCtx();
		let resolveRun!: (r: ToolResult) => void;
		const runPromise = new Promise<ToolResult>((r) => (resolveRun = r));
		const rec = createTask(env, ctx, "crawl", undefined, () => runPromise);
		await deferred[0]; // the initial write only — the run() promise is still pending

		const cancelled = await cancelTask(env, rec.taskId);
		expect(cancelled.ok).toBe(true);
		if (cancelled.ok) expect(cancelled.rec.status).toBe("cancelled");

		// A late-arriving result must NOT overwrite the cancelled status —
		// "once cancelled, a task MUST remain cancelled" even if the underlying
		// work keeps running and eventually settles.
		resolveRun(ok("too late"));
		await Promise.all(deferred.splice(0));
		const after = await getTask(env, rec.taskId);
		expect(after?.status).toBe("cancelled");
	});

	it("returns not_found for an unknown id", async () => {
		const env = makeEnv(makeKv());
		const r = await cancelTask(env, "nope");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe("not_found");
	});

	it("refuses to cancel a task already in a terminal status", async () => {
		const kv = makeKv();
		const env = makeEnv(kv);
		const { ctx, deferred } = makeCtx();
		const rec = createTask(env, ctx, "shop", undefined, async () => ok("done"));
		await Promise.all(deferred.splice(0));
		await Promise.all(deferred.splice(0));

		const r = await cancelTask(env, rec.taskId);
		expect(r.ok).toBe(false);
		if (!r.ok && r.error === "terminal") expect(r.status).toBe("completed");
	});

	it("does not resurrect a task cancelled between finishTask's read and write (TOCTOU, #375)", async () => {
		const kv = makeKv();
		const env = makeEnv(kv);
		const { ctx, deferred } = makeCtx();

		let resolveRun!: (r: ToolResult) => void;
		const runPromise = new Promise<ToolResult>((r) => (resolveRun = r));
		const rec = createTask(env, ctx, "pipe", undefined, () => runPromise);
		await deferred[0]; // initial "working" write lands

		// Simulate a tasks/cancel landing in the gap between finishTask's initial read
		// and its write: intercept the FIRST kv.get finishTask issues and, before
		// returning that (now-stale) "working" snapshot, run a real cancelTask to
		// completion — its own read AND write both land inside the gap, exactly the
		// window #375 describes (distinct from #357's createTask-vs-finishTask race).
		const originalGet = kv.get.bind(kv);
		let getCalls = 0;
		kv.get = async (key: string) => {
			getCalls++;
			const value = await originalGet(key);
			if (getCalls === 1) await cancelTask(env, rec.taskId);
			return value;
		};

		resolveRun(ok("finished after cancel"));
		await Promise.all(deferred.splice(0));

		const after = await getTask(env, rec.taskId);
		expect(after?.status).toBe("cancelled");
	});
});

describe("waitForTerminal", () => {
	it("returns immediately once the task is already terminal", async () => {
		const kv = makeKv();
		const env = makeEnv(kv);
		const { ctx, deferred } = makeCtx();
		const rec = createTask(env, ctx, "batch_fetch", undefined, async () => ok("x"));
		await Promise.all(deferred.splice(0));
		await Promise.all(deferred.splice(0));

		const rec2 = await waitForTerminal(env, rec.taskId, 5_000);
		expect(rec2?.status).toBe("completed");
	});

	it("polls until a task transitions from working to completed", async () => {
		const kv = makeKv();
		const env = makeEnv(kv);
		const { ctx, deferred } = makeCtx();
		let resolveRun!: (r: ToolResult) => void;
		const runPromise = new Promise<ToolResult>((r) => (resolveRun = r));
		const rec = createTask(env, ctx, "pipe", undefined, () => runPromise);
		await deferred[0]; // the initial write only — the run() promise is still pending

		const waiter = waitForTerminal(env, rec.taskId, 5_000);
		// Resolve the run shortly after polling has started.
		setTimeout(() => resolveRun(ok("eventually")), 20);
		const settled = await waiter;
		expect(settled?.status).toBe("completed");
		expect(settled?.result?.content[0].text).toBe("eventually");
	});

	it("gives up and returns the still-non-terminal record after maxWaitMs", async () => {
		const kv = makeKv();
		const env = makeEnv(kv);
		const { ctx, deferred } = makeCtx();
		const rec = createTask(env, ctx, "render", undefined, () => new Promise<ToolResult>(() => {})); // never settles
		await deferred[0]; // the initial write only — the run() promise never settles at all

		const settled = await waitForTerminal(env, rec.taskId, 50);
		expect(settled?.status).toBe("working");
	});

	it("returns null for an unknown id", async () => {
		const env = makeEnv(makeKv());
		expect(await waitForTerminal(env, "nope", 50)).toBeNull();
	});
});

describe("toTaskResult", () => {
	it("stamps the related-task _meta onto the stored ToolResult", async () => {
		const kv = makeKv();
		const env = makeEnv(kv);
		const { ctx, deferred } = makeCtx();
		const rec = createTask(env, ctx, "shop", undefined, async () => ok("bought it"));
		await Promise.all(deferred.splice(0));
		await Promise.all(deferred.splice(0));

		const finished = await getTask(env, rec.taskId);
		const result = toTaskResult(finished!);
		expect(result.content[0].text).toBe("bought it");
		expect(result._meta).toEqual({ "io.modelcontextprotocol/related-task": { taskId: rec.taskId } });
	});
});

describe("isTerminal", () => {
	it("classifies terminal vs. non-terminal statuses", () => {
		expect(isTerminal("completed")).toBe(true);
		expect(isTerminal("failed")).toBe(true);
		expect(isTerminal("cancelled")).toBe(true);
		expect(isTerminal("working")).toBe(false);
		expect(isTerminal("input_required")).toBe(false);
	});
});

describe("listTasks", () => {
	it("lists tasks under the internal prefix and paginates via the KV cursor", async () => {
		const kv = makeKv();
		const env = makeEnv(kv);
		const { ctx, deferred } = makeCtx();

		for (let i = 0; i < 5; i++) {
			createTask(env, ctx, "batch", undefined, async () => ok(`r${i}`));
		}
		await Promise.all(deferred.splice(0));
		await Promise.all(deferred.splice(0));

		const page1 = await listTasks(env, undefined, 2);
		expect(page1.tasks.length).toBe(2);
		expect(page1.nextCursor).toBeDefined();

		const page2 = await listTasks(env, page1.nextCursor, 2);
		expect(page2.tasks.length).toBe(2);

		const page3 = await listTasks(env, page2.nextCursor, 2);
		expect(page3.tasks.length).toBe(1);
		expect(page3.nextCursor).toBeUndefined();

		// Nothing in kv-store outside the task prefix leaked in.
		for (const t of [...page1.tasks, ...page2.tasks, ...page3.tasks]) expect(typeof t.taskId).toBe("string");
	});
});
