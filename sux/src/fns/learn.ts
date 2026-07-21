import { hasAI } from "../ai";
import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { staged } from "../stage";
import { embedOne } from "./_embed";
import { appendOnLearn } from "./_kb";
import { classifyKnn, clearExamples, deleteBatch, type Example, listExamples, newId, putExample } from "./_examples";
import { errMsg, oj } from "./_util";

// learn — the stateless-learning substrate. Teach sux a labeled example
// (action=learn: embed `input`, store it under `label`, mirror a line into the vault
// KB), then classify new inputs by nearest labeled example (action=classify: embed the
// query, brute-force kNN over the stored set, vote a label). This is complementary to
// the `classify` fn's zero-shot LLM call: kNN needs no model call at classify time
// beyond one embed, and it LEARNS from your corrections — the more you teach, the
// sharper it gets. `recall` reads this same store back as a 5th source.
//
// Every write carries a `batch` handle (the bulk-undo): action=undo(batch=X) deletes
// exactly the records taught in that batch; action=reset clears the whole set. A learn
// with no explicit `batch` gets its own single-record batch, so any teach is undoable.
//
// GATE: the AI-dependent branches (learn's embed, classify's embed) check hasAI(env)
// first and return failWith("not_configured", …) — never throw — exactly like
// preferences.ts / recall.ts. No new arm-flag: these are explicit, caller-invoked tool
// calls over an always-bound KV, not an autonomous loop (see the chunk's gating note).
// The vault mirror is best-effort and no-ops when the vault is unconfigured.

function record(ex: Example): Record<string, unknown> {
	return { id: ex.id, label: ex.label, input: ex.input, source: ex.source, batch: ex.batch, ts: ex.ts, embedded: Array.isArray(ex.embedding) && ex.embedding.length > 0 };
}

