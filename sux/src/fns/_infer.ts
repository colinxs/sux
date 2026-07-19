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
// "vault" added (#865) for the design doc §4 "first slice" — emerging-topic drift is scoped
// to vault+mail specifically, so the detector needs a vault arm alongside the original five.
export type InferDomain = "mail" | "purchases" | "calendar" | "files" | "health" | "vault";

const ARM_ENV_KEY: Record<InferDomain, keyof RtEnv> = {
	mail: "INFER_ARM_MAIL",
	purchases: "INFER_ARM_PURCHASES",
	calendar: "INFER_ARM_CALENDAR",
	files: "INFER_ARM_FILES",
	health: "INFER_ARM_HEALTH",
	vault: "INFER_ARM_VAULT",
};

// Every domain, for cascade paths that can't assume a single domain owns an inference (a
// merged-evidence inference — e.g. centroid drift over vault+mail — is logged under only one
// of its evidence domains; see deleteInferSignal's cross-domain scan, #950).
const ALL_DOMAINS: InferDomain[] = Object.keys(ARM_ENV_KEY) as InferDomain[];

/** Hard stop: a truthy INFER_KILL toggle halts every domain, regardless of its own arm flag. */
export const isInferKilled = (env: RtEnv): boolean => flagOn(env.INFER_KILL);

/** Per-domain arm — default OFF (toggle, not bare truthiness). A global kill always wins. */
export const hasInferArm = (env: RtEnv, domain: InferDomain): boolean =>
	flagOn(env[ARM_ENV_KEY[domain]] as string | undefined) && !isInferKilled(env);

