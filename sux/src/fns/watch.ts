import { type RtEnv, type Fn, fail, failWith, ok } from "../registry";
import { fetchTextOk, isHttpUrl, sha256Hex, oj } from "./_util";
import { select } from "./select";

/** SHA-256 hex of a UTF-8 string. */
async function sha256Text(s: string): Promise<string> {
	return sha256Hex(new TextEncoder().encode(s));
}

/** First numeric value found in text (commas stripped), e.g. "$1,234.56 →Buy" → 1234.56.
 *  Returns null when no digit run is present — callers fall back to the hash-only diff. */
function extractNumber(text: string): number | null {
	const m = text.match(/-?\d[\d,]*\.?\d*/);
	if (!m) return null;
	const n = Number(m[0].replace(/,/g, ""));
	return Number.isFinite(n) ? n : null;
}

// ── Directory index (#899) ──────────────────────────────────────────────────────
// A single sux:watch:index key holding every active watch's {keyId, url, selector?,
// label?, lastChecked} — the only way a cron sweep can enumerate "which watches exist"
// without knowing every url+selector+label combination up front (the per-watch keys are
// one-way hashes). Kept in lockstep with the existing first_seen/change-detected write
// path below (upsert) and reset (remove) rather than touched on every no-change recheck,
// so a steady page costs no extra KV traffic beyond what watch already did.
const INDEX_KEY = "sux:watch:index";

export type WatchIndexEntry = { keyId: string; url: string; selector?: string; label?: string; threshold?: number; thresholdPct?: number; lastChecked: string };

