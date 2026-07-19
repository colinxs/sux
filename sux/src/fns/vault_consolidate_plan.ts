import { type Fn, failWith, ok } from "../registry";
import { runVerb } from "./run";
import { READ_CONCURRENCY, classifyNotes, cutoffIso, defaultDeps, hasConsolidate, staleDays } from "./_consolidate";
import { errMsg, oj } from "./_util";

// vault_consolidate_plan — the entrypoint for the DURABLE, human-approved action-half of
// `consolidate` (see _consolidate.ts's header for the "detection only" gap this closes):
// lists + reads a page of vault notes, classifies them with consolidate's EXISTING
// duplicate-candidate detection (classifyNotes/duplicateKey), then starts a `run` of the
// `vault-consolidate-plan` op (op-engine/registry.ts), which proposes a REVERSIBLE
// faithful-union merge per candidate cluster and PAUSES for one human "apply these note
// merges?" approval before applying anything. Nothing is ever auto-applied — mirrors
// mail_triage_plan.ts's shape exactly (fetch-then-runVerb; a durable op leaf only sees
// `caps`, not env, so the vault read happens here). Gated behind CONSOLIDATE_ENABLED, same
// flag as `consolidate` itself (fail-closed).
const numClamp = (v: unknown, lo: number, hi: number, dflt: number): number => Math.min(hi, Math.max(lo, Math.floor(Number(v) || dflt)));

export const vault_consolidate_plan: Fn = {
	name: "vault_consolidate_plan",
	surface: "leaf",
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	description:
		"Durable vault-consolidation-with-approval: scans a page of vault notes for likely-duplicate titles (consolidate's existing detection), then starts a durable run (op:'vault-consolidate-plan') that proposes a REVERSIBLE faithful-union merge per duplicate cluster — the canonical (lexicographically-first) note is overwritten with the merged content, the other is only APPENDED a pointer back to it, never deleted — then PAUSES for one human 'apply these note merges?' approval before applying anything. Nothing is ever auto-applied. Returns {instanceId}: poll with `run {action:'status', instanceId}`; approve with `run {action:'answer', instanceId, prompt:\"apply these note merges?\", payload:{approved:true}}`, or veto with {approved:false}. An unanswered gate applies nothing after 24h (fails closed). Needs CONSOLIDATE_ENABLED (same flag as `consolidate`) and a configured vault (git-backed Obsidian).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			max: { type: "integer", minimum: 1, maximum: 500, description: "Max notes to list+read this scan (default 200)." },
			maxClusters: { type: "integer", minimum: 1, maximum: 50, description: "Max duplicate clusters to propose merges for this batch (default 20)." },
		},
	},
	run: async (env, a) => {
		if (!hasConsolidate(env)) {
			return failWith("not_configured", "vault_consolidate_plan is disabled — set CONSOLIDATE_ENABLED to arm it (same flag as `consolidate`). Nothing scanned or merged until it's set.");
		}
		try {
			const deps = await defaultDeps();
			const max = numClamp(a?.max, 1, 500, 200);
			const maxClusters = numClamp(a?.maxClusters, 1, 50, 20);
			let allPaths: string[];
			try {
				allPaths = await deps.listNotes(env);
			} catch (e) {
				return failWith("upstream_error", `vault list failed: ${errMsg(e)}`);
			}
			const paths = allPaths.slice(0, max);
			// Read in READ_CONCURRENCY-sized parallel batches rather than one unbounded Promise.all
			// over up to `max` (schema max 500) notes — mirrors _consolidate.ts's runConsolidate sweep
			// (#964), which bounds the same GitHub Contents API read pattern for the same reason.
			const contents = new Map<string, string>();
			for (let i = 0; i < paths.length; i += READ_CONCURRENCY) {
				const batch = paths.slice(i, i + READ_CONCURRENCY);
				await Promise.all(
					batch.map(async (path) => {
						try {
							contents.set(path, await deps.readNote(env, path));
						} catch {
							/* one unreadable note must not sink the whole scan */
						}
					}),
				);
			}
			const { duplicate_candidates } = classifyNotes(paths, contents, cutoffIso(staleDays(env), new Date()), staleDays(env));
			// classifyNotes emits pairwise candidates (for the digest's "a ↔ b" display), but a
			// duplicate GROUP of 3+ notes must become exactly ONE cluster — every pair sharing a
			// key already names the same group, so collapse by key back into the full member set
			// before handing it to the op (#764: pairwise clusters sharing a `keep` overwrote each
			// other's merge one-by-one).
			const keyToGroup = new Map<string, Set<string>>();
			for (const d of duplicate_candidates) {
				if (!contents.has(d.a) || !contents.has(d.b)) continue;
				const group = keyToGroup.get(d.key) ?? new Set<string>();
				group.add(d.a);
				group.add(d.b);
				keyToGroup.set(d.key, group);
			}
			const clusters = [...keyToGroup.entries()]
				.slice(0, maxClusters)
				.map(([key, group]) => {
					const groupPaths = [...group];
					return { paths: groupPaths, contents: groupPaths.map((p) => contents.get(p)!), key };
				});
			if (!clusters.length) return ok(oj({ scanned: paths.length, candidates: 0, note: "no duplicate candidates found — nothing to merge" }));
			const res = await runVerb({ op: "vault-consolidate-plan", input: clusters, mode: "durable" }, env);
			return ok(
				oj({
					scanned: paths.length,
					candidates: clusters.length,
					...res,
					note: 'durable run started — proposes a faithful-union merge per cluster, then pauses for a human \'apply these note merges?\' approval. Poll with `run {action:\'status\', instanceId}`; approve/reject with `run {action:\'answer\', instanceId, prompt:"apply these note merges?"}` ({approved:true|false}).',
				}),
			);
		} catch (e) {
			return failWith("upstream_error", errMsg(e));
		}
	},
};
