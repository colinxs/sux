import type { RtEnv } from "../registry";
import { cosine } from "./_embed";
import type { SemanticChunk } from "./_vault_semantic";
import type { MailSemanticChunk } from "./_mail_semantic";
import type { FilesSemanticChunk } from "./_files_semantic";

// _cross_semantic — the standing cross-domain half of #785: vault_semantic/mail_semantic/
// files_semantic (_vault_semantic.ts/_mail_semantic.ts/_files_semantic.ts) each already embed
// their own domain, but nothing runs the three indices AGAINST EACH OTHER to find durable
// relationships (a vault note whose nearest neighbors are specific emails and a Dropbox file).
// This module is the PURE detector half — cosine-rank the vault's chunks against a pooled
// mail+files target set, threshold, cap. No caps/env needed (mirrors _consolidate.ts's
// classifyNotes: the pure classification stays a plain function, testable with fixed vectors,
// with the actual index fetches left to the calling fn). The action half (registry.ts's
// `cross-semantic-plan` op + caps.ts's `related-links` sink) proposes these as an APPEND-ONLY
// "Related" block on the vault note — never a mail/file mutation, never a vault delete — mirroring
// vault-consolidate-plan's reversible-only bar.

// SAFETY (fail-closed): CROSS_SEMANTIC_ENABLED unset ⇒ vault_cross_link_plan refuses to run.
// Read-only detection composes existing semantic indices; the only write (an append-only
// "Related" block) happens after a human "add these related links?" approval, same as
// vault-consolidate-plan — but this still gates behind an explicit flag, since a new, noisier
// (cross-domain) class of vault write shouldn't arm itself just because AI + a vault happen to
// be configured. flagOn treats "0"/"false"/"off" as OFF explicitly, so an explicit
// CROSS_SEMANTIC_ENABLED=0 stays off rather than arming on mere presence (mirrors
// _consolidate.ts's flagOn).
const flagOn = (v: string | undefined): boolean => {
	const s = (v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "off";
};
export const hasCrossSemantic = (env: RtEnv): boolean => flagOn((env as { CROSS_SEMANTIC_ENABLED?: string }).CROSS_SEMANTIC_ENABLED);

// Cross-domain similarity is noisier than same-domain kNN (email previews, vault prose, and
// file text have different length/style distributions — the issue's own "honest caveat"), so
// the bar sits well above topKByCosine's k=8-and-take-whatever-ranks-highest same-domain
// default: a candidate must actually be a close match, not just the closest of a mediocre lot.
const MIN_SCORE = 0.75;
// Per-note and total caps bound both the "Related" block's size (a wall of low-signal links
// helps nobody) and the human-approval batch's size, mirroring vault-consolidate-plan's
// maxClusters bound.
const MAX_PER_NOTE = 3;
const MAX_TOTAL = 50;

// Cost is O(vaultChunks × targets) cosine calls with no cap of its own — each domain's OWN
// index already self-caps (vault 5000/mail 1000/files 3000), so a full-size vault can still
// drive ~5000×4000=20M cosine calls in one invocation, worst case. That was tolerable when this
// only ran on an explicit human-triggered vault_cross_link_plan call; #948's unattended weekly
// cron sweep has no human watching, and a mid-computation CPU-time kill isn't a catchable JS
// exception, so the sweep's ledger key never gets marked and it silently retries the same
// failure forever. Bound the pair count before the double loop runs, by capping how many vault
// chunks get scanned against a given target-set size (~2M pairs ≈ 1.5s of cosine calls on 768-dim
// vectors — well under a Worker's CPU budget) rather than capping targets, since targets is
// already the smaller, self-capped pooled set.
const MAX_PAIRS = 2_000_000;

export type CrossDomainItem = { domain: "mail" | "files"; key: string; label: string; embedding: number[] };
export type CrossLink = { vaultPath: string; domain: "mail" | "files"; key: string; label: string; score: number };

/** Pool mail_semantic's chunks into the domain-tagged shape crossDomainLinks ranks against —
 *  `key` is the message id (a durable JMAP identity), `label` the subject (what a human reads
 *  in the proposed "Related" block). Chunks that never embedded (a transient batch hiccup, same
 *  gap topKMailByCosine already filters) are skipped. */
export function mailToCrossItems(chunks: MailSemanticChunk[]): CrossDomainItem[] {
	return chunks.filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0).map((c) => ({ domain: "mail" as const, key: c.id, label: c.subject, embedding: c.embedding }));
}

/** Pool files_semantic's chunks the same way — `key`/`label` are both the Dropbox path (files
 *  have no separate title the way a vault note or an email subject does). */
export function filesToCrossItems(chunks: FilesSemanticChunk[]): CrossDomainItem[] {
	return chunks.filter((c) => Array.isArray(c.embedding) && c.embedding.length > 0).map((c) => ({ domain: "files" as const, key: c.path, label: c.path, embedding: c.embedding }));
}

/** For each vault note (aggregated across its chunks), find the best-scoring mail/files items
 *  above `minScore`, at most `maxPerNote` per note, ranked and capped at `maxTotal` pairs overall
 *  — the standing "propose" half of #785's cross-domain backlink detector. A note can match the
 *  SAME target through more than one of its own chunks; only the target's best-scoring chunk
 *  match survives per note (a duplicate {domain,key} pair would just double-list the same email/
 *  file in the note's "Related" block for no added signal). */
export function crossDomainLinks(vaultChunks: SemanticChunk[], targets: CrossDomainItem[], opts?: { minScore?: number; maxPerNote?: number; maxTotal?: number }): CrossLink[] {
	const minScore = opts?.minScore ?? MIN_SCORE;
	const maxPerNote = opts?.maxPerNote ?? MAX_PER_NOTE;
	const maxTotal = opts?.maxTotal ?? MAX_TOTAL;
	if (!targets.length) return [];
	const chunkCap = Math.max(1, Math.floor(MAX_PAIRS / targets.length));
	const scanChunks = vaultChunks.length > chunkCap ? vaultChunks.slice(0, chunkCap) : vaultChunks;
	const bestByNote = new Map<string, Map<string, CrossLink>>();
	for (const vc of scanChunks) {
		if (!Array.isArray(vc.embedding) || !vc.embedding.length) continue;
		let best = bestByNote.get(vc.path);
		for (const t of targets) {
			const score = cosine(vc.embedding, t.embedding);
			if (score < minScore) continue;
			if (!best) {
				best = new Map<string, CrossLink>();
				bestByNote.set(vc.path, best);
			}
			const targetKey = `${t.domain}:${t.key}`;
			const cur = best.get(targetKey);
			if (!cur || score > cur.score) best.set(targetKey, { vaultPath: vc.path, domain: t.domain, key: t.key, label: t.label, score });
		}
	}
	const out: CrossLink[] = [];
	for (const best of bestByNote.values()) {
		out.push(
			...[...best.values()]
				.sort((a, b) => b.score - a.score)
				.slice(0, maxPerNote),
		);
	}
	return out.sort((a, b) => b.score - a.score).slice(0, maxTotal);
}
