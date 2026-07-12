import { describe, expect, it } from "vitest";
import { extraCost, weightedRateLimit } from "./rate-limit";

describe("extraCost", () => {
	it("charges cost-1 extra tokens for weighted fns, 0 for default/unknown", () => {
		expect(extraCost("render")).toBe(4); // cost 5
		expect(extraCost("search")).toBe(2); // cost 3
		expect(extraCost("summarize")).toBe(1); // cost 2
		expect(extraCost("hash")).toBe(0); // default cost 1
		expect(extraCost("does_not_exist")).toBe(0);
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
});
