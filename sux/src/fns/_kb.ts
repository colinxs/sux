import type { RtEnv } from "../registry";
import { fingerprint, ledger } from "../ledger";
import { obsidian } from "./obsidian";

// Vault-KB write-hooks: as sux's self-distilling KV stores update (learn, save-on-search,
// oracle knowledge bases, preferences voice specs), mirror a human-readable line/section
// into the Obsidian vault so the knowledge is legible AND git-versioned — git history IS
// the undo for the vault side (the existing house convention), so these hooks carry a
// batch marker for traceability but do not invent a vault-delete undo. The authoritative
// state lives in KV (_examples.ts, sux:oracle:*, sux:prefs:*); this is the readable log.
//
// Both hooks are IDEMPOTENT (ledger fingerprint over the exact content → a re-run of the
// same learn/search converges instead of duplicating) and BEST-EFFORT: they route
// through the already-audited obsidian.run({action:"append"}) path and swallow every
// failure. When the vault is unconfigured (no OBSIDIAN_VAULT_REPO / remote), the append
// returns isError and the hook simply no-ops — fail-closed, never fatal to the caller.

const LEARN_NOTE = "sux/Learned.md";
const SEARCH_NOTE = "sux/Searches.md";
const ORACLE_NOTE = "sux/Knowledge.md";
const PREFS_NOTE = "sux/Voice.md";
const WHITELIST_NOTE = "sux/Whitelisted.md";

/** Append via obsidian, deduped by `dedupKey` (the SEMANTIC content — not the rendered line,
 *  whose batch marker is unique per call). Returns true iff it actually wrote. */
async function appendOnce(env: RtEnv, note: string, content: string, ns: string, dedupKey: string): Promise<boolean> {
	try {
		const fp = await fingerprint(`${note}\n${dedupKey}`);
		const fresh = await ledger(env, ns).markIfNew(fp);
		if (!fresh) return false; // already mirrored this exact content — converge, don't duplicate
		const r = await obsidian.run(env, { action: "append", path: note, content });
		if (r.isError) {
			// Vault unconfigured or write refused — un-mark so a later configured run can retry.
			try {
				await env.OAUTH_KV?.delete(`sux:ledger:${ns}:${fp}`);
			} catch {
				/* best-effort */
			}
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

/** Mirror a learned {label ← input} exemplar into the vault KB, tagged with its batch.
 *  Dedup is on label+input (the semantics) so re-teaching identical content converges. */
export function appendOnLearn(env: RtEnv, label: string, input: string, batch: string): Promise<boolean> {
	const clean = input.replace(/\s+/g, " ").trim();
	const line = `- **${label}** ← ${clean} <!-- batch:${batch} -->`;
	return appendOnce(env, LEARN_NOTE, line, "kb:learn", `${label}\n${clean}`);
}

/** Mirror a search + its result summary into the vault KB (save-on-search).
 *  Dedup is on the query so re-searching the same thing doesn't re-append. */
export function appendOnSearch(env: RtEnv, query: string, resultSummary: string): Promise<boolean> {
	const q = query.replace(/\s+/g, " ").trim();
	const summary = resultSummary.replace(/\s+/g, " ").trim().slice(0, 500);
	const line = `- **${q}** — ${summary}`;
	return appendOnce(env, SEARCH_NOTE, line, "kb:search", q);
}

/** Mirror an oracle topic's freshly re-distilled knowledge base into the vault as a
 *  timestamped section. Dedup is on topic+distilled, so the log grows one section per
 *  distinct KB version — a legible git-versioned history of the topic's evolution. */
export function appendOnOracle(env: RtEnv, topic: string, distilled: string): Promise<boolean> {
	const t = topic.replace(/\s+/g, " ").trim() || "default";
	const body = distilled.trim();
	if (!body) return Promise.resolve(false);
	const section = `\n## ${t} — ${new Date().toISOString()}\n\n${body}\n`;
	return appendOnce(env, ORACLE_NOTE, section, "kb:oracle", `${t}\n${body.replace(/\s+/g, " ")}`);
}

/** Record a WHITELISTED source in the vault as a git-versioned provenance ledger — the auditable
 *  copyright story for the `study` verb: exactly what user-supplied material was distilled, of what
 *  kind, into which topic, and when. This logs PROVENANCE only (never the source's text — the
 *  distilled KB itself is mirrored by appendOnOracle). Dedup is on topic+source so re-studying the
 *  same material into the same topic converges instead of duplicating the ledger line. */
export function appendOnWhitelist(env: RtEnv, topic: string, source: string, kind: string, title?: string): Promise<boolean> {
	const t = topic.replace(/\s+/g, " ").trim() || "default";
	const src = source.replace(/\s+/g, " ").trim().slice(0, 300) || "(inline)";
	const label = (title ?? "").replace(/\s+/g, " ").trim();
	const line = `- **${t}** ← ${kind}: ${src}${label ? ` — ${label}` : ""} <!-- whitelisted:${new Date().toISOString()} -->`;
	return appendOnce(env, WHITELIST_NOTE, line, "kb:whitelist", `${t}\n${src}`);
}

/** Mirror a preferences profile's freshly re-distilled voice spec into the vault as a
 *  timestamped section. Dedup is on profile+spec, so each distinct spec version appends
 *  once — a legible git-versioned history of how the voice has been tuned. */
export function appendOnPreferences(env: RtEnv, profile: string, spec: string): Promise<boolean> {
	const p = profile.replace(/\s+/g, " ").trim() || "default";
	const body = spec.trim();
	if (!body) return Promise.resolve(false);
	const section = `\n## ${p} — ${new Date().toISOString()}\n\n${body}\n`;
	return appendOnce(env, PREFS_NOTE, section, "kb:prefs", `${p}\n${body.replace(/\s+/g, " ")}`);
}
