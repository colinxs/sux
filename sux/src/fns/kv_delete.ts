import { type Fn, fail, ok } from "../registry";

// User-facing KV keys live under a fixed "kv:" namespace so tool deletes can never
// touch internal cache:/sux:/oauth keys. A key is rejected if, after trimming, it
// is empty or resolves into one of those reserved spaces.
const NS = "kv:";
const RESERVED = ["cache:", "sux:", "oauth"];

/** Validate a user-supplied key and return its namespaced form, or an error string. */
function resolveKey(raw: unknown): { key: string } | { error: string } {
	if (typeof raw !== "string") return { error: "key is required (string)." };
	const key = raw.trim();
	if (!key) return { error: "key must be a non-empty string." };
	const lower = key.toLowerCase();
	if (lower.startsWith(NS)) return { error: `key must not include the internal '${NS}' prefix — it is added automatically.` };
	if (RESERVED.some((p) => lower.startsWith(p))) return { error: `key resolves into reserved space (${RESERVED.join(", ")}) and is refused.` };
	return { key: NS + key };
}

export const kv_delete: Fn = {
	name: "kv_delete",
	description: "Delete a key from the KV store. Params: key (required). Keys are namespaced under 'kv:'; internal cache:/sux:/oauth keys are refused. Returns a confirmation.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["key"],
		properties: {
			key: { type: "string", description: "The key to delete (without the internal 'kv:' prefix)." },
		},
	},
	cacheable: false,
	raw: true,
	run: async (env, args) => {
		const r = resolveKey(args?.key);
		if ("error" in r) return fail(r.error);
		await env.OAUTH_KV.delete(r.key);
		return ok(`Deleted '${String(args.key).trim()}'.`);
	},
};
