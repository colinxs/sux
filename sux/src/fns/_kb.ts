import type { RtEnv } from "../registry";
import { fingerprint, ledger } from "../ledger";
import { obsidian } from "./obsidian";

// Vault-KB write-hooks: as the user teaches sux (learn) or searches (save-on-search),
// mirror a human-readable line into the Obsidian vault so the knowledge is legible AND
// git-versioned — git history IS the undo for the vault side (the existing house
// convention), so these hooks carry a batch marker for traceability but do not invent a
// vault-delete undo. The authoritative learned set lives in KV (_examples.ts); this is
// the readable log.
//
// Both hooks are IDEMPOTENT (ledger fingerprint over the exact content → a re-run of the
// same learn/search converges instead of duplicating) and BEST-EFFORT: they route
// through the already-audited obsidian.run({action:"append"}) path and swallow every
// failure. When the vault is unconfigured (no OBSIDIAN_VAULT_REPO / remote), the append
// returns isError and the hook simply no-ops — fail-closed, never fatal to the caller.

const LEARN_NOTE = "sux/Learned.md";
const SEARCH_NOTE = "sux/Searches.md";

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
