// Resilient render for the retailer fns: try the Mac backend first, fall back to
// Cloudflare Browser Rendering (residential + stealth) when it's down.
//
// The Mac node is primary because it has the best track record against active bot
// walls and owns the solver tiers the cf path CANNOT replicate — the PerimeterX
// press-and-hold gesture and the CapSolver captcha tier. But when the node is
// off/502/circuit-open, a mac-only retailer fn fails outright. cf-residential is a
// PROVEN fallback for at least Amazon's AWS WAF (verified live), and worst-case it
// matches today's behavior since it only fires AFTER mac has already failed.
//
// Whichever backend answers, the caller runs the SAME extractor on the returned
// HTML (the extractors are backend-agnostic). Never throws — if BOTH fail we
// surface the mac error, the more informative signal and the message callers match.

import { cfRender } from "./cf-render";
import { type MacRenderResult, macRender } from "./mac-render";
import type { RtEnv } from "./registry";

// The retail callers only ever want post-JS HTML, so this is the mac spec minus
// `as` (always html). `solve` is honored on the mac leg (cf has no solver tier).
export type RetailRenderSpec = {
	url: string;
	wait_until?: string;
	wait_ms?: number;
	block_resources?: boolean;
	timeout_ms?: number;
	solve?: boolean;
};

export type RetailRenderOpts = {
	// Try cf-residential FIRST (mac as fallback). Right for AWS-WAF sites (Amazon) where
	// cf+residential+stealth is a proven pass — avoids the flaky mac node on the common
	// path. Leave false for PerimeterX/Akamai sites (Walmart/HomeDepot) where only the
	// mac node's gesture + solver tiers get through.
	preferCf?: boolean;
};

// Both legs run sequentially inside the 60s FN_DEADLINE_MS, and the mac leg's HTTP
// timeout is its render budget + a ~15s margin — so the FIRST leg must be capped well
// under the deadline or the fallback never runs (the bug this fixes). Budgets chosen so
// worst case (first + second + mac margin) lands ~52s, leaving an 8s buffer.
const FIRST_LEG_MS = 25_000;
const SECOND_LEG_MS = 12_000;

/**
 * Render a retail page across the mac + cf backends with a deadline-safe fallback.
 * Order is mac→cf by default, cf→mac when opts.preferCf. Returns the never-throw mac
 * envelope; on total failure it surfaces the first (primary) backend's error.
 */
export async function retailRender(env: RtEnv, spec: RetailRenderSpec, opts: RetailRenderOpts = {}): Promise<MacRenderResult> {
	const order: Array<"mac" | "cf"> = opts.preferCf ? ["cf", "mac"] : ["mac", "cf"];
	const firstBudget = Math.min(spec.timeout_ms ?? FIRST_LEG_MS, FIRST_LEG_MS);

	const runLeg = async (backend: "mac" | "cf", budget: number): Promise<MacRenderResult> => {
		if (backend === "mac") return macRender(env, { as: "html", ...spec, timeout_ms: budget });
		const cf = await cfRender(env, { url: spec.url, as: "html", wait_until: spec.wait_until, wait_ms: spec.wait_ms, block_resources: spec.block_resources, timeout_ms: budget, residential: true, stealth: true });
		if (cf.ok && "body" in cf) return { ok: true, contentType: cf.contentType, body: cf.body };
		return { ok: false, error: cf.ok ? "cf render returned a non-HTML result" : cf.error };
	};

	const first = await runLeg(order[0], firstBudget);
	if (first.ok) return first;
	const second = await runLeg(order[1], SECOND_LEG_MS);
	return second.ok ? second : first; // surface the primary (first-choice) backend's error
}
