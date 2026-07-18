// Chunk 01 of the proactive-nudge split (#858 → #863 → this issue, #864). Scope here is
// ONLY the substrate: an append-only per-domain signal log + a per-domain kill-switch-style
// arm gate. No detectors (centroid drift/EWMA — a later issue), no deletion/cascade path, no
// nudge write, no suggest-only warm-up. Every call in this module is inert unless its domain
// is explicitly armed, so shipping this adds zero observable behavior on its own.
//
// Design: docs/design/archive/chunks/designs/proactive-nudge.design.md §1 "Signal log", §3
// guardrail 2 ("Strictly opt-in per domain... health arms independently and last... the
// arm-flag lives in a binding the inference loop has no write credential to").
//
// SAFETY MODEL (mirrors _self_improve.ts's isKilled/hasSelfImprove):
//   isInferKilled — INFER_KILL, checked first, before any per-domain arm check. A truthy
//                   toggle (flagOn) halts every domain at once, regardless of per-domain arms.
//   hasInferArm   — flagOn(INFER_ARM_<DOMAIN>) && !isInferKilled(env). Unset/"0"/"false"/"off"
//                   ⇒ that domain's substrate is fully dormant (append is a no-op). Each domain
//                   arms independently — arming `mail` does not arm `purchases`/`health`/etc.
// Both are `wrangler secret`s, NOT declared in wrangler.jsonc (like SELF_IMPROVE_*/DROPBOX_FULL_*)
// — this module has no write credential to its own gate, so it structurally cannot arm itself.
import type { RtEnv } from "../registry";
import { cappedKvLog } from "./_capped_kv_log";

// Toggle parser shared across the gated-loop modules (_self_improve.ts, _mail_triage.ts, …):
// empty/"0"/"false"/"no"/"off" ⇒ off, so an explicit falsey value can never flip a gate on.
const flagOn = (v: string | undefined): boolean => {
	const s = String(v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
};

// The five domains named in the design doc §3 guardrail 2. `health` is last deliberately —
// no health-specific logic lives here, but the type includes it so a later issue's health
// detector reuses this same gate + signal-log shape rather than inventing a parallel one.
export type InferDomain = "mail" | "purchases" | "calendar" | "files" | "health";

const ARM_ENV_KEY: Record<InferDomain, keyof RtEnv> = {
	mail: "INFER_ARM_MAIL",
	purchases: "INFER_ARM_PURCHASES",
	calendar: "INFER_ARM_CALENDAR",
	files: "INFER_ARM_FILES",
	health: "INFER_ARM_HEALTH",
};

/** Hard stop: a truthy INFER_KILL toggle halts every domain, regardless of its own arm flag. */
export const isInferKilled = (env: RtEnv): boolean => flagOn(env.INFER_KILL);

/** Per-domain arm — default OFF (toggle, not bare truthiness). A global kill always wins. */
export const hasInferArm = (env: RtEnv, domain: InferDomain): boolean =>
	flagOn(env[ARM_ENV_KEY[domain]] as string | undefined) && !isInferKilled(env);

// ── Signal log (append-only, per domain) ──────────────────────────────────────
// `{ts, vec, redacted_snippet, source_tag}` per §1. `vec` is the embedding of the redacted
// snippet, never the raw source text — the detector (a later issue) runs arithmetic over
// `vec`/scalar rollups, so raw personal data need not round-trip through this log at all.
export type InferSignal = {
	ts: number;
	vec: number[];
	redacted_snippet: string;
	source_tag: string;
};

// Capped like the other per-domain KV logs (findings, feedback, mail-triage undo) — bounded
// so an unbounded incremental append can't grow one KV value past the 25MB cap enforced by
// cappedKvLog itself. No batch retrain ever reads this in bulk; a detector only needs a
// bounded recent window (14d/60d per §1), so capping here doesn't lose the analysis surface.
const SIGNAL_CAP = 2000;

const signalLogKey = (domain: InferDomain): string => `kv:infer:${domain}:signals`;

const signalLog = (env: RtEnv, domain: InferDomain) => cappedKvLog<InferSignal>(env, signalLogKey(domain), SIGNAL_CAP);

export type AppendSignalResult = { appended: boolean; reason: string };

/**
 * Append one signal to a domain's log. Fail-closed: a dormant domain (unarmed, or killed)
 * writes nothing and returns `{appended: false}` — the caller doesn't need its own gate check,
 * since this is the ONLY write path onto the log.
 */
export async function appendInferSignal(env: RtEnv, domain: InferDomain, signal: InferSignal): Promise<AppendSignalResult> {
	if (isInferKilled(env)) return { appended: false, reason: "killed" };
	if (!hasInferArm(env, domain)) return { appended: false, reason: "dormant" };
	await signalLog(env, domain).push(signal);
	return { appended: true, reason: "ok" };
}

/** Read back a domain's signal log (newest-first, per cappedKvLog's push ordering). Dormant or
 * not, reads are harmless (no outward action) — used by tests and a future detector alike. */
export async function readInferSignals(env: RtEnv, domain: InferDomain): Promise<InferSignal[]> {
	return signalLog(env, domain).load();
}
