// Resilient render for the retailer fns: try Cloudflare Browser Rendering
// (residential + stealth) FIRST, fall back to the Mac patched-browser backend only
// when cf can't clear a given wall.
//
// cf-residential is the DEFAULT backend: a stealthed headless Chromium egressing
// from a home IP, a proven pass for the WAF/soft-bot walls the retailers hit on the
// common path (Amazon's AWS WAF, verified live) with no dependency on the single
// flaky Mac node. The Mac node is now a DORMANT fallback — it still owns the solver
// tiers cf CANNOT replicate (the PerimeterX press-and-hold gesture, the CapSolver
// captcha pass), so a call facing a gesture/captcha wall opts back into mac-first
// per call (opts.preferMac) or reaches the node explicitly via backend:mac.
//
// Whichever backend answers, the caller runs the SAME extractor on the returned
// HTML (the extractors are backend-agnostic). Never throws — if BOTH fail we
// surface the first (primary) backend's error, the signal callers match on.

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
	// Opt back into mac-FIRST (cf as the fallback) for a specific retailer/call. cf is
	// the universal default; set this ONLY when cf regresses on a wall that needs the
	// mac node's gesture/captcha tiers up front (a PerimeterX press-and-hold or a real
	// captcha wall) so the flaky-but-capable node leads instead of trailing.
	preferMac?: boolean;
};

// Both legs run sequentially inside the 60s FN_DEADLINE_MS, and the mac (fallback)
// leg's HTTP timeout is its render budget + a ~15s margin — so the FIRST (cf) leg
// must be capped well under the deadline or the fallback never runs. Budgets chosen
// so worst case (first + second + mac margin) lands ~52s, leaving an 8s buffer. A
// caller adding a THIRD escalation rung (e.g. the paid unlocker on homedepot/costco)
// must keep its own budget inside that buffer — FN_DEADLINE_MS is the hard backstop.
const FIRST_LEG_MS = 25_000;
const SECOND_LEG_MS = 12_000;

// A bot WALL comes back as a "successful" fetch of a block/challenge page, not a transport
// error — so a leg that returns HTML isn't necessarily a win. Treat a page carrying these
// signatures as a FAILURE so the ladder escalates (cf→mac, and the caller's unlocker rung)
// instead of returning the wall as content. MARKER-based only (no blanket length check — a
// legitimately short page must not read as blocked): Akamai (Access Denied / sec-cpt /
// Reference #), PerimeterX-HUMAN (Pardon Our Interruption / verify you are human / px-captcha),
// Cloudflare/Imperva challenge.
const BLOCK_RE = /Access Denied|sec-cpt|Pardon Our Interruption|verify you are (a )?human|px-captcha|Attention Required|Just a moment|Incapsula|Request unsuccessful|Reference #\d/i;

// `minBytes` is opt-in and OFF by default (0) so the ladder's own escalation calls below
// stay marker-only, per the no-blanket-length-check rule above. A caller that already knows
// zero products were extracted from an ostensibly-successful render has a stronger signal —
// a short body at that point is far more likely an empty/challenge shell than a genuinely
// terse real page — so it can opt in with e.g. `looksBlocked(body, 1000)` to also flag those.
// This is THE canonical bot-wall check: retailer fns should route their own "was this
// zero-product result actually a wall?" logic through this rather than hand-rolling a
// drifted regex (the drift is how a marker one retailer added never reached the others).
export function looksBlocked(html: string | undefined, minBytes = 0): boolean {
	if (html == null) return false;
	if (BLOCK_RE.test(html)) return true;
	return html.length < minBytes;
}

/**
 * Render a retail page across the cf + mac backends with a deadline-safe fallback.
 * Order is cf→mac by default, mac→cf when opts.preferMac. Returns the never-throw mac
 * envelope; on total failure it surfaces the first (primary) backend's error.
 */
export async function retailRender(env: RtEnv, spec: RetailRenderSpec, opts: RetailRenderOpts = {}): Promise<MacRenderResult> {
	const order: Array<"mac" | "cf"> = opts.preferMac ? ["mac", "cf"] : ["cf", "mac"];
	const firstBudget = Math.min(spec.timeout_ms ?? FIRST_LEG_MS, FIRST_LEG_MS);

	const runLeg = async (backend: "mac" | "cf", budget: number): Promise<MacRenderResult> => {
		if (backend === "mac") {
			const m = await macRender(env, { as: "html", ...spec, timeout_ms: budget });
			// A mac leg that returns a wall (rare — mac solves challenges — but possible) must
			// also escalate, not pass the block page through as content. A concurrent
			// solverError means the CapSolver tier itself broke — name it in the signal so a
			// solver breakage isn't invisible behind a generic "blocked".
			if (m.ok && "body" in m && looksBlocked(m.body)) {
				return { ok: false, error: m.solverError ? `mac render blocked (bot wall); solver errored: ${m.solverError}` : "mac render blocked (bot wall)" };
			}
			return m;
		}
		const cf = await cfRender(env, { url: spec.url, as: "html", wait_until: spec.wait_until, wait_ms: spec.wait_ms, block_resources: spec.block_resources, timeout_ms: budget, residential: true, stealth: true });
		if (cf.ok && "body" in cf) {
			// cf cleared transport but may have fetched a bot wall — a "successful" block page.
			// Treat it as a failure so the ladder escalates to mac / the paid unlocker.
			if (looksBlocked(cf.body)) return { ok: false, error: "cf render blocked (bot wall)" };
			return { ok: true, contentType: cf.contentType, body: cf.body };
		}
		return { ok: false, error: cf.ok ? "cf render returned a non-HTML result" : cf.error };
	};

	const first = await runLeg(order[0], firstBudget);
	if (first.ok) return first;
	const second = await runLeg(order[1], SECOND_LEG_MS);
	return second.ok ? second : first; // surface the primary (first-choice) backend's error
}
