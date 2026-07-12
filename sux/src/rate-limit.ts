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

/**
 * Consume the weighted extra tokens for a tools/call. Returns a 429 Response when
 * the limiter denies mid-way (so the caller returns it), or null to proceed.
 * No-op when there's no limiter binding or the method isn't tools/call.
 */
export async function weightedRateLimit(env: RtEnv, login: string, rpc: JsonRpc | undefined): Promise<Response | null> {
	if (!env.MCP_RATE_LIMITER || rpc?.method !== "tools/call") return null;
	// Charge the REAL leaf's weight even when it's reached via the `fn` escape —
	// otherwise an expensive tool (render/Kagi/AI) dodges its cost behind fn({name}).
	// Same unwrap rule the dispatcher uses, so the two never diverge.
	const effectiveName = unwrapFnCall(rpc.params, FUNCTIONS)?.name ?? String(rpc.params?.name ?? "");
	const extra = extraCost(effectiveName);
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
