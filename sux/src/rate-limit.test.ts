import { describe, expect, it } from "vitest";
import { extraCost, requestCost, weightedRateLimit } from "./rate-limit";

describe("extraCost", () => {
	it("charges cost-1 extra tokens for weighted fns, 0 for default/unknown", () => {
		expect(extraCost("render")).toBe(4); // cost 5
		expect(extraCost("search")).toBe(2); // cost 3
		expect(extraCost("summarize")).toBe(1); // cost 2
		expect(extraCost("hash")).toBe(0); // default cost 1
		expect(extraCost("does_not_exist")).toBe(0);
	});
});

describe("requestCost", () => {
	it("falls back to extraCost for a plain (non-fan-out) tool", () => {
		expect(requestCost("render", {})).toBe(4);
		expect(requestCost("hash", { any: 1 })).toBe(0);
	});

	it("sums the mapped leaf's weight across a batch's width (the evasion hole)", () => {
		// batch({tool:"render", over:[…3]}) = 3 real renders → 3 × 4 extra, NOT batch's 0.
		expect(requestCost("batch", { tool: "render", over: ["a", "b", "c"], args: {} })).toBe(12);
		// `calls` form counts the same way.
		expect(requestCost("batch", { tool: "render", calls: [{}, {}] })).toBe(8);
		// A cheap leaf still sums to 0 — no false backpressure.
		expect(requestCost("batch", { tool: "hash", over: [1, 2, 3] })).toBe(0);
	});

	it("clamps a batch's width to MAX_BATCH_CALLS so a hostile width can't overcharge", () => {
		const over = Array.from({ length: 500 }, (_, i) => i);
		expect(requestCost("batch", { tool: "render", over })).toBe(100 * 4); // clamped at 100
	});

	it("adds the reduce_with reducer's weight to a batch", () => {
		expect(requestCost("batch", { tool: "hash", over: [1, 2], reduce_with: { tool: "summarize" } })).toBe(1);
	});

	it("prices a reduce_with pipe reducer's own steps, not its flat cost-1 weight (#356)", () => {
		const reduceWith = { tool: "pipe", args: { steps: [{ tool: "render" }, { tool: "render" }] } };
		expect(requestCost("batch", { tool: "hash", over: [1], reduce_with: reduceWith })).toBe(8); // 2 renders × 4 extra, not 0
	});

	it("prices a batch-mapped pipe's nested steps per mapped call, not pipe's flat cost-1 weight (#454)", () => {
		const args = { steps: [{ tool: "render" }, { tool: "render" }] };
		expect(requestCost("batch", { tool: "pipe", over: [1, 2, 3], args })).toBe(3 * 8); // 3 mapped pipes × 2 renders × 4 extra
	});

	it("clamps a batch-mapped nested-fanout tool to the tighter nested-call cap, not MAX_BATCH_CALLS (#454)", () => {
		const over = Array.from({ length: 50 }, (_, i) => i);
		const args = { steps: [{ tool: "render" }] };
		expect(requestCost("batch", { tool: "pipe", over, args })).toBe(25 * 4); // clamped at 25 nested calls, not 50
	});

	it("charges only the wrapper for an invalid/recursive batch target", () => {
		expect(requestCost("batch", { over: [1, 2, 3] })).toBe(0); // no tool
		expect(requestCost("batch", { tool: "batch", over: [1, 2] })).toBe(0); // recursive
	});

	it("sums each step's leaf weight for a pipe, clamped to MAX_PIPE_STEPS", () => {
		expect(requestCost("pipe", { steps: [{ tool: "render" }, { tool: "search" }, { tool: "hash" }] })).toBe(6); // 4 + 2 + 0
		const steps = Array.from({ length: 40 }, () => ({ tool: "render" }));
		expect(requestCost("pipe", { steps })).toBe(25 * 4); // clamped at 25 steps
	});
});

