import { describe, expect, it, vi } from "vitest";
import type { Fn, RtEnv } from "./registry";
import { cacheKey, extractRpcFromText, type JsonRpc } from "./mcp-util";
import { FUNCTIONS } from "./fns";
import worker, { handleRpc, oauthErrorResponse, rtServer } from "./index";
import { readMetrics } from "./metrics";

// scheduled() wiring tests spy on shipMetricsSnapshot (never actually reaches the
// network without GRAFANA_PROM_* secrets, but the spy lets us assert it was called on
// both cron branches) and stub out web_search_selftest's real network probes (the only
// daily sub-job that isn't fail-closed without config — see _web_search_selftest.ts).
vi.mock("./grafana", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./grafana")>();
	return { ...actual, shipMetricsSnapshot: vi.fn(actual.shipMetricsSnapshot) };
});
vi.mock("./fns/_web_search_selftest", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./fns/_web_search_selftest")>();
	return { ...actual, runWebSearchSelftest: vi.fn(async () => ({ probes: [] })) };
});

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
	// Soft-TTL markers live in KV metadata (not the value), so keep them in a side map
	// keyed identically. `store` stays a Map<string,string> so existing tests that seed
	// or read plain-JSON values directly are undisturbed; entries seeded without
	// metadata read back as legacy (fresh), matching production's backward-compat path.
	const meta = new Map<string, { softExpiresAt: number }>();
	const kv = {
		get: async (key: string) => store.get(key) ?? null,
		getWithMetadata: async (key: string) => ({ value: store.get(key) ?? null, metadata: meta.get(key) ?? null }),
		put: async (key: string, value: string, opts?: { metadata?: { softExpiresAt: number } }) => {
			store.set(key, value);
			if (opts?.metadata) meta.set(key, opts.metadata);
			else meta.delete(key);
		},
		delete: async (key: string) => {
			store.delete(key);
			meta.delete(key);
		},
		// Cursor = a plain numeric offset into the sorted keyspace — good enough for
		// tests exercising tasks/list's pass-through pagination (KV's real cursor is
		// an opaque token; we don't need to mimic its encoding, just its contract).
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
	return { store, meta, kv };
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

	it("tools/list returns only the front verbs, not every leaf", async () => {
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
		const names = out.result.tools.map((t: { name: string }) => t.name);
		// Front verbs advertised…
		expect(names).toContain("sux");
		expect(names).toContain("fn");
		expect(names).toContain("search");
		// …leaves hidden from the list (still reachable via `fn` or by name).
		expect(names).not.toContain("hash");
		// The list stays legible — far short of the full ~110-fn surface. (Headroom for the
		// agent front verbs `proposals`/`agenda`; still a small legible subset.)
		expect(out.result.tools.length).toBeLessThan(FUNCTIONS.length);
		expect(out.result.tools.length).toBeLessThanOrEqual(24);
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

	it("rejects multi-byte-UTF-8 args whose byte size exceeds the cap even though its UTF-16 code-unit length reads under it", async () => {
		const { kv } = makeKv();
		const { ctx } = makeCtx();
		// 100k CJK chars: ~100k UTF-16 code units (under the 256k-byte cap by length)
		// but ~300k UTF-8 bytes (over it) — the exact gap String.length misses.
		const text = "国".repeat(100_000);
		const out = await callRpc(makeEnv(kv), ctx, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "hash", arguments: { text } } });
		expect(out.result.isError).toBe(true);
		expect(out.result.content[0].text).toMatch(/too large/);
	});

	// The `fn` escape hatch: fn({name, args}) reaches any hidden leaf and must behave
	// exactly like a direct call — same output, same cache entry.
	it("fn escape dispatches to a leaf identically to a direct call", async () => {
		const { kv } = makeKv();
		const { ctx, deferred } = makeCtx();
		const env = makeEnv(kv);
		const direct = await callRpc(env, ctx, { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "hash", arguments: { text: "front-door" } } });
		const viaFn = await callRpc(env, ctx, { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "fn", arguments: { name: "hash", args: { text: "front-door" } } } });
		await Promise.all(deferred);
		expect(viaFn.result.isError).toBeFalsy();
		expect(viaFn.result.content[0].text).toBe(direct.result.content[0].text);
		// Byte-identical dispatch ⇒ shared cache key: both wrote the same one entry.
		const key = await cacheKey("hash", { text: "front-door" });
		expect(kv.get(key)).resolves.not.toBeNull();
	});

	it("fn escape with an unknown inner name returns a typed not_found error", async () => {
		const { kv } = makeKv();
		const { ctx } = makeCtx();
		const out = await callRpc(makeEnv(kv), ctx, { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "fn", arguments: { name: "not_a_real_leaf", args: {} } } });
		// Falls through to the `fn` fn's own run (name not unwrapped) → typed failure,
		// NOT a JSON-RPC -32601 (the `fn` tool itself exists and ran).
		expect(out.result.isError).toBe(true);
		expect(out.result.content[0].text).toContain("[not_found]");
	});

	it("fn escape without a name returns a typed bad_input error", async () => {
		const { kv } = makeKv();
		const { ctx } = makeCtx();
		const out = await callRpc(makeEnv(kv), ctx, { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "fn", arguments: {} } });
		expect(out.result.isError).toBe(true);
		expect(out.result.content[0].text).toContain("[bad_input]");
	});

	it("fn escape cannot recurse into itself", async () => {
		const { kv } = makeKv();
		const { ctx } = makeCtx();
		const out = await callRpc(makeEnv(kv), ctx, { jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "fn", arguments: { name: "fn", args: {} } } });
		expect(out.result.isError).toBe(true);
		expect(out.result.content[0].text).toContain("cannot call itself");
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

	it("a coalesced burst of identical cacheable calls schedules exactly one cache write", async () => {
		// Gate every KV read so all N concurrent callers park BEFORE any reaches
		// singleFlight — guaranteeing they coalesce onto one leader. Count only the
		// cache: writes (metrics writes go to sux:metrics:* shards).
		const store = new Map<string, string>();
		let waiting = 0;
		let releaseGet!: () => void;
		const gate = new Promise<void>((r) => (releaseGet = r));
		let cachePuts = 0;
		const kv = {
			get: async (key: string) => store.get(key) ?? null,
			// The dispatch cache read goes through getWithMetadata; gate it so all N
			// concurrent callers park here BEFORE any reaches singleFlight.
			getWithMetadata: async (key: string) => {
				waiting++;
				await gate;
				return { value: store.get(key) ?? null, metadata: null };
			},
			put: async (key: string, value: string) => {
				if (key.startsWith("cache:")) cachePuts++;
				store.set(key, value);
			},
			delete: async (key: string) => void store.delete(key),
		};
		const { ctx, deferred } = makeCtx();
		const env = makeEnv(kv as unknown as ReturnType<typeof makeKv>["kv"]);
		const rpc: JsonRpc = {
			jsonrpc: "2.0",
			id: 9,
			method: "tools/call",
			params: { name: "json", arguments: { data: '{"a":1}', from: "json" } },
		};

		const N = 4;
		const calls = Array.from({ length: N }, () => callRpc(env, ctx, rpc));
		// Wait until all N are parked at the gated read, then release them together.
		while (waiting < N) await new Promise((r) => setTimeout(r, 0));
		releaseGet();

		const outs = await Promise.all(calls);
		await Promise.all(deferred.splice(0));

		// Every coalesced caller got the correct result …
		for (const o of outs) expect(JSON.parse(o.result.content[0].text)).toEqual({ a: 1 });
		// … but the close path ran once: a single KV write for the whole group, not N.
		expect(cachePuts).toBe(1);
		expect([...store.keys()].filter((k) => k.startsWith("cache:")).length).toBe(1);
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

	it("fresh:false is stripped too, so it doesn't fragment the cache key or leak into the fn", async () => {
		const { kv, store } = makeKv();
		const { ctx, deferred } = makeCtx();
		const env = makeEnv(kv);
		const args = { data: '{"c":3}', from: "json" };
		// The key a plain (no-meta-arg) call hashes.
		const plainKey = await cacheKey("json", args);

		// An explicit fresh:false must behave exactly like a plain call: stripped
		// before cacheKey + run. A leaked falsy `fresh` would both change the hashed
		// args → a divergent key AND reach the fn as an unknown argument.
		const out = await callRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 10,
			method: "tools/call",
			params: { name: "json", arguments: { ...args, fresh: false } },
		});
		expect(out.result.isError).toBeFalsy();
		expect(JSON.parse(out.result.content[0].text)).toEqual({ c: 3 });
		await Promise.all(deferred.splice(0));
		expect([...store.keys()].filter((k) => k.startsWith("cache:"))).toEqual([plainKey]);
	});

	it("summarize:false is stripped, caching under the plain key (no ::summarize namespace)", async () => {
		const { kv, store } = makeKv();
		const { ctx, deferred } = makeCtx();
		const env = makeEnv(kv);
		const args = { data: '{"d":4}', from: "json" };
		const plainKey = await cacheKey("json", args);

		// summarize:false must NOT namespace the key (::summarize) nor reach the fn —
		// it caches under exactly the plain key, identical to a call with no meta-arg.
		const out = await callRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 11,
			method: "tools/call",
			params: { name: "json", arguments: { ...args, summarize: false } },
		});
		expect(JSON.parse(out.result.content[0].text)).toEqual({ d: 4 });
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

describe("stale-while-revalidate cache reads", () => {
	// json is a real cacheable fn: {data:'{"a":1}', from:"json"} -> a result whose
	// text is JSON.stringify({a:1}). We seed a hand-built cache entry whose SOFT TTL
	// marker (KV metadata) is either past (stale) or in the future (fresh) and assert
	// the read path serves it immediately, refreshing in the background only when stale.
	const args = { data: '{"a":1}', from: "json" };
	const seedResult = (text: string) => JSON.stringify({ content: [{ type: "text", text }] });
	// Drain deferred to a fixed point: a background refresh schedules its own nested
	// KV put via ctx.waitUntil, so one splice isn't enough to settle everything.
	const drain = async (deferred: Promise<unknown>[]) => {
		while (deferred.length) await Promise.all(deferred.splice(0));
	};

	it("serves a stale entry immediately and schedules a background refresh", async () => {
		const { kv, store, meta } = makeKv();
		const { ctx, deferred } = makeCtx();
		const env = makeEnv(kv);
		const key = await cacheKey("json", args);
		// A cached entry whose soft TTL already lapsed (but not yet KV-evicted).
		store.set(key, seedResult("STALE_VALUE"));
		meta.set(key, { softExpiresAt: Date.now() - 1000 });

		const out = await callRpc(env, ctx, { jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "json", arguments: { ...args } } });
		// Served the stale value IMMEDIATELY — not the freshly-recomputed {a:1}.
		expect(out.result.content[0].text).toBe("STALE_VALUE");

		// The background refresh recomputed and rewrote the SAME entry: the stale value
		// is gone, replaced by the real conversion, and the soft marker is pushed forward.
		await drain(deferred);
		expect(store.get(key)).not.toContain("STALE_VALUE");
		expect(JSON.parse(JSON.parse(store.get(key)!).content[0].text)).toEqual({ a: 1 });
		expect(meta.get(key)!.softExpiresAt).toBeGreaterThan(Date.now());
	});

	it("serves a fresh entry directly with no background refresh", async () => {
		const { kv, store, meta } = makeKv();
		const { ctx, deferred } = makeCtx();
		const env = makeEnv(kv);
		const key = await cacheKey("json", args);
		// A cached entry still within its soft TTL.
		store.set(key, seedResult("FRESH_VALUE"));
		meta.set(key, { softExpiresAt: Date.now() + 60_000 });

		const out = await callRpc(env, ctx, { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "json", arguments: { ...args } } });
		expect(out.result.content[0].text).toBe("FRESH_VALUE");

		// No refresh ran: the entry is untouched (still the seeded value, not {a:1}).
		await drain(deferred);
		expect(JSON.parse(store.get(key)!).content[0].text).toBe("FRESH_VALUE");
	});

	it("treats a legacy entry with no soft marker as fresh (no refresh)", async () => {
		const { kv, store } = makeKv();
		const { ctx, deferred } = makeCtx();
		const env = makeEnv(kv);
		const key = await cacheKey("json", args);
		// Pre-SWR entry: value only, no metadata written.
		store.set(key, seedResult("LEGACY_VALUE"));

		const out = await callRpc(env, ctx, { jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "json", arguments: { ...args } } });
		expect(out.result.content[0].text).toBe("LEGACY_VALUE");

		await drain(deferred);
		expect(JSON.parse(store.get(key)!).content[0].text).toBe("LEGACY_VALUE");
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

	it("still echoes the message for a genuine OAuthError (400) — classified by type, not by keyword", async () => {
		const { OAuthError } = await import("./workers-oauth-utils");
		const res = oauthErrorResponse(new OAuthError("invalid_request", "invalid redirect_uri: not registered"));
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.error).toBe("invalid_request");
		expect(body.error_description).toContain("redirect_uri");
	});

	it("does NOT classify a plain Error as client-side just because its message contains a common keyword like 'state' or 'invalid'", async () => {
		const secret = "KV put failed for client abc123: invalid signature at endpoint https://internal-kv.example/state";
		const res = oauthErrorResponse(new Error(secret));
		expect(res.status).toBe(500);
		const body = (await res.json()) as any;
		expect(body.error).toBe("server_error");
		expect(JSON.stringify(body)).not.toContain(secret);
	});

	it("forwards an OAuthError's headers (e.g. Retry-After) onto the Response", async () => {
		const err = Object.assign(new Error("upstream rate limited"), {
			name: "OAuthError",
			code: "temporarily_unavailable",
			description: "upstream rate limited",
			statusCode: 429,
			headers: { "Retry-After": "60" },
		});
		const res = oauthErrorResponse(err);
		expect(res.status).toBe(429);
		expect(res.headers.get("Retry-After")).toBe("60");
		const body = (await res.json()) as any;
		expect(body.error).toBe("temporarily_unavailable");
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
		const summ = await callRpc(env, ctx, { ...base, params: { name: "json", arguments: { data: bigData, summarize: true } } });
		expect(summ.result.content[0].text).toBe("AI SUMMARY");
		await Promise.all(deferred);

		// same call without summarize → the real (long) conversion, not the summary
		const raw = await callRpc(env, ctx, { ...base, params: { name: "json", arguments: { data: bigData } } });
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
		const out = await callRpc(env, ctx, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "json", arguments: { data: bigData, summarize: true } } });
		expect(out.result.content[0].text).toContain("yyyy"); // unchanged
	});

	// Adversarial: the egress-context bleed. Two concurrent tools/call requests share
	// ONE isolate env; the per-call reqId/ctx must be threaded per-request, not parked
	// on the shared env (where the second request would overwrite the first's).
	it("threads egress per-request — concurrent calls keep distinct reqIds, shared env untouched", async () => {
		// Probe fn: reads its env's reqId, holds at a barrier until BOTH requests are
		// concurrently inside run() (the exact window a shared-env _egress would clobber),
		// then re-reads. Per-request threading ⇒ the reqId is stable across the barrier
		// and distinct between the two requests; the shared env is never mutated.
		let release!: () => void;
		const barrier = new Promise<void>((r) => (release = r));
		let inRun = 0;
		const seen: Array<{ before: unknown; after: unknown }> = [];
		const probe: Fn = {
			name: "__egress_probe",
			cost: 0,
			description: "test probe",
			inputSchema: { type: "object", additionalProperties: true, properties: {} },
			cacheable: false,
			run: async (env: RtEnv) => {
				const before = env._egress?.reqId;
				if (++inRun === 2) release();
				await barrier;
				const after = env._egress?.reqId;
				seen.push({ before, after });
				return { content: [{ type: "text" as const, text: String(after) }] };
			},
		};
		FUNCTIONS.push(probe);
		try {
			const sharedEnv = makeEnv(makeKv().kv); // ONE env object, both requests
			const { ctx } = makeCtx();
			const fire = (id: number) => callRpc(sharedEnv, ctx, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "__egress_probe", arguments: {} } });
			await Promise.all([fire(1), fire(2)]);
			expect(seen).toHaveLength(2);
			for (const s of seen) {
				expect(typeof s.after).toBe("string");
				expect(s.after).toBe(s.before); // no mid-run clobber from the sibling request
			}
			expect(seen[0].after).not.toBe(seen[1].after); // distinct correlation ids — no bleed
			expect((sharedEnv as unknown as { _egress?: unknown })._egress).toBeUndefined(); // shared env never mutated
		} finally {
			FUNCTIONS.splice(FUNCTIONS.indexOf(probe), 1);
		}
	});
});

