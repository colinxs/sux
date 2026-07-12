#!/usr/bin/env node
// billing-check — one usage-vs-limit report across the three meters this repo
// spends on, so an auto-merge pipeline that now runs Claude on every PR (and a
// repo going private, where Actions minutes are metered) can't quietly blow a
// budget. Queries live where it can, estimates (clearly labelled) where no API
// exists, and exits non-zero when any meter is over threshold so CI can gate on it.
//
//   node scripts/billing-check.mjs                 (report; exit 1 if any ≥ 80%)
//   node scripts/billing-check.mjs --threshold 90  (custom breach %)
//   node scripts/billing-check.mjs --json          (machine-readable)
//
// Tokens (env; all optional — a missing token degrades that meter to a skip,
// never a fake number):
//   GH_BILLING_TOKEN   PAT with read:billing/admin — GitHub Actions minutes.
//                      Falls back to GH_TOKEN/GITHUB_TOKEN, which 403s on the
//                      billing endpoint (default Actions token lacks the scope).
//   CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID — Workers requests + AI neurons.
//   GITHUB_TOKEN/GH_TOKEN — run counts for the Anthropic spend ESTIMATE.
//   ANTHROPIC_ADMIN_KEY — if set, a note points at the real usage source; there
//                      is no simple public usage API, so spend stays an estimate.
import { pathToFileURL } from "node:url";

const OWNER = process.env.GH_BILLING_OWNER ?? "colinxs";
const REPO = process.env.GH_BILLING_REPO ?? "colinxs/sux";

// Included-allowance defaults (override via env). Numbers are the plan tiers this
// repo actually runs on; a wrong-but-close limit is still a useful headroom gauge.
const LIMITS = {
	// GitHub Actions: private-repo free tier is ~2000 min/mo (Pro). Metered after.
	ghActionsMinutes: num(process.env.GH_ACTIONS_LIMIT_MIN, 2000),
	// Workers Paid ($5/mo) includes 10M requests/mo.
	cfWorkersRequests: num(process.env.CF_REQUESTS_LIMIT, 10_000_000),
	// Workers AI Paid includes 10k neurons/day → ~300k/mo baseline allowance.
	cfNeurons: num(process.env.CF_NEURONS_LIMIT, 300_000),
	// Anthropic has no included allowance; this is a soft monthly $ budget to watch.
	anthropicSpendUsd: num(process.env.ANTHROPIC_BUDGET_USD, 50),
};

// Rough per-run Anthropic cost for the ESTIMATE. claude-code-action runs burn
// tokens on repo context + reasoning; security-review's 20-min budget is the
// heaviest. These are deliberately conservative order-of-magnitude figures.
const RUN_COST_USD = { "security-review": 0.9, claude: 0.4, "claude-autofix": 0.3 };

function num(v, d) {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : d;
}

/** consumed percentage, clamped to [0, ∞); null when the limit is unknown. */
export function pct(used, limit) {
	if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
	return (used / limit) * 100;
}

/** classify a meter for reporting/exit: over ≥ threshold, warn ≥ 60%, else ok. */
export function classify(p, threshold) {
	if (p == null) return "unknown";
	if (p >= threshold) return "over";
	if (p >= Math.min(60, threshold * 0.75)) return "warn";
	return "ok";
}

const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 1 : 0 }) : "—");
const ICON = { over: "✗", warn: "!", ok: "✓", unknown: "?", skip: "·", error: "✗" };

// ---- meters -----------------------------------------------------------------

async function ghJson(path, token) {
	const r = await fetch(`https://api.github.com${path}`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "sux-billing-check",
		},
		signal: AbortSignal.timeout(20000),
	});
	return { status: r.status, body: r.ok ? await r.json() : await r.text().catch(() => "") };
}

