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
	description:
		"Delete a key from the KV store. Params: key (required), confirm (required — must be true), dry_run (optional). Unlike the vault/Dropbox stores, KV has NO git history or trash, so a delete is genuinely irreversible — it requires confirm:true (a deliberate two-step, mirroring vault_delete). Pass dry_run:true to preview whether the key exists (nothing is deleted) before committing. Keys are namespaced under 'kv:'; internal cache:/sux:/oauth keys are refused.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["key"],
		properties: {
			key: { type: "string", description: "The key to delete (without the internal 'kv:' prefix)." },
			confirm: { type: "boolean", description: "Must be true — KV deletes are irreversible (no history, no trash)." },
			dry_run: { type: "boolean", description: "Preview whether the key exists without deleting it." },
		},
	},
	cacheable: false,
	raw: true,
	run: async (env, args) => {
		const r = resolveKey(args?.key);
		if ("error" in r) return fail(r.error);
		const shown = String(args.key).trim();
		if (args?.dry_run === true) {
			const exists = (await env.OAUTH_KV.get(r.key)) !== null;
			return ok(`DRY RUN — nothing deleted. '${shown}' ${exists ? "exists and would be deleted" : "does not exist (delete would be a no-op)"}. Re-call with confirm:true to apply. KV deletes are irreversible.`);
		}
		if (args?.confirm !== true) return fail("kv_delete requires confirm:true (KV deletes are irreversible — no history, no trash). Pass dry_run:true first to preview.");
		await env.OAUTH_KV.delete(r.key);
		return ok(`Deleted '${shown}'.`);
	},
};