// The runtime discovery manifest lives in rtServer.fetch (upstream of handleRpc), so
// drive it through the gate directly. The per-domain /vault/mcp · /mail/mcp · /files/mcp
// routes are fully retired — a single /mcp front door remains.
describe("rtServer.fetch — connector manifest (one front door)", () => {
	const gateCtx = () => ({ waitUntil: () => {}, props: { login: ALLOWED } }) as unknown as Parameters<typeof rtServer.fetch>[2];

	type Manifest = { name: string; connectors: Array<{ name: string; url: string; tools: number | null }> };

	it("GET /mcp/connectors surfaces the one sux connector with its live count", async () => {
		const { kv } = makeKv();
		const res = await rtServer.fetch(new Request("https://sux.example.dev/mcp/connectors"), makeEnv(kv), gateCtx());
		expect(res.status).toBe(200);
		const body = (await res.json()) as Manifest;
		expect(body.name).toBe("sux");
		expect(body.connectors).toHaveLength(1);
		expect(body.connectors[0]).toMatchObject({ name: "sux", url: "https://sux.example.dev/mcp" });
		expect(typeof body.connectors[0].tools).toBe("number"); // live count folded in
		expect(body.connectors.find((c) => c.name === "vault")).toBeUndefined();
	});

	it("GET /mcp/connectors?all=1 no longer surfaces any retired extras", async () => {
		const { kv } = makeKv();
		const res = await rtServer.fetch(new Request("https://sux.example.dev/mcp/connectors?all=1"), makeEnv(kv), gateCtx());
		expect(res.status).toBe(200);
		const body = (await res.json()) as Manifest;
		expect(body.connectors).toHaveLength(1);
		expect(body.connectors.map((c) => c.name)).toEqual(["sux"]);
	});

	// Regression guard: the retired routes no longer dispatch to a personal-namespace
	// handler — they fall through to the one research-tools front door like any other path.
	it.each([["/vault/mcp"], ["/mail/mcp"], ["/files/mcp"]])("POST initialize to retired %s no longer routes to a namespace handler", async (path) => {
		const { kv } = makeKv();
		const req = new Request(`https://sux.example.dev${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
		});
		const res = await rtServer.fetch(req, makeEnv(kv), gateCtx());
		expect(res.status).toBe(200);
		const rpc = extractRpcFromText(await res.text(), res.headers.get("content-type"));
		expect(["vault", "mail", "files"]).not.toContain(rpc?.result.serverInfo.name);
		expect(rpc?.result.serverInfo.name).toBe("research-tools");
	});
});

// The auth-allowlist + rate-limit gate in rtServer.fetch, upstream of both the
// manifest short-circuit and handleRpc — only the happy path (props.login ===
// ALLOWED) was previously exercised anywhere in this file.
describe("rtServer.fetch — auth/rate-limit gate (403/429)", () => {
	const ctxFor = (props?: { login?: string }) => ({ waitUntil: () => {}, props }) as unknown as Parameters<typeof rtServer.fetch>[2];
	const rpcRequest = () =>
		new Request("https://sux.example.dev/mcp", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
		});

	it("403s a login outside the allowlist", async () => {
		const { kv } = makeKv();
		const res = await rtServer.fetch(rpcRequest(), makeEnv(kv), ctxFor({ login: "not-allowed" }));
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "forbidden" });
	});

	it("403s when props carries no login at all", async () => {
		const { kv } = makeKv();
		const res = await rtServer.fetch(rpcRequest(), makeEnv(kv), ctxFor(undefined));
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "forbidden" });
	});

	it("429s an allowed login once the rate limiter says no, with a retry-after hint", async () => {
		const { kv } = makeKv();
		const env = { ...makeEnv(kv), MCP_RATE_LIMITER: { limit: async () => ({ success: false }) } } as unknown as RtEnv;
		const res = await rtServer.fetch(rpcRequest(), env, ctxFor({ login: ALLOWED }));
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({ error: "rate_limited" });
		expect(res.headers.get("retry-after")).toBe("10");
	});

	it("fails OPEN (does not block) when the rate limiter itself throws", async () => {
		const { kv } = makeKv();
		const env = {
			...makeEnv(kv),
			MCP_RATE_LIMITER: {
				limit: async () => {
					throw new Error("limiter unavailable");
				},
			},
		} as unknown as RtEnv;
		const res = await rtServer.fetch(rpcRequest(), env, ctxFor({ login: ALLOWED }));
		expect(res.status).toBe(200);
	});
});

// MCP Tasks primitive (src/tasks.ts) — task-augmented tools/call, plus
// tasks/get, tasks/result, tasks/list, tasks/cancel, all driven through the
// real handleRpc dispatch (same helpers as the rest of this file).
describe("MCP Tasks primitive", () => {
	it("initialize advertises the tasks capability", async () => {
		const { kv } = makeKv();
		const { ctx } = makeCtx();
		const out = await callRpc(makeEnv(kv), ctx, { jsonrpc: "2.0", id: 1, method: "initialize" });
		expect(out.result.capabilities.tasks).toEqual({ list: {}, cancel: {}, requests: { tools: { call: {} } } });
	});

	it("tools/list tags task-capable tools with execution.taskSupport, leaves the rest untagged", async () => {
		const { kv } = makeKv();
		const { ctx } = makeCtx();
		const out = await callRpc(makeEnv(kv), ctx, { jsonrpc: "2.0", id: 2, method: "tools/list" });
		const byName = Object.fromEntries(out.result.tools.map((t: { name: string; execution?: unknown }) => [t.name, t.execution]));
		expect(byName.pipe).toEqual({ taskSupport: "optional" });
		expect(byName.batch).toEqual({ taskSupport: "optional" });
		expect(byName.sux).toBeUndefined();
		expect(byName.search).toBeUndefined();
	});

	it("a task-augmented call to a non-task-capable tool is refused with -32601", async () => {
		const { kv } = makeKv();
		const { ctx } = makeCtx();
		const out = await callRpc(makeEnv(kv), ctx, {
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "hash", arguments: { text: "x" }, task: {} },
		});
		expect(out.error?.code).toBe(-32601);
	});

	it("a task-augmented call to a capable tool returns a CreateTaskResult, then completes and is retrievable", async () => {
		const { kv } = makeKv();
		const { ctx, deferred } = makeCtx();
		const create = await callRpc(makeEnv(kv), ctx, {
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: { name: "pipe", arguments: { steps: [{ tool: "hash", args: { text: "task-me" } }] }, task: { ttl: 60_000 } },
		});
		expect(create.result.task).toBeDefined();
		expect(create.result.task.status).toBe("working");
		expect(typeof create.result.task.taskId).toBe("string");
		expect(create.result.task.ttl).toBe(60_000);
		const taskId = create.result.task.taskId;

		// Let the ctx.waitUntil-scheduled run (and its KV writes) settle.
		await Promise.all(deferred.splice(0));
		await Promise.all(deferred.splice(0));

		const got = await callRpc(makeEnv(kv), ctx, { jsonrpc: "2.0", id: 5, method: "tasks/get", params: { taskId } });
		expect(got.result.status).toBe("completed");
		expect(got.result).not.toHaveProperty("result"); // tasks/get never leaks the payload

		const result = await callRpc(makeEnv(kv), ctx, { jsonrpc: "2.0", id: 6, method: "tasks/result", params: { taskId } });
		expect(result.result.isError).toBeFalsy();
		expect(typeof result.result.content[0].text).toBe("string");
		expect(result.result._meta).toEqual({ "io.modelcontextprotocol/related-task": { taskId } });
	});

	it("records the REAL terminal outcome in metrics once, not a fake ms:0 success at task creation", async () => {
		const { kv } = makeKv();
		const { ctx, deferred } = makeCtx();
		const env = makeEnv(kv);
		const create = await callRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 12,
			method: "tools/call",
			params: { name: "pipe", arguments: { steps: [{ tool: "hash", args: { text: "metrics-me" } }] }, task: { ttl: 60_000 } },
		});
		expect(create.result.task.status).toBe("working");

		// Nothing recorded yet at creation time — recordCall/shipToLoki must not fire
		// until fn.run actually settles (the bug: a fake {ms:0, error:false} landed here).
		const beforeSettle = await readMetrics(env);
		expect(beforeSettle.total).toBe(0);
		expect(beforeSettle.tools.pipe).toBeUndefined();

		// Let the background run (and finishTask's recordCall/shipToLoki) settle.
		await Promise.all(deferred.splice(0));
		await Promise.all(deferred.splice(0));
		await Promise.all(deferred.splice(0));

		const after = await readMetrics(env);
		expect(after.total).toBe(1); // recorded exactly once, at settle time
		expect(after.tools.pipe).toBeDefined();
		expect(after.tools.pipe.calls).toBe(1);
		expect(after.tools.pipe.errors).toBe(0);
		expect(after.recent[0].tool).toBe("pipe");
		expect(after.recent[0].error).toBe(false);
	});

	it("tasks/get on an unknown taskId is a -32602 error", async () => {
		const { kv } = makeKv();
		const { ctx } = makeCtx();
		const out = await callRpc(makeEnv(kv), ctx, { jsonrpc: "2.0", id: 7, method: "tasks/get", params: { taskId: "nope" } });
		expect(out.error?.code).toBe(-32602);
	});

	it("tasks/cancel flips a working task to cancelled, and refuses a second cancel", async () => {
		const { kv } = makeKv();
		const { ctx, deferred } = makeCtx();
		const create = await callRpc(makeEnv(kv), ctx, {
			jsonrpc: "2.0",
			id: 8,
			method: "tools/call",
			params: { name: "batch", arguments: { tool: "hash", calls: [{ text: "a" }] }, task: {} },
		});
		const taskId = create.result.task.taskId;

		const cancelled = await callRpc(makeEnv(kv), ctx, { jsonrpc: "2.0", id: 9, method: "tasks/cancel", params: { taskId } });
		expect(cancelled.result.status).toBe("cancelled");

		const again = await callRpc(makeEnv(kv), ctx, { jsonrpc: "2.0", id: 10, method: "tasks/cancel", params: { taskId } });
		expect(again.error?.code).toBe(-32602);

		// The batch run keeps executing and settling in the background, but its
		// result must never overwrite the cancelled status.
		await Promise.all(deferred.splice(0));
		const after = await callRpc(makeEnv(kv), ctx, { jsonrpc: "2.0", id: 11, method: "tasks/get", params: { taskId } });
		expect(after.result.status).toBe("cancelled");
	});

	it("tasks/list paginates via cursor and only ever returns the public task shape", async () => {
		const { kv } = makeKv();
		const { ctx, deferred } = makeCtx();
		for (let i = 0; i < 3; i++) {
			await callRpc(makeEnv(kv), ctx, {
				jsonrpc: "2.0",
				id: 100 + i,
				method: "tools/call",
				params: { name: "batch", arguments: { tool: "hash", calls: [{ text: String(i) }] }, task: {} },
			});
		}
		await Promise.all(deferred.splice(0));

		const page1 = await callRpc(makeEnv(kv), ctx, { jsonrpc: "2.0", id: 200, method: "tasks/list", params: { limit: 2 } });
		expect(page1.result.tasks.length).toBe(2);
		expect(page1.result.nextCursor).toBeDefined();
		for (const t of page1.result.tasks) expect(t).not.toHaveProperty("result");

		const page2 = await callRpc(makeEnv(kv), ctx, { jsonrpc: "2.0", id: 201, method: "tasks/list", params: { cursor: page1.result.nextCursor, limit: 2 } });
		expect(page2.result.tasks.length).toBe(1);
	});
});

// The two Cloudflare Cron Triggers (wrangler.jsonc) share one scheduled() entrypoint
// that branches on event.cron. Every downstream tick is fail-closed (no-ops without its
// own *_ENABLED flag/secrets), so driving the real handler with a minimal env is safe —
// the heartbeats it stamps into KV (src/cron-heartbeat.ts) are the observable proof each
// branch actually reached its sub-jobs, without needing to mock file-local functions
// (mailTriageTick/maintenanceTick aren't exported) directly. See #601.
const METRICS_CRON = "*/5 * * * *";
const DAILY_CRON = "0 13 * * *";
const heartbeatKey = (job: string) => `sux:cron:heartbeat:${job}`;

describe("scheduled (cron-dispatch wiring)", () => {
	it("METRICS_CRON fires shipMetricsSnapshot + mail_triage, not the daily maintenance jobs", async () => {
		const { kv, store } = makeKv();
		const { ctx, deferred } = makeCtx();
		const { shipMetricsSnapshot } = await import("./grafana");
		vi.mocked(shipMetricsSnapshot).mockClear();

		await worker.scheduled({ cron: METRICS_CRON } as unknown as ScheduledController, makeEnv(kv), ctx);
		await Promise.all(deferred);

		expect(shipMetricsSnapshot).toHaveBeenCalledTimes(1);
		expect(store.has(heartbeatKey("mail_triage"))).toBe(true);
		expect(store.has(heartbeatKey("self_improve"))).toBe(false);
		expect(store.has(heartbeatKey("kroger_token"))).toBe(false);
	});

	it("a non-METRICS_CRON event fires maintenanceTick + selfImproveTick, not mail_triage", async () => {
		const { kv, store } = makeKv();
		const { ctx, deferred } = makeCtx();
		const { shipMetricsSnapshot } = await import("./grafana");
		vi.mocked(shipMetricsSnapshot).mockClear();

		await worker.scheduled({ cron: DAILY_CRON } as unknown as ScheduledController, makeEnv(kv), ctx);
		await Promise.all(deferred);

		expect(shipMetricsSnapshot).toHaveBeenCalledTimes(1);
		expect(store.has(heartbeatKey("self_improve"))).toBe(true);
		expect(store.has(heartbeatKey("kroger_token"))).toBe(true);
		expect(store.has(heartbeatKey("mail_triage"))).toBe(false);
	});

	it("a rejected shipMetricsSnapshot on the frequent path is swallowed, not thrown (#579)", async () => {
		const { kv } = makeKv();
		const { ctx, deferred } = makeCtx();
		const { shipMetricsSnapshot } = await import("./grafana");
		vi.mocked(shipMetricsSnapshot).mockRejectedValueOnce(new Error("grafana push failed"));

		await expect(worker.scheduled({ cron: METRICS_CRON } as unknown as ScheduledController, makeEnv(kv), ctx)).resolves.toBeUndefined();
		await expect(Promise.all(deferred)).resolves.toBeDefined();
	});
});