async function githubActionsMeter() {
	const token = process.env.GH_BILLING_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
	const m = { name: "GitHub Actions minutes", unit: "min", limit: LIMITS.ghActionsMinutes };
	if (!token) return { ...m, state: "skip", note: "no GH_BILLING_TOKEN/GITHUB_TOKEN in env" };
	try {
		const { status, body } = await ghJson(`/users/${OWNER}/settings/billing/actions`, token);
		// 403 = wrong scope; 404 = billing endpoint invisible to this token (same
		// root cause). Either way it needs a PAT with admin/read:billing.
		if (status === 403 || status === 404) return { ...m, state: "skip", note: `HTTP ${status} — token lacks admin/read:billing; set GH_BILLING_TOKEN (PAT with those scopes)` };
		if (status !== 200) return { ...m, state: "error", note: `HTTP ${status} ${String(body).slice(0, 120)}` };
		// included_minutes = plan allowance; total_minutes_used = this cycle.
		const used = Number(body.total_minutes_used) || 0;
		const limit = Number(body.included_minutes) || m.limit;
		return { ...m, limit, used, state: "ok", note: `paid so far: ${fmt(Number(body.total_paid_minutes_used) || 0)} min` };
	} catch (e) {
		return { ...m, state: "error", note: err(e) };
	}
}

async function cfGraphQL(query, variables, token) {
	const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ query, variables }),
		signal: AbortSignal.timeout(20000),
	});
	const j = await r.json().catch(() => ({}));
	if (!r.ok || j.errors?.length) throw new Error(`CF GraphQL ${r.status}: ${JSON.stringify(j.errors ?? j).slice(0, 160)}`);
	return j.data;
}