async function readWatchIndex(env: RtEnv): Promise<WatchIndexEntry[]> {
	try {
		const raw = await env.OAUTH_KV.get(INDEX_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((e): e is WatchIndexEntry => Boolean(e) && typeof e.keyId === "string" && typeof e.url === "string") : [];
	} catch {
		return [];
	}
}

/** Every active watch, for a cron sweep to enumerate and re-check. Best-effort: a corrupt
 *  or unreadable index degrades to an empty list rather than throwing. */
export const listWatches = readWatchIndex;

/** Upsert this watch into the directory — called only from the first_seen/change-detected
 *  paths (see run() below), never on a no-change recheck. Best-effort: an index write
 *  failure must never break the check itself, which already succeeded by this point.
 *  Merges into an existing entry for this keyId rather than rebuilding from scratch: a
 *  recheck call that omits threshold/threshold_pct (valid per the schema — they're meant
 *  to persist onto the watch) must carry forward the previously-stored threshold/thresholdPct
 *  instead of silently wiping them (#1108). */
async function upsertWatchIndex(env: RtEnv, keyId: string, url: string, selector: string, label: string, threshold?: number, thresholdPct?: number): Promise<void> {
	try {
		const entries = await readWatchIndex(env);
		const idx = entries.findIndex((e) => e.keyId === keyId);
		const existing = idx >= 0 ? entries[idx] : undefined;
		const finalThreshold = threshold !== undefined ? threshold : existing?.threshold;
		const finalThresholdPct = thresholdPct !== undefined ? thresholdPct : existing?.thresholdPct;
		const entry: WatchIndexEntry = {
			keyId,
			url,
			...(selector ? { selector } : {}),
			...(label ? { label } : {}),
			...(finalThreshold !== undefined ? { threshold: finalThreshold } : {}),
			...(finalThresholdPct !== undefined ? { thresholdPct: finalThresholdPct } : {}),
			lastChecked: new Date().toISOString(),
		};
		if (idx >= 0) entries[idx] = entry;
		else entries.push(entry);
		await env.OAUTH_KV.put(INDEX_KEY, JSON.stringify(entries));
	} catch {
		// best-effort — see comment above.
	}
}

/** Remove this watch from the directory — called from reset:true, the only un-watch path. */
async function removeWatchIndex(env: RtEnv, keyId: string): Promise<void> {
	try {
		const entries = await readWatchIndex(env);
		const next = entries.filter((e) => e.keyId !== keyId);
		if (next.length === entries.length) return;
		if (next.length === 0) await env.OAUTH_KV.delete(INDEX_KEY);
		else await env.OAUTH_KV.put(INDEX_KEY, JSON.stringify(next));
	} catch {
		// best-effort — see comment above.
	}
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
		"Detect whether a page's content changed since the last check. Fetches `url` through the residential proxy, optionally reduces to a CSS `selector` region, SHA-256 hashes it, and compares to the last-seen hash stored in KV (namespaced by url+selector+label). First check records the hash (first_seen:true, changed:false); later checks report changed = hash differs from the stored one and update it. Numeric-diff mode: set `threshold` and/or `threshold_pct` to extract the first number in the (selector-reduced) content and only report changed:true when it moves by at least that absolute amount or that percentage (either crossing counts) since the last reported value — cuts noisy proposals from a page that changes text without its tracked number moving (e.g. a price page's \"N people viewing\" banner). Falls back to the plain hash diff when no number can be parsed. reset:true deletes the stored baseline (hash + numeric, if any) for that url+selector+label (the only way to un-watch — the sux:watch: keys are outside kv_delete's reach) so the next check re-baselines. Returns JSON {url, label?, changed, first_seen, hash, previous_hash?, numeric_value?, previous_numeric_value?, checked_at}. Stateful — never cached.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: {
			url: { type: "string", description: "Absolute http(s) URL to watch." },
			selector: { type: "string", description: "Optional CSS selector — hash only this region instead of the whole page." },
			label: { type: "string", description: "Optional namespacing string so the same url+selector can be tracked under distinct watches." },
			reset: { type: "boolean", description: "Delete the stored baseline for this url+selector+label instead of checking — un-watches it so the next check re-baselines (first_seen:true). No fetch." },
			threshold: { type: "number", description: "Numeric-diff mode: only report changed:true when the number extracted from the content moves by at least this absolute amount since the last reported value. OR'd with threshold_pct when both are set. Persists onto the watch so the cron sweep (#899) applies it too." },
			threshold_pct: { type: "number", description: "Numeric-diff mode: only report changed:true when the extracted number moves by at least this percentage of the last reported value. OR'd with threshold when both are set." },
		},
	},
	cacheable: false,
	run: async (env, args) => {
		try {
			const url = String(args?.url ?? "");
			const selector = args?.selector != null ? String(args.selector) : "";
			const label = args?.label != null ? String(args.label) : "";
			const reset = args?.reset === true;
			const threshold = args?.threshold != null ? Number(args.threshold) : undefined;
			const thresholdPct = args?.threshold_pct != null ? Number(args.threshold_pct) : undefined;

			if (!isHttpUrl(url)) return failWith("bad_input", "Provide an absolute http(s) url.");
			if (threshold !== undefined && !Number.isFinite(threshold)) return failWith("bad_input", "threshold must be a number.");
			if (thresholdPct !== undefined && !Number.isFinite(thresholdPct)) return failWith("bad_input", "threshold_pct must be a number.");

			const keyId = await sha256Text(`${url}\n${selector}\n${label}`);
			const kvKey = `sux:watch:${keyId}`;
			const valueKey = `${kvKey}:value`;

			// reset un-watches: drop the baseline so the next check re-baselines. No fetch —
			// this is the only user-facing removal, since sux:watch: keys are outside kv_delete's
			// reach (it only touches the user kv: namespace).
			if (reset) {
				const existed = (await env.OAUTH_KV.get(kvKey)) !== null;
				if (existed) {
					await env.OAUTH_KV.delete(kvKey);
					await env.OAUTH_KV.delete(valueKey);
					await removeWatchIndex(env, keyId);
				}
				const result = ok(
					oj({
						url,
						...(label ? { label } : {}),
						reset: true,
						existed,
						checked_at: new Date().toISOString(),
					}),
				);
				result.noCache = true;
				return result;
			}

			const fetched = await fetchTextOk(env, url, {});
			if ("error" in fetched) return failWith("upstream_error", fetched.error);

			const content = selector ? await reduce(fetched.text, selector) : fetched.text;
			const hash = await sha256Text(content);

			const previous = await env.OAUTH_KV.get(kvKey);
			const firstSeen = previous === null;
			let changed = !firstSeen && hash !== previous;

			// Numeric-diff mode (#1091): when a threshold is configured and a number can be
			// parsed out of the content, `changed` is decided off the numeric delta against the
			// last REPORTED value (not the immediately-prior check), not the raw hash diff — a
			// footer/ad re-render that leaves the tracked number untouched no longer counts as a
			// change. No number found ⇒ falls back to the hash diff already computed above.
			const numericMode = threshold !== undefined || thresholdPct !== undefined;
			const numericValue = numericMode ? extractNumber(content) : null;
			let previousNumericValue: number | undefined;
			if (numericValue !== null) {
				const storedValue = await env.OAUTH_KV.get(valueKey);
				if (storedValue === null) {
					changed = false; // establishing the numeric baseline is not itself a reportable change
				} else {
					previousNumericValue = Number(storedValue);
					const delta = numericValue - previousNumericValue;
					const crossesAbs = threshold !== undefined && Math.abs(delta) >= threshold;
					const crossesPct = thresholdPct !== undefined && previousNumericValue !== 0 && (Math.abs(delta) / Math.abs(previousNumericValue)) * 100 >= thresholdPct;
					changed = crossesAbs || crossesPct;
				}
				if (storedValue === null || changed) await env.OAUTH_KV.put(valueKey, String(numericValue));
			}

			// Store the new hash whenever it differs from what's recorded (first sight,
			// or an actual change) — a no-change re-check needs no write.
			if (firstSeen || changed) await env.OAUTH_KV.put(kvKey, hash);

			// The directory index (#899) normally rides the same condition as the hash write, so a
			// cron sweep has something to enumerate. Numeric mode breaks that coupling: `changed`
			// is deliberately false most steady-state checks, but the sweep still needs this call's
			// threshold/thresholdPct written onto the entry (#1091) — so a numeric-mode call always
			// syncs the index, not just on firstSeen/changed.
			if (firstSeen || changed || numericMode) await upsertWatchIndex(env, keyId, url, selector, label, threshold, thresholdPct);

			const out: Record<string, unknown> = {
				url,
				...(label ? { label } : {}),
				changed,
				first_seen: firstSeen,
				hash,
				...(firstSeen ? {} : { previous_hash: previous }),
				...(numericValue !== null ? { numeric_value: numericValue, ...(previousNumericValue !== undefined ? { previous_numeric_value: previousNumericValue } : {}) } : {}),
				checked_at: new Date().toISOString(),
			};
			const result = ok(oj(out));
			result.noCache = true; // stateful: the stored hash mutates each check
			return result;
		} catch (e) {
			return fail(`watch failed: ${String((e as Error)?.message ?? e)}`);
		}
	},
};
