import { type Fn, fail, ok } from "../registry";
import { staged } from "../stage";
import { oj } from "./_util";

// User-facing KV keys live under a fixed "kv:" namespace so tool deletes can never
// touch internal cache:/sux:/oauth keys — the "kv:" prefix already confines every
// key this fn can touch, so there's no reserved-space collision to guard against
// beyond that. A key is rejected if, after trimming, it is empty.
const NS = "kv:";

/** Validate a user-supplied key and return its namespaced form, or an error string. */
function resolveKey(raw: unknown): { key: string } | { error: string } {
	if (typeof raw !== "string") return { error: "key is required (string)." };
	const key = raw.trim();
	if (!key) return { error: "key must be a non-empty string." };
	const lower = key.toLowerCase();
	if (lower.startsWith(NS)) return { error: `key must not include the internal '${NS}' prefix — it is added automatically.` };
	return { key: NS + key };
}

export const kv_delete: Fn = {
	name: "kv_delete",
	description:
		"Delete a key from the KV store. Params: key (required). Unlike the vault/Dropbox stores, KV has NO git history or trash, so a delete is genuinely irreversible — it STAGES A PREVIEW BY DEFAULT (whether the key exists, nothing deleted) — re-call with the returned commit_token, or pass force:true, to apply in one shot. Keys are namespaced under 'kv:'; internal cache:/sux:/oauth keys are refused.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["key"],
		properties: {
			key: { type: "string", description: "The key to delete (without the internal 'kv:' prefix)." },
			stage: { type: "boolean", description: "Preview only: returns {preview, commit_token}, deletes nothing." },
			commit_token: { type: "string", description: "Commit a previously staged delete (the payload must match what was staged)." },
			force: { type: "boolean", description: "Skip staging and delete in one shot (the ! override). By default a delete stages a preview first." },
		},
	},
	cacheable: false,
	raw: true,
	run: async (env, args) => {
		const r = resolveKey(args?.key);
		if ("error" in r) return fail(r.error);
		const shown = String(args.key).trim();
		try {
			const exists = (await env.OAUTH_KV.get(r.key)) !== null;
			const preview = { action: "kv delete", key: shown, exists };
			const gateArgs = { stage: args?.stage === true, commit_token: args?.commit_token ? String(args.commit_token) : undefined, force: args?.force === true };
			const out = await staged(env, "kv_delete", gateArgs, { key: shown }, preview, async () => {
				await env.OAUTH_KV.delete(r.key);
				return `Deleted '${shown}'.`;
			});
			return "stageResult" in out ? ok(oj(out.stageResult)) : ok(out.result);
		} catch (e) {
			return fail(`kv_delete failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
