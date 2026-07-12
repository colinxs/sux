import { maybeCompressString } from "./_gzip";
import { type Fn, fail, ok } from "../registry";

// User-facing KV keys live under a fixed "kv:" namespace so tool writes can never
// collide with internal cache:/sux:/oauth keys. A key is rejected if, after
// trimming, it is empty or resolves into one of those reserved spaces.
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

export const kv_put: Fn = {
	name: "kv_put",
	description: "Write a value to the KV store. Params: key (required), value (required string), ttl (optional seconds, min 60). Keys are namespaced under 'kv:'; internal cache:/sux:/oauth keys are refused. Returns a confirmation.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["key", "value"],
		properties: {
			key: { type: "string", description: "The key to write (without the internal 'kv:' prefix)." },
			value: { type: "string", description: "The string value to store." },
			ttl: { type: "number", description: "Optional expiration in seconds (Cloudflare KV minimum is 60)." },
		},
	},
	cacheable: false,
	raw: true,
	run: async (env, args) => {
		const r = resolveKey(args?.key);
		if ("error" in r) return fail(r.error);
		if (typeof args?.value !== "string") return fail("value is required (string).");

		const opts: { expirationTtl?: number } = {};
		if (args?.ttl !== undefined) {
			const ttl = Number(args.ttl);
			if (!Number.isFinite(ttl) || ttl < 60) return fail("ttl must be a number >= 60 seconds (Cloudflare KV minimum).");
			opts.expirationTtl = Math.floor(ttl);
		}

		// Transparently gzip large text values (control-prefixed base64 frame;
		// kv_get inflates on read). Small/incompressible values are stored plain,
		// so legacy readers and existing values are unaffected.
		await env.OAUTH_KV.put(r.key, await maybeCompressString(args.value), opts);
		const bytes = new TextEncoder().encode(args.value).length;
		const suffix = opts.expirationTtl ? ` (expires in ${opts.expirationTtl}s)` : "";
		return ok(`Wrote ${bytes} bytes to '${String(args.key).trim()}'${suffix}.`);
	},
};
