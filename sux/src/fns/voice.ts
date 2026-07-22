import { hasAI, llm } from "../ai";
import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { FRAMEWORKS } from "./_frameworks";
import { readProfile, type VoiceExample } from "./preferences";

// AI text-restyler. Rewrites `text` into a target `style` and/or a learned
// preference `profile` (a distilled spec + a few-shot of writing samples kept in
// KV by the `preferences` fn), preserving meaning, names, facts, numbers, and
// links. The user's text is UNTRUSTED — it rides the guarded llm() so it's fenced
// as data (see ai.ts) and can't hijack the restyle instruction. Output is only the
// rewritten text, no preamble.

/** Pull the best voice-sample text out of one stored example (string or object). */
function exampleText(e: VoiceExample): string {
	if (typeof e === "string") return e.trim();
	if (e && typeof e === "object") {
		const o = e as Record<string, unknown>;
		const pick = o.after ?? o.output ?? o.rewritten ?? o.text ?? o.example ?? o.sample;
		return String(pick ?? JSON.stringify(o)).trim();
	}
	return String(e).trim();
}

/**
 * Load a profile from KV and fold its distilled spec + up to ~3 examples into
 * system guidance lines. Returns [] if the profile is absent or unparseable — the
 * caller degrades gracefully (a bad/missing profile never fails the restyle).
 *
 * The read goes through preferences.readProfile so the prefix/shape/compression
 * contract has a single owner; this fn keeps only the object-form exampleText()
 * unwrapping on top.
 */
async function profileGuidance(env: RtEnv, profile: string): Promise<string[]> {
	let p: Awaited<ReturnType<typeof readProfile>>;
	try {
		p = await readProfile(env, profile);
	} catch {
		return [];
	}
	if (!p) return [];
	const lines: string[] = [];
	const spec = p.distilled_spec.trim();
	if (spec) lines.push(`Learned voice profile "${profile}" — match this style specification:\n${spec}`);
	const examples = p.examples
		.map(exampleText)
		.filter((s) => s.length > 0)
		.slice(0, 3);
	if (examples.length) {
		lines.push(`Reference samples written in the "${profile}" voice (match their tone and cadence, not their content):\n${examples.map((s, i) => `Sample ${i + 1}: ${s}`).join("\n")}`);
	}
	return lines;
}

// The default "house voice", distilled from the PRINCIPLES of Strunk's Elements of
// Style (the rules, not the book's own prose). Applied when a caller gives no
// explicit `style` and no usable `profile`, so `voice(text)` alone rewrites toward
// vigorous, concise, concrete English.
const DEFAULT_VOICE_SPEC = [
	"Rewrite in clear, vigorous, plain English, following these principles:",
	'- Omit needless words — every word must tell. Cut padding ("the fact that", "in order to", "there is/are", "it should be noted that") and hollow qualifiers ("very", "rather", "quite", "really", "actually", "certainly").',
	'- Prefer the active voice: "I will remember", not "it will be remembered by me"; use the passive only when the thing acted upon must be the subject.',
	'- Put statements in positive form — make definite assertions. Prefer "forgot" to "did not remember", "dishonest" to "not honest"; avoid noncommittal hedging.',
	'- Use specific, concrete, definite language over the vague and abstract: "it rained every day", not "a period of unfavorable weather".',
	"- Express coordinate ideas in parallel grammatical form; keep related words together; place the emphatic word at the sentence's end.",
	'- Prefer short, direct sentences and vary their length; avoid a long string of clauses strung together with "and", "but", "which", "so".',
	"- Do not overstate, and do not hedge into mush. Say it plainly, once.",
].join("\n");

/** Normalize `framework` (a single name or an array of names) into a de-duped list. */
function frameworkNames(raw: unknown): string[] {
	const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
	return [...new Set(list.map((f) => String(f).trim()).filter(Boolean))];
}

/**
 * Fold each named communication/persuasion lens's trusted spec (see _frameworks.ts)
 * into system guidance lines. Unknown names are silently skipped — one line notes
 * the miss, mirroring how an absent voice `profile` degrades gracefully above.
 */
function frameworkGuidance(names: string[]): string[] {
	const lines: string[] = [];
	for (const name of names) {
		const lens = FRAMEWORKS[name];
		if (lens) lines.push(`Apply this lens (${name} v${lens.version}):\n${lens.spec}`);
		else lines.push(`(Framework "${name}" was not found.)`);
	}
	return lines;
}

