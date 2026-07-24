import { hasAI, llm } from "../ai";
import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { errMsg, oj } from "./_util";

// Emulated-expert-role drafting (sux#1475) — for informal-assessment gaps with no scrape
// or purchase path (an expert-witness gut-check before a real expert is retained, a
// case-merit read with no attorney involved yet, ...). Domain-agnostic: a `role` + a fact
// pattern + caller-supplied sources, never sux's own research (that's scrape/search/study's
// job — this fn only synthesizes FROM what it's given, so a claim can always be traced to
// a source or flagged as unsupported).
//
// The design constraint comes from a real prior manual attempt (vault repo,
// 01-records/health/Drafts/Diagnostic-Delay-Evidence-Package-2026-07-16.md §3): five
// AI-drafted "would N reasonable clinicians call this good medicine" panels, each backed by
// real cited literature, each STILL adversarially reviewed as unfair/overstated — a literal
// arithmetic error (0.41 read as "under" a 0.4 threshold), a stat generalized outside its
// tested subtype, a guideline applied outside its scope, a payer checklist conflated with a
// clinical standard, a citation asked to support a claim it didn't test. The synthesized
// JUDGMENT failed under scrutiny even when the underlying facts/quotes held up. So: every
// draft here is ALWAYS run through independent adversarial review before it's returned, and
// the disclaimer is unconditional — there is no "quick draft, skip review" path.

const DISCLAIMER =
	"This is an LLM emulation of an expert-style opinion, drafted for informal internal triage only. " +
	"It is NOT a real expert's opinion, is not admissible or reliable as one, and a real expert is still " +
	"required for anything that matters. Treat every claim below per its own status — 'supported' still " +
	"means 'an LLM read the cited source as saying this', not that the source was independently verified.";

const SKEPTIC_COUNT = 3;

export type ClaimStatus = "supported" | "disputed" | "unverified" | "partial";
type Claim = { claim: string; status: ClaimStatus; source_id?: string };
type Draft = { assessment: string; claims: Claim[] };
type SkepticVerdict = { refuted: boolean; issues: string[] };

/** Strip a ```json fence (or any fence) and grab the first {...} block — llama-class models
 *  routinely wrap structured output in prose or a code fence despite being told not to. */
function extractJsonObject<T>(raw: string, fallback: T): T {
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw;
	const m = fenced.match(/\{[\s\S]*\}/);
	if (!m) return fallback;
	try {
		return JSON.parse(m[0]) as T;
	} catch {
		return fallback;
	}
}

function draftPrompt(role: string, question: string, factPattern: string, sources: Array<{ id: string; citation: string; excerpt: string }>): { system: string; user: string } {
	const srcBlock = sources.map((s) => `[${s.id}] ${s.citation}\n${s.excerpt}`).join("\n\n");
	return {
		system:
			`You are drafting an INFORMAL, NON-EXPERT emulation of what a "${role}" might say — NOT a real expert opinion. ` +
			"Ground every claim ONLY in the sources given; never introduce outside facts, statistics, or guidelines not present in them. " +
			"For each claim, cite the source id it rests on (or omit source_id if it's an inference, and mark it 'unverified' or 'partial'). " +
			'Respond with ONLY a JSON object: {"assessment": string, "claims": [{"claim": string, "status": "supported"|"disputed"|"unverified"|"partial", "source_id"?: string}]}. No prose outside the JSON.',
		user: `Question: ${question}\n\nFact pattern:\n${factPattern}\n\nSources:\n${srcBlock || "(none provided)"}`,
	};
}

function skepticPrompt(role: string, factPattern: string, sources: Array<{ id: string; citation: string; excerpt: string }>, draft: Draft): { system: string; user: string } {
	const srcBlock = sources.map((s) => `[${s.id}] ${s.citation}\n${s.excerpt}`).join("\n\n");
	return {
		system:
			`You are an ADVERSARIAL reviewer of an AI-drafted "${role}"-style assessment. Your job is to find errors, not to be agreeable. ` +
			"Check specifically for: arithmetic/unit-conversion/threshold mistakes; a statistic or finding generalized beyond the population/subtype the source actually studied; " +
			"a guideline or standard applied outside the scope it was written for; a payer/administrative policy conflated with a clinical or professional standard; " +
			"a citation invoked for a claim it doesn't actually support. If you are uncertain whether the draft holds up, default to refuted:true — " +
			"a false alarm here just means one more review pass; a missed error reaches a human as if it were reliable. " +
			'Respond with ONLY JSON: {"refuted": boolean, "issues": string[]}.',
		user: `Fact pattern:\n${factPattern}\n\nSources:\n${srcBlock || "(none provided)"}\n\nDraft assessment:\n${draft.assessment}\n\nDraft claims:\n${JSON.stringify(draft.claims, null, 2)}`,
	};
}

