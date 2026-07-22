import { afterEach, describe, expect, it, vi } from "vitest";
import { lunchmoney, codeFor, hasLunchmoney } from "./lunchmoney";

const ENV = { LUNCHMONEY_API_KEY: "lm_key" } as any;
const parse = (r: any) => JSON.parse(r.content[0].text);

/** Route a mocked fetch by URL path → JSON body (all HTTP 200 unless a status is given). */
function routeFetch(routes: Record<string, { body: unknown; status?: number }>) {
	return vi.fn(async (u: string | URL, init?: any) => {
		expect(init?.method ?? "GET").toBe("GET");
		expect(init.headers.Authorization).toBe("Bearer lm_key");
		const path = new URL(String(u)).pathname;
		const hit = Object.entries(routes).find(([p]) => path.endsWith(p));
		if (!hit) throw new Error(`unexpected fetch: ${path}`);
		const { body, status } = hit[1];
		return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: status ?? 200 });
	});
}

afterEach(() => vi.unstubAllGlobals());

describe("lunchmoney (read-only REST adapter)", () => {
	it("is inert (not_configured) without an API key", async () => {
		const r = await lunchmoney.run({} as any, { op: "accounts" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("[not_configured]");
		expect(r.content[0].text).toMatch(/LUNCHMONEY_API_KEY/);
		expect(hasLunchmoney({} as any)).toBe(false);
		expect(hasLunchmoney(ENV)).toBe(true);
	});

	it("exposes only the four read ops — no mutation/transfer/trade/update op, and is flagged read-only + PHI-fenced", () => {
		const ops = (lunchmoney.inputSchema as any).properties.op.enum as string[];
		expect(ops).toEqual(["accounts", "transactions", "budgets", "recurring"]);
		for (const forbidden of ["transfer", "trade", "move", "pay", "send", "buy", "sell", "delete", "update", "create", "insert", "categorize", "graphql"]) {
			expect(ops).not.toContain(forbidden);
		}
		expect(lunchmoney.annotations?.readOnlyHint).toBe(true);
		// Financial data is PHI-adjacent: never response-cached, never a /s/ share handle.
		expect(lunchmoney.cacheable).toBe(false);
		expect(lunchmoney.raw).toBe(true);
	});

	it("accounts GETs /assets + /plaid_accounts + /me with a Bearer key and shapes each account", async () => {
		vi.stubGlobal(
			"fetch",
			routeFetch({
				"/me": { body: { primary_currency: "usd", user_name: "C" } },
				"/assets": { body: { assets: [{ id: 1, type_name: "cash", display_name: "Wallet", balance: "50.0000", to_base: 50, currency: "usd", institution_name: "Cash" }] } },
				"/plaid_accounts": { body: { plaid_accounts: [{ id: 2, type: "depository", subtype: "checking", name: "Checking", balance: "1000.0000", to_base: 1000, currency: "usd", institution_name: "Chase", status: "active" }] } },
			}),
		);
		const out = parse(await lunchmoney.run(ENV, { op: "accounts" }));
		expect(out).toMatchObject({
			primary_currency: "usd",
			counts: { assets: 1, plaid_accounts: 1 },
			assets: [{ id: 1, name: "Wallet", type: "cash", balance: 50, toBase: 50, liability: false, source: "manual" }],
			plaid_accounts: [{ id: 2, name: "Checking", type: "depository", subtype: "checking", balance: 1000, liability: false, source: "plaid" }],
		});
	});

	// ---- net worth: the critical positive-magnitude / liability-direction logic ----

	it("an ASSET increases net worth (depository/cash/investment add)", async () => {
		vi.stubGlobal(
			"fetch",
			routeFetch({
				"/me": { body: { primary_currency: "usd" } },
				"/assets": { body: { assets: [{ id: 1, type_name: "investment", name: "Brokerage", balance: "2000.0000", to_base: 2000, currency: "usd" }] } },
				"/plaid_accounts": { body: { plaid_accounts: [{ id: 2, type: "depository", name: "Checking", balance: "1000.0000", to_base: 1000, currency: "usd" }] } },
			}),
		);
		const out = parse(await lunchmoney.run(ENV, { op: "accounts" }));
		expect(out.net_worth).toMatchObject({ assets_total: 3000, liabilities_total: 0, net_worth: 3000 });
	});

	it("a LIABILITY reduces net worth — a loan/credit is a POSITIVE balance that must be SUBTRACTED", async () => {
		vi.stubGlobal(
			"fetch",
			routeFetch({
				"/me": { body: { primary_currency: "usd" } },
				"/assets": { body: { assets: [] } },
				// A credit card and a loan both come back as POSITIVE magnitudes.
				"/plaid_accounts": {
					body: {
						plaid_accounts: [
							{ id: 1, type: "credit", subtype: "credit card", name: "Visa", balance: "500.0000", to_base: 500, currency: "usd" },
							{ id: 2, type: "loan", subtype: "student", name: "Student Loan", balance: "30000.0000", to_base: 30000, currency: "usd" },
						],
					},
				},
			}),
		);
		const out = parse(await lunchmoney.run(ENV, { op: "accounts" }));
		expect(out.net_worth).toMatchObject({ assets_total: 0, liabilities_total: 30500, net_worth: -30500 });
		expect(out.plaid_accounts.every((a: any) => a.liability === true)).toBe(true);
	});

	it("mixed assets + liabilities net correctly (assets minus positive-magnitude debts)", async () => {
		vi.stubGlobal(
			"fetch",
			routeFetch({
				"/me": { body: { primary_currency: "usd" } },
				"/assets": { body: { assets: [{ id: 1, type_name: "real estate", name: "House", balance: "400000.0000", to_base: 400000, currency: "usd" }] } },
				"/plaid_accounts": {
					body: {
						plaid_accounts: [
							{ id: 2, type: "depository", name: "Checking", balance: "5000.0000", to_base: 5000, currency: "usd" },
							{ id: 3, type: "loan", subtype: "mortgage", name: "Mortgage", balance: "300000.0000", to_base: 300000, currency: "usd" },
						],
					},
				},
			}),
		);
		const out = parse(await lunchmoney.run(ENV, { op: "accounts" }));
		// 400000 house + 5000 checking − 300000 mortgage = 105000.
		expect(out.net_worth).toMatchObject({ assets_total: 405000, liabilities_total: 300000, net_worth: 105000 });
	});

	it("surfaces a MANUAL `loan` asset (type_name=loan on /assets) and counts it as debt, not an asset", async () => {
		vi.stubGlobal(
			"fetch",
			routeFetch({
				"/me": { body: { primary_currency: "usd" } },
				// A future MyStudentData parser pushes a federal-loan balance in as a manual asset.
				"/assets": { body: { assets: [{ id: 9, type_name: "loan", subtype_name: "student loan", name: "Federal Student Loans", balance: "42000.0000", to_base: 42000, currency: "usd" }] } },
				"/plaid_accounts": { body: { plaid_accounts: [] } },
			}),
		);
		const out = parse(await lunchmoney.run(ENV, { op: "accounts" }));
		expect(out.assets).toHaveLength(1);
		expect(out.assets[0]).toMatchObject({ name: "Federal Student Loans", type: "loan", liability: true, source: "manual" });
		expect(out.net_worth).toMatchObject({ assets_total: 0, liabilities_total: 42000, net_worth: -42000 });
	});

	it("net worth prefers to_base, falls back to the raw balance when to_base is absent", async () => {
		vi.stubGlobal(
			"fetch",
			routeFetch({
				"/me": { body: { primary_currency: "usd" } },
				"/assets": { body: { assets: [{ id: 1, type_name: "cash", name: "Euro cash", balance: "100.0000", to_base: 108.5, currency: "eur" }] } },
				"/plaid_accounts": { body: { plaid_accounts: [{ id: 2, type: "depository", name: "No conversion", balance: "20.0000", currency: "usd" }] } },
			}),
		);
		const out = parse(await lunchmoney.run(ENV, { op: "accounts" }));
		// 108.5 (to_base) + 20 (raw balance, no to_base) = 128.5.
		expect(out.net_worth.net_worth).toBe(128.5);
	});

	it("accounts survives a failing /me (best-effort currency label) as long as balances read", async () => {
		vi.stubGlobal(
			"fetch",
			routeFetch({
				"/me": { body: "server error", status: 500 },
				"/assets": { body: { assets: [{ id: 1, type_name: "cash", name: "Wallet", balance: "10.0000", to_base: 10 }] } },
				"/plaid_accounts": { body: { plaid_accounts: [] } },
			}),
		);
		const out = parse(await lunchmoney.run(ENV, { op: "accounts" }));
		expect(out.primary_currency).toBeUndefined();
		expect(out.net_worth.net_worth).toBe(10);
	});

	it("a failing /assets sinks the accounts read with the mapped failure code", async () => {
		vi.stubGlobal("fetch", routeFetch({ "/me": { body: {} }, "/assets": { body: { error: "nope" }, status: 401 }, "/plaid_accounts": { body: { plaid_accounts: [] } } }));
		const r = await lunchmoney.run(ENV, { op: "accounts" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("[not_configured]");
	});

	// ---- transactions ----

	it("transactions passes the window + debit_as_negative and preserves negative=expense amounts", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: string | URL, init?: any) => {
				const url = new URL(String(u));
				expect(url.pathname).toMatch(/\/transactions$/);
				expect(init.headers.Authorization).toBe("Bearer lm_key");
				expect(url.searchParams.get("start_date")).toBe("2026-01-01");
				expect(url.searchParams.get("end_date")).toBe("2026-01-31");
				expect(url.searchParams.get("debit_as_negative")).toBe("true");
				expect(url.searchParams.get("limit")).toBe("50");
				return new Response(JSON.stringify({ has_more: false, transactions: [{ id: 7, date: "2026-01-05", amount: "-4.5000", to_base: -4.5, currency: "usd", payee: "Café ☕", category_name: "Coffee", category_id: 3, is_pending: false }] }), { status: 200 });
			}),
		);
		const out = parse(await lunchmoney.run(ENV, { op: "transactions", since: "2026-01-01", until: "2026-01-31", limit: 50 }));
		expect(out).toMatchObject({ count: 1, has_more: false, transactions: [{ id: 7, amount: -4.5, payee: "Café ☕", category: "Coffee", categoryId: 3, pending: false }] });
	});

	it("transactions caps limit at 500 and defaults to 100", async () => {
		let seen = "";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: string | URL) => {
				seen = new URL(String(u)).searchParams.get("limit") ?? "";
				return new Response(JSON.stringify({ transactions: [] }), { status: 200 });
			}),
		);
		await lunchmoney.run(ENV, { op: "transactions", limit: 99999 });
		expect(seen).toBe("500");
		await lunchmoney.run(ENV, { op: "transactions" });
		expect(seen).toBe("100");
	});

	// ---- budgets ----

	it("budgets defaults to the current month and shapes the per-category month map", async () => {
		const now = new Date();
		const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
		const expectedStart = `${now.getUTCFullYear()}-${mm}-01`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: string | URL) => {
				const url = new URL(String(u));
				expect(url.pathname).toMatch(/\/budgets$/);
				expect(url.searchParams.get("start_date")).toBe(expectedStart);
				return new Response(
					JSON.stringify([
						{ category_name: "Groceries", category_id: 11, category_group_name: "Food", is_income: false, exclude_from_budget: false, data: { [expectedStart]: { budget_amount: 600, budget_to_base: 600, spending_to_base: 250.5, num_transactions: 8, budget_currency: "usd" } } },
					]),
					{ status: 200 },
				);
			}),
		);
		const out = parse(await lunchmoney.run(ENV, { op: "budgets" }));
		expect(out).toMatchObject({ start_date: expectedStart, count: 1, budgets: [{ category: "Groceries", categoryId: 11, group: "Food", months: { [expectedStart]: { budgeted: 600, spending: 250.5, numTransactions: 8, currency: "usd" } } }] });
	});

	// ---- recurring ----

	it("recurring GETs /recurring_items, tolerates a bare-array response, shapes cadence", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: string | URL) => {
				expect(new URL(String(u)).pathname).toMatch(/\/recurring_items$/);
				return new Response(JSON.stringify([{ id: 4, payee: "Netflix", amount: "-15.4900", to_base: -15.49, currency: "usd", granularity: "month", quantity: 1, category_id: 5, is_income: false, billing_date: "2026-02-01" }]), { status: 200 });
			}),
		);
		const out = parse(await lunchmoney.run(ENV, { op: "recurring" }));
		expect(out).toMatchObject({ count: 1, recurring: [{ id: 4, payee: "Netflix", amount: -15.49, cadence: "1 month", granularity: "month", quantity: 1, isIncome: false }] });
	});

	it("recurring also accepts the deprecated wrapped {recurring_items:[…]} shape", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ recurring_items: [{ id: 1, payee: "Rent", amount: "-1500.0000" }] }), { status: 200 })));
		const out = parse(await lunchmoney.run(ENV, { op: "recurring" }));
		expect(out).toMatchObject({ count: 1, recurring: [{ payee: "Rent", amount: -1500 }] });
	});

	// ---- failure taxonomy ----

	it("maps upstream statuses + 200-with-error bodies to the failure taxonomy", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 })));
		expect((await lunchmoney.run(ENV, { op: "recurring" })).content[0].text).toContain("[not_configured]");
		vi.stubGlobal("fetch", vi.fn(async () => new Response("slow down", { status: 429 })));
		expect((await lunchmoney.run(ENV, { op: "recurring" })).content[0].text).toContain("[rate_limited]");
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "range too wide" }), { status: 200 })));
		expect((await lunchmoney.run(ENV, { op: "recurring" })).content[0].text).toContain("[upstream_error]");
	});

	it("an unknown op is a bad_input, never a silent success", async () => {
		const r = await lunchmoney.run(ENV, { op: "spend" } as any);
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("[bad_input]");
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
