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

/** Stable identity for a signal — `source_tag` is per-item ("mail:<id>", "vault:<path>", ...) and
 * `ts` disambiguates re-embeds of the same source, so the pair is unique within one domain's log
 * without needing a separate id field on `InferSignal` itself. Shared by the drift detector
 * (evidence-trail ids) and the deletion path below (delete-by-id target). */
export const inferSignalId = (s: InferSignal): string => `${s.source_tag}@${s.ts}`;

// ── Inference log (append-only, per domain) ───────────────────────────────────
// A detector's surviving candidate, once it's actually wired to a nudge (a later issue in the
// #858 split), persists here so the deletion/cascade path below has something concrete to
// cascade against. `evidenceIds` are `inferSignalId(...)` values into the SAME domain's signal
// log — deleting a cited signal must delete the inference too (design doc §3 guardrail 3, GDPR
// erasure: no inference may outlive the evidence it was derived from).
export type InferInference = {
	id: string;
	createdAt: number;
	cluster: string;
	evidenceIds: string[];
};

const INFERENCE_CAP = 500;
const inferenceLogKey = (domain: InferDomain): string => `kv:infer:${domain}:inferences`;
const inferenceLog = (env: RtEnv, domain: InferDomain) => cappedKvLog<InferInference>(env, inferenceLogKey(domain), INFERENCE_CAP);

/** Append one inference. Fail-closed like `appendInferSignal` — a dormant/killed domain writes
 * nothing, so a nudge/inference can never be produced for a domain the user hasn't armed. */
export async function appendInferInference(env: RtEnv, domain: InferDomain, inference: InferInference): Promise<AppendSignalResult> {
	if (isInferKilled(env)) return { appended: false, reason: "killed" };
	if (!hasInferArm(env, domain)) return { appended: false, reason: "dormant" };
	await inferenceLog(env, domain).push(inference);
	return { appended: true, reason: "ok" };
}

/** Read back a domain's inference log (newest-first). Reads are always allowed, gated or not. */
export async function readInferInferences(env: RtEnv, domain: InferDomain): Promise<InferInference[]> {
	return inferenceLog(env, domain).load();
}

export type DeleteSignalResult = { deletedSignals: number; cascadedInferences: number };

/**
 * Right-to-erasure path (design doc §3 guardrail 3): delete one signal by id, cascading to any
 * inference that cites it as evidence. Deliberately NOT gated behind `hasInferArm`/`isInferKilled`
 * — a domain the user has since disarmed (or a globally killed inference loop) must still let
 * them erase data written while it was armed; the arm/kill gates protect new writes, not the
 * erasure of past ones.
 */
export async function deleteInferSignal(env: RtEnv, domain: InferDomain, signalIdToDelete: string): Promise<DeleteSignalResult> {
	const signals = await signalLog(env, domain).load();
	const remaining = signals.filter((s) => inferSignalId(s) !== signalIdToDelete);
	const deletedSignals = signals.length - remaining.length;
	if (deletedSignals > 0) await signalLog(env, domain).save(remaining);

	const inferences = await inferenceLog(env, domain).load();
	const survivors = inferences.filter((i) => !i.evidenceIds.includes(signalIdToDelete));
	const cascadedInferences = inferences.length - survivors.length;
	if (cascadedInferences > 0) await inferenceLog(env, domain).save(survivors);

	return { deletedSignals, cascadedInferences };
}

/** Delete a single inference by id. No downstream cascade needed here — an inference has no
 * evidence of its own beyond the signals it already cites (a shipped nudge is derived FROM an
 * inference, but wiring that deletion is a later issue in the split). */
export async function deleteInferInference(env: RtEnv, domain: InferDomain, inferenceId: string): Promise<{ deleted: number }> {
	const inferences = await inferenceLog(env, domain).load();
	const survivors = inferences.filter((i) => i.id !== inferenceId);
	const deleted = inferences.length - survivors.length;
	if (deleted > 0) await inferenceLog(env, domain).save(survivors);
	return { deleted };
}

/** Purge a whole domain's signal-log + inference-log in one shot — the coarsest erasure control
 * ("purge a whole domain's signal-log" per the design doc). */
export async function purgeInferDomain(env: RtEnv, domain: InferDomain): Promise<void> {
	await signalLog(env, domain).save([]);
	await inferenceLog(env, domain).save([]);
}
