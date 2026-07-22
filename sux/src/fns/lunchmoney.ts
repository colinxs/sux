import { type Fn, type FailCode, failWith, ok, type RtEnv } from "../registry";
import { errMsg, oj } from "./_util";

// Lunch Money over its first-class developer REST API — a read-only, honest adapter
// (accounts + net worth, transactions, budgets, recurring). Auth is a plain personal API
// key used as `Authorization: Bearer <key>` (my.lunchmoney.app → Settings → Developers),
// so there is NO OAuth, NO browser-session token, NO paste-door — just a LUNCHMONEY_API_KEY
// worker secret. Inert until that secret is set → not_configured.
//
// READ-ONLY BY CONSTRUCTION: only GET endpoints are wired, and the op enum is closed to
// four read verbs. Lunch Money's API *can* update transactions/assets/budgets, but sux never
// moves money or edits records — the mutation surface is simply unbuilt (asserted in a test).
// Financial data is sensitive: cacheable:false + raw:true, so amounts never enter the response
// cache and never a /s/ share handle (the same PHI-fence mychart uses for clinical data).
//
// NET WORTH — the one non-obvious bit: Lunch Money stores every balance as a POSITIVE
// magnitude. A liability (loan / credit card / other liability) is a positive number that must
// be SUBTRACTED, never added — a $30k loan comes back as +30000 and would otherwise inflate
// net worth. The direction lives in the account TYPE, whose field name and vocabulary differ
// between the two endpoints: `/assets` carries `type_name` ("credit", "loan", "other
// liability", plus asset types cash/investment/real estate/vehicle/cryptocurrency/employee
// compensation/other asset), while `/plaid_accounts` carries Plaid's `type` ("credit",
// "loan", plus asset types depository/investment/brokerage/cash). Balances span BOTH /assets
// (manually-managed, incl. manual `loan` assets a future MyStudentData parser can push in) AND
// /plaid_accounts (bank-linked) — net worth sums both, using each account's `to_base` (already
// converted to the primary currency) with liabilities negated. Each returned account carries a
// `liability` flag so the components stay auditable.

const API = "https://dev.lunchmoney.app/v1";

/** True when the Lunch Money API key is configured. */
export const hasLunchmoney = (env: RtEnv): boolean => Boolean(env.LUNCHMONEY_API_KEY);

const NOT_CONFIGURED =
	"Lunch Money not configured. Set LUNCHMONEY_API_KEY to a Lunch Money API key — create one " +
	"at my.lunchmoney.app → Settings → Developers (connect your accounts in Lunch Money first, " +
	"so there's data to read). Read-only — sux never moves money.";

/** Map an HTTP status to the shared failure taxonomy (mirrors todoist). A 401/403 means the
 *  key is missing/rejected → not_configured, pointing back at where to mint one. */
export const codeFor = (status: number): FailCode =>
	status === 401 || status === 403 ? "not_configured" : status === 429 ? "rate_limited" : status === 400 ? "bad_input" : status === 404 ? "not_found" : "upstream_error";

async function lmGet(env: RtEnv, path: string, params?: Record<string, unknown>): Promise<{ status: number; json: any; text: string }> {
	const url = new URL(`${API}${path}`);
	for (const [k, v] of Object.entries(params ?? {})) {
		if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
	}
	const resp = await fetch(url.toString(), {
		method: "GET",
		headers: {
			Authorization: `Bearer ${String(env.LUNCHMONEY_API_KEY)}`,
			Accept: "application/json",
		},
		signal: AbortSignal.timeout(20_000),
	});
	const text = await resp.text().catch(() => "");
	let json: any = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		/* non-JSON error page — leave json null, keep text for the failure detail */
	}
	return { status: resp.status, json, text };
}

/** Lunch Money reports an error as `{error: "..."}` or `{errors: [...]}` — and sometimes on an
 *  HTTP 200 (a bad range/param) — so every op checks the body for it too, not just the status. */
const lmErr = (j: any): string | undefined => {
	if (!j || typeof j !== "object" || Array.isArray(j)) return undefined;
	if (typeof j.error === "string" && j.error) return j.error;
	if (Array.isArray(j.errors) && j.errors.length) return j.errors.map(String).filter(Boolean).join("; ") || undefined;
	return undefined;
};

