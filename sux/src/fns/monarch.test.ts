import { afterEach, describe, expect, it, vi } from "vitest";
import { monarch, codeFor, isReadOnlyDoc } from "./monarch";

const ENV = { MONARCH_TOKEN: "mtk" } as any;
const parse = (r: any) => JSON.parse(r.content[0].text);

afterEach(() => vi.unstubAllGlobals());

describe("monarch (read-only GraphQL adapter)", () => {
	it("is inert (not_configured) without a token, pointing at /monarch/connect", async () => {
		const r = await monarch.run({} as any, { op: "accounts" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("[not_configured]");
		expect(r.content[0].text).toMatch(/\/monarch\/connect/);
	});

	it("reads the pasted KV grant (monarch:grant) when no MONARCH_TOKEN secret is set", async () => {
		const kv = { get: vi.fn(async (k: string) => (k === "monarch:grant" ? JSON.stringify({ token: "pasted-tok", issued_at: 1 }) : null)) };
		vi.stubGlobal("fetch", vi.fn(async (_u: string | URL, init?: any) => {
			expect(init.headers.Authorization).toBe("Token pasted-tok");
			return new Response(JSON.stringify({ data: { accounts: [] } }), { status: 200 });
		}));
		const out = parse(await monarch.run({ OAUTH_KV: kv } as any, { op: "accounts" }));
		expect(out).toMatchObject({ count: 0 });
	});

	it("the KV grant WINS over a legacy MONARCH_TOKEN secret", async () => {
		const kv = { get: vi.fn(async (k: string) => (k === "monarch:grant" ? JSON.stringify({ token: "grant-tok", issued_at: 1 }) : null)) };
		vi.stubGlobal("fetch", vi.fn(async (_u: string | URL, init?: any) => {
			expect(init.headers.Authorization).toBe("Token grant-tok"); // not the secret "mtk"
			return new Response(JSON.stringify({ data: { accounts: [] } }), { status: 200 });
		}));
		await monarch.run({ MONARCH_TOKEN: "mtk", OAUTH_KV: kv } as any, { op: "accounts" });
	});

	it("a stale token (Monarch 401) surfaces as not_configured pointing at /monarch/connect, never a hard error", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: "unauthorized" }] }), { status: 401 })));
		const r = await monarch.run(ENV, { op: "accounts" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("[not_configured]");
		expect(r.content[0].text).toMatch(/\/monarch\/connect/);
	});

	it("exposes no mutation/transfer/trade op — only the read-only enum", () => {
		const ops = (monarch.inputSchema as any).properties.op.enum as string[];
		expect(ops).toEqual(["accounts", "transactions", "budgets", "cashflow", "categories", "holdings", "graphql"]);
		for (const forbidden of ["transfer", "trade", "move", "pay", "send", "buy", "sell", "delete", "update", "create"]) {
			expect(ops).not.toContain(forbidden);
		}
		expect(monarch.annotations?.readOnlyHint).toBe(true);
	});

	it("accounts POSTs to the GraphQL API with the Token + Client-Platform headers, shapes accounts", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			expect(String(u)).toBe("https://api.monarch.com/graphql");
			expect(init.method).toBe("POST");
			expect(init.headers.Authorization).toBe("Token mtk");
			expect(init.headers["Client-Platform"]).toBe("web");
			const body = JSON.parse(init.body);
			expect(body.query).toMatch(/accounts/);
			return new Response(JSON.stringify({ data: { accounts: [{ id: "a1", displayName: "Checking", currentBalance: 1234.56, type: { name: "depository" }, institution: { name: "Chase" } }] } }), { status: 200 });
		}));
		const out = parse(await monarch.run(ENV, { op: "accounts" }));
		expect(out).toMatchObject({ count: 1, accounts: [{ id: "a1", name: "Checking", balance: 1234.56, type: "depository", institution: "Chase" }] });
	});

	it("transactions passes filters + paging and preserves Monarch's negative-is-expense amounts", async () => {
		vi.stubGlobal("fetch", vi.fn(async (_u: string | URL, init?: any) => {
			const body = JSON.parse(init.body);
			expect(body.variables).toMatchObject({ offset: 0, limit: 50, filters: { startDate: "2026-01-01", endDate: "2026-01-31", search: "coffee", categories: ["c1"] } });
			expect(body.variables.filters.accounts).toBeUndefined(); // empty array pruned
			return new Response(JSON.stringify({ data: { allTransactions: { totalCount: 1, results: [{ id: "t1", amount: -4.5, date: "2026-01-05", pending: false, merchant: { name: "Café ☕" }, category: { id: "c1", name: "Coffee" }, account: { id: "a1", displayName: "Checking" } }] } } }), { status: 200 });
		}));
		const out = parse(await monarch.run(ENV, { op: "transactions", start: "2026-01-01", end: "2026-01-31", search: "coffee", categories: ["c1"], accounts: [], limit: 50 }));
		expect(out).toMatchObject({ totalCount: 1, count: 1, offset: 0, limit: 50, transactions: [{ id: "t1", amount: -4.5, merchant: "Café ☕", category: "Coffee" }] });
	});

	it("transactions caps limit at 200", async () => {
		vi.stubGlobal("fetch", vi.fn(async (_u: string | URL, init?: any) => {
			expect(JSON.parse(init.body).variables.limit).toBe(200);
			return new Response(JSON.stringify({ data: { allTransactions: { totalCount: 0, results: [] } } }), { status: 200 });
		}));
		await monarch.run(ENV, { op: "transactions", limit: 5000 });
	});

	it("graphql passes a read-only query through verbatim", async () => {
		vi.stubGlobal("fetch", vi.fn(async (_u: string | URL, init?: any) => {
			const body = JSON.parse(init.body);
			expect(body.query).toBe("query Me { me { id } }");
			expect(body.variables).toEqual({ x: 1 });
			return new Response(JSON.stringify({ data: { me: { id: "u1" } } }), { status: 200 });
		}));
		const out = parse(await monarch.run(ENV, { op: "graphql", query: "query Me { me { id } }", variables: { x: 1 } }));
		expect(out).toMatchObject({ data: { me: { id: "u1" } } });
	});

	it("graphql surfaces a GraphQL-level error even on a 2xx response, instead of returning isError:false (#373)", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: "field 'me' is not accessible" }] }), { status: 200 })));
		const r = await monarch.run(ENV, { op: "graphql", query: "query Me { me { id } }" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("[upstream_error]");
		expect(r.content[0].text).toMatch(/not accessible/);
	});

	it("graphql refuses a mutation without ever calling fetch", async () => {
		const spy = vi.fn();
		vi.stubGlobal("fetch", spy);
		const r = await monarch.run(ENV, { op: "graphql", query: "  # a comment\n  mutation Nope { deleteAccount(id: 1) { ok } }" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("[bad_input]");
		expect(r.content[0].text).toMatch(/read-only/);
		expect(spy).not.toHaveBeenCalled();
	});

	it("isReadOnlyDoc allows queries (incl. anonymous/comment-led) and rejects mutations/subscriptions", () => {
		expect(isReadOnlyDoc("query { accounts { id } }")).toBe(true);
		expect(isReadOnlyDoc("{ accounts { id } }")).toBe(true);
		expect(isReadOnlyDoc("# lead comment\nquery Foo { x }")).toBe(true);
		expect(isReadOnlyDoc("mutation { deleteAccount(id:1){ok} }")).toBe(false);
		expect(isReadOnlyDoc("  mutation Foo { x }")).toBe(false);
		expect(isReadOnlyDoc("subscription Foo { x }")).toBe(false);
	});

	it("maps upstream statuses + GraphQL errors to the failure taxonomy", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: "unauthorized" }] }), { status: 401 })));
		expect((await monarch.run(ENV, { op: "accounts" })).content[0].text).toContain("[not_configured]");
		vi.stubGlobal("fetch", vi.fn(async () => new Response("throttled", { status: 429 })));
		expect((await monarch.run(ENV, { op: "accounts" })).content[0].text).toContain("[rate_limited]");
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: "boom" }] }), { status: 200 })));
		expect((await monarch.run(ENV, { op: "accounts" })).content[0].text).toContain("[upstream_error]");
	});

	it("codeFor maps statuses like the shared taxonomy", () => {
		expect(codeFor(401)).toBe("not_configured");
		expect(codeFor(403)).toBe("not_configured");
		expect(codeFor(429)).toBe("rate_limited");
		expect(codeFor(400)).toBe("bad_input");
		expect(codeFor(404)).toBe("not_found");
		expect(codeFor(500)).toBe("upstream_error");
	});
});