// ── Signal log (append-only, per domain) ──────────────────────────────────────
// `{id, ts, vec, redacted_snippet, source_tag}` per §1 (+ `id`, added in #866 so an individual
// signal — and any inference citing it as evidence — is addressable for the cascading-delete
// path the design doc's safety preconditions require before any nudge ships).
export type InferSignal = {
	id: string;
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

export type AppendSignalResult = { appended: boolean; reason: string; id?: string };

/**
 * Append one signal to a domain's log. Fail-closed: a dormant domain (unarmed, or killed)
 * writes nothing and returns `{appended: false}` — the caller doesn't need its own gate check,
 * since this is the ONLY write path onto the log. Assigns `id` here (the ONLY place a signal
 * is minted) so callers never invent their own ids that could collide.
 */
export async function appendInferSignal(env: RtEnv, domain: InferDomain, signal: Omit<InferSignal, "id">): Promise<AppendSignalResult> {
	if (isInferKilled(env)) return { appended: false, reason: "killed" };
	if (!hasInferArm(env, domain)) return { appended: false, reason: "dormant" };
	const id = crypto.randomUUID();
	await signalLog(env, domain).push({ ...signal, id });
	return { appended: true, reason: "ok", id };
}

/** Read back a domain's signal log (newest-first, per cappedKvLog's push ordering). Dormant or
 * not, reads are harmless (no outward action) — used by tests and a future detector alike. */
export async function readInferSignals(env: RtEnv, domain: InferDomain): Promise<InferSignal[]> {
	return signalLog(env, domain).load();
}

// ── Inference log (append-only, per domain) ───────────────────────────────────
// A later detector's surviving candidate, kept only long enough to be cited as `evidenceIds`
// so a signal deletion can find and cascade into it (§3 guardrail 3) — no nudge-write logic
// lives here, that's a separate later issue. `evidenceIds` are `InferSignal.id`s.
export type InferInference = {
	id: string;
	domain: InferDomain;
	kind: string;
	evidenceIds: string[];
	createdAt: number;
	payload: unknown;
};

const INFERENCE_CAP = 500;

const inferenceLogKey = (domain: InferDomain): string => `kv:infer:${domain}:inferences`;

const inferenceLog = (env: RtEnv, domain: InferDomain) => cappedKvLog<InferInference>(env, inferenceLogKey(domain), INFERENCE_CAP);

/** Append one inference, same fail-closed gate as appendInferSignal (armed domain only). */
export async function appendInferInference(env: RtEnv, domain: InferDomain, inference: Omit<InferInference, "id">): Promise<AppendSignalResult> {
	if (isInferKilled(env)) return { appended: false, reason: "killed" };
	if (!hasInferArm(env, domain)) return { appended: false, reason: "dormant" };
	const id = crypto.randomUUID();
	await inferenceLog(env, domain).push({ ...inference, id });
	return { appended: true, reason: "ok", id };
}

/** Read back a domain's inference log (newest-first). */
export async function readInferInferences(env: RtEnv, domain: InferDomain): Promise<InferInference[]> {
	return inferenceLog(env, domain).load();
}

// ── Deletion / cascade (§3 guardrail 3 — "explainable + forgettable") ─────────
// Deletion is NEVER gated by arm/kill: a disarmed or killed domain must still be erasable,
// same as an armed one — the arm flag governs new writes, not the user's right to forget what
// was already written. GDPR erasure framing (design doc refs) means these run unconditionally.

export type DeleteSignalResult = { deletedSignal: boolean; cascadedInferenceIds: string[] };

/**
 * Cascade a set of removed signal ids into every armed domain's inference log (skipping
 * `skipDomain`, if given — for a caller that has already wiped that domain's own log directly):
 * strip the removed ids out of every inference's `evidenceIds`, and delete any inference left
 * with ZERO evidence — no inference may outlive the evidence it was derived from. A merged-
 * evidence inference (evidenceIds spanning multiple armed domains — e.g. centroid drift over
 * vault+mail) is logged under only ONE of those domains, so the scan always covers every domain,
 * not just the removed signals' own (#950). Shared by deleteInferSignal (one id) and
 * purgeInferDomain (a whole domain's worth) — same loop shape, differing only in set size.
 */
async function cascadeTrimInferences(env: RtEnv, removedIds: Set<string>, skipDomain?: InferDomain): Promise<string[]> {
	const deletedInferenceIds: string[] = [];
	for (const d of ALL_DOMAINS) {
		if (d === skipDomain) continue;
		const inferences = await inferenceLog(env, d).load();
		const kept: InferInference[] = [];
		let changed = false;
		for (const inf of inferences) {
			const remaining = inf.evidenceIds.filter((id) => !removedIds.has(id));
			if (remaining.length === inf.evidenceIds.length) {
				kept.push(inf);
				continue;
			}
			changed = true;
			if (remaining.length > 0) {
				kept.push({ ...inf, evidenceIds: remaining });
			} else {
				deletedInferenceIds.push(inf.id);
			}
		}
		if (changed) await inferenceLog(env, d).save(kept);
	}
	return deletedInferenceIds;
}

/**
 * Delete one signal by id, then cascade: strip that id out of every inference's `evidenceIds`,
 * and delete any inference that had ALL of its evidence removed — no inference may outlive the
 * evidence it was derived from. An inference that still cites other, undeleted signals survives
 * with its `evidenceIds` trimmed.
 *
 * The signal itself only ever lives in its own domain's log, but a merged-evidence inference
 * (evidenceIds spanning multiple armed domains — e.g. centroid drift over vault+mail) is logged
 * under only ONE of those domains, not necessarily `domain`. So the cascade scans every domain's
 * inference log, not just this signal's own — otherwise a signal deleted from a non-primary
 * domain can never find/trim/delete the inference it fed (#950).
 */
export async function deleteInferSignal(env: RtEnv, domain: InferDomain, signalId: string): Promise<DeleteSignalResult> {
	const signals = await signalLog(env, domain).load();
	const kept = signals.filter((s) => s.id !== signalId);
	const deletedSignal = kept.length !== signals.length;
	if (deletedSignal) await signalLog(env, domain).save(kept);

	const cascadedInferenceIds = await cascadeTrimInferences(env, new Set([signalId]));

	return { deletedSignal, cascadedInferenceIds };
}

/** Delete one inference directly (the user forgetting a suggestion, not its underlying signals). */
export async function deleteInferInference(env: RtEnv, domain: InferDomain, inferenceId: string): Promise<boolean> {
	const inferences = await inferenceLog(env, domain).load();
	const kept = inferences.filter((inf) => inf.id !== inferenceId);
	if (kept.length === inferences.length) return false;
	await inferenceLog(env, domain).save(kept);
	return true;
}

/**
 * Purge a whole domain: wipe its signal log and inference log entirely, then cascade into every
 * OTHER domain's inference log — same "no inference may outlive its evidence" guardrail
 * deleteInferSignal enforces (#950), just for a whole-domain wipe instead of one signal. A
 * merged-evidence inference (e.g. centroid drift over vault+mail) can be logged under only ONE
 * of its evidence domains, so purging a different domain's signals must still find and
 * trim/cascade-delete any inference elsewhere that cited them.
 */
export async function purgeInferDomain(env: RtEnv, domain: InferDomain): Promise<void> {
	const purgedIds = new Set((await signalLog(env, domain).load()).map((s) => s.id));

	await signalLog(env, domain).save([]);
	await inferenceLog(env, domain).save([]);

	if (!purgedIds.size) return;
	await cascadeTrimInferences(env, purgedIds, domain);
}
