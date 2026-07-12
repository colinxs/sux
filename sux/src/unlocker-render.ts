// Shared client for a paid residential "web unlocker" backend (Bright Data / Zyte /
// Oxylabs-style): a hosted HTTP endpoint that fetches a URL through its own managed
// residential IP pool + challenge-solving and returns the final unlocked HTML. This
// is the LAST rung of the retail escalation ladder — reached only after cf-residential
// (primary) and the mac gesture/captcha node (fallback) both fail a hard wall
// (Home Depot's Akamai `_abck`, Costco's Akamai soft-block). It is a plain
// authenticated POST — no browser — so it is cheaper on Worker CPU than a render but
// costs money per call.
//
// Gated fail-closed exactly like macRender: unset UNLOCKER_API_URL/UNLOCKER_API_KEY →
// the rung no-ops with `{ ok:false, error:"unlocker not configured" }`, never throws,
// so the caller falls straight through to its existing blocked-failure message. It is
// body-in / body-out (POST `{ url }`, HTML back) so swapping providers is a config
// change (the URL the operator sets), not a code change.

import type { RtEnv } from "./registry";

// What a caller asks the unlocker to fetch. Only `url` is required; `timeout_ms`
// lets a caller keep the rung inside the retail deadline budget (see retail-render).
export type UnlockerSpec = {
	url: string;
	timeout_ms?: number;
};

export type UnlockerResult = { ok: true; contentType: string; body: string } | { ok: false; error: string };

// Bound the AbortSignal so a slow provider can never hang the rung. Kept tight because
// this fires only after cf+mac already spent their budgets — FN_DEADLINE_MS is the
// ultimate cap, but a paid unlocker should not push us to it.
const UNLOCKER_TIMEOUT_DEFAULT_MS = 12_000;
const UNLOCKER_TIMEOUT_CAP_MS = 20_000;

/**
 * POST a URL to the paid unlocker and return the unlocked HTML. Never throws:
 * unconfigured backend, transport error, non-2xx, unreadable/empty body all resolve
 * to `{ ok:false, error }`. When UNLOCKER_API_URL/UNLOCKER_API_KEY are unset it
 * short-circuits instantly with `unlocker not configured` (no network) — the
 * fail-closed default until an operator arms the rung.
 */
export async function unlockerRender(env: RtEnv, spec: UnlockerSpec): Promise<UnlockerResult> {
	if (!env.UNLOCKER_API_URL || !env.UNLOCKER_API_KEY) {
		return { ok: false, error: "unlocker not configured" };
	}
	const timeout = Math.min(spec.timeout_ms ?? UNLOCKER_TIMEOUT_DEFAULT_MS, UNLOCKER_TIMEOUT_CAP_MS);
	let resp: Response;
	try {
		resp = await fetch(env.UNLOCKER_API_URL, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${env.UNLOCKER_API_KEY}` },
			body: JSON.stringify({ url: spec.url }),
			signal: AbortSignal.timeout(timeout),
		});
	} catch (e) {
		return { ok: false, error: `unlocker failed: ${String((e as Error).message ?? e)}` };
	}
	if (!resp.ok) {
		return { ok: false, error: `unlocker failed: HTTP ${resp.status}` };
	}
	let body: string;
	try {
		body = await resp.text();
	} catch {
		return { ok: false, error: `unlocker failed: unreadable response (HTTP ${resp.status}).` };
	}
	if (!body) return { ok: false, error: "unlocker returned an empty body" };
	return { ok: true, contentType: resp.headers.get("content-type") ?? "text/html", body };
}
