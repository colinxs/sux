import { type Fn, failWith, ok } from "../registry";
import { runVerb } from "./run";
import { classifyNotes, cutoffIso, defaultDeps, hasConsolidate, staleDays } from "./_consolidate";
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
			const contents = new Map<string, string>();
			await Promise.all(
				paths.map(async (path) => {
					try {
						contents.set(path, await deps.readNote(env, path));
					} catch {
						/* one unreadable note must not sink the whole scan */
					}
				}),
			);
			const { duplicate_candidates } = classifyNotes(paths, contents, cutoffIso(staleDays(env), new Date()), staleDays(env));
			const clusters = duplicate_candidates
				.filter((d) => contents.has(d.a) && contents.has(d.b))
				.slice(0, maxClusters)
				.map((d) => ({ a: d.a, aContent: contents.get(d.a)!, b: d.b, bContent: contents.get(d.b)!, key: d.key }));
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
