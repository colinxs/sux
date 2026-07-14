import { hasAI, llm } from "../ai";
import { type Fn, failWith, ok, type RtEnv, type ToolResult } from "../registry";
import { maybeCompressString, maybeDecompressString } from "./_gzip";
import { appendOnPreferences } from "./_kb";
import { errMsg, oj } from "./_util";

// A KV-backed style-preference profile that LEARNS over time and continually
// self-distills. Each `learn` appends an exemplar of the user's preferred writing
// voice to a rolling few-shot (capped at the last 20) and RE-DISTILLS a concise
// style spec from the whole set via the guarded llm() — that re-distillation IS the
// continual model update. The stored shape { distilled_spec, examples, updated_at }
// is exactly what the `voice` fn folds back in from KV, so voice(profile:X) picks up
// whatever preferences(action:learn, profile:X) has taught.
//
// The samples are caller-supplied and UNTRUSTED — they ride the guarded llm() so
// they're fenced as <<<DATA>>> (see ai.ts) and can't hijack the distill instruction.

/** The KV key prefix for stored voice profiles — shared with the `voice` reader. */
export const KV_PREFIX = "sux:prefs:";

/** How many exemplars we keep — the rolling few-shot the spec is distilled from. */
const MAX_EXAMPLES = 20;

/** The distill instruction (trusted system role). The examples ride the user role, fenced. */
const DISTILL_SYSTEM =
	"From these examples of the user's preferred writing voice, write a concise style spec — tone, formality, length, vocabulary, structure, do's/don'ts — in <=200 words. Output only the spec.";

/** A single stored exemplar — normally a plain string, but a caller may have stored a
 * structured "before → after" object, which the `voice` reader knows how to unwrap. */
export type VoiceExample = string | Record<string, unknown>;

export type StoredProfile = {
	distilled_spec: string;
	examples: VoiceExample[];
	updated_at: number;
	/** Monotonic write counter — the token the learn/forget RMW checks to detect a
	 * concurrent update before it overwrites (0 for legacy profiles written pre-guard). */
	version: number;
};

/**
 * Read + parse a stored profile; null if absent or unparseable (never throws here).
 * Exported so the `voice` fn reads back the exact prefix/shape/compression contract
 * this fn writes, instead of re-hand-rolling it — one owner of the storage format.
 * Examples are preserved in their raw (string | object) form; `voice` unwraps them.
 */
export async function readProfile(env: RtEnv, profile: string): Promise<StoredProfile | null> {
	const stored = await env.OAUTH_KV.get(`${KV_PREFIX}${profile}`);
	if (!stored) return null;
	const raw = await maybeDecompressString(stored);
	try {
		const p = JSON.parse(raw) as Partial<StoredProfile>;
		return {
			distilled_spec: String(p?.distilled_spec ?? ""),
			examples: Array.isArray(p?.examples)
				? (p.examples.filter((e) => typeof e === "string" || (e != null && typeof e === "object")) as VoiceExample[])
				: [],
			updated_at: Number(p?.updated_at) || 0,
			version: Number(p?.version) || 0,
		};
	} catch {
		return null;
	}
}

/** Render one exemplar for the distill prompt — strings verbatim, objects as JSON. */
function exampleForDistill(e: VoiceExample): string {
	return typeof e === "string" ? e : JSON.stringify(e);
}

/**
 * Re-distill a spec from `examples` and write it back under a lost-update guard.
 *
 * The window between reading the prior profile and writing the new one spans a full
 * LLM round-trip, so two concurrent learn/forget calls on the same profile could both
 * distill from the same `prior` and the last writer would silently drop the other's
 * contribution. We re-read the profile AFTER the distill and refuse the write if its
 * version moved — the loser is told to retry (and on retry reads the winner's update).
 * KV has no compare-and-set, so a hair-thin residual race remains between this re-read
 * and the put; the guard collapses the wide LLM-length window to that, which is the
 * pragmatic fix short of serializing every learn through a Durable Object (see #288).
 */
async function redistillAndStore(
	env: RtEnv,
	profile: string,
	examples: VoiceExample[],
	priorVersion: number,
): Promise<{ record: StoredProfile } | { error: ToolResult }> {
	const examplesBlock = examples.map((e, i) => `Example ${i + 1}:\n${exampleForDistill(e)}`).join("\n\n");
	const spec = await llm(env, DISTILL_SYSTEM, examplesBlock, 512, "distill a style spec");
	if (!spec.trim()) return { error: failWith("upstream_error", "preferences distilled an empty spec — retry.") };

	const current = await readProfile(env, profile);
	if ((current?.version ?? 0) !== priorVersion)
		return { error: failWith("upstream_error", `preferences: '${profile}' was updated concurrently — retry so your change distills against the latest set.`) };

	const record: StoredProfile = { distilled_spec: spec.trim(), examples, updated_at: Date.now(), version: priorVersion + 1 };
	await env.OAUTH_KV.put(`${KV_PREFIX}${profile}`, await maybeCompressString(JSON.stringify(record)));
	// Best-effort, idempotent vault mirror — no-ops (fail-closed) if the vault is unconfigured.
	const mirrored = await appendOnPreferences(env, profile, record.distilled_spec);
	console.log(`preferences: stored profile=${profile} examples=${examples.length} version=${record.version} mirrored=${mirrored}`);
	return { record };
}

