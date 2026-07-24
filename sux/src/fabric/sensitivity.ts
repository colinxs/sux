// The placement fabric's sensitivity lattice (design §6, Stage 0.3).
//
// Before this module the concept existed only in prose: `grep -rn sensitivity sux/src
// --include='*.ts'` returned five comments and zero code. Every one of those comments is a human
// promise that nothing enforces. This is the type that makes the promise checkable.
//
// ENFORCEMENT IS NOT HERE. This unit is the lattice and the join; the gate that consults it is
// Stage 1's `admit()`. Landing the type first means the gate gets reviewed against something
// concrete instead of being designed in the same PR as the thing it depends on.

/** The disclosure-risk tags (design §6). Order in this array is presentation only — see the
 * `Sensitivity` docstring for why these are deliberately unranked. */
export const SENSITIVITY_TAGS = ["phi", "legal", "embarrassment", "secrets", "financial"] as const;

export type SensitivityTag = (typeof SENSITIVITY_TAGS)[number];

/** A value's disclosure risk: a SET of tags, never a number and never an ordered enum.
 *
 * This is the design's central correction and the easiest thing to get wrong. The tags are not
 * rankable against each other because they disqualify destinations by DIFFERENT MECHANISMS:
 *
 *   - `legal` disqualifies by CATEGORY — third-party disclosure can waive privilege, so the only
 *     question is "is this operator a third party?", regardless of that party's security posture.
 *   - `phi` / `embarrassment` disqualify by COUNTERPARTY ATTRIBUTE — the question is who the
 *     operator is and what they have agreed to.
 *
 * A single integer `riskTier` cannot express both, and collapsing them to one would silently
 * permit exactly the disclosures that matter most: a public court filing is legally fine anywhere
 * but embarrassing, and a routine lab value is PHI but not embarrassing. Neither dominates. */
export type Sensitivity = ReadonlySet<SensitivityTag>;

/** A Set that is immutable AT RUNTIME, not just to the type checker.
 *
 * `Object.freeze` does NOT make a Set immutable — it locks properties, while `add`/`delete`/
 * `clear` mutate internal slots and keep working. `ReadonlySet` catches this at compile time, but
 * the two constants below are process-wide singletons: one mutation through an `as any` (or from
 * plain JS) would silently reclassify every comparison made afterwards, with nothing to observe.
 * Shadowing the mutators on the instance is what actually closes it. */
function immutableSensitivity(tags: readonly SensitivityTag[]): Sensitivity {
	const s = new Set<SensitivityTag>(tags);
	const refuse = (): never => {
		throw new TypeError("Sensitivity constants are immutable — build a new set with sensitivity() or join()");
	};
	return Object.freeze(Object.assign(s, { add: refuse, delete: refuse, clear: refuse })) as unknown as Sensitivity;
}

/** No known disclosure risk. Correct ONLY for a value proven untagged — never as a stand-in for
 * "we haven't classified this yet", which is what `classify` exists to catch. */
export const PUBLIC: Sensitivity = immutableSensitivity([]);

/** Every tag. What an unclassified value is treated as. */
export const MAX_SENSITIVITY: Sensitivity = immutableSensitivity(SENSITIVITY_TAGS);

export function sensitivity(...tags: SensitivityTag[]): Sensitivity {
	return new Set(tags);
}

/** The provenance join: a value derived from several sources carries the UNION of their tags.
 *
 * This is the whole point of the lattice. Without it, sensitivity launders away through one
 * transformation — a summary of a PHI document stops being PHI, a diff of a legal file stops
 * being legal — and every downstream gate then reasons about a value whose real provenance has
 * been discarded. Union is the only operation that cannot lose a tag. */
export function join(...parts: Sensitivity[]): Sensitivity {
	const out = new Set<SensitivityTag>();
	for (const part of parts) for (const tag of part) out.add(tag);
	return out;
}

/** Resolve a possibly-unknown classification, FAILING CLOSED.
 *
 * Absent, malformed, or partly-unrecognized input resolves to MAX_SENSITIVITY, not PUBLIC. The
 * direction is the safety property: getting it backwards is silent — an unclassified PHI note
 * would simply be treated as public and routed anywhere, with nothing anomalous to observe.
 *
 * `embarrassment` in particular has no external definition to look a value up in; it is learned
 * from the owner's corrections, so "not yet learned" must mean "assume tagged". */
export function classify(input: unknown): Sensitivity {
	if (input == null) return MAX_SENSITIVITY;
	const raw: unknown[] = input instanceof Set ? [...input] : Array.isArray(input) ? input : [input];
	// An empty set is a real, meaningful claim ("classified, and nothing applies"); an empty
	// ARRAY from untrusted/serialized input is indistinguishable from a dropped field, so only a
	// genuine Set is allowed to assert emptiness.
	if (raw.length === 0) return input instanceof Set ? PUBLIC : MAX_SENSITIVITY;
	const out = new Set<SensitivityTag>();
	for (const tag of raw) {
		// One unrecognized member taints the whole set rather than being dropped — a tag this
		// build doesn't know about is more likely a NEWER tag than a typo, and silently discarding
		// it would narrow the classification.
		if (typeof tag !== "string" || !(SENSITIVITY_TAGS as readonly string[]).includes(tag)) return MAX_SENSITIVITY;
		out.add(tag as SensitivityTag);
	}
	return out;
}

export function isTagged(s: Sensitivity, tag: SensitivityTag): boolean {
	return s.has(tag);
}

/** Tags in `SENSITIVITY_TAGS` order — a Set iterates in insertion order, so two equal
 * classifications built in different orders would otherwise serialize differently and compare
 * unequal as strings. */
export function tagsOf(s: Sensitivity): SensitivityTag[] {
	return SENSITIVITY_TAGS.filter((t) => s.has(t));
}

/** Set equality. `Set` has no structural equality and `===` on two equal classifications is
 * false, which is a quiet way to write a gate that never matches. */
export function sameSensitivity(a: Sensitivity, b: Sensitivity): boolean {
	return a.size === b.size && [...a].every((t) => b.has(t));
}

/** True when `a` permits nothing `b` doesn't — i.e. `a ⊆ b`. Written subset-wise on purpose:
 * "at least as sensitive as" is the comparison a gate wants, and phrasing it as a partial order
 * keeps the unranked-tags property visible (two sets can be incomparable in both directions). */
export function atLeastAsSensitiveAs(a: Sensitivity, b: Sensitivity): boolean {
	return [...b].every((t) => a.has(t));
}

/** A value carrying its classification and where that classification came from. `sources` is for
 * explaining a decision after the fact — a denial the owner can't trace is a denial they will
 * route around. */
export interface Tagged<T> {
	value: T;
	sensitivity: Sensitivity;
	sources: readonly string[];
}

/** Build a derived value's tag set from its inputs. The counterpart to `join` at the value level:
 * the result is tagged with the union of every input's tags, plus any tags the derivation itself
 * introduces, and it remembers which inputs it came from. */
export function derive<T>(value: T, inputs: ReadonlyArray<Tagged<unknown>>, extra: Sensitivity = PUBLIC): Tagged<T> {
	return {
		value,
		sensitivity: join(...inputs.map((i) => i.sensitivity), extra),
		sources: [...new Set(inputs.flatMap((i) => i.sources))],
	};
}

/** Wrap a value whose classification is known. Use `classify` on the tags when they come from
 * anywhere untrusted (KV, a request body, a stored manifest) rather than asserting them here. */
export function tag<T>(value: T, s: Sensitivity, source: string): Tagged<T> {
	return { value, sensitivity: s, sources: [source] };
}
