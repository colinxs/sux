// Resilient render for the retailer fns: Cloudflare Browser Run (residential +
// stealth) is the PRIMARY, with the paid residential "unlocker" as the fallback
// rung for the hard walls cf can't clear (Home Depot's Akamai `_abck`, Walmart's
// PerimeterX, Costco's Akamai soft-block).
//
// cf-residential is a stealthed headless Chromium egressing from a home IP — a
// proven pass for the WAF/soft-bot walls the retailers hit on the common path
// (Amazon's AWS WAF, verified live). The unlocker is a hosted residential IP pool
// + challenge-solving reached by a plain authenticated POST (no browser); it is
// env-gated fail-closed (UNLOCKER_API_* unset → no-ops instantly), so the common
// path stays pure cf and a hard wall surfaces cf's blocked error unchanged.
//
// Whichever backend answers, the caller runs the SAME extractor on the returned
// HTML (the extractors are backend-agnostic). Never throws — if BOTH fail we
// surface the cf (primary) backend's error, the signal callers match on.

import { cfRender } from "./cf-render";
import type { RtEnv } from "./registry";
import { unlockerRender } from "./unlocker-render";
import { learnedRung, recordRung } from "./fns/_util/rung-memory";

// The retail callers only ever want post-JS HTML, so this is the render spec minus
// `as` (always html).
export type RetailRenderSpec = {
	url: string;
	wait_until?: string;
	wait_ms?: number;
	block_resources?: boolean;
	timeout_ms?: number;
};

// The never-throw render envelope, shared by retailRender and its callers (was
// MacRenderResult before the mac backend was removed).
export type RenderResult = { ok: true; contentType: string; body: string } | { ok: false; error: string };

// The cf (primary) leg runs inside the 60s FN_DEADLINE_MS; its budget is capped
// well under the deadline so the unlocker fallback still has room to run. The cf
// leg's real ceiling is FIRST_LEG_MS + the caller's `wait_ms`, which cf-render
// sleeps AFTER goto — and which this path does NOT clamp, since retailRender calls
// cfRender directly rather than through the render fn (whose schema caps wait_ms at
// 10s). Worst case at today's callers (wait_ms ≤6s): 25 + 6 + 12 ≈ 43s, plus launch
// and extraction — inside the deadline, but raise `wait_ms` here and it isn't.
const FIRST_LEG_MS = 25_000;
const UNLOCKER_LEG_MS = 12_000;

// A bot WALL comes back as a "successful" fetch of a block/challenge page, not a transport
// error — so a leg that returns HTML isn't necessarily a win. Treat a page carrying these
// signatures as a FAILURE so the ladder escalates (cf→unlocker) instead of returning the
// wall as content. MARKER-based only (no blanket length check — a legitimately short page
// must not read as blocked): Akamai (Access Denied / sec-cpt / Reference #), PerimeterX-HUMAN
// (Pardon Our Interruption / verify you are human / px-captcha), Cloudflare/Imperva challenge.
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
 * Render a retail page across the cf + unlocker backends with a deadline-safe
 * fallback. Order is cf→unlocker: cf-residential first, then the paid unlocker for
 * a wall cf couldn't clear (a no-op when UNLOCKER_API_* is unset). Returns the
 * never-throw envelope; on total failure it surfaces the cf (primary) error.
 */
export async function retailRender(env: RtEnv, spec: RetailRenderSpec): Promise<RenderResult> {
	const budget = Math.min(spec.timeout_ms ?? FIRST_LEG_MS, FIRST_LEG_MS);

	// A domain previously learned to need the unlocker can skip straight past cf's
	// doomed rung (#844) — still re-probed periodically by learnedRung itself, so a
	// domain that's stopped needing it drifts back down rather than staying pinned.
	const learned = await learnedRung(env, spec.url);
	if (learned === "unlocker") {
		// Learned shortcut: try the unlocker first, skipping cf's doomed rung (#844).
		// If the unlocker itself fails (transient timeout/rate-limit, or the site no
		// longer needs it), fall through to cf below rather than failing outright —
		// mirrors _util.ts's fetchTextOkEscalating fallback-from-the-bottom pattern.
		const u = await unlockerRender(env, { url: spec.url, timeout_ms: UNLOCKER_LEG_MS });
		if (u.ok && !looksBlocked(u.body)) {
			await recordRung(env, spec.url, "unlocker");
			return { ok: true, contentType: u.contentType, body: u.body };
		}
		const unlockerError = u.ok ? "unlocker render blocked (bot wall)" : u.error;
		const cf = await cfRender(env, {
			url: spec.url,
			as: "html",
			wait_until: spec.wait_until,
			wait_ms: spec.wait_ms,
			block_resources: spec.block_resources,
			timeout_ms: budget,
			residential: true,
			stealth: true,
		});
		if (cf.ok && "body" in cf && !looksBlocked(cf.body)) {
			await recordRung(env, spec.url, "render");
			return { ok: true, contentType: cf.contentType, body: cf.body };
		}
		return { ok: false, error: unlockerError };
	}

	const cf = await cfRender(env, {
		url: spec.url,
		as: "html",
		wait_until: spec.wait_until,
		wait_ms: spec.wait_ms,
		block_resources: spec.block_resources,
		timeout_ms: budget,
		residential: true,
		stealth: true,
	});
	// cf cleared transport but may have fetched a bot wall — a "successful" block page.
	// Treat it as a failure so the ladder escalates to the paid unlocker.
	if (cf.ok && "body" in cf && !looksBlocked(cf.body)) {
		await recordRung(env, spec.url, "render");
		return { ok: true, contentType: cf.contentType, body: cf.body };
	}
	const cfError = cf.ok ? ("body" in cf ? "cf render blocked (bot wall)" : "cf render returned a non-HTML result") : cf.error;

	// Fallback: the paid residential unlocker (no-ops instantly when UNLOCKER_API_* is unset).
	const u = await unlockerRender(env, { url: spec.url, timeout_ms: UNLOCKER_LEG_MS });
	if (u.ok && !looksBlocked(u.body)) {
		await recordRung(env, spec.url, "unlocker");
		return { ok: true, contentType: u.contentType, body: u.body };
	}

	return { ok: false, error: cfError }; // surface the primary (cf) backend's error
}
