import { afterEach, describe, expect, it, vi } from "vitest";
import { consensus } from "./consensus";

function kvStub(seed: Record<string, string> = {}) {
	const map = new Map<string, string>(Object.entries(seed));
	return {
		map,
		get: vi.fn(async (k: string) => (map.has(k) ? map.get(k)! : null)),
		put: vi.fn(async (k: string, v: string) => {
			map.set(k, v);
		}),
		delete: vi.fn(async (k: string) => {
			map.delete(k);
		}),
	};
}

// An env with a live grant + already-cached access token, so the search cycle runs
// straight to the MCP endpoint without a refresh round-trip.
const connectedEnv = () =>
	({
		OAUTH_KV: kvStub({
			"sux:consensus:client": JSON.stringify({ client_id: "cid" }),
			"sux:consensus:grant": JSON.stringify({ refresh_token: "rt", issued_at: 1 }),
			"sux:consensus:token": "at-cached",
		}),
	}) as any;

const PAPER = {
	title: "Creatine and cognition: a meta-analysis",
	authors: [{ name: "Ada Lovelace" }, { name: "Alan Turing" }],
	year: 2023,
	journal: "Journal of Nutrition",
	claim: "Creatine supplementation modestly improves short-term memory.",
	doi: "10.1000/abc",
	url: "https://consensus.app/papers/abc",
};

// MCP tools/call result: tool output wrapped as a JSON text content part.
const searchResultBody = (papers: any[] = [PAPER]) => ({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({ results: papers }) }] } });
const initBody = { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {} } };

// Route by the JSON-RPC method in the POST body — initialize vs tools/call both hit
// the same MCP URL, so match on the body, not the URL.
const mcpRouter =
	(handlers: { init?: () => Response; call?: () => Response }) =>
	async (_u: any, init?: any): Promise<Response> => {
		const body = init?.body ? JSON.parse(init.body) : {};
		if (body.method === "initialize") return (handlers.init ?? (() => new Response(JSON.stringify(initBody), { status: 200 })))();
		if (body.method === "tools/call") return (handlers.call ?? (() => new Response(JSON.stringify(searchResultBody()), { status: 200 })))();
		throw new Error(`unexpected method ${body.method}`);
	};

afterEach(() => vi.restoreAllMocks());

describe("consensus fn", () => {
	it("requires a query", async () => {
		const r = await consensus.run(connectedEnv(), {});
		expect(r.isError).toBe(true);
	});

	it("not_configured when no grant exists, pointing at /consensus/connect", async () => {
		const env = { OAUTH_KV: kvStub() } as any;
		const r = await consensus.run(env, { query: "does creatine help cognition?" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/not_configured/);
		expect(r.content[0].text).toMatch(/\/consensus\/connect/);
	});

	it("round-trips initialize + tools/call and normalizes a JSON-framed result", async () => {
		vi.stubGlobal("fetch", vi.fn(mcpRouter({})));
		const r = await consensus.run(connectedEnv(), { query: "creatine cognition" });
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		expect(out.count).toBe(1);
		const e = out.results[0];
		expect(e.title).toBe(PAPER.title);
		expect(e.authors).toEqual(["Ada Lovelace", "Alan Turing"]);
		expect(e.year).toBe(2023);
		expect(e.journal).toBe("Journal of Nutrition");
		expect(e.snippet).toMatch(/short-term memory/);
		expect(e.doi).toBe("10.1000/abc");
		expect(e.url).toBe("https://consensus.app/papers/abc");
	});

	it("passes query, year window, study_types and limit into the search arguments", async () => {
		const spy = vi.fn(mcpRouter({}));
		vi.stubGlobal("fetch", spy);
		await consensus.run(connectedEnv(), { query: "statins", year_min: 2015, year_max: 2024, study_types: ["rct", "meta-analysis"], limit: 5 });
		const callBody = JSON.parse(spy.mock.calls.find((c) => JSON.parse(c[1].body).method === "tools/call")![1].body);
		expect(callBody.params.name).toBe("search");
		expect(callBody.params.arguments).toMatchObject({ query: "statins", year_min: 2015, year_max: 2024, study_types: ["rct", "meta-analysis"], limit: 5 });
	});

	it("handles an SSE-framed (text/event-stream) response body", async () => {
		const sse = (obj: any) => new Response(`event: message\ndata: ${JSON.stringify(obj)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
		vi.stubGlobal("fetch", vi.fn(mcpRouter({ init: () => sse(initBody), call: () => sse(searchResultBody()) })));
		const r = await consensus.run(connectedEnv(), { query: "creatine cognition" });
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		expect(out.count).toBe(1);
		expect(out.results[0].title).toBe(PAPER.title);
	});

	it("reads structuredContent when the server returns it instead of a text part", async () => {
		const structured = { jsonrpc: "2.0", id: 2, result: { structuredContent: { results: [PAPER] } } };
		vi.stubGlobal("fetch", vi.fn(mcpRouter({ call: () => new Response(JSON.stringify(structured), { status: 200 }) })));
		const r = await consensus.run(connectedEnv(), { query: "x" });
		const out = JSON.parse(r.content[0].text);
		expect(out.count).toBe(1);
		expect(out.results[0].title).toBe(PAPER.title);
	});

	it("self-heals a 401 by dropping the cached token and re-minting once from the grant", async () => {
		const env = connectedEnv();
		let served401 = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_u: any, init?: any) => {
				const raw = String(init?.body ?? "");
				if (raw.includes("grant_type=refresh_token")) return new Response(JSON.stringify({ access_token: "at-fresh", expires_in: 3600 }), { status: 200 });
				const body = raw ? JSON.parse(raw) : {};
				if (body.method === "initialize") {
					// first initialize 401s (stale cached token); after re-mint it succeeds
					if (!served401) {
						served401 = true;
						return new Response("unauthorized", { status: 401 });
					}
					return new Response(JSON.stringify(initBody), { status: 200 });
				}
				if (body.method === "tools/call") return new Response(JSON.stringify(searchResultBody()), { status: 200 });
				throw new Error(`unexpected ${JSON.stringify(body)}`);
			}),
		);
		const r = await consensus.run(env, { query: "creatine" });
		expect(r.isError).toBeFalsy();
		expect(JSON.parse(r.content[0].text).count).toBe(1);
		// the fresh token replaced the stale cached one
		expect(env.OAUTH_KV.map.get("sux:consensus:token")).toBe("at-fresh");
	});

	it("surfaces a JSON-RPC tool error as an upstream_error fail", async () => {
		const errBody = { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "quota exceeded" } };
		vi.stubGlobal("fetch", vi.fn(mcpRouter({ call: () => new Response(JSON.stringify(errBody), { status: 200 }) })));
		const r = await consensus.run(connectedEnv(), { query: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/quota exceeded/);
	});
});
