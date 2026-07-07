import { describe, expect, it } from "vitest";
import type { RtEnv } from "./registry";
import { cacheKey, extractRpcFromText, type JsonRpc } from "./mcp-util";
import { handleRpc, oauthErrorResponse } from "./index";

// End-to-end coverage of the REAL tools/call dispatch chain in index.ts
// (parseJsonRpc → findFn → normalizeArgs/raw bypass → run → normalizeText →
// recordCall → deferCacheWrite → sseResponse), driven through the exported
// handleRpc that the production fetch path also calls. No OAuthProvider, no
// Request — just a fake env + ctx.

const ALLOWED = "octocat";

// Map-backed KV: get/put/delete over an in-memory store, mirroring the slice of
// the KVNamespace surface the dispatch chain and recordCall actually touch.
function makeKv() {
	const store = new Map<string, string>();
	const kv = {
		get: async (key: string) => store.get(key) ?? null,
		put: async (key: string, value: string) => void store.set(key, value),
		delete: async (key: string) => void store.delete(key),
	};
	return { store, kv };
}

// ctx whose waitUntil captures deferred promises so the test can await the
// off-response-path KV writes (deferCacheWrite + recordCall) before inspecting KV.
function makeCtx() {
	const deferred: Promise<unknown>[] = [];
	return { deferred, ctx: { waitUntil: (p: Promise<unknown>) => void deferred.push(p) } as unknown as ExecutionContext };
}

function makeEnv(kv: ReturnType<typeof makeKv>["kv"]): RtEnv {
	return {
		OAUTH_KV: kv,
		ALLOWED_GITHUB_LOGIN: ALLOWED,
		// A rate limiter that always allows; the gate lives in rtServer.fetch, not
		// handleRpc, but include it so the env shape is realistic.
		MCP_RATE_LIMITER: { limit: async () => ({ success: true }) },
	} as unknown as RtEnv;
}

// Decode the SSE body handleRpc returns back into a JSON-RPC envelope.
async function callRpc(env: RtEnv, ctx: ExecutionContext, rpc: JsonRpc): Promise<JsonRpc> {
	const res = await handleRpc(env, ctx, rpc);
	const rpcOut = extractRpcFromText(await res.text(), res.headers.get("content-type"));
	if (!rpcOut) throw new Error("no JSON-RPC in response body");
	return rpcOut;
}

