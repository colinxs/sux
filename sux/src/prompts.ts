/**
 * The one home for every internal prompt sux sends to a model — see
 * docs/knowledge/prompt-engineering.md for the standard. Consolidating the inline
 * *_SYSTEM constants here makes the whole prompt surface (a) enforceable against one
 * typed contract, (b) A/B-able across sites, and (c) a single target the (dispatched)
 * DSPy optimize harness reads. Migration is incremental: three exemplars land here now —
 * a classifier, a synthesis prompt, and a generator, one per metric family (standard §8)
 * — and the remaining inline call sites are a dispatched mechanical sweep that conforms
 * to this same shape.
 */

/** Which model actually RUNS a prompt — decides who may optimize it (writer matches
 *  runner; standard §2). The internal llm() path is workers-ai (llama), OpenAI only on
 *  failover; claude/openai/gemini are for subagent/CI/cross-vendor prompts. */
export type PromptRunner = "workers-ai" | "claude" | "openai" | "gemini";

/** Cost/quality tier — routing + how much optimizer effort a rewrite is worth. */
export type PromptDifficulty = "trivial" | "standard" | "hard";

/** How a candidate rewrite is scored against fixtures (standard §8). Deterministic
 *  families (exact/label) first; the judge families are for genuinely open outputs. */
export type PromptMetric = "exact" | "label" | "faithfulness" | "format" | "judge";

/** Lifecycle (standard §5): `fluid` = under optimization, cache-cold; `crystallized` =
 *  eval-gated, frozen, eligible for response-cache pinning. */
export type PromptState = "fluid" | "crystallized";

export interface PromptRecord {
	/** Stable dotted "<fn>.<role>" id — the eval-fixture key and cache namespace. */
	readonly id: string;
	readonly runner: PromptRunner;
	/** Trusted system instruction; buildMessages() appends the fence guard, so this must
	 *  never contain the <<<DATA>>> markers (enforced by prompts.test.ts). */
	readonly system: string;
	/** Short task label, rides in guardInstruction(); maps to llm()'s `task` arg. */
	readonly task: string;
	/** Output-token ceiling; maps to llm()'s `maxTokens` arg. */
	readonly maxTokens: number;
	readonly difficulty: PromptDifficulty;
	readonly metric: PromptMetric;
	readonly state: PromptState;
	/** Path to the fixture set (dispatched full-B wires these). */
	readonly evalRef?: string;
	readonly note?: string;
}

/** Types a record literal and freezes it, so a crystallized prompt can't be mutated out
 *  from under the response cache at runtime. */
function definePrompt(r: PromptRecord): PromptRecord {
	return Object.freeze(r);
}

// ── Exemplars — one per metric family (standard §8). ─────────────────────────────

/** _mail_triage.ts's ambiguous-case spam classifier. Trivial, deterministic: the output
 *  is one word, scored by exact match. */
export const MAIL_TRIAGE_SPAM = definePrompt({
	id: "mail_triage.spam",
	runner: "workers-ai",
	system:
		"You classify a single email as promotional/marketing SPAM or NOT. Reply with exactly one word: SPAM or NOT_SPAM. SPAM means a sales pitch, marketing blast, or promotional offer; a real person's message, a receipt/transaction/service notification, or an on-topic reply is NOT_SPAM.",
	task: "classify spam",
	maxTokens: 8,
	difficulty: "trivial",
	metric: "exact",
	state: "fluid",
	note: "Ambiguous-case AI tier; fires only when sync rules fall through to unknown.",
});

/** oracle.ts's distill instruction. Also reused by _assimilate.ts via oracle.ts's
 *  re-export of DISTILL_SYSTEM, so the two paths' distillates stay interchangeable. */
export const ORACLE_DISTILL = definePrompt({
	id: "oracle.distill",
	runner: "workers-ai",
	system:
		"Extract and condense the KEY KNOWLEDGE (facts, definitions, concepts, relationships, procedures, rules) from the material into concise, self-contained notes that can answer future questions on this topic. Omit fluff, examples-for-flavor, and boilerplate. Output only the notes, <= ~500 words.",
	task: "distill knowledge notes",
	maxTokens: 1024,
	difficulty: "standard",
	metric: "faithfulness",
	state: "fluid",
	note: "Shared with _assimilate.ts (the #1283 spine) — keep the distillate style stable.",
});

/** _infer_nudge.ts's phrasing prompt. Strict single-sentence format plus two hard
 *  constraints (no invented facts, never name a diagnosis) → a format/constraint judge. */
export const INFER_NUDGE_PHRASING = definePrompt({
	id: "infer_nudge.phrasing",
	runner: "workers-ai",
	system:
		"You turn redacted evidence lines into exactly ONE short, warm suggestion sentence in the form " +
		"'I noticed <plain evidence> — want me to <gentle action>?'. Output ONLY that one sentence: no preamble, " +
		"no markdown, no extra commentary. Never invent a fact that isn't present in the evidence, and never name " +
		"a medical condition or diagnosis.",
	task: "phrasing a proactive nudge from redacted signal evidence",
	maxTokens: 120,
	difficulty: "standard",
	metric: "format",
	state: "fluid",
	note: "One LLM touch in the rules-then-LLM nudge ladder; degrades to a static template.",
});

/** The registry — every record, keyed by its own id. The conformance test and (dispatched)
 *  eval harness iterate this; new prompts are added here as they migrate off inline
 *  constants. */
export const PROMPTS: Readonly<Record<string, PromptRecord>> = Object.freeze(
	Object.fromEntries([MAIL_TRIAGE_SPAM, ORACLE_DISTILL, INFER_NUDGE_PHRASING].map((p) => [p.id, p])),
);
