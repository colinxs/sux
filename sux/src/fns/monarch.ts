import { type Fn, type FailCode, failWith, ok, type RtEnv } from "../registry";
import { errMsg, oj } from "./_util";

// Monarch Money over its GraphQL API — a read-only, honest adapter (accounts,
// balances, transactions, budgets, cashflow, categories, holdings). Auth is a
// personal API token used directly as `Authorization: Token <token>` (NO OAuth,
// NO email/password/MFA login — that flow is prohibited to handle; Colin mints the
// token out-of-band via `scripts/mint-monarch-token.py`, which drives the
// monarchmoney fork's interactive login. NOTE: the web app authenticates over an
// httpOnly session cookie + CSRF, so there is NO `Authorization: Token` header to
// copy from devtools — the login flow is the only source).
// Inert until MONARCH_TOKEN is set, exactly like FASTMAIL_TOKEN / TODOIST_TOKEN.
//
// READ-ONLY BY CONSTRUCTION: no mutation op exists, and the `graphql` escape hatch
// refuses any mutation/subscription document. sux never moves money — the field
// operations (transfers, trades) are simply unbuilt. Amounts pass byte-exact
// (raw:true, cacheable:false — personal financial data never enters the response
// cache); Monarch's sign convention is preserved (negative = expense/outflow).

const API = "https://api.monarchmoney.com/graphql";

const NOT_CONFIGURED =
	"Monarch Money not configured. Set MONARCH_TOKEN to a Monarch API token — " +
	"mint one with `scripts/mint-monarch-token.py` (drives the monarchmoney fork's " +
	"login; the web app is cookie+CSRF, so there is no devtools token to copy). " +
	"Read-only — sux never moves money.";

/** True when the Monarch token is configured. */
export const hasMonarch = (env: RtEnv): boolean => Boolean(env.MONARCH_TOKEN);

/** Map an HTTP status to the shared failure taxonomy (mirrors todoist's mapping). */
export const codeFor = (status: number): FailCode =>
	status === 401 || status === 403 ? "not_configured" : status === 429 ? "rate_limited" : status === 400 ? "bad_input" : status === 404 ? "not_found" : "upstream_error";

async function gql(env: RtEnv, query: string, variables?: Record<string, unknown>): Promise<{ status: number; json: any }> {
	const resp = await fetch(API, {
		method: "POST",
		headers: {
			Authorization: `Token ${String(env.MONARCH_TOKEN)}`,
			"Content-Type": "application/json",
			Accept: "application/json",
			"Client-Platform": "web", // Monarch rejects requests without a Client-Platform.
		},
		body: JSON.stringify({ query, variables: variables ?? {} }),
		signal: AbortSignal.timeout(20_000),
	});
	const json = await resp.json().catch(() => null);
	return { status: resp.status, json };
}

/** Run a query, folding HTTP status + GraphQL `errors` into the failure taxonomy. */
async function query(env: RtEnv, op: string, gqlDoc: string, variables?: Record<string, unknown>): Promise<{ data?: any; fail?: ReturnType<typeof failWith> }> {
	const r = await gql(env, gqlDoc, variables);
	if (r.status >= 400) {
		const detail = r.json?.errors?.[0]?.message ?? `HTTP ${r.status}`;
		return { fail: failWith(codeFor(r.status), `Monarch ${op}: ${detail}`) };
	}
	if (Array.isArray(r.json?.errors) && r.json.errors.length) {
		return { fail: failWith("upstream_error", `Monarch ${op}: ${r.json.errors.map((e: any) => e?.message).filter(Boolean).join("; ") || "GraphQL error"}`) };
	}
	return { data: r.json?.data };
}

/** First-of-month for a YYYY-MM (or today's month when absent), as YYYY-MM-DD. */
const monthStart = (m?: string): string => {
	const s = typeof m === "string" && /^\d{4}-\d{2}$/.test(m) ? m : new Date().toISOString().slice(0, 7);
	return `${s}-01`;
};
/** Last-of-month for a YYYY-MM (or today's month when absent), as YYYY-MM-DD. */
const monthEnd = (m?: string): string => {
	const s = typeof m === "string" && /^\d{4}-\d{2}$/.test(m) ? m : new Date().toISOString().slice(0, 7);
	const [y, mm] = s.split("-").map(Number);
	return new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10);
};

const strArr = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String).filter(Boolean) : undefined);
const definedOnly = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)));

// ---- GraphQL documents (unofficial Monarch schema, mirrors the monarchmoney lib) ----

const Q_ACCOUNTS = `query GetAccounts { accounts { id displayName currentBalance displayBalance includeInNetWorth updatedAt type { name display } subtype { name display } institution { name } } }`;