describe("handleRpc (index.ts dispatch)", () => {
	it("initialize returns a well-formed result", async () => {
		const { kv } = makeKv();
		const { ctx } = makeCtx();
		const out = await callRpc(makeEnv(kv), ctx, { jsonrpc: "2.0", id: 1, method: "initialize" });
		expect(out.result.protocolVersion).toBe("2025-06-18");
		expect(out.result.serverInfo).toEqual({ name: "research-tools", version: "0.1.0" });
		expect(out.result.capabilities.tools).toEqual({ listChanged: false });
	});

	it("tools/list returns the fn list shape", async () => {
		const { kv } = makeKv();
		const { ctx } = makeCtx();
		const out = await callRpc(makeEnv(kv), ctx, { jsonrpc: "2.0", id: 2, method: "tools/list" });
		expect(Array.isArray(out.result.tools)).toBe(true);
		expect(out.result.tools.length).toBeGreaterThan(0);
		for (const t of out.result.tools) {
			expect(typeof t.name).toBe("string");
			expect(typeof t.description).toBe("string");
			expect("inputSchema" in t).toBe(true);
		}
		expect(out.result.tools.some((t: { name: string }) => t.name === "hash")).toBe(true);
	});

	it("unknown tool name → JSON-RPC error -32601", async () => {
		const { kv } = makeKv();
		const { ctx } = makeCtx();
		const out = await callRpc(makeEnv(kv), ctx, {
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "not_a_real_tool", arguments: {} },
		});
		expect(out.error.code).toBe(-32601);
		expect(out.error.message).toContain("not_a_real_tool");
	});

	it("a cacheable fn called twice with identical args is served from the KV cache", async () => {
		const { kv, store } = makeKv();
		const { ctx, deferred } = makeCtx();
		const env = makeEnv(kv);
		const rpc: JsonRpc = {
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: { name: "json", arguments: { data: '{"a":1}', from: "json" } },
		};

		const first = await callRpc(env, ctx, rpc);
		expect(JSON.parse(first.result.content[0].text)).toEqual({ a: 1 });
		// Let the deferred cache write land.
		await Promise.all(deferred.splice(0));

		// A cache entry now exists; break run() so the only way to still succeed is
		// the cache read path.
		const cacheKeys = [...store.keys()].filter((k) => k.startsWith("cache:"));
		expect(cacheKeys.length).toBe(1);
		store.set(cacheKeys[0], JSON.stringify({ content: [{ type: "text", text: "FROM_CACHE" }] }));

		const second = await callRpc(env, ctx, rpc);
		expect(second.result.content[0].text).toBe("FROM_CACHE"); // served from KV, run() not re-executed
	});

	it("fresh:true bypasses the cache READ but still rewrites the same entry", async () => {
		const { kv, store } = makeKv();
		const { ctx, deferred } = makeCtx();
		const env = makeEnv(kv);
		const args = { data: '{"a":1}', from: "json" };
		const base: JsonRpc = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "json", arguments: { ...args } } };

		// (a) First call caches, then overwrite the entry with a sentinel and prove
		// a plain (no-fresh) call is served from that sentinel — the baseline.
		const first = await callRpc(env, ctx, base);
		expect(JSON.parse(first.result.content[0].text)).toEqual({ a: 1 });
		await Promise.all(deferred.splice(0));

		const cacheKeys = [...store.keys()].filter((k) => k.startsWith("cache:"));
		expect(cacheKeys.length).toBe(1);
		const key = cacheKeys[0];
		const sentinel = JSON.stringify({ content: [{ type: "text", text: "STALE_SENTINEL" }] });
		store.set(key, sentinel);

		const cached = await callRpc(env, ctx, { ...base, params: { name: "json", arguments: { ...args } } });
		expect(cached.result.content[0].text).toBe("STALE_SENTINEL"); // served from KV

		// (b) Now call with fresh:true — the read is bypassed so run() executes and
		// returns the real result, NOT the sentinel; the fn never sees `fresh`.
		const fresh = await callRpc(env, ctx, { ...base, params: { name: "json", arguments: { ...args, fresh: true } } });
		expect(JSON.parse(fresh.result.content[0].text)).toEqual({ a: 1 });
		expect(fresh.result.content[0].text).not.toContain("STALE_SENTINEL");

		// The fresh result overwrote the SAME cache entry (identical key, no divergent
		// second entry), replacing the sentinel with the freshly-computed value.
		await Promise.all(deferred.splice(0));
		expect([...store.keys()].filter((k) => k.startsWith("cache:"))).toEqual([key]);
		expect(JSON.parse(JSON.parse(store.get(key)!).content[0].text)).toEqual({ a: 1 });
		expect(store.get(key)).not.toBe(sentinel);
	});

	it("fresh is stripped before the fn runs, so the cache key is identical to a plain call", async () => {
		const { kv, store } = makeKv();
		const { ctx, deferred } = makeCtx();
		const env = makeEnv(kv);
		const args = { data: '{"b":2}', from: "json" };
		// The key a plain (no-fresh) call would hash — computed from the stripped args.
		const plainKey = await cacheKey("json", args);

		// A fresh:true call: succeeds normally (fn ignored no unknown key) and writes
		// under exactly plainKey — proving `fresh` was removed before cacheKey and
		// before run() (a leaked `fresh` would change the hashed args → a different key).
		const out = await callRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 8,
			method: "tools/call",
			params: { name: "json", arguments: { ...args, fresh: true } },
		});
		expect(out.result.isError).toBeFalsy();
		expect(JSON.parse(out.result.content[0].text)).toEqual({ b: 2 });
		await Promise.all(deferred.splice(0));
		expect([...store.keys()].filter((k) => k.startsWith("cache:"))).toEqual([plainKey]);
	});

	it("an isError result is not written to KV", async () => {
		const { kv, store } = makeKv();
		const { ctx, deferred } = makeCtx();
		const env = makeEnv(kv);
		// json fails (returns isError) on malformed source data.
		const out = await callRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 5,
			method: "tools/call",
			params: { name: "json", arguments: { data: "{not valid", from: "json" } },
		});
		expect(out.result.isError).toBe(true);
		await Promise.all(deferred.splice(0));
		expect([...store.keys()].some((k) => k.startsWith("cache:"))).toBe(false);
	});

	it("a raw fn bypasses unicode normalization of its args", async () => {
		const { kv } = makeKv();
		const { ctx, deferred } = makeCtx();
		const env = makeEnv(kv);
		// hash is raw + cacheable. A zero-width space (U+200B) would be stripped by
		// normalizeArgs for a non-raw fn; because hash is raw, the ZWSP reaches run()
		// intact and the digest differs from the ZWSP-stripped input.
		const withZwsp = "a\u200Bb";
		const stripped = "ab";
		const call = (text: string) =>
			callRpc(env, ctx, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "hash", arguments: { text } } });

		const hZwsp = (await call(withZwsp)).result.content[0].text;
		await Promise.all(deferred.splice(0));
		const hStripped = (await call(stripped)).result.content[0].text;
		await Promise.all(deferred.splice(0));

		// Independently compute the expected digest of the raw (ZWSP-bearing) bytes.
		const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(withZwsp));
		const expected = Array.from(new Uint8Array(buf))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		expect(hZwsp).toBe(expected); // the ZWSP survived to run() unmodified
		expect(hZwsp).not.toBe(hStripped); // and it materially changed the output
	});
});