export const learn: Fn = {
	name: "learn",
	cost: 3,
	cacheable: false,
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	description:
		"Stateless-learning substrate — teach sux by example, then classify by nearest labeled example (kNN over Workers-AI embeddings). " +
		"`action`: learn (default) | classify | list | undo | reset. " +
		"learn: embed `input` and store it under `label` (`source` optional); mirrors a line into the vault KB (git-versioned) and returns {id, batch, undo_hint} — every teach is undoable. Pass `batch` to group several teaches under one undo handle. " +
		"classify: embed `input`, k-nearest over the stored set (k default 3), return the voted `label` + `confidence` (cosine of the nearest) + the `neighbors`; an empty store returns label:null (not an error). " +
		"list: enumerate stored examples (no AI). undo: delete exactly the records tagged `batch`. reset: clear the WHOLE learned set — not batch-undoable, so it STAGES A PREVIEW BY DEFAULT (re-call with the returned commit_token, or pass force:true, to apply in one shot). " +
		"Complements `classify` (zero-shot LLM): this one LEARNS from your corrections and needs no model call at classify time beyond one embed. `recall` reads this store back. Needs the Workers-AI binding for learn/classify. Stateful — never cached.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["learn", "classify", "list", "undo", "reset"], default: "learn" },
			input: { type: "string", description: "learn/classify: the text to teach (with `label`) or to classify." },
			label: { type: "string", description: "learn: the label to attach to `input`." },
			source: { type: "string", description: "learn: optional provenance tag (e.g. where the example came from)." },
			batch: { type: "string", description: "learn: group this teach under a named undo handle. undo: the batch to delete." },
			k: { type: "integer", minimum: 1, maximum: 25, default: 3, description: "classify: how many nearest neighbors to vote over." },
			stage: { type: "boolean", description: "reset: preview only — returns {preview, commit_token}, clears nothing." },
			commit_token: { type: "string", description: "reset: commit a previously staged reset." },
			force: { type: "boolean", description: "reset: skip staging and clear in one shot (the ! override). By default reset stages a preview first." },
		},
	},
	raw: true,
	run: async (env: RtEnv, args: any) => {
		const action = String(args?.action ?? "learn").trim().toLowerCase();
		try {
			if (action === "list") {
				const all = await listExamples(env);
				const labels: Record<string, number> = {};
				for (const e of all) labels[e.label] = (labels[e.label] ?? 0) + 1;
				return ok(oj({ action, count: all.length, labels, examples: all.map(record) }));
			}

			if (action === "undo") {
				const batch = String(args?.batch ?? "").trim();
				if (!batch) return failWith("bad_input", "action=undo requires a `batch` — the handle returned by a prior learn.");
				const deleted = await deleteBatch(env, batch);
				return ok(oj({ action, batch, deleted, note: deleted ? `removed ${deleted} record(s) from batch ${batch}` : `no records tagged batch ${batch}` }));
			}

			if (action === "reset") {
				// reset clears the WHOLE set and is not batch-undoable — same irreversible
				// shape as kv_delete/vault_delete, so it's routed through the shared
				// stage()/STAGE_KINDS guard (learn_reset, irreversible:true) instead of a bare
				// confirm:true check (#1141): stages a preview by default, applies on a
				// matching commit_token or force:true.
				const preview = { action: "learn reset", note: "clears the ENTIRE learned set — not batch-undoable." };
				const gateArgs = { stage: args?.stage === true, commit_token: args?.commit_token ? String(args.commit_token) : undefined, force: args?.force === true };
				const out = await staged(env, "learn_reset", gateArgs, {}, preview, async () => {
					const deleted = await clearExamples(env);
					return { deleted, note: `cleared the learned set (${deleted} record(s))` };
				});
				return "stageResult" in out ? ok(oj(out.stageResult)) : ok(oj({ action, ...out.result }));
			}

			if (action === "classify") {
				const input = String(args?.input ?? "").trim();
				if (!input) return failWith("bad_input", "action=classify requires an `input` to classify.");
				if (!hasAI(env)) return failWith("not_configured", "Workers AI binding not configured — needed to embed the query for kNN classify.");
				const all = await listExamples(env);
				if (!all.length) return ok(oj({ action, input, label: null, confidence: 0, neighbors: [], note: "the learned set is empty — teach it with action=learn." }));
				const vec = await embedOne(env, input);
				const k = Math.min(25, Math.max(1, Number(args?.k) || 3));
				const v = classifyKnn(vec, all, k);
				return ok(oj({ action, input, label: v.label, confidence: v.confidence, neighbors: v.neighbors.map((n) => ({ label: n.label, input: n.input, score: n.score })), examples: all.length }));
			}

			if (action === "learn") {
				const input = String(args?.input ?? "").trim();
				const label = String(args?.label ?? "").trim();
				if (!input) return failWith("bad_input", "action=learn requires an `input` — the example text to teach.");
				if (!label) return failWith("bad_input", "action=learn requires a `label` to attach to the input.");
				if (!hasAI(env)) return failWith("not_configured", "Workers AI binding not configured — needed to embed the example.");

				const id = newId();
				const batch = String(args?.batch ?? "").trim() || id; // no explicit batch → this record is its own undo handle
				const embedding = await embedOne(env, input);
				const ex: Example = { id, input, label, batch, ts: Date.now(), embedding, ...(args?.source ? { source: String(args.source) } : {}) };
				await putExample(env, ex);

				// Best-effort, idempotent vault mirror — no-ops (fail-closed) if the vault is unconfigured.
				const mirrored = await appendOnLearn(env, label, input, batch);
				console.log(`learn: stored id=${id} label=${label} batch=${batch} mirrored=${mirrored}`);
				return ok(oj({ action, id, batch, label, mirrored_to_vault: mirrored, undo_hint: `learn(action:"undo", batch:"${batch}")` }));
			}

			return failWith("bad_input", `Unknown action '${action}'. Use learn | classify | list | undo | reset.`);
		} catch (e) {
			return failWith("upstream_error", `learn (${action}) failed: ${errMsg(e)}`);
		}
	},
};
