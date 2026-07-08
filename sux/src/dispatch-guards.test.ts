import { describe, expect, it } from "vitest";
import type { RtEnv, ToolResult } from "./registry";
import { extractRpcFromText, type JsonRpc } from "./mcp-util";
import { checkArgs, clampResult, handleRpc, withDeadline } from "./index";

// Dispatch-path safety rails (index.ts): the per-fn deadline, the output byte-cap,
// and the arg-size/depth guard. The deadline and byte-cap are unit-tested against a
// FAKE fn/result (no such pathological fn exists in FUNCTIONS), and the arg-guard is
// driven end-to-end through the real handleRpc dispatch with a real cacheable fn.

const ALLOWED = "octocat";

function makeKv() {
	const store = new Map<string, string>();
	const kv = {
		get: async (key: string) => store.get(key) ?? null,
		put: async (key: string, value: string) => void store.set(key, value),
		delete: async (key: string) => void store.delete(key),
	};
	return { store, kv };
}

function makeCtx() {
	const deferred: Promise<unknown>[] = [];
	return { deferred, ctx: { waitUntil: (p: Promise<unknown>) => void deferred.push(p) } as unknown as ExecutionContext };
}

function makeEnv(kv: ReturnType<typeof makeKv>["kv"]): RtEnv {
	return {
		OAUTH_KV: kv,
		ALLOWED_GITHUB_LOGIN: ALLOWED,
		MCP_RATE_LIMITER: { limit: async () => ({ success: true }) },
	} as unknown as RtEnv;
}

async function callRpc(env: RtEnv, ctx: ExecutionContext, rpc: JsonRpc): Promise<JsonRpc> {
	const res = await handleRpc(env, ctx, rpc);
	const rpcOut = extractRpcFromText(await res.text(), res.headers.get("content-type"));
	if (!rpcOut) throw new Error("no JSON-RPC in response body");
	return rpcOut;
}

describe("withDeadline (per-fn hard timeout)", () => {
	it("a slow fn is timed out into a clean isError result", async () => {
		// A fake fn whose run never settles — it would hang the isolate forever.
		const hang = new Promise<ToolResult>(() => {});
		const out = await withDeadline("slowfn", 15, hang);
		expect(out.isError).toBe(true);
		expect(out.content[0].text).toContain("slowfn");
		expect(out.content[0].text).toContain("timed out after 15ms");
	});

	it("a fn that resolves before the deadline wins the race unchanged", async () => {
		const fast = Promise.resolve<ToolResult>({ content: [{ type: "text", text: "OK" }] });
		const out = await withDeadline("fastfn", 10_000, fast);
		expect(out.isError).toBeFalsy();
		expect(out.content[0].text).toBe("OK");
	});

	it("a fn that rejects before the deadline propagates the rejection (caught upstream)", async () => {
		const boom = Promise.reject<ToolResult>(new Error("kaboom"));
		await expect(withDeadline("badfn", 10_000, boom)).rejects.toThrow("kaboom");
	});
});

describe("clampResult (output byte-cap)", () => {
	it("clamps oversized output and appends a truncation marker", async () => {
		const big: ToolResult = { content: [{ type: "text", text: "x".repeat(5000) }] };
		const out = clampResult(big, 1000);
		// First part is clamped to exactly the cap …
		expect(out.content[0].text.length).toBe(1000);
		// … and a trailing marker is appended describing the cap.
		const marker = out.content[out.content.length - 1].text;
		expect(marker).toContain("truncated");
		expect(marker).toContain("1000");
	});

	it("returns the same result untouched when within budget", async () => {
		const small: ToolResult = { content: [{ type: "text", text: "tiny" }] };
		const out = clampResult(small, 1000);
		expect(out).toBe(small); // same reference — no allocation on the common path
	});

	it("clamps across multiple text parts, preserving isError/noCache", async () => {
		const r: ToolResult = { content: [{ type: "text", text: "a".repeat(800) }, { type: "text", text: "b".repeat(800) }], isError: false, noCache: true };
		const out = clampResult(r, 1000);
		const total = out.content.filter((p) => !p.text.startsWith("\n")).reduce((n, p) => n + p.text.length, 0);
		expect(total).toBe(1000);
		expect(out.noCache).toBe(true);
	});
});

describe("checkArgs (arg-size / depth guard)", () => {
	it("passes normal args", () => {
		expect(checkArgs({ a: 1, b: "hello" }, 256_000, 64)).toBeNull();
		expect(checkArgs(undefined, 256_000, 64)).toBeNull();
	});

	it("rejects oversized args", () => {
		const reason = checkArgs({ blob: "z".repeat(2000) }, 1000, 64);
		expect(reason).toContain("too large");
	});

	it("rejects args nested past the depth limit without blowing the stack", () => {
		// Build a chain deeper than the limit; exceedsDepth must bail out early.
		let node: Record<string, unknown> = {};
		const root = node;
		for (let i = 0; i < 200; i++) {
			const next: Record<string, unknown> = {};
			node.next = next;
			node = next;
		}
		expect(checkArgs(root, 256_000, 64)).toContain("nested too deep");
	});
});

describe("arg-size guard end-to-end (handleRpc dispatch)", () => {
	it("rejects a tools/call whose JSON args are oversized, before the fn runs", async () => {
		const { kv, store } = makeKv();
		const { ctx, deferred } = makeCtx();
		const env = makeEnv(kv);
		// json is a real cacheable fn; a >256KB `data` arg is rejected up front, so the
		// fn never runs and nothing is cached.
		const out = await callRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "json", arguments: { data: JSON.stringify({ x: "q".repeat(300_000) }), from: "json" } },
		});
		expect(out.result.isError).toBe(true);
		expect(out.result.content[0].text).toContain("rejected");
		expect(out.result.content[0].text).toContain("too large");
		await Promise.all(deferred.splice(0));
		expect([...store.keys()].some((k) => k.startsWith("cache:"))).toBe(false);
	});
});
