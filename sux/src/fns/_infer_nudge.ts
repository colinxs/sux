// Chunk 04 of the proactive-nudge split (#858 → #863 → this issue, #867). Scope here is
// ONLY the nudge-surface write: take a surviving centroid-drift candidate (#865) and, subject
// to the design doc §2/§3 high-signal caps, phrase + append ONE line to the Daily-note `sux`
// section — the same quiet-channel `digestAppend` pattern _agenda.ts/_mail_triage.ts/
// _briefing.ts/_ask_gate_reminder.ts already use. No reply-command processing lives here (that
// would be a `dismiss`/`yes`/etc. inbound loop, mirroring _agenda_reply.ts's split from
// _agenda.ts) — this issue's deliverable is the write path + its caps, matching the design
// doc's own §2 vs. the later interactive-controls framing.
//
// Design: docs/design/archive/chunks/designs/proactive-nudge.design.md §2 "Nudge surface",
// §3 guardrail 3 ("explainable + forgettable") and guardrail "high-signal" (§2's last bullet).
// Depends on #864 (signal-log + arm gate) and #865 (centroid-drift detector) — both landed
// (#946) — and #866's cascading deletion path (also #946), which per the design doc's own
// ordering must land before this ships live; it did.
import type { RtEnv } from "../registry";
import { fingerprint, ledger } from "../ledger";
import { hasAI, llm } from "../ai";
import { appendInferInference, hasInferArm, isInferKilled, readInferSignals, type InferDomain, type InferSignal } from "./_infer";
import { detectCentroidDrift, type DriftCandidate, type DriftOptions } from "./_infer_drift";
import { errMsg, vaultToday } from "./_util";

const numOr = (v: unknown, dflt: number): number => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : dflt;
};

// The design doc's §4 "first slice": emerging-topic over vault+mail only. A later domain
// (purchases/calendar/files/health) gets its own detector issue before it's added here.
const FIRST_SLICE_DOMAINS: InferDomain[] = ["vault", "mail"];

/** Confidence floor on driftScore — default matches _infer_drift.ts's own detector threshold,
 *  so this is a belt-and-suspenders re-check, not a second independent bar. */
const confidenceFloor = (env: RtEnv): number => {
	const n = Number(env.INFER_NUDGE_MIN_CONFIDENCE);
	return Number.isFinite(n) && n > 0 ? n : 0.15;
};

/** How long a fired inference's evidence-fingerprint is suppressed from re-firing — the
 *  "cooldown so a dismissed inference can't re-fire" guardrail, applied unconditionally since
 *  this issue doesn't (yet) process an explicit dismiss/not-useful reply. Default 7 days. */
const cooldownDays = (env: RtEnv): number => numOr(env.INFER_NUDGE_COOLDOWN_DAYS, 7);

const RATE_WINDOW_SECONDS = 24 * 3600; // "≤1 inference nudge/domain/day" (design doc §2)

export type InferNudgeDeps = {
	detectDrift: (env: RtEnv, domains: InferDomain[], opts?: DriftOptions) => Promise<DriftCandidate | null>;
	signalsFor: (env: RtEnv, domain: InferDomain) => Promise<InferSignal[]>;
	/** The ONE LLM touch in the whole feature — phrasing only, fed redacted evidence lines,
	 *  never the raw candidate/decision. */
	phrase: (env: RtEnv, evidenceLines: string, cluster: string) => Promise<string>;
	digestAppend: (env: RtEnv, path: string, content: string) => Promise<void>;
};

export type InferNudgeReport = {
	dormant?: boolean;
	fired?: boolean;
	suppressed?: "no_candidate" | "below_floor" | "rate_capped" | "deduped";
	cluster?: string;
	driftScore?: number;
	inferenceId?: string;
	note?: string;
	error?: string;
};

/** A stable-ish key for "this evidence set" so a re-detected near-identical candidate (drift
 *  recomputes evidenceIds fresh every cycle over a rolling window) doesn't re-fire during its
 *  cooldown just because the window shifted by a few signals. Not cryptographic — a dedupe
 *  key, not a security boundary. */
async function evidenceFingerprint(evidenceIds: string[]): Promise<string> {
	return fingerprint(evidenceIds.slice().sort().join(","));
}

function buildDigestBlock(candidate: DriftCandidate, phrasing: string, whyTrail: string[], inferenceId: string): string {
	const shortId = inferenceId.slice(0, 8);
	const lines = [
		"",
		`## sux nudge — ${new Date().toISOString()}`,
		`_emerging-topic · ${candidate.cluster} · confidence ${candidate.driftScore.toFixed(2)} · recipe centroid_drift_`,
		"",
		`**suggests:** ${phrasing}`,
		"",
		"why:",
		...whyTrail.map((w) => `- ${w}`),
		"",
		`controls: reply \`yes ${shortId}\` (confirm) · \`dismiss ${shortId}\` (one-off) · \`not-useful ${shortId}\` (raise the bar) · \`never-for-this ${candidate.cluster}\` (suppress this domain)`,
		"",
	];
	return lines.join("\n");
}

/** Run one nudge-write cycle. Fail-closed: dormant unless at least one first-slice domain is
 *  armed (INFER_ARM_VAULT/INFER_ARM_MAIL) and INFER_KILL isn't set. Detects centroid drift over
 *  the armed domains, applies the confidence floor + rate cap (≤1/domain/day) + evidence-dedupe
 *  cooldown, and — only if all three clear — phrases + appends ONE line to the Daily note. Every
 *  successful fire is also logged to the (domain-keyed) inference log so #866's cascading
 *  deletion can find and forget it. A suppressed/no-candidate cycle is the overwhelmingly
 *  common, correct result — never an error. */
