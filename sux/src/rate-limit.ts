// Weighted, per-tool rate limiting. The base gate (index.ts fetch) charges every
// request 1 token against the per-user limiter. This adds the EXTRA tokens an
// expensive tool consumes beyond that base, so a burst of paid/heavy calls
// (render, Kagi/SerpAPI, Workers AI) exhausts the budget faster than free
// deterministic fns — backpressure lands where the real cost is. Weights are
// declared per fn via Fn.cost (default 1 = no extra).

import { FUNCTIONS } from "./fns";
import { KIND_PLANS, parseStrategies } from "./fns/get";
import { shipToLoki } from "./grafana";
import { type JsonRpc, sseResponse } from "./mcp-util";
import { recordCall } from "./metrics";
import { exceedsDepth, MAX_ARG_DEPTH } from "./prim";
import { findFn, type RtEnv, unwrapFnCall } from "./registry";

const rateLimited = (): Response =>
	new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "10" } });

const nestedTooDeep = (id: unknown, name: string): Response =>
	sseResponse({
		jsonrpc: "2.0",
		id: id ?? null,
		result: { content: [{ type: "text", text: `Tool '${name}' rejected: arguments nested too deep (> ${MAX_ARG_DEPTH} levels)` }], isError: true },
	});

/** Extra limiter tokens a tool consumes beyond the base 1. cost defaults to 1
 *  (→ 0 extra); unknown tools charge 0 extra (they'll 404 in dispatch anyway). */
export function extraCost(name: string): number {
	const fn = findFn(FUNCTIONS, name);
	return Math.max(0, (fn?.cost ?? 1) - 1);
}

// The fan-out wrappers run their target tool(s) many times behind a single
// tools/call, so their own weight (batch/pipe default to cost 1 → 0 extra) does
// NOT reflect the real work. Charging only the wrapper let a burst of expensive
// leaves — batch({tool:"render", over:[…100]}) is 100 real renders — through for
// zero extra tokens, a straight limiter-evasion hole. requestCost resolves the
// leaf(s) the way the dispatchers do (batch.ts / pipe.ts) and sums their weights,
// clamped to each wrapper's amplification cap so a hostile width can't inflate the
// charge past what dispatch will actually run.
const MAX_BATCH_CALLS = 100;
const MAX_PIPE_STEPS = 25;

/** EXTRA limiter tokens this whole request will consume — the sum of the leaf
 *  weights it fans into, not just the front tool's. Falls back to extraCost(name)
 *  for every non-fan-out tool. */
// batch's own nested-fanout amplification cap (mirrors NESTED_FANOUT_TOOLS/
// MAX_NESTED_CALLS in batch.ts — duplicated here, same as MAX_BATCH_CALLS/
// MAX_PIPE_STEPS above, so pricing can't be gamed past what dispatch will
// actually run without importing batch.ts's internals).
const NESTED_FANOUT_TOOLS = new Set(["pipe", "batch_fetch", "crawl"]);
const MAX_NESTED_CALLS = 25;

