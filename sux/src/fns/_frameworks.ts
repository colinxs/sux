// Trusted, versioned "lens" specs voice.ts folds into its system prompt (never the
// untrusted `text`) when a caller passes `framework`. Each spec is short imperative
// guidance distilled from one well-known communication/persuasion framework, matching
// DEFAULT_VOICE_SPEC's style — a bulleted rulebook, not prose about the book.

const NVC_SPEC = [
	"Nonviolent Communication (Rosenberg) — structure a charged message as OFNR:",
	"- Observation: state the fact without evaluation or blame — what a camera would record, not your interpretation of it.",
	'- Feeling: name the emotion, owned — "I feel…", never "you make me…".',
	"- Need: name the universal human need underneath the feeling.",
	"- Request: make one concrete, positive, doable, present-tense ask — a request, not a demand.",
	"Use for conflict, hard personal conversations, de-escalation, and boundary-setting.",
].join("\n");

const PRINCIPLED_NEGOTIATION_SPEC = [
	"Principled Negotiation (Fisher & Ury, Getting to Yes):",
	"- Separate the people from the problem — attack the issue, not each other.",
	"- Focus on interests, not positions — ask why a position is held before arguing with it.",
	"- Invent options for mutual gain before deciding — widen the pie before dividing it.",
	"- Insist on objective criteria — settle differences by a fair standard, not by will.",
	"- Know and reference your BATNA (best alternative to a negotiated agreement).",
	"Use for asks, negotiations, and disputes that need a durable agreement.",
].join("\n");

const TACTICAL_EMPATHY_SPEC = [
	"Tactical Empathy (Voss, Never Split the Difference):",
	'- Label emotions: "It seems like…", "It sounds like…" — name what the other side feels.',
	"- Mirror the last few words of what they said to draw more out.",
	'- Ask calibrated "how" and "what" questions — never "why", which reads as an attack.',
	'- Aim for "that\'s right" (they feel understood), not a fast, hollow "yes".',
	'- Treat "no" as safe and clarifying, not as failure — it starts the real conversation.',
	"- Slow it down; don't rush to a close.",
	"Use for high-stakes or emotional negotiations and buy-in.",
].join("\n");

const CARNEGIE_SPEC = [
	"How to Win Friends and Influence People (Carnegie):",
	"- Don't criticize, condemn, or complain.",
	"- Give honest, specific appreciation — never flattery.",
	"- Talk in terms of the other person's interests, not your own.",
	"- Use their name.",
	"- Be genuinely interested in them and let them do the talking.",
	"- If correcting them, do it indirectly and let them save face.",
	"Use for warm outreach, relationship-building, and persuasion where goodwill matters.",
].join("\n");

const CIALDINI_SPEC = [
	"Influence (Cialdini) — the seven levers of persuasion:",
	"- Reciprocity: give first.",
	"- Commitment/consistency: invite a small, voluntary commitment that a larger ask can follow.",
	"- Social proof: show that similar others already agree or act this way.",
	"- Authority: cite genuine relevant expertise or credentials.",
	"- Liking: build genuine rapport and similarity.",
	"- Scarcity: note real limits of time or availability.",
	"- Unity: appeal to shared identity — \"people like us\".",
	"Apply these ethically: surface TRUE reasons to agree; never manufacture false scarcity, false proof, or false authority.",
	"Use for persuasive, marketing, or fundraising copy.",
].join("\n");

/** One versioned lens: `version` bumps whenever `spec`'s wording changes, for future auditability. */
export interface FrameworkLens {
	version: number;
	spec: string;
}

export const FRAMEWORKS: Record<string, FrameworkLens> = {
	nvc: { version: 1, spec: NVC_SPEC },
	"principled-negotiation": { version: 1, spec: PRINCIPLED_NEGOTIATION_SPEC },
	"tactical-empathy": { version: 1, spec: TACTICAL_EMPATHY_SPEC },
	carnegie: { version: 1, spec: CARNEGIE_SPEC },
	cialdini: { version: 1, spec: CIALDINI_SPEC },
};