export async function runInferNudge(env: RtEnv, opts: { domains?: InferDomain[] }, deps: InferNudgeDeps): Promise<InferNudgeReport> {
	if (isInferKilled(env)) {
		return { dormant: true, note: "infer_nudge is dormant — INFER_KILL is set. Fail-closed: no candidate is ever detected or written while killed." };
	}
	const domains = (opts.domains ?? FIRST_SLICE_DOMAINS).filter((d) => hasInferArm(env, d));
	if (!domains.length) {
		return {
			dormant: true,
			note: "infer_nudge is dormant — no first-slice domain is armed. Set INFER_ARM_VAULT and/or INFER_ARM_MAIL (per-domain toggles, unset ⇒ inert) to let the centroid-drift detector surface an emerging-topic nudge to the Daily note.",
		};
	}

	let candidate: DriftCandidate | null;
	try {
		candidate = await deps.detectDrift(env, domains);
	} catch (e) {
		return { error: `drift detection failed: ${errMsg(e)}` };
	}
	if (!candidate) return { suppressed: "no_candidate" };
	if (candidate.driftScore < confidenceFloor(env)) return { suppressed: "below_floor", cluster: candidate.cluster, driftScore: candidate.driftScore };

	const rate = ledger(env, "infer_nudge_rate", RATE_WINDOW_SECONDS);
	if (await rate.seen(candidate.cluster)) return { suppressed: "rate_capped", cluster: candidate.cluster, driftScore: candidate.driftScore };

	const fp = await evidenceFingerprint(candidate.evidenceIds);
	const dedupe = ledger(env, "infer_nudge_dedupe", cooldownDays(env) * 86400);
	const dedupeKey = `${candidate.cluster}:${fp}`;
	if (await dedupe.seen(dedupeKey)) return { suppressed: "deduped", cluster: candidate.cluster, driftScore: candidate.driftScore };

	// Why-trail: source-tagged, already-redacted evidence (never raw content) — both the
	// digest's evidence block and the one phrasing call see only this.
	const signalsByDomain = await Promise.all(domains.map((d) => deps.signalsFor(env, d)));
	const byId = new Map<string, InferSignal>();
	for (const list of signalsByDomain) for (const s of list) byId.set(s.id, s);
	const evidence = candidate.evidenceIds
		.map((id) => byId.get(id))
		.filter((s): s is InferSignal => Boolean(s))
		.slice(0, 8);
	const whyTrail = evidence.map((s) => `[${s.source_tag}] ${s.redacted_snippet}`);

	let phrasing: string;
	try {
		phrasing = await deps.phrase(env, whyTrail.join("\n"), candidate.cluster);
	} catch (e) {
		return { error: `phrasing failed: ${errMsg(e)}` };
	}

	// Logged under the first armed domain — one inference record for the merged-cluster
	// candidate, addressable by #866's cascading deletion regardless of which domain's arm
	// governs it (deletion walks a domain's own inference log).
	const rec = await appendInferInference(env, domains[0], {
		domain: domains[0],
		kind: "centroid_drift",
		evidenceIds: candidate.evidenceIds,
		createdAt: Date.now(),
		payload: { cluster: candidate.cluster, driftScore: candidate.driftScore },
	});
	const inferenceId = rec.id ?? crypto.randomUUID();

	try {
		await deps.digestAppend(env, `Daily/${vaultToday(env.VAULT_TZ)}.md`, buildDigestBlock(candidate, phrasing, whyTrail, inferenceId));
	} catch (e) {
		return { error: `vault append failed: ${errMsg(e)}`, cluster: candidate.cluster, driftScore: candidate.driftScore, inferenceId };
	}

	await rate.mark(candidate.cluster);
	await dedupe.mark(dedupeKey);

	return { fired: true, cluster: candidate.cluster, driftScore: candidate.driftScore, inferenceId };
}

// A static, non-diagnostic fallback phrasing (no LLM call) — used when Workers-AI isn't
// configured, so the nudge surface degrades to a plain template rather than failing closed.
const fallbackPhrasing = (cluster: string): string => `A lot about ${cluster} lately — start a note/project for it?`;

/** Production surface: the real centroid-drift detector, signal-log reads, a Workers-AI
 *  phrasing call (redacted evidence only, `llm()`'s `<<<DATA>>>` fence — see ai.ts), and the
 *  git-backed vault append. Dynamically imported so the cron path pulls these in only when
 *  armed (mirrors _agenda/_ask_gate_reminder/_infer_drift). */
export async function defaultDeps(): Promise<InferNudgeDeps> {
	const { obsidian } = await import("./obsidian");
	return {
		detectDrift: (env, domains, opts) => detectCentroidDrift(env, domains, opts),
		signalsFor: (env, domain) => readInferSignals(env, domain),
		phrase: async (env, evidenceLines, cluster) => {
			if (!hasAI(env) || !evidenceLines.trim()) return fallbackPhrasing(cluster);
			const system =
				"You turn redacted evidence lines into exactly ONE short, warm suggestion sentence in the form " +
				"'I noticed <plain evidence> — want me to <gentle action>?'. Output ONLY that one sentence: no preamble, " +
				"no markdown, no extra commentary. Never invent a fact that isn't present in the evidence, and never name " +
				"a medical condition or diagnosis.";
			const out = await llm(env, system, evidenceLines, 120, "phrasing a proactive nudge from redacted signal evidence");
			return out.trim() || fallbackPhrasing(cluster);
		},
		digestAppend: async (env, path, content) => {
			const r = await obsidian.run(env, { action: "append", path, content, backend: "git" });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "vault append failed");
		},
	};
}