function monthStartISO() {
	const d = new Date();
	return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

async function cloudflareMeters() {
	const token = process.env.CLOUDFLARE_API_TOKEN;
	const account = process.env.CLOUDFLARE_ACCOUNT_ID;
	const reqMeter = { name: "CF Workers requests", unit: "req", limit: LIMITS.cfWorkersRequests };
	const aiMeter = { name: "CF Workers AI neurons", unit: "neurons", limit: LIMITS.cfNeurons };
	if (!token || !account) {
		const note = "no CLOUDFLARE_API_TOKEN/ACCOUNT_ID in env";
		return [{ ...reqMeter, state: "skip", note }, { ...aiMeter, state: "skip", note }];
	}
	const since = `${monthStartISO()}T00:00:00Z`;
	const until = new Date().toISOString();
	const out = [];
	// Workers requests (month-to-date), summed across scripts.
	try {
		const q = `query($a:String!,$s:Time!,$u:Time!){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:10000,filter:{datetime_geq:$s,datetime_leq:$u}){sum{requests}}}}}`;
		const d = await cfGraphQL(q, { a: account, s: since, u: until }, token);
		const rows = d?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
		const used = rows.reduce((t, r) => t + (r.sum?.requests || 0), 0);
		out.push({ ...reqMeter, used, state: "ok", note: "month-to-date, all scripts" });
	} catch (e) {
		out.push({ ...reqMeter, state: "error", note: err(e) });
	}
	// Workers AI neurons (month-to-date). Dataset/field names follow the CF
	// GraphQL schema; if CF renames them this degrades to a labelled error (never
	// a fake number). Verify with introspection if it starts erroring.
	try {
		const q = `query($a:String!,$s:Time!,$u:Time!){viewer{accounts(filter:{accountTag:$a}){aiInferenceAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_leq:$u}){sum{totalNeurons}}}}}`;
		const d = await cfGraphQL(q, { a: account, s: since, u: until }, token);
		const rows = d?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups ?? [];
		const used = rows.reduce((t, r) => t + (r.sum?.totalNeurons || 0), 0);
		out.push({ ...aiMeter, used, state: "ok", note: "month-to-date" });
	} catch (e) {
		out.push({ ...aiMeter, state: "error", note: err(e) });
	}
	return out;
}

/** count Actions runs of a workflow file created since ISO date. */
async function countRuns(workflowFile, sinceISO, token) {
	const { status, body } = await ghJson(
		`/repos/${REPO}/actions/workflows/${workflowFile}/runs?created=%3E%3D${sinceISO}&per_page=1`,
		token,
	);
	if (status !== 200) return null;
	return Number(body.total_count) || 0;
}

export function estimateAnthropicSpend(counts, costTable = RUN_COST_USD) {
	let usd = 0;
	const parts = [];
	for (const [name, n] of Object.entries(counts)) {
		if (n == null) continue;
		const c = (costTable[name] ?? 0.4) * n;
		usd += c;
		parts.push(`${name}×${n}`);
	}
	return { usd, parts };
}

async function anthropicMeter() {
	const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_BILLING_TOKEN;
	const m = { name: "Anthropic API spend (est.)", unit: "USD", limit: LIMITS.anthropicSpendUsd, estimate: true };
	if (!token) return { ...m, state: "skip", note: "no GITHUB_TOKEN for run counts; real number needs Anthropic admin/usage API or console" };
	try {
		const since = monthStartISO();
		const workflows = { "security-review": "security-review.yml", claude: "claude.yml", "claude-autofix": "claude-autofix.yml" };
		const counts = {};
		for (const [key, file] of Object.entries(workflows)) counts[key] = await countRuns(file, since, token);
		if (Object.values(counts).every((v) => v == null)) return { ...m, state: "error", note: "could not read workflow run counts" };
		const { usd, parts } = estimateAnthropicSpend(counts);
		const src = process.env.ANTHROPIC_ADMIN_KEY ? "ANTHROPIC_ADMIN_KEY set — verify against console usage" : "no usage API; console for the real number";
		return { ...m, used: usd, state: "ok", note: `ESTIMATE from run counts (${parts.join(", ") || "0 runs"}); ${src}` };
	} catch (e) {
		return { ...m, state: "error", note: err(e) };
	}
}

const err = (e) => `${e?.name ?? "Error"}: ${String(e?.message ?? e).slice(0, 140)}`;

// ---- report -----------------------------------------------------------------

export function evaluate(meters, threshold) {
	return meters.map((m) => {
		const p = m.state === "ok" ? pct(m.used, m.limit) : null;
		return { ...m, pct: p, level: m.state === "ok" ? classify(p, threshold) : m.state };
	});
}

async function main() {
	const argv = process.argv.slice(2);
	const asJson = argv.includes("--json");
	const ti = argv.indexOf("--threshold");
	const threshold = ti >= 0 ? num(argv[ti + 1], 80) : num(process.env.BILLING_THRESHOLD, 80);

	const meters = evaluate(
		[await githubActionsMeter(), ...(await cloudflareMeters()), await anthropicMeter()],
		threshold,
	);

	if (asJson) {
		console.log(JSON.stringify({ threshold, generatedAt: new Date().toISOString(), meters }, null, 2));
	} else {
		console.log(`sux billing/usage — ${new Date().toISOString().slice(0, 10)} (breach threshold: ${threshold}%)\n`);
		for (const m of meters) {
			const unit = m.unit === "USD" ? `$${fmt(m.used)}` : `${fmt(m.used)} ${m.unit}`;
			const of = m.unit === "USD" ? `$${fmt(m.limit)}` : `${fmt(m.limit)} ${m.unit}`;
			const bar = m.pct == null ? "" : `  ${m.pct.toFixed(0).padStart(3)}%  (${unit} / ${of})`;
			console.log(`${ICON[m.level] ?? "?"} ${m.name.padEnd(28)}${bar}`);
			if (m.note) console.log(`    ${m.note}`);
		}
	}

	const over = meters.filter((m) => m.level === "over");
	const unknown = meters.filter((m) => ["skip", "error", "unknown"].includes(m.level));
	if (!asJson) {
		console.log(
			`\n${over.length} meter(s) over ${threshold}%` +
				(over.length ? `: ${over.map((m) => `${m.name} (${m.pct.toFixed(0)}%)`).join(", ")}` : "") +
				(unknown.length ? `; ${unknown.length} unqueryable (${unknown.map((m) => m.name).join(", ")})` : ""),
		);
	}
	process.exitCode = over.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
