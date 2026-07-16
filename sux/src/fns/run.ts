import { runInline, type Op } from "@suxos/lib";
import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { makeCaps } from "../op-engine/caps";
import { registry } from "../op-engine/registry";
import { errMsg, oj } from "./_util";

export type RunMode = "inline" | "durable" | "auto";

// `auto` routes to the durable runtime exactly when the op needs it: a fan-out (`map`,
// to run items concurrently under retries) or an `ask` (a human pause that must survive
// isolate eviction). A flat pure/effect pipe has neither, so it runs inline in-request
// — cheap, synchronous, no Workflow instance. Recurses through `pipe` since either can nest.
function needsDurable(n: Op): boolean {
	if (n.tag === "map" || n.tag === "ask") return true;
	if (n.tag === "pipe") return n.steps.some(needsDurable);
	return false;
}

/**
 * Run a registered op by id. INLINE (forced, or `auto` over a simple tree) interprets
 * the op in-request and returns its OUTPUT. DURABLE (forced, or `auto` over a tree with
 * fan-out/ask) starts an OpWorkflow instance and returns `{ instanceId }` — the caller
 * polls status and delivers `ask` answers to the instance out of band. Throws on an
 * unknown op, or on durable mode without the OP_WORKFLOW binding.
 */
export async function runVerb({ op: opId, input, mode = "auto" }: { op: string; input: any; mode?: RunMode }, env: RtEnv): Promise<any> {
	const build = registry[opId];
	if (!build) throw new Error(`unknown op: ${opId}`);
	const tree = build();
	const durable = mode === "durable" || (mode === "auto" && needsDurable(tree));
	if (!durable) return runInline(tree, input, makeCaps(env));
	if (!env.OP_WORKFLOW) throw new Error("run: durable mode needs the OP_WORKFLOW binding.");
	const instance = await env.OP_WORKFLOW.create({ params: { opId, input } });
	return { instanceId: instance.id };
}

export const run: Fn = {
	name: "run",
	surface: "front",
	// A run has side effects (op leaves, sinks) and starting a Workflow is not idempotent,
	// so it must never be served from cache.
	cacheable: false,
	description:
		"Run a composable op (a named suxlib Op tree) by id. {op}: the registered op id (call with a bad id to see the list; MVP ships `echo`). {input}: the op's input value (any JSON). {mode}: auto (default — inline for a simple pure/effect pipe, durable when the op fans out (map) or pauses for a human (ask)) | inline (force in-request; returns the op's output) | durable (force a Workflow; returns {instanceId} to poll). The durable runtime persists every step, so a run survives isolate eviction, retries, and multi-day approval pauses. Durable mode needs the OP_WORKFLOW binding.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["op"],
		properties: {
			op: { type: "string", description: "Registered op id to run (e.g. `echo`). An unknown id returns the known-ops list." },
			input: { description: "Input value passed to the op tree (any JSON: string, object, array, …)." },
			mode: {
				type: "string",
				enum: ["inline", "durable", "auto"],
				description: "auto (default): inline for a simple op, durable when it fans out or asks. inline: force in-request, return output. durable: force a Workflow, return {instanceId}.",
			},
		},
	},
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	run: async (env, a) => {
		const opId = a?.op ? String(a.op) : "";
		if (!opId) return failWith("bad_input", "run requires an `op` (a registered op id).");
		if (!registry[opId]) return failWith("not_found", `run: unknown op '${opId}'. Known ops: ${Object.keys(registry).join(", ") || "(none)"}.`);
		const mode = a?.mode ? String(a.mode) : "auto";
		if (mode !== "inline" && mode !== "durable" && mode !== "auto") return failWith("bad_input", `run: mode must be inline|durable|auto (got '${mode}').`);
		try {
			const res = await runVerb({ op: opId, input: a?.input, mode }, env);
			return ok(oj(res));
		} catch (e) {
			return failWith("upstream_error", `run ${opId} failed: ${errMsg(e)}`);
		}
	},
};
