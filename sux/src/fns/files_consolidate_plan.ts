import { type Fn, failWith, ok } from "../registry";
import { runVerb } from "./run";
import { hasFilesConsolidate, findDuplicateFiles } from "./_files_consolidate";
import { filesSemanticIndex } from "./_files_semantic";
import { collectBinaryCandidates, findBinaryDuplicateFiles } from "./_files_binary_dup";
import { hasDropboxFullWrite } from "./_dropbox-full";
import { errMsg, oj } from "./_util";

// files_consolidate_plan — the entrypoint for the DURABLE, human-approved Dropbox-duplicate
// cleanup #1015 documents as missing: reuses files_semantic's ALREADY-COMPUTED embeddings
// (_files_semantic.ts's filesSemanticIndex — no separate read/embed pass here) to cluster
// near-identical TEXT files (_files_consolidate.ts's cosine union-find), PLUS a second,
// complementary source for everything files_semantic never embeds (screenshots, PDFs, other
// binaries) — _files_binary_dup.ts's content_hash group-by, a free field Dropbox's own
// list_folder already returns per file (#1022: no re-embed/vision-model pass needed for an
// EXACT byte-identical match). Both cluster sets feed the same `run` of the
// `files-consolidate-plan` op (op-engine/registry.ts), which proposes a REVERSIBLE
// relocation per duplicate cluster — the canonical (lexicographically-first) path is left
// untouched, every other member is moved into a parallel `/Archive/Duplicates/` tree, never
// deleted — then PAUSES for one human "archive these duplicate files?" approval before
// applying anything. Mirrors contact_consolidate_plan.ts's shape (fetch-then-runVerb; a
// durable op leaf only sees `caps`, not env) — except there isn't even a fetch here, since
// the index is already built. Gated behind FILES_CONSOLIDATE_ENABLED (detection) AND
// DROPBOX_FULL_WRITE_ENABLED (the eventual move, the same Mode-B write arm every other
// whole-Dropbox mutation needs) — fail-closed on both, since starting a run whose approval
// could never actually apply would just pause a human for nothing.
const numClamp = (v: unknown, lo: number, hi: number, dflt: number): number => Math.min(hi, Math.max(lo, Math.floor(Number(v) || dflt)));

export const files_consolidate_plan: Fn = {
	name: "files_consolidate_plan",
	surface: "leaf",
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	description:
		"Durable Dropbox-duplicate-cleanup-with-approval: reuses files_semantic's existing embeddings to cluster near-identical TEXT files (cosine similarity — no re-read/re-embed), plus a byte-identical content_hash group-by over everything else (screenshots, PDFs, other binaries files_semantic never embeds), then starts a durable run (op:'files-consolidate-plan') that proposes a REVERSIBLE relocation per duplicate cluster — the canonical (lexicographically-first) path is left alone, every other member is proposed to move into '/Archive/Duplicates/<its original path>', never deleted — then PAUSES for one human 'archive these duplicate files?' approval before applying anything. Nothing is ever auto-applied. Returns {instanceId}: poll with `run {action:'status', instanceId}`; approve with `run {action:'answer', instanceId, prompt:\"archive these duplicate files?\", payload:{approved:true}}`, or veto with {approved:false}. An unanswered gate applies nothing after 24h (fails closed). Needs FILES_CONSOLIDATE_ENABLED, DROPBOX_FULL_WRITE_ENABLED (the eventual move), and a configured Dropbox Mode B account (files_semantic / DROPBOX_FULL_*).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			maxClusters: { type: "integer", minimum: 1, maximum: 50, description: "Max duplicate clusters to propose relocations for this batch (default 20)." },
		},
	},
	run: async (env, a) => {
		if (!hasFilesConsolidate(env)) {
			return failWith("not_configured", "files_consolidate_plan is disabled — set FILES_CONSOLIDATE_ENABLED to arm it. Nothing scanned or archived until it's set.");
		}
		if (!hasDropboxFullWrite(env)) {
			return failWith("not_configured", "files_consolidate_plan also needs DROPBOX_FULL_WRITE_ENABLED armed — an approval can never actually relocate a duplicate without the Mode B write arm.");
		}
		try {
			const index = await filesSemanticIndex(env);
			if (!index) return failWith("not_configured", "files_consolidate_plan needs Dropbox Mode B configured (DROPBOX_FULL_REFRESH_TOKEN + DROPBOX_FULL_APP_KEY) — files_semantic has no index to cluster.");
			const maxClusters = numClamp(a?.maxClusters, 1, 50, 20);
			const textClusters = findDuplicateFiles(index.chunks);
			const { files: binaryCandidates, truncated: binaryTruncated } = await collectBinaryCandidates(env);
			const binaryClusters = findBinaryDuplicateFiles(binaryCandidates);
			const clusters = [...textClusters, ...binaryClusters].slice(0, maxClusters);
			if (!clusters.length) return ok(oj({ scanned: index.total, scannedBinary: binaryCandidates.length, candidates: 0, note: "no duplicate candidates found — nothing to archive" }));
			const input = clusters.map((cl) => ({ paths: cl.paths }));
			const res = await runVerb({ op: "files-consolidate-plan", input, mode: "durable" }, env);
			return ok(
				oj({
					scanned: index.total,
					scannedBinary: binaryCandidates.length,
					...(binaryTruncated ? { binaryTruncated: true } : {}),
					candidates: clusters.length,
					...res,
					note: 'durable run started — proposes a relocation per cluster, then pauses for a human \'archive these duplicate files?\' approval. Poll with `run {action:\'status\', instanceId}`; approve/reject with `run {action:\'answer\', instanceId, prompt:"archive these duplicate files?"}` ({approved:true|false}).',
				}),
			);
		} catch (e) {
			return failWith("upstream_error", errMsg(e));
		}
	},
};