const Q_TRANSACTIONS = `query GetTransactionsList($offset: Int, $limit: Int, $filters: TransactionFilterInput) {
  allTransactions(filters: $filters) {
    totalCount
    results(offset: $offset, limit: $limit, orderBy: "date") {
      id amount date pending notes
      merchant { name }
      category { id name }
      account { id displayName }
    }
  }
}`;

const Q_BUDGETS = `query Common_GetJointPlanningData($startDate: Date!, $endDate: Date!) {
  budgetData(startMonth: $startDate, endMonth: $endDate) {
    monthlyAmountsByCategory {
      category { id name }
      monthlyAmounts { month plannedCashFlowAmount actualAmount remainingAmount }
    }
  }
}`;

const Q_CASHFLOW = `query GetCashFlow($filters: TransactionFilterInput) {
  summary: aggregates(filters: $filters) {
    summary { sumIncome sumExpense savings savingsRate }
  }
  byCategory: aggregates(filters: $filters, groupBy: ["category"]) {
    groupBy { category { id name } }
    summary { sumIncome sumExpense }
  }
}`;

const Q_CATEGORIES = `query GetCategories { categories { id name group { id name type } } }`;

const Q_HOLDINGS = `query GetHoldings { portfolio { aggregateHoldings { edges { node { security { ticker name } totalValue quantity } } } } }`;

const account = (a: any) => ({
	id: a?.id,
	name: a?.displayName,
	balance: a?.currentBalance,
	displayBalance: a?.displayBalance,
	includeInNetWorth: a?.includeInNetWorth,
	type: a?.type?.name,
	subtype: a?.subtype?.name,
	institution: a?.institution?.name,
	updatedAt: a?.updatedAt,
});

const txn = (t: any) => ({ id: t?.id, amount: t?.amount, date: t?.date, pending: t?.pending, notes: t?.notes || undefined, merchant: t?.merchant?.name, category: t?.category?.name, categoryId: t?.category?.id, account: t?.account?.displayName, accountId: t?.account?.id });