describe("weightedRateLimit", () => {
	// Limiter that allows `budget` calls then denies.
	const limiter = (budget: number) => {
		let n = 0;
		return { calls: () => n, limit: async () => ({ success: ++n <= budget }) };
	};
	const call = (name: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });

	it("returns null (proceed) when the tool has no extra cost", async () => {
		const rl = limiter(0);
		const r = await weightedRateLimit({ MCP_RATE_LIMITER: rl } as any, "u", call("hash"));
		expect(r).toBeNull();
		expect(rl.calls()).toBe(0); // never touched the limiter
	});

	it("consumes cost-1 extra tokens and proceeds when under budget", async () => {
		const rl = limiter(10);
		const r = await weightedRateLimit({ MCP_RATE_LIMITER: rl } as any, "u", call("render"));
		expect(r).toBeNull();
		expect(rl.calls()).toBe(4); // render cost 5 → 4 extra
	});

	it("returns a 429 when the limiter denies mid-way", async () => {
		const rl = limiter(1); // only 1 allowed, render needs 4 extra
		const r = await weightedRateLimit({ MCP_RATE_LIMITER: rl } as any, "u", call("render"));
		expect(r).not.toBeNull();
		expect(r!.status).toBe(429);
		expect(await r!.json()).toEqual({ error: "rate_limited" });
	});

	it("no-ops without a limiter binding or on non-tools/call methods", async () => {
		expect(await weightedRateLimit({} as any, "u", call("render"))).toBeNull();
		const rl = limiter(0);
		expect(await weightedRateLimit({ MCP_RATE_LIMITER: rl } as any, "u", { method: "tools/list" } as any)).toBeNull();
		expect(rl.calls()).toBe(0);
	});

	// The front-door `fn` escape must not let an expensive leaf dodge its weight.
	const fnCall = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fn", arguments: { name, args } } });

	it("charges the real leaf's weight when it's reached via the `fn` escape", async () => {
		const rl = limiter(10);
		const r = await weightedRateLimit({ MCP_RATE_LIMITER: rl } as any, "u", fnCall("render"));
		expect(r).toBeNull();
		expect(rl.calls()).toBe(4); // render cost 5 → 4 extra, same as a direct render call
	});

	it("a bare/unknown-inner `fn` call charges nothing extra (falls through to fn's own run)", async () => {
		const rl = limiter(10);
		expect(await weightedRateLimit({ MCP_RATE_LIMITER: rl } as any, "u", fnCall("does_not_exist"))).toBeNull();
		expect(await weightedRateLimit({ MCP_RATE_LIMITER: rl } as any, "u", call("fn"))).toBeNull();
		expect(rl.calls()).toBe(0); // fn itself has default cost
	});

	// A Unicode-obfuscated inner name must NOT dodge the weighted cost: the limiter
	// resolves it through the same normalization the dispatcher will, so a fullwidth or
	// zero-width-spaced leaf is charged exactly as its plain form.
	// A wide batch of an expensive leaf must be charged for every real run, not for
	// batch's own cost-1 weight — otherwise the limiter is trivially evaded.
	it("charges the full fan-out weight for a batch of renders", async () => {
		const rl = limiter(100);
		const r = await weightedRateLimit({ MCP_RATE_LIMITER: rl } as any, "u", {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "batch", arguments: { tool: "render", over: ["a", "b", "c"] } },
		} as any);
		expect(r).toBeNull();
		expect(rl.calls()).toBe(12); // 3 renders × 4 extra each
	});

	it("denies mid-way when a wide batch exhausts the budget", async () => {
		const rl = limiter(5); // 3 renders need 12 extra
		const r = await weightedRateLimit({ MCP_RATE_LIMITER: rl } as any, "u", {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "batch", arguments: { tool: "render", over: ["a", "b", "c"] } },
		} as any);
		expect(r!.status).toBe(429);
	});

	it("sums a pipe's step weights so a pipeline of renders can't slip the limiter", async () => {
		const rl = limiter(100);
		const r = await weightedRateLimit({ MCP_RATE_LIMITER: rl } as any, "u", {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "pipe", arguments: { steps: [{ tool: "render" }, { tool: "render" }] } },
		} as any);
		expect(r).toBeNull();
		expect(rl.calls()).toBe(8); // 2 render steps × 4 extra
	});

	it("charges the full fan-out weight even when a batch is reached via the `fn` escape", async () => {
		const rl = limiter(100);
		const r = await weightedRateLimit({ MCP_RATE_LIMITER: rl } as any, "u", fnCall("batch", { tool: "render", over: ["a", "b"] }));
		expect(r).toBeNull();
		expect(rl.calls()).toBe(8); // 2 renders × 4 extra, same as a direct batch call
	});

	it("charges the real leaf's weight even when the `fn` inner name is Unicode-obfuscated", async () => {
		const fullwidthRender = "ｒｅｎｄｅｒ"; // ｒｅｎｄｅｒ
		const zeroWidthRender = "ren​der";
		for (const obf of [fullwidthRender, zeroWidthRender]) {
			const rl = limiter(10);
			const r = await weightedRateLimit({ MCP_RATE_LIMITER: rl } as any, "u", fnCall(obf));
			expect(r).toBeNull();
			expect(rl.calls(), `obfuscated ${JSON.stringify(obf)} should charge render's 4 extra`).toBe(4);
		}
	});
});
