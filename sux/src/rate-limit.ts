// Weighted, per-tool rate limiting. The base gate (index.ts fetch) charges every
// request 1 token against the per-user limiter. This adds the EXTRA tokens an
// expensive tool consumes beyond that base, so a burst of paid/heavy calls
// (render, Kagi/SerpAPI, Workers AI) exhausts the budget faster than free
// deterministic fns — backpressure lands where the real cost is. Weights are
// declared per fn via Fn.cost (default 1 = no extra).

import { FUNCTIONS } from "./fns";
import type { JsonRpc } from "./mcp-util";
import { findFn, type RtEnv, unwrapFnCall } from "./registry";

const rateLimited = (): Response =>
	new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "10" } });

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
export function requestCost(name: string, args: unknown): number {
	const a = (args && typeof args === "object" && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
	if (name === "batch") {
		const tool = typeof a.tool === "string" ? a.tool.trim() : "";
		// Missing/recursive target is rejected in dispatch and never fans out — charge
		// only the wrapper so an invalid batch can't be gamed into a free pass either way.
		if (!tool || tool === "batch") return extraCost(name);
		const width = Array.isArray(a.over) ? a.over.length : Array.isArray(a.calls) ? a.calls.length : 0;
		const calls = Math.min(width, MAX_BATCH_CALLS);
		let total = extraCost(tool) * calls;
		const reduceWith = a.reduce_with;
		if (reduceWith && typeof reduceWith === "object" && typeof (reduceWith as { tool?: unknown }).tool === "string") {
			total += extraCost((reduceWith as { tool: string }).tool.trim());
		}
		return total;
	}
	if (name === "pipe") {
		const steps = Array.isArray(a.steps) ? (a.steps as unknown[]).slice(0, MAX_PIPE_STEPS) : [];
		let total = 0;
		for (const s of steps) {
			const tool = s && typeof s === "object" && typeof (s as { tool?: unknown }).tool === "string" ? (s as { tool: string }).tool.trim() : "";
			if (tool) total += extraCost(tool);
		}
		return total;
	}
	return extraCost(name);
}

/**
 * Consume the weighted extra tokens for a tools/call. Returns a 429 Response when
 * the limiter denies mid-way (so the caller returns it), or null to proceed.
 * No-op when there's no limiter binding or the method isn't tools/call.
 */
export async function weightedRateLimit(env: RtEnv, login: string, rpc: JsonRpc | undefined): Promise<Response | null> {
	if (!env.MCP_RATE_LIMITER || rpc?.method !== "tools/call") return null;
	// Charge the REAL leaf's weight even when it's reached via the `fn` escape —
	// otherwise an expensive tool (render/Kagi/AI) dodges its cost behind fn({name}).
	// Same unwrap rule the dispatcher uses, so the two never diverge. requestCost then
	// sums the fan-out leaves (batch/pipe) so a wide batch of renders can't slip the
	// limiter behind the wrapper's own cost-1 weight.
	const unwrapped = unwrapFnCall(rpc.params, FUNCTIONS);
	const effectiveName = unwrapped?.name ?? String(rpc.params?.name ?? "");
	const effectiveArgs = unwrapped?.args ?? rpc.params?.arguments;
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