/** Fold HTTP status + a Lunch Money error body into the failure taxonomy. */
function lmFailure(op: string, r: { status: number; json: any; text: string }): ReturnType<typeof failWith> | undefined {
	if (r.status >= 400) {
		return failWith(codeFor(r.status), `lunchmoney ${op}: ${lmErr(r.json) ?? (r.text.slice(0, 200) || `HTTP ${r.status}`)}`);
	}
	const bodyErr = lmErr(r.json);
	if (bodyErr) return failWith("upstream_error", `lunchmoney ${op}: ${bodyErr}`);
	return undefined;
}

/** Lunch Money returns money as a string ("1201.0100") on the `balance`/`amount` fields, a
 *  number on `to_base` — coerce to a finite number, or undefined when absent/unparseable. */
const num = (v: unknown): number | undefined => {
	if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
	if (typeof v === "string" && v.trim() !== "") {
		const n = Number(v);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

// A positive balance under one of these types is DEBT (subtract from net worth), not an asset.
// Covers both endpoints' vocabularies: /assets `type_name` ("credit", "loan", "other
// liability") and /plaid_accounts Plaid `type` ("credit", "loan"). Everything else —
// depository, cash, investment, brokerage, real estate, vehicle, cryptocurrency, employee
// compensation, other asset — is an asset that ADDS.
const LIABILITY_TYPES = new Set(["loan", "credit", "credit card", "line of credit", "other liability", "liability"]);
const isLiability = (...types: Array<unknown>): boolean => types.some((t) => typeof t === "string" && LIABILITY_TYPES.has(t.toLowerCase()));

const pad2 = (n: number): string => String(n).padStart(2, "0");
/** First-of-current-month, YYYY-MM-DD (UTC) — the default window start for the month-granular
 *  budgets/recurring endpoints, which require an explicit start_date. */
const monthStartToday = (): string => {
	const d = new Date();
	return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-01`;
};
/** Last-of-current-month, YYYY-MM-DD (UTC). */
const monthEndToday = (): string => {
	const d = new Date();
	const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
	return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(last)}`;
};

/** A manually-managed asset (/assets) → a normalized account. `type_name`/`subtype_name` carry
 *  the direction; a manual `loan` asset (e.g. a federal student loan pushed in by a future
 *  ingest parser) lands here as a liability. */
const assetAccount = (a: any) => ({
	id: a?.id,
	name: a?.display_name || a?.name,
	type: a?.type_name,
	subtype: a?.subtype_name ?? undefined,
	balance: num(a?.balance),
	toBase: num(a?.to_base),
	currency: a?.currency,
	institution: a?.institution_name ?? undefined,
	source: "manual" as const,
	liability: isLiability(a?.type_name, a?.subtype_name),
	balanceAsOf: a?.balance_as_of ?? undefined,
	excludeTransactions: typeof a?.exclude_transactions === "boolean" ? a.exclude_transactions : undefined,
});

/** A Plaid-synced account (/plaid_accounts) → a normalized account. Here the direction lives in
 *  `type`/`subtype` (Plaid's vocabulary), NOT `type_name`. */
const plaidAccount = (p: any) => ({
	id: p?.id,
	name: p?.display_name || p?.name,
	type: p?.type,
	subtype: p?.subtype ?? undefined,
	balance: num(p?.balance),
	toBase: num(p?.to_base),
	currency: p?.currency,
	institution: p?.institution_name ?? undefined,
	source: "plaid" as const,
	liability: isLiability(p?.type, p?.subtype),
	status: p?.status ?? undefined,
	balanceLastUpdate: p?.balance_last_update ?? undefined,
});

type NormAccount = { liability: boolean; toBase?: number; balance?: number };
/** Net-worth contribution in the primary currency: prefer `to_base` (already converted), fall
 *  back to the raw balance (assumed primary currency) when it's absent. */
const contribution = (a: NormAccount): number => a.toBase ?? a.balance ?? 0;

const txn = (t: any) => ({
	id: t?.id,
	date: t?.date,
	amount: num(t?.amount),
	toBase: num(t?.to_base),
	currency: t?.currency,
	payee: t?.payee,
	category: t?.category_name ?? undefined,
	categoryId: t?.category_id ?? undefined,
	notes: t?.notes || undefined,
	status: t?.status,
	pending: typeof t?.is_pending === "boolean" ? t.is_pending : undefined,
	recurringId: t?.recurring_id ?? undefined,
});

/** One category's per-month budgeted vs actual, from /budgets' nested `data` map (keyed by a
 *  YYYY-MM-DD month-start). */
const budgetCategory = (c: any) => {
	const data = c?.data && typeof c.data === "object" ? c.data : {};
	const months: Record<string, { budgeted?: number; spending?: number; numTransactions?: number; currency?: string }> = {};
	for (const [month, d] of Object.entries<any>(data)) {
		months[month] = {
			budgeted: num(d?.budget_to_base) ?? num(d?.budget_amount),
			spending: num(d?.spending_to_base),
			numTransactions: typeof d?.num_transactions === "number" ? d.num_transactions : undefined,
			currency: d?.budget_currency ?? undefined,
		};
	}
	return {
		category: c?.category_name,
		categoryId: c?.category_id,
		group: c?.category_group_name ?? undefined,
		isGroup: typeof c?.is_group === "boolean" ? c.is_group : undefined,
		isIncome: typeof c?.is_income === "boolean" ? c.is_income : undefined,
		excludeFromBudget: typeof c?.exclude_from_budget === "boolean" ? c.exclude_from_budget : undefined,
		months,
	};
};

const recurringItem = (x: any) => ({
	id: x?.id,
	payee: x?.payee,
	description: x?.description ?? undefined,
	amount: num(x?.amount),
	toBase: num(x?.to_base),
	currency: x?.currency,
	cadence: [x?.quantity, x?.granularity].filter((v) => v !== undefined && v !== null && v !== "").join(" ") || undefined,
	granularity: x?.granularity ?? undefined,
	quantity: typeof x?.quantity === "number" ? x.quantity : undefined,
	categoryId: x?.category_id ?? undefined,
	isIncome: typeof x?.is_income === "boolean" ? x.is_income : undefined,
	billingDate: x?.billing_date ?? undefined,
});

/** Lunch Money's list endpoints have drifted between a bare array and a single-key wrapper
 *  object (`/recurring_items` vs the deprecated `/recurring_expenses: {recurring_expenses:[]}`);
 *  accept either so a shape drift degrades to empty, never a throw. */
const listUnder = (json: any, key: string): any[] => {
	if (Array.isArray(json)) return json;
	if (json && typeof json === "object" && Array.isArray(json[key])) return json[key];
	return [];
};

export const lunchmoney: Fn = {
	name: "lunchmoney",
	cost: 2,
	cacheable: false,
	raw: true,
	annotations: { readOnlyHint: true, openWorldHint: true },
	description:
		"Lunch Money — READ-ONLY personal finance over its first-class developer API. sux NEVER moves money: only GET endpoints are wired, no op mutates. Ops: " +
		"accounts (manually-managed /assets + Plaid-linked /plaid_accounts → per-account balances + net worth; liabilities like loans/credit are stored as POSITIVE magnitudes and are SUBTRACTED, so a loan reduces net worth) | transactions ({since?, until?, limit?} — YYYY-MM-DD dates; amounts signed negative=expense/outflow, positive=income/inflow) | budgets ({since?, until?} — per-category budgeted vs actual by month; defaults to the current month) | recurring ({since?, until?} — recurring items: payee, amount, cadence, income-vs-expense; defaults to the current month). " +
		"Needs LUNCHMONEY_API_KEY (my.lunchmoney.app → Settings → Developers; connect your accounts in Lunch Money first) — absent or rejected → not_configured, nothing runs.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["op"],
		properties: {
			op: { type: "string", enum: ["accounts", "transactions", "budgets", "recurring"] },
			since: { type: "string", description: "transactions/budgets/recurring: window start, YYYY-MM-DD (budgets/recurring default to the current month)." },
			until: { type: "string", description: "transactions/budgets/recurring: window end, YYYY-MM-DD." },
			limit: { type: "integer", minimum: 1, maximum: 500, description: "transactions: max rows to return (default 100)." },
		},
	},
	run: async (env: RtEnv, a: any) => {
		if (!hasLunchmoney(env)) return failWith("not_configured", NOT_CONFIGURED);
		const op = String(a?.op ?? "");
		try {
			if (op === "accounts") {
				const [assetsR, plaidR, meR] = await Promise.all([lmGet(env, "/assets"), lmGet(env, "/plaid_accounts"), lmGet(env, "/me")]);
				const af = lmFailure("assets", assetsR);
				if (af) return af;
				const pf = lmFailure("plaid_accounts", plaidR);
				if (pf) return pf;
				// /me is best-effort — it only labels the net-worth currency; a failure there must
				// not sink an otherwise-good balances read.
				const primaryCurrency = meR.status < 400 ? (meR.json?.primary_currency ?? undefined) : undefined;
				const assets = listUnder(assetsR.json?.assets ?? assetsR.json, "assets").map(assetAccount);
				const plaidAccounts = listUnder(plaidR.json?.plaid_accounts ?? plaidR.json, "plaid_accounts").map(plaidAccount);
				const all = [...assets, ...plaidAccounts];
				const assetsTotal = all.filter((x) => !x.liability).reduce((s, x) => s + contribution(x), 0);
				const liabilitiesTotal = all.filter((x) => x.liability).reduce((s, x) => s + contribution(x), 0);
				return ok(
					oj({
						primary_currency: primaryCurrency,
						counts: { assets: assets.length, plaid_accounts: plaidAccounts.length },
						net_worth: { assets_total: round2(assetsTotal), liabilities_total: round2(liabilitiesTotal), net_worth: round2(assetsTotal - liabilitiesTotal), currency: primaryCurrency },
						assets,
						plaid_accounts: plaidAccounts,
					}),
				);
			}
			if (op === "transactions") {
				const limit = Math.min(500, Math.max(1, Number.isFinite(Number(a?.limit)) ? Number(a.limit) : 100));
				// debit_as_negative=true makes expenses negative / income positive — the intuitive
				// bank-statement sign (negative = outflow) the agenda spend detectors expect.
				const r = await lmGet(env, "/transactions", { start_date: a?.since, end_date: a?.until, limit, debit_as_negative: true });
				const fail = lmFailure("transactions", r);
				if (fail) return fail;
				const transactions = listUnder(r.json?.transactions ?? r.json, "transactions").map(txn);
				return ok(oj({ count: transactions.length, has_more: Boolean(r.json?.has_more), transactions }));
			}
			if (op === "budgets") {
				const start = typeof a?.since === "string" && a.since ? a.since : monthStartToday();
				const end = typeof a?.until === "string" && a.until ? a.until : monthEndToday();
				const r = await lmGet(env, "/budgets", { start_date: start, end_date: end });
				const fail = lmFailure("budgets", r);
				if (fail) return fail;
				const budgets = listUnder(r.json?.budgets ?? r.json, "budgets").map(budgetCategory);
				return ok(oj({ start_date: start, end_date: end, count: budgets.length, budgets }));
			}
			if (op === "recurring") {
				const start = typeof a?.since === "string" && a.since ? a.since : monthStartToday();
				const end = typeof a?.until === "string" && a.until ? a.until : monthEndToday();
				const r = await lmGet(env, "/recurring_items", { start_date: start, end_date: end, debit_as_negative: true });
				const fail = lmFailure("recurring", r);
				if (fail) return fail;
				const recurring = listUnder(r.json?.recurring_items ?? r.json, "recurring_items").map(recurringItem);
				return ok(oj({ start_date: start, end_date: end, count: recurring.length, recurring }));
			}
			return failWith("bad_input", `lunchmoney: unknown op '${op}'.`);
		} catch (e) {
			return failWith("upstream_error", `lunchmoney ${op} failed: ${errMsg(e)}`);
		}
	},
};