describe("oauthErrorResponse (server_error must not leak internal detail)", () => {
	it("returns an opaque 500 for a non-client error, keeping the real message out of the body", async () => {
		const secret = "TypeError: cannot read properties of undefined (reading 'access_token') at fetchUpstreamAuthToken";
		const res = oauthErrorResponse(new Error(secret));
		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe("server_error");
		expect(body.error_description).toBe("Internal server error.");
		expect(body.error_description).not.toContain("access_token");
		expect(body.error_description).not.toContain("fetchUpstreamAuthToken");
		expect(JSON.stringify(body)).not.toContain(secret);
	});

	it("still echoes the message for a client-side mistake (400)", async () => {
		const res = oauthErrorResponse(new Error("invalid redirect_uri: not registered"));
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.error).toBe("invalid_request");
		expect(body.error_description).toContain("redirect_uri");
	});
});

describe("summarize-before-return meta-arg", () => {
	it("replaces the output with an AI summary, caches it apart from raw, skips raw fns", async () => {
		const { kv, store } = makeKv();
		const { ctx, deferred } = makeCtx();
		const env = { ...makeEnv(kv), AI: { run: async () => ({ response: "AI SUMMARY" }) } } as any;
		const bigData = JSON.stringify({ note: "x".repeat(600) });
		const base = { jsonrpc: "2.0", id: 1, method: "tools/call" } as const;

		// summarize:true → the AI summary is returned instead of the full conversion
		const summ = await callRpc(env, ctx, { ...base, params: { name: "json", arguments: { data: bigData, to: "yaml", summarize: true } } });
		expect(summ.result.content[0].text).toBe("AI SUMMARY");
		await Promise.all(deferred);

		// same call without summarize → the real (long) conversion, not the summary
		const raw = await callRpc(env, ctx, { ...base, params: { name: "json", arguments: { data: bigData, to: "yaml" } } });
		expect(raw.result.content[0].text).not.toBe("AI SUMMARY");
		expect(raw.result.content[0].text).toContain("xxxx");
		await Promise.all(deferred);

		// summarized and raw results cache under distinct keys (::summarize namespace)
		expect([...store.keys()].filter((k) => k.startsWith("cache:")).length).toBe(2);
	});

	it("returns the raw result when AI isn't configured (best-effort)", async () => {
		const { kv } = makeKv();
		const { ctx } = makeCtx();
		const env = makeEnv(kv); // no AI binding
		const bigData = JSON.stringify({ note: "y".repeat(600) });
		const out = await callRpc(env, ctx, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "json", arguments: { data: bigData, to: "yaml", summarize: true } } });
		expect(out.result.content[0].text).toContain("yyyy"); // unchanged
	});
});