export const voice: Fn = {
	name: "voice",
	cost: 2,
	description:
		"AI text-restyler. Rewrites `text` into a target `style` and/or a learned preference `profile`, preserving meaning, names, facts, numbers, and links — returns only the rewritten text, no preamble. " +
		"`style`: free-form — any descriptor works (common ones: professional, non-violent, brief, casual, academic, friendly, formal, plain, warm). " +
		"`profile`: name of a learned voice profile (see the `preferences` fn) whose distilled spec + example samples are folded in from KV; skipped gracefully if absent. " +
		"With NO `style` and no usable `profile`, `voice(text)` rewrites in the default house voice — concise, active, concrete English distilled from the principles of Strunk's Elements of Style (omit needless words, active voice, positive form, specific/definite language). `strength`: light (a gentle touch, keep most original phrasing) | strong (fully recast; default). `framework`: one or more communication/persuasion lens names layered on top of style/profile — nvc (Nonviolent Communication), principled-negotiation (Getting to Yes), tactical-empathy (Never Split the Difference), carnegie (How to Win Friends), cialdini (Influence); unknown names are skipped gracefully. `instructions`: optional extra guidance.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text"],
		properties: {
			text: { type: "string", description: "The text to restyle." },
			style: { type: "string", description: "Target style — free-form (e.g. professional, non-violent, brief, casual, academic, friendly)." },
			profile: { type: "string", description: "Name of a learned voice profile to apply (see the `preferences` fn)." },
			strength: { type: "string", enum: ["light", "strong"], default: "strong", description: "light = gentle touch; strong = fully recast (default)." },
			framework: {
				type: ["string", "array"],
				items: { type: "string" },
				description: "One or more communication/persuasion lens names to layer in: nvc, principled-negotiation, tactical-empathy, carnegie, cialdini. Unknown names are skipped gracefully.",
			},
			instructions: { type: "string", description: "Optional extra guidance for the rewrite." },
		},
	},
	cacheable: true,
	ttl: 3600,
	run: async (env, args) => {
		if (!hasAI(env)) return failWith("not_configured", 'Workers AI binding not configured (add "ai" to wrangler).');

		const text = String(args?.text ?? "");
		const style = String(args?.style ?? "").trim();
		const profile = String(args?.profile ?? "").trim();
		const strength = args?.strength === "light" ? "light" : "strong";
		const frameworks = frameworkNames(args?.framework);
		const instructions = String(args?.instructions ?? "").trim();

		if (!text.trim()) return failWith("bad_input", "Provide `text` to restyle.");

		try {
			// Fold the learned profile (if any) into system guidance. Absent/unparseable
			// profiles yield [] and are silently skipped — the restyle proceeds on style alone.
			const profileLines = profile ? await profileGuidance(env, profile) : [];

			const guidance: string[] = [];
			if (style) guidance.push(`Target style: ${style}.`);
			guidance.push(...profileLines);
			const frameworkLines = frameworkGuidance(frameworks);
			guidance.push(...frameworkLines);
			if (instructions) guidance.push(`Additional guidance: ${instructions}`);
			// A profile named but not found leaves only a placeholder line so the model
			// still restyles on whatever style was given (or, if none, does a faithful copy).
			if (profile && profileLines.length === 0) guidance.push(`(Voice profile "${profile}" was not found.)`);
			// Default voice: with no explicit style and no usable profile, restyle toward
			// the house voice distilled from Strunk's Elements of Style.
			if (!style && profileLines.length === 0) guidance.push(`Target voice (default house style):\n${DEFAULT_VOICE_SPEC}`);

			const touch =
				strength === "light"
					? "Apply a light touch: adjust tone and word choice toward the target while keeping most of the original phrasing and structure."
					: "Fully recast the text in the target voice: rephrase freely so it reads as if natively written that way.";

			const system = [
				"You are a precise text restyler. Rewrite the given text to match the target voice below.",
				touch,
				"Absolutely preserve the original meaning, all names, facts, numbers, dates, quotes, and links/URLs verbatim. Do not add, remove, or invent information.",
				"Output ONLY the rewritten text — no preamble, no quotes, no explanation, no labels.",
				"",
				...guidance,
			].join("\n");

			// text is the UNTRUSTED user content — passed as the user arg so guarded llm()
			// fences it in <<<DATA>>> markers; it can never dislodge the system restyle spec.
			const maxTokens = Math.min(2048, Math.max(256, Math.ceil(text.length / 2)));
			const out = await llm(env, system, text.slice(0, 24_000), maxTokens, "restyle");
			if (!out?.trim()) return failWith("upstream_error", "voice produced an empty result — retry.");
			return ok(out);
		} catch (e) {
			return failWith("upstream_error", `voice failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