export function requestCost(name: string, args: unknown): number {
	const a = (args && typeof args === "object" && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
	if (name === "batch") {
		const tool = typeof a.tool === "string" ? a.tool.trim() : "";
		// Missing/recursive target is rejected in dispatch and never fans out — charge
		// only the wrapper so an invalid batch can't be gamed into a free pass either way.
		if (!tool || tool === "batch") return extraCost(name);
		const width = Array.isArray(a.over) ? a.over.length : Array.isArray(a.calls) ? a.calls.length : 0;
		const cap = NESTED_FANOUT_TOOLS.has(tool) ? MAX_NESTED_CALLS : MAX_BATCH_CALLS;
		const calls = Math.min(width, cap);
		// Price each mapped call by the mapped TOOL's own cost, recursing when it's
		// itself a fan-out (pipe/batch_fetch/crawl) — a flat extraCost(tool) lookup
		// undercounts a batch-mapped pipe's real nested-render weight to ~0 (#454).
		// `calls` (per-item full args) prices each entry individually; `over`+`args`
		// shares one template across every mapped call.
		let total: number;
		if (Array.isArray(a.calls)) {
			total = (a.calls as unknown[]).slice(0, calls).reduce((sum: number, c) => sum + requestCost(tool, c), 0);
		} else {
			total = requestCost(tool, a.args) * calls;
		}
		const reduceWith = a.reduce_with;
		if (reduceWith && typeof reduceWith === "object" && typeof (reduceWith as { tool?: unknown }).tool === "string") {
			// Recurse into the reducer's own args too — a reduce_with:{tool:'pipe',...}
			// fans into real nested calls just like the map side (#356).
			total += requestCost((reduceWith as { tool: string }).tool.trim(), (reduceWith as { args?: unknown }).args);
		}
		return total;
	}
	if (name === "pipe") {
		const steps = Array.isArray(a.steps) ? (a.steps as unknown[]).slice(0, MAX_PIPE_STEPS) : [];
		let total = 0;
		for (const s of steps) {
			const tool = s && typeof s === "object" && typeof (s as { tool?: unknown }).tool === "string" ? (s as { tool: string }).tool.trim() : "";
			const stepArgs = s && typeof s === "object" ? (s as { args?: unknown }).args : undefined;
			if (tool) total += requestCost(tool, stepArgs);
		}
		return total;
	}
	// get's own flat cost (5) doesn't reflect its real internal fan-out: query mode
	// dispatches a Kagi-equivalent search per file(kind,query) clause (uncapped input
	// would be an uncapped Kagi-call fan-out — get.ts's MAX_GET_STRATEGIES bounds the
	// actual clause count parsed, so pricing mirrors that same cap), and URL mode
	// dispatches render (as:pdf) or wayback+scrape (as:archive). Both call other fns
	// directly via findFn().run() rather than a nested tools/call, so — like batch/pipe
	// — the real weight must be priced here rather than left at get's flat baseline.
	if (name === "get") {
		const input = typeof a.input === "string" ? a.input : "";
		let total: number;
		if (/^https?:\/\//i.test(input.trim())) {
			total = a.as === "archive" ? extraCost("wayback") + extraCost("scrape") : extraCost("render");
		} else {
			// Price each parsed strategy by its ACTUAL metered lens-call count — kinds
			// document/ebook/any run 2 lensIds (→ 2 kagiTool calls), not 1 — reusing
			// get.ts's own parser/plans so the charge tracks runStrategies exactly and
			// can't drift (a flat strategyCount × search under-charged those kinds by 2×).
			const kindArg = typeof a.kind === "string" ? a.kind : undefined;
			total = parseStrategies(input, kindArg).reduce((sum, s) => sum + KIND_PLANS[s.kind].lensIds.length * extraCost("search"), 0);
		}
		if (a.store && a.store !== "none") total += extraCost("ingest");
		return total;
	}
	return extraCost(name);
}

/**
 * Consume the weighted extra tokens for a tools/call. Returns a 429 Response when
 * the limiter denies mid-way (so the caller returns it), or null to proceed.
 * No-op when there's no limiter binding or the method isn't tools/call.
 */
export async function weightedRateLimit(
	env: RtEnv,
	ctx: { waitUntil(p: Promise<unknown>): void },
	login: string,
	rpc: JsonRpc | undefined,
): Promise<Response | null> {
	if (!env.MCP_RATE_LIMITER || rpc?.method !== "tools/call") return null;
	// Charge the REAL leaf's weight even when it's reached via the `fn` escape —
	// otherwise an expensive tool (render/Kagi/AI) dodges its cost behind fn({name}).
	// Same unwrap rule the dispatcher uses, so the two never diverge. requestCost then
	// sums the fan-out leaves (batch/pipe) so a wide batch of renders can't slip the
	// limiter behind the wrapper's own cost-1 weight.
	const unwrapped = unwrapFnCall(rpc.params, FUNCTIONS);
	const effectiveName = unwrapped?.name ?? String(rpc.params?.name ?? "");
	const effectiveArgs = unwrapped?.args ?? rpc.params?.arguments;
	// requestCost recurses through nested pipe/batch args with no depth cap of its
	// own — a self-nested pipe/batch payload can stack-overflow it. checkArgs's
	// MAX_ARG_DEPTH guard exists precisely to stop this, but runs later in
	// handleRpc; reject here first, before pricing, so requestCost never sees an
	// over-deep payload (#626).
	if (effectiveArgs !== null && typeof effectiveArgs === "object" && exceedsDepth(effectiveArgs, MAX_ARG_DEPTH)) {
		const err = `arguments nested too deep (> ${MAX_ARG_DEPTH} levels)`;
		const rejectEvent = { tool: effectiveName, ms: 0, error: true, err };
		recordCall(env, ctx, rejectEvent);
		shipToLoki(env, ctx, rejectEvent);
		return nestedTooDeep(rpc.id, effectiveName);
	}
	const extra = requestCost(effectiveName, effectiveArgs);
	for (let i = 0; i < extra; i++) {
		// Fail OPEN if the limiter throws — an unavailable limiter must never itself
		// become an outage (mirrors the presence-check fail-open above).
		let success = true;
		try {
			success = (await env.MCP_RATE_LIMITER.limit({ key: login })).success;
		} catch (e) {
			console.warn(`weighted rate limiter threw, failing open: ${String((e as Error)?.message ?? e)}`);
			break;
		}
		if (!success) return rateLimited();
	}
	return null;
}
