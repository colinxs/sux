import { type Fn, fail, failWith, ok } from "../registry";
import { fetchTextOk, isHttpUrl, sha256Hex } from "./_util";
import { select } from "./select";

/** SHA-256 hex of a UTF-8 string. */
async function sha256Text(s: string): Promise<string> {
	return sha256Hex(new TextEncoder().encode(s));
}

/**
 * Reduce fetched HTML to the CSS-selected region by delegating to the `select`
 * fn (pure — it reads inline `html`, never re-fetches). Returns the JSON array of
 * matches so the hash tracks exactly what the selector picks out. On any failure
 * (bad selector, no matches) it degrades to hashing the whole body rather than
 * throwing — a watch must never break on the reduce step.
 */
async function reduce(html: string, selector: string): Promise<string> {
	try {
		const r = await select.run({} as never, { html, selector, limit: 1000 });
		if (r.isError || !Array.isArray(r.content)) return html;
		return r.content[0]?.text ?? html;
	} catch {
		return html;
	}
}

export const watch: Fn = {
	name: "watch",
	description:
		"Detect whether a page's content changed since the last check. Fetches `url` through the residential proxy, optionally reduces to a CSS `selector` region, SHA-256 hashes it, and compares to the last-seen hash stored in KV (namespaced by url+selector+label). First check records the hash (first_seen:true, changed:false); later checks report changed = hash differs from the stored one and update it. Returns JSON {url, label?, changed, first_seen, hash, previous_hash?, checked_at}. Stateful — never cached.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: {
			url: { type: "string", description: "Absolute http(s) URL to watch." },
			selector: { type: "string", description: "Optional CSS selector — hash only this region instead of the whole page." },
			label: { type: "string", description: "Optional namespacing string so the same url+selector can be tracked under distinct watches." },
		},
	},
	cacheable: false,
	run: async (env, args) => {
		try {
			const url = String(args?.url ?? "");
			const selector = args?.selector != null ? String(args.selector) : "";
			const label = args?.label != null ? String(args.label) : "";

			if (!isHttpUrl(url)) return failWith("bad_input", "Provide an absolute http(s) url.");

			const fetched = await fetchTextOk(env, url, {});
			if ("error" in fetched) return failWith("upstream_error", fetched.error);

			const content = selector ? await reduce(fetched.text, selector) : fetched.text;
			const hash = await sha256Text(content);

			const keyId = await sha256Text(`${url}\n${selector}\n${label}`);
			const kvKey = `sux:watch:${keyId}`;

			const previous = await env.OAUTH_KV.get(kvKey);
			const firstSeen = previous === null;
			const changed = !firstSeen && hash !== previous;

			// Store the new hash whenever it differs from what's recorded (first sight,
			// or an actual change) — a no-change re-check needs no write.
			if (firstSeen || changed) await env.OAUTH_KV.put(kvKey, hash);

			const out: Record<string, unknown> = {
				url,
				...(label ? { label } : {}),
				changed,
				first_seen: firstSeen,
				hash,
				...(firstSeen ? {} : { previous_hash: previous }),
				checked_at: new Date().toISOString(),
			};
			const result = ok(JSON.stringify(out, null, 2));
			result.noCache = true; // stateful: the stored hash mutates each check
			return result;
		} catch (e) {
			return fail(`watch failed: ${String((e as Error)?.message ?? e)}`);
		}
	},
};
