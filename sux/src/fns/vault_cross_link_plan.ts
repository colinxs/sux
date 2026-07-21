import { type Fn, failWith, ok } from "../registry";
import { runVerb } from "./run";
import { contactsToCrossItems, hasCrossSemantic, crossDomainLinks, filesToCrossItems, mailToCrossItems, type CrossDomainItem } from "./_cross_semantic";
import { vaultCfg } from "./obsidian";
import { vaultSemanticIndex } from "./_vault_semantic";
import { mailSemanticIndex } from "./_mail_semantic";
import { filesSemanticIndex } from "./_files_semantic";
import { contactSemanticIndex } from "./_contact_semantic";
import { errMsg, oj } from "./_util";

// vault_cross_link_plan — the entrypoint for the DURABLE, human-approved action-half of #785:
// ranks the vault's semantic index (_vault_semantic.ts) against the pooled mail_semantic +
// files_semantic indices to find standing cross-domain relationships (a vault note whose
// nearest neighbors are specific emails and a Dropbox file), then starts a `run` of the
// `cross-semantic-plan` op (op-engine/registry.ts), which PAUSES for one human "add these
// related links?" approval before appending anything. Nothing is ever auto-applied — mirrors
// vault_consolidate_plan.ts's shape (fetch-then-runVerb; a durable op leaf only sees `caps`, not
// env, so every index fetch happens here). The ranking itself (crossDomainLinks) needs no
// `caps` either, so — unlike vault_consolidate_plan's classify-in-the-op split — it runs here
// too, keeping the durable run's input a small, already-decided batch instead of the full
// (embedding-heavy) chunk sets. Gated behind CROSS_SEMANTIC_ENABLED (fail-closed).
const numClamp = (v: unknown, lo: number, hi: number, dflt: number): number => Math.min(hi, Math.max(lo, Math.floor(Number(v) || dflt)));

export const vault_cross_link_plan: Fn = {
	name: "vault_cross_link_plan",
	surface: "leaf",
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	description:
		"Durable cross-domain-linking-with-approval: cosine-ranks the vault's semantic index against the pooled mail + Dropbox (Mode B) + contacts semantic indices for close matches (a vault note whose nearest neighbors are specific emails/files/contacts), then starts a durable run (op:'cross-semantic-plan') that PAUSES for one human 'add these related links?' approval before appending anything. Reversible and non-destructive: each matched note only gets an APPEND-ONLY 'Related' block, never a content overwrite or delete. Returns {instanceId}: poll with `run {action:'status', instanceId}`; approve with `run {action:'answer', instanceId, prompt:\"add these related links?\", payload:{approved:true}}`, or veto with {approved:false}. An unanswered gate applies nothing after 24h (fails closed). Needs CROSS_SEMANTIC_ENABLED, a configured vault, and Workers-AI; mail/files/contacts legs are each skipped (not fatal) when JMAP/Dropbox Mode B aren't configured.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			minScore: { type: "number", minimum: 0, maximum: 1, description: "Minimum cosine similarity for a cross-domain match (default 0.75 — cross-domain corpora are noisier than same-domain kNN)." },
			maxPerNote: { type: "integer", minimum: 1, maximum: 20, description: "Max related items proposed per vault note (default 3)." },
			maxTotal: { type: "integer", minimum: 1, maximum: 200, description: "Max total match pairs proposed this batch (default 50)." },
		},
	},
	run: async (env, a) => {
		if (!hasCrossSemantic(env)) {
			return failWith("not_configured", "vault_cross_link_plan is disabled — set CROSS_SEMANTIC_ENABLED to arm it. Nothing scanned or linked until it's set.");
		}
		const cfg = vaultCfg(env);
		if ("error" in cfg) return failWith("not_configured", `vault_cross_link_plan needs a configured vault: ${cfg.error}`);
		try {
			const vaultIndex = await vaultSemanticIndex(env, cfg);
			if (!vaultIndex) return failWith("not_configured", "vault_cross_link_plan needs Workers-AI (env.AI) to rank the vault's semantic index.");
			const [mailIndex, filesIndex, contactsIndex] = await Promise.all([mailSemanticIndex(env), filesSemanticIndex(env), contactSemanticIndex(env)]);
			const targets: CrossDomainItem[] = [
				...(mailIndex ? mailToCrossItems(mailIndex.chunks) : []),
				...(filesIndex ? filesToCrossItems(filesIndex.chunks) : []),
				...(contactsIndex ? contactsToCrossItems(contactsIndex.chunks) : []),
			];
			if (!targets.length) {
				return ok(oj({ candidates: 0, note: "no mail, files, or contacts semantic index is configured — nothing to cross-link against" }));
			}
			const minScore = typeof a?.minScore === "number" ? Math.min(1, Math.max(0, a.minScore)) : undefined;
			const maxPerNote = a?.maxPerNote !== undefined ? numClamp(a.maxPerNote, 1, 20, 3) : undefined;
			const maxTotal = a?.maxTotal !== undefined ? numClamp(a.maxTotal, 1, 200, 50) : undefined;
			const candidates = crossDomainLinks(vaultIndex.chunks, targets, { minScore, maxPerNote, maxTotal });
			if (!candidates.length) return ok(oj({ candidates: 0, note: "no cross-domain matches above threshold — nothing to link" }));
			const res = await runVerb({ op: "cross-semantic-plan", input: candidates, mode: "durable" }, env);
			return ok(
				oj({
					candidates: candidates.length,
					...res,
					note: 'durable run started — pauses for a human \'add these related links?\' approval before appending anything. Poll with `run {action:\'status\', instanceId}`; approve/reject with `run {action:\'answer\', instanceId, prompt:"add these related links?"}` ({approved:true|false}).',
				}),
			);
		} catch (e) {
			return failWith("upstream_error", errMsg(e));
		}
	},
};
