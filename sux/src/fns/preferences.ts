import { hasAI, llm } from "../ai";
import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { errMsg } from "./_util";

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

const KV_PREFIX = "sux:prefs:";

/** How many exemplars we keep — the rolling few-shot the spec is distilled from. */
const MAX_EXAMPLES = 20;

/** The distill instruction (trusted system role). The examples ride the user role, fenced. */
const DISTILL_SYSTEM =
	"From these examples of the user's preferred writing voice, write a concise style spec — tone, formality, length, vocabulary, structure, do's/don'ts — in <=200 words. Output only the spec.";

type StoredProfile = { distilled_spec: string; examples: string[]; updated_at: number };


/** Read + parse a stored profile; null if absent or unparseable (never throws here). */
async function loadProfile(env: RtEnv, profile: string): Promise<StoredProfile | null> {
	const raw = await env.OAUTH_KV.get(`${KV_PREFIX}${profile}`);
	if (!raw) return null;
	try {
		const p = JSON.parse(raw) as Partial<StoredProfile>;
		return {
			distilled_spec: String(p?.distilled_spec ?? ""),
			examples: Array.isArray(p?.examples) ? p.examples.map((e) => String(e)) : [],
			updated_at: Number(p?.updated_at) || 0,
		};
	} catch {
		return null;
	}
}

export const preferences: Fn = {
	name: "preferences",
	cost: 2,
	description:
		"A KV-backed style-preference profile that LEARNS over time and continually self-distills — the learned voice `profile` the `voice` fn applies. " +
		"`action`: get (default) | learn | list | reset. `profile` names the profile (default \"default\"). " +
		"learn: append `sample` (an exemplar of the desired voice — a phrasing you like, or a \"before → after\" correction) to a rolling few-shot (last 20 kept), then RE-DISTILL a concise <=200-word style spec from the whole set via Workers AI and store it — this is the continual model update; returns the new spec + example count. " +
		"get: return the profile's { distilled_spec, example_count, updated_at } (or a not-found note). list: enumerate profile names. reset: delete the profile. " +
		"`note`: optional free-form annotation. Samples are untrusted and are fenced as data when distilled. Stateful — never cached.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["learn", "get", "list", "reset"], default: "get" },
			profile: { type: "string", default: "default", description: "Profile name (default \"default\")." },
			sample: { type: "string", description: "learn: an exemplar of the desired voice (a phrasing you like, or a \"before → after\" correction)." },
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
				return ok(JSON.stringify({ action, count: names.length, profiles: names }, null, 2));
			}

			if (action === "reset") {
				const existed = (await env.OAUTH_KV.get(`${KV_PREFIX}${profile}`)) != null;
				await env.OAUTH_KV.delete(`${KV_PREFIX}${profile}`);
				return ok(JSON.stringify({ action, profile, deleted: existed, note: existed ? "profile removed" : "no such profile (nothing to delete)" }, null, 2));
			}

			if (action === "get") {
				const p = await loadProfile(env, profile);
				if (!p) return ok(JSON.stringify({ action, profile, found: false, note: `No profile '${profile}'. Teach it with action=learn.` }, null, 2));
				return ok(JSON.stringify({ action, profile, found: true, distilled_spec: p.distilled_spec, example_count: p.examples.length, updated_at: p.updated_at }, null, 2));
			}

			if (action === "learn") {
				const sample = String(args?.sample ?? "").trim();
				if (!sample) return failWith("bad_input", "action=learn requires a `sample` — an exemplar of the desired voice (a phrasing you like, or a \"before → after\" correction).");
				if (!hasAI(env)) return failWith("not_configured", 'Workers AI binding not configured (add "ai" to wrangler) — needed to re-distill the style spec.');

				// Append the new exemplar, then keep only the last MAX_EXAMPLES — the rolling
				// few-shot the spec is distilled from. Oldest drops off the front.
				const prior = (await loadProfile(env, profile))?.examples ?? [];
				const examples = [...prior, sample].slice(-MAX_EXAMPLES);

				// RE-DISTILL from the whole accumulated set — the continual model update. The
				// examples are UNTRUSTED, so they ride the guarded llm() as the user arg and
				// get fenced in <<<DATA>>> markers; the distill instruction stays in the
				// trusted system role and can't be dislodged.
				const examplesBlock = examples.map((e, i) => `Example ${i + 1}:\n${e}`).join("\n\n");
				const spec = await llm(env, DISTILL_SYSTEM, examplesBlock, 512, "distill a style spec");
				if (!spec.trim()) return failWith("upstream_error", "preferences (learn) distilled an empty spec — retry.");

				const record: StoredProfile = { distilled_spec: spec.trim(), examples, updated_at: Date.now() };
				await env.OAUTH_KV.put(`${KV_PREFIX}${profile}`, JSON.stringify(record));
				console.log(`preferences: learned profile=${profile} examples=${examples.length}`);
				return ok(
					JSON.stringify(
						{ action, profile, distilled_spec: record.distilled_spec, example_count: examples.length, updated_at: record.updated_at, ...(args?.note ? { note: String(args.note) } : {}) },
						null,
						2,
					),
				);
			}

			return failWith("bad_input", `Unknown action '${action}'.`);
		} catch (e) {
			return failWith("upstream_error", `preferences (${action}) failed: ${errMsg(e)}`);
		}
	},
};
