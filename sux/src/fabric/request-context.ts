// The placement fabric's per-request context (design §7, Stage 0.2a).
//
// This GENERALIZES `EgressContext` rather than inventing a sibling, because the egress audit is
// the one place per-request state is already done correctly and its hazard note (proxy.ts) is
// the sharpest statement of the trap in this codebase:
//
//   the isolate is SHARED across concurrent requests, so anything parked on the shared `env`
//   gets clobbered.
//
// `_egress` solves that with a per-request env CLONE — a shallow copy where bindings (KV/R2/…)
// share the one env by reference and only this context is per-request. Everything added here
// inherits that discipline or it races, and it races intermittently, which is the worst way to
// find out.
//
// The FIELD on RtEnv stays named `_egress`. That is deliberate, not laziness: it is read through
// ~20 fns via smartFetch without threading a positional arg, so renaming it is mechanical churn
// that belongs with Stage 0.1's sweep of the same call sites, not with the type change. The
// relationship is stated here rather than left implicit — there is ONE per-request mechanism,
// not two.

import { classify, join, MAX_SENSITIVITY, PUBLIC, type Sensitivity, tagsOf } from "./sensitivity";

/** How the caller is waiting on this request. Deadline overrun degrades to async rather than
 * erroring (design §7), so the mode has to be readable by whatever decides to degrade. */
export type RequestMode = "sync" | "async-push" | "async-pull" | "streaming";

export interface RequestContext {
	/** The request's own ExecutionContext — never a concurrent request's, which is the bug
	 * parking this on the shared env produced. */
	ctx: { waitUntil(p: Promise<unknown>): void };
	/** Short correlation id, one per tools/call. */
	reqId: string;
	/** The OAuth-authenticated principal. The only per-request identity signal this
	 * stateless-per-request server has. */
	login?: string;
	/** Everything this request has touched so far, joined. Mutable by design — it accumulates
	 * as the request reads sources — which is exactly why it must live on the per-request clone. */
	sensitivity: Sensitivity;
	/** Where each tag came from, so a later refusal can be explained. A denial the owner can't
	 * trace is a denial they route around. */
	provenance: string[];
	/** Wall-clock start and budget, so a degradation decision has something to read instead of
	 * re-deriving a deadline per call site. */
	startedAt: number;
	deadlineMs: number;
	mode: RequestMode;
}

export function newRequestContext(
	ctx: { waitUntil(p: Promise<unknown>): void },
	opts: { reqId: string; login?: string; deadlineMs: number; now: number; mode?: RequestMode },
): RequestContext {
	return {
		ctx,
		reqId: opts.reqId,
		login: opts.login,
		// A request that has touched nothing is genuinely public — NOT unknown. `classify` is
		// what fails closed on an unclassified VALUE; a fresh context has simply read nothing
		// yet, and seeding it MAX would make every request maximally sensitive forever, since
		// join can only widen.
		sensitivity: PUBLIC,
		provenance: [],
		startedAt: opts.now,
		deadlineMs: opts.deadlineMs,
		mode: opts.mode ?? "sync",
	};
}

/** Record that this request touched a source of the given sensitivity. Joins (unions) into the
 * request's tag set — never replaces — so no read can narrow what an earlier read established.
 * `tags` goes through `classify`, so an unclassified or malformed source is treated as maximally
 * sensitive rather than quietly contributing nothing. */
export function observeSensitivity(rc: RequestContext, tags: unknown, source: string): void {
	const resolved = classify(tags);
	rc.sensitivity = join(rc.sensitivity, resolved);
	if (source && !rc.provenance.includes(source)) rc.provenance.push(source);
}

/** Milliseconds left in the budget, floored at 0. */
export function remainingMs(rc: RequestContext, now: number): number {
	return Math.max(0, rc.deadlineMs - (now - rc.startedAt));
}

/** True once the budget is spent — the signal to degrade to async rather than error (§7). */
export function isOverDeadline(rc: RequestContext, now: number): boolean {
	return remainingMs(rc, now) === 0;
}

/** A log/audit-safe view. Tag NAMES and provenance labels only — never the content that carried
 * them, and never the login, which is identity rather than classification. */
export function describeSensitivity(rc: RequestContext): { tags: string[]; provenance: string[]; maxed: boolean } {
	return {
		tags: tagsOf(rc.sensitivity),
		provenance: [...rc.provenance],
		maxed: rc.sensitivity.size === MAX_SENSITIVITY.size,
	};
}