/** Reject a mutation/subscription document (read-only escape hatch), tolerating leading comments/whitespace. */
export const isReadOnlyDoc = (doc: string): boolean => {
	const stripped = doc
		.replace(/#[^\n]*/g, "") // line comments
		.replace(/\s+/g, " ")
		.trim();
	return !/^\s*(mutation|subscription)\b/i.test(stripped) && !/\b(mutation|subscription)\s+\w*\s*[({]/i.test(stripped);
};

export const monarch: Fn = {
	name: "monarch",
	cost: 2,
	cacheable: false,
	raw: true,
	annotations: { readOnlyHint: true, openWorldHint: true },
	description:
		"Monarch Money — READ-ONLY personal finance (accounts, balances, transactions, budgets, cashflow, categories, holdings). sux NEVER moves money: no transfer/trade op exists and the raw escape hatch refuses mutations. Ops: " +
		"accounts (balances + institutions) | transactions ({start?, end?, search?, accounts?, categories?, limit?, offset?} — YYYY-MM-DD dates, ids from `categories`/`accounts`) | budgets ({month?} YYYY-MM, planned vs actual per category) | cashflow ({start?, end?} — income/expense/savings summary + per-category breakdown) | categories (id source for filtering) | holdings (investment positions) | graphql ({query, variables?} — raw read-only passthrough; mutation/subscription refused). " +
		"Amounts are byte-exact in Monarch's convention (negative = expense/outflow). " +
		"Needs MONARCH_TOKEN (the `Authorization: Token` header from app.monarchmoney.com, or the monarchmoney Python lib's interactive login) — absent → not_configured, nothing runs.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["op"],
		properties: {
			op: { type: "string", enum: ["accounts", "transactions", "budgets", "cashflow", "categories", "holdings", "graphql"] },
			start: { type: "string", description: "transactions/cashflow: window start, YYYY-MM-DD." },
			end: { type: "string", description: "transactions/cashflow: window end, YYYY-MM-DD." },
			search: { type: "string", description: "transactions: free-text match on merchant/notes." },
			accounts: { type: "array", items: { type: "string" }, description: "transactions: filter to these account ids." },
			categories: { type: "array", items: { type: "string" }, description: "transactions: filter to these category ids (from the `categories` op)." },
			limit: { type: "integer", minimum: 1, maximum: 200, description: "transactions: page size (default 100, capped 200)." },
			offset: { type: "integer", minimum: 0, description: "transactions: page offset (default 0)." },
			month: { type: "string", description: "budgets: target month YYYY-MM (default current)." },
			query: { type: "string", description: "graphql: a GraphQL *query* document (read-only; mutations/subscriptions refused)." },
			variables: { type: "object", additionalProperties: true, description: "graphql: variables for the query document." },
		},
	},
	run: async (env: RtEnv, a: any) => {
		if (!hasMonarch(env)) return failWith("not_configured", NOT_CONFIGURED);
		const op = String(a?.op ?? "");
		try {
			if (op === "accounts") {
				const { data, fail } = await query(env, "accounts", Q_ACCOUNTS);
				if (fail) return fail;
				const accounts = (data?.accounts ?? []).map(account);
				return ok(oj({ count: accounts.length, accounts }));
			}
			if (op === "categories") {
				const { data, fail } = await query(env, "categories", Q_CATEGORIES);
				if (fail) return fail;
				const categories = (data?.categories ?? []).map((c: any) => ({ id: c?.id, name: c?.name, group: c?.group?.name, groupType: c?.group?.type }));
				return ok(oj({ count: categories.length, categories }));
			}
			if (op === "holdings") {
				const { data, fail } = await query(env, "holdings", Q_HOLDINGS);
				if (fail) return fail;
				const holdings = (data?.portfolio?.aggregateHoldings?.edges ?? []).map((e: any) => ({ ticker: e?.node?.security?.ticker, name: e?.node?.security?.name, value: e?.node?.totalValue, quantity: e?.node?.quantity }));
				return ok(oj({ count: holdings.length, holdings }));
			}
			if (op === "transactions") {
				const limit = Math.min(200, Math.max(1, Number.isFinite(Number(a?.limit)) ? Number(a.limit) : 100));
				const offset = Math.max(0, Number.isFinite(Number(a?.offset)) ? Number(a.offset) : 0);
				const filters = definedOnly({ startDate: a?.start, endDate: a?.end, search: a?.search, accounts: strArr(a?.accounts), categories: strArr(a?.categories) });
				const { data, fail } = await query(env, "transactions", Q_TRANSACTIONS, { offset, limit, filters });
				if (fail) return fail;
				const all = data?.allTransactions ?? {};
				const results = (all.results ?? []).map(txn);
				return ok(oj({ totalCount: all.totalCount ?? results.length, count: results.length, offset, limit, transactions: results }));
			}
			if (op === "budgets") {
				const startDate = monthStart(a?.month);
				const endDate = monthEnd(a?.month);
				const { data, fail } = await query(env, "budgets", Q_BUDGETS, { startDate, endDate });
				if (fail) return fail;
				const rows = (data?.budgetData?.monthlyAmountsByCategory ?? []).map((r: any) => {
					const m = r?.monthlyAmounts?.[0] ?? {};
					return { category: r?.category?.name, categoryId: r?.category?.id, planned: m?.plannedCashFlowAmount, actual: m?.actualAmount, remaining: m?.remainingAmount };
				});
				return ok(oj({ month: startDate.slice(0, 7), count: rows.length, budgets: rows }));
			}
			if (op === "cashflow") {
				const filters = definedOnly({ startDate: a?.start, endDate: a?.end });
				const { data, fail } = await query(env, "cashflow", Q_CASHFLOW, { filters });
				if (fail) return fail;
				const summary = data?.summary?.[0]?.summary ?? data?.summary?.summary ?? null;
				const byCategory = (data?.byCategory ?? []).map((g: any) => ({ category: g?.groupBy?.category?.name, categoryId: g?.groupBy?.category?.id, income: g?.summary?.sumIncome, expense: g?.summary?.sumExpense }));
				return ok(oj({ summary, byCategory }));
			}
			if (op === "graphql") {
				const doc = typeof a?.query === "string" ? a.query : "";
				if (!doc.trim()) return failWith("bad_input", "monarch graphql requires a `query` document string.");
				if (!isReadOnlyDoc(doc)) return failWith("bad_input", "monarch graphql is read-only — mutation/subscription documents are refused (sux never moves money).");
				const vars = a?.variables && typeof a.variables === "object" && !Array.isArray(a.variables) ? (a.variables as Record<string, unknown>) : undefined;
				const r = await gql(env, doc, vars);
				if (r.status >= 400) return failWith(codeFor(r.status), `Monarch graphql: ${r.json?.errors?.[0]?.message ?? `HTTP ${r.status}`}`);
				return ok(oj(r.json ?? {}));
			}
			return failWith("bad_input", `monarch: unknown op '${op}'.`);
		} catch (e) {
			return failWith("upstream_error", `monarch ${op} failed: ${errMsg(e)}`);
		}
	},
};