export const preferences: Fn = {
	name: "preferences",
	cost: 2,
	description:
		"A KV-backed style-preference profile that LEARNS over time and continually self-distills — the learned voice `profile` the `voice` fn applies. " +
		"`action`: get (default) | learn | forget | list | reset. `profile` names the profile (default \"default\"). " +
		"learn: append `sample` (an exemplar of the desired voice — a phrasing you like, or a \"before → after\" correction) to a rolling few-shot (last 20 kept), then RE-DISTILL a concise <=200-word style spec from the whole set via Workers AI and store it — this is the continual model update; returns the new spec + example count. " +
		"forget: drop one exemplar (1-based `index`, or the last if omitted) and re-distill from the rest — the surgical alternative to reset when one bad sample skewed the voice; removing the last exemplar deletes the profile. " +
		"get: return the profile's { distilled_spec, example_count, updated_at }; pass `examples:true` to also return the raw exemplars so you can see which to forget (or a not-found note). list: enumerate profile names. reset: delete the profile. " +
		"`note`: optional free-form annotation. Samples are untrusted and are fenced as data when distilled. Stateful — never cached.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["learn", "get", "forget", "list", "reset"], default: "get" },
			profile: { type: "string", default: "default", description: "Profile name (default \"default\")." },
			sample: { type: "string", description: "learn: an exemplar of the desired voice (a phrasing you like, or a \"before → after\" correction)." },
			index: { type: "integer", minimum: 1, description: "forget: 1-based position of the exemplar to drop (omit to drop the most recent)." },
			examples: { type: "boolean", description: "get: also return the raw stored exemplars (so you can pick one to forget)." },
			note: { type: "string", description: "Optional free-form annotation." },
		},
	},
	cacheable: false,
	raw: true,
	run: async (env, args) => {
		const action = String(args?.action ?? "get");
		const profile = String(args?.profile ?? "default").trim() || "default";

		try {
			if (action === "list") {
				const names: string[] = [];
				let cursor: string | undefined;
				do {
					const page = await env.OAUTH_KV.list({ prefix: KV_PREFIX, cursor });
					for (const k of page.keys) names.push(k.name.slice(KV_PREFIX.length));
					cursor = page.list_complete ? undefined : page.cursor;
				} while (cursor);
				names.sort();
				return ok(oj({ action, count: names.length, profiles: names }));
			}

			if (action === "reset") {
				const existed = (await env.OAUTH_KV.get(`${KV_PREFIX}${profile}`)) != null;
				await env.OAUTH_KV.delete(`${KV_PREFIX}${profile}`);
				return ok(oj({ action, profile, deleted: existed, note: existed ? "profile removed" : "no such profile (nothing to delete)" }));
			}

			if (action === "get") {
				const p = await readProfile(env, profile);
				if (!p) return ok(oj({ action, profile, found: false, note: `No profile '${profile}'. Teach it with action=learn.` }));
				const includeExamples = args?.examples === true;
				return ok(
					oj({
						action,
						profile,
						found: true,
						distilled_spec: p.distilled_spec,
						example_count: p.examples.length,
						updated_at: p.updated_at,
						...(includeExamples ? { examples: p.examples } : {}),
					}),
				);
			}

			if (action === "learn") {
				const sample = String(args?.sample ?? "").trim();
				if (!sample) return failWith("bad_input", "action=learn requires a `sample` — an exemplar of the desired voice (a phrasing you like, or a \"before → after\" correction).");
				if (!hasAI(env)) return failWith("not_configured", 'Workers AI binding not configured (add "ai" to wrangler) — needed to re-distill the style spec.');

				// Append the new exemplar, then keep only the last MAX_EXAMPLES — the rolling
				// few-shot the spec is distilled from. Oldest drops off the front.
				const prior = await readProfile(env, profile);
				const examples = [...(prior?.examples ?? []), sample].slice(-MAX_EXAMPLES);

				const out = await redistillAndStore(env, profile, examples, prior?.version ?? 0);
				if ("error" in out) return out.error;
				return ok(oj({ action, profile, distilled_spec: out.record.distilled_spec, example_count: examples.length, updated_at: out.record.updated_at, ...(args?.note ? { note: String(args.note) } : {}) }));
			}

			if (action === "forget") {
				const prior = await readProfile(env, profile);
				if (!prior || prior.examples.length === 0)
					return ok(oj({ action, profile, found: false, note: `No profile '${profile}' with exemplars to forget.` }));

				const n = prior.examples.length;
				const idx = args?.index == null ? n : Number(args.index);
				if (!Number.isInteger(idx) || idx < 1 || idx > n)
					return failWith("bad_input", `action=forget needs an \`index\` in 1..${n} (or omit it to drop the most recent). Use action=get with examples:true to see them.`);

				const examples = prior.examples.filter((_, i) => i !== idx - 1);

				// Nothing left to distill from — an empty few-shot has no voice, so remove the
				// profile outright rather than store a spec distilled from nothing.
				if (examples.length === 0) {
					await env.OAUTH_KV.delete(`${KV_PREFIX}${profile}`);
					return ok(oj({ action, profile, removed_index: idx, example_count: 0, deleted: true, note: "last exemplar forgotten — profile removed." }));
				}

				if (!hasAI(env)) return failWith("not_configured", 'Workers AI binding not configured (add "ai" to wrangler) — needed to re-distill after forget.');

				const out = await redistillAndStore(env, profile, examples, prior.version);
				if ("error" in out) return out.error;
				return ok(oj({ action, profile, removed_index: idx, distilled_spec: out.record.distilled_spec, example_count: examples.length, updated_at: out.record.updated_at, ...(args?.note ? { note: String(args.note) } : {}) }));
			}

			return failWith("bad_input", `Unknown action '${action}'.`);
		} catch (e) {
			return failWith("upstream_error", `preferences (${action}) failed: ${errMsg(e)}`);
		}
	},
};
