import { maybeDecompressString } from "./_gzip";
import { type Fn, fail, ok } from "../registry";

// All user-facing KV keys live under a fixed "kv:" namespace so tool writes can
// never collide with internal cache:/sux:/oauth keys. A user key is rejected if,
// after trimming, it is empty or resolves into one of those reserved spaces.
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

export const kv_get: Fn = {
	name: "kv_get",
	description: "Read a value from the KV store by key. Params: key (required). Keys are namespaced under 'kv:'; internal cache:/sux:/oauth keys are refused. Returns the stored value or a clear not-found.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["key"],
		properties: {
			key: { type: "string", description: "The key to read (without the internal 'kv:' prefix)." },
		},
	},
	cacheable: false,
	raw: true,
	run: async (env, args) => {
		const r = resolveKey(args?.key);
		if ("error" in r) return fail(r.error);
		const value = await env.OAUTH_KV.get(r.key);
		if (value === null) return fail(`key '${String(args.key).trim()}' not found.`);
		try {
			// Inflate a transparently-compressed value; a plain/legacy value passes through.
			return ok(await maybeDecompressString(value));
		} catch (e) {
			// A corrupt/truncated `\0gz:` frame or the decompression-bomb guard tripping
			// throws — turn it into a clean fail() (mirrors dropbox/store) instead of an
			// uncaught rejection surfacing as a generic dispatcher error.
			return fail(`key '${String(args.key).trim()}' could not be decompressed: ${String((e as Error)?.message ?? e)}`);
		}
	},
};