export const expert_draft: Fn = {
	name: "expert_draft",
	cost: 4,
	description:
		"Emulated-expert-role drafting for informal-assessment gaps with no scrape/purchase path (e.g. a would-a-reasonable-expert-call-this-a-breach gut-check before a real expert is retained) — domain-agnostic, not medical-specific. Drafts an assessment grounded ONLY in caller-supplied `sources`, then ALWAYS runs it through independent adversarial review (default: 3 reviewers, majority-refute rejects) before returning — there is no way to skip review. Every response carries an unconditional, unremovable disclaimer: this is an LLM emulation for informal triage only, never a real expert opinion. Returns { disclaimer, role, review: {rejected, votes}, assessment, claims } — `assessment`/`claims` are replaced with a rejection notice (issues kept visible) when the majority of reviewers refute the draft.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["role", "question", "fact_pattern", "sources"],
		properties: {
			role: { type: "string", description: "The expert-style role to emulate, e.g. 'emergency medicine physician' or 'appellate litigator'." },
			question: { type: "string", description: "The specific question to assess, e.g. 'does this read as a standard-of-care breach'." },
			fact_pattern: { type: "string", description: "The scoped fact pattern to assess — as much relevant detail as is known." },
			sources: {
				type: "array",
				minItems: 1,
				items: { type: "object", additionalProperties: false, required: ["id", "citation", "excerpt"], properties: { id: { type: "string" }, citation: { type: "string" }, excerpt: { type: "string" } } },
				description: "Real sources to ground the draft in — at least one required (this fn never does its own research; use scrape/search/study first).",
			},
		},
	},
	cacheable: false,
	run: async (env: RtEnv, args) => {
		const role = String(args?.role ?? "").trim();
		const question = String(args?.question ?? "").trim();
		const factPattern = String(args?.fact_pattern ?? "").trim();
		const sources = Array.isArray(args?.sources) ? args.sources : [];
		if (!role) return failWith("bad_input", "expert_draft requires a `role` (the expert-style role to emulate).");
		if (!question) return failWith("bad_input", "expert_draft requires a `question`.");
		if (!factPattern) return failWith("bad_input", "expert_draft requires a `fact_pattern`.");
		if (!sources.length) return failWith("bad_input", "expert_draft requires at least one item in `sources` — it never does its own research; scrape/search/study first, then pass what you found here.");
		if (!hasAI(env)) return failWith("not_configured", 'Workers AI binding not configured (add "ai" to wrangler) — needed to draft and adversarially review.');

		const cleanSources = sources.map((s: any, i: number) => ({ id: String(s?.id ?? `s${i + 1}`), citation: String(s?.citation ?? ""), excerpt: String(s?.excerpt ?? "") }));

		try {
			const dp = draftPrompt(role, question, factPattern, cleanSources);
			const draftRaw = await llm(env, dp.system, dp.user, 1200, "drafting an emulated expert-style assessment");
			const draft = extractJsonObject<Draft>(draftRaw, { assessment: draftRaw.trim(), claims: [] });
			if (typeof draft.assessment !== "string" || !Array.isArray(draft.claims)) {
				return failWith("upstream_error", "expert_draft: the model's draft pass didn't return the expected {assessment, claims} shape.");
			}

			const sp = skepticPrompt(role, factPattern, cleanSources, draft);
			const votes = await Promise.all(
				Array.from({ length: SKEPTIC_COUNT }, () => llm(env, sp.system, sp.user, 500, "adversarially reviewing an emulated expert-style draft").then((raw) => extractJsonObject<SkepticVerdict>(raw, { refuted: true, issues: ["reviewer response unparseable — defaulting to refuted"] }))),
			);
			const refutedCount = votes.filter((v) => v.refuted).length;
			const rejected = refutedCount * 2 >= SKEPTIC_COUNT; // majority-refute kills it
			const issues = votes.flatMap((v) => (Array.isArray(v.issues) ? v.issues : []));

			return ok(
				oj({
					disclaimer: DISCLAIMER,
					role,
					review: { rejected, votes: SKEPTIC_COUNT, refuted: refutedCount, issues },
					...(rejected
						? { assessment: "REJECTED by adversarial review — not presented. See review.issues for what the reviewers found.", claims: [] }
						: { assessment: draft.assessment, claims: draft.claims }),
				}),
			);
		} catch (e) {
			return failWith("upstream_error", `expert_draft failed: ${errMsg(e)}`);
		}
	},
};
