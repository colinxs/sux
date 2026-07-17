import { runInline, type Op } from "@suxos/lib";
import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { makeCaps } from "../op-engine/caps";
import { registry } from "../op-engine/registry";
import { errMsg, oj } from "./_util";

export type RunMode = "inline" | "durable" | "auto";

// The Cloudflare `Workflow` binding has no list()/enumerate() — `get(id)` needs an id
// the caller already holds. We keep our own index in KV so a `list` action can answer
// "what durable runs exist" (e.g. to find paused `ask` gates) without the caller having
// squirreled away every instanceId itself.
const RUN_INDEX_PREFIX = "sux:run:idx:";
const RUN_INDEX_MAX = 200;

type RunIndexEntry = { instanceId: string; opId: string; startedAt: number };

/** Best-effort — an index-write hiccup must never fail the run it's indexing. */
async function indexDurableRun(env: RtEnv, entry: RunIndexEntry): Promise<void> {
	try {
		await env.OAUTH_KV.put(`${RUN_INDEX_PREFIX}${entry.instanceId}`, JSON.stringify(entry));
	} catch (e) {
		console.log(`run: failed to index durable instance ${entry.instanceId}: ${errMsg(e)}`);
	}
}

/**
 * List indexed durable run instances (most recently started first, capped at
 * RUN_INDEX_MAX), enriched with each instance's live status where the binding is
 * available. A status fetch that fails (e.g. the instance aged past retention) reports
 * `status: "unknown"` rather than dropping the entry — the index itself is still useful.
 */
export async function listDurableRuns(env: RtEnv): Promise<Array<RunIndexEntry & { status: string }>> {
	const entries: RunIndexEntry[] = [];
	let cursor: string | undefined;
	do {
		const page = await env.OAUTH_KV.list({ prefix: RUN_INDEX_PREFIX, cursor });
		for (const k of page.keys) {
			const raw = await env.OAUTH_KV.get(k.name);
			if (!raw) continue;
			try {
				entries.push(JSON.parse(raw) as RunIndexEntry);
			} catch {
				// skip an unparseable entry rather than fail the whole list
			}
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	entries.sort((a, b) => b.startedAt - a.startedAt);
	const top = entries.slice(0, RUN_INDEX_MAX);
	if (!env.OP_WORKFLOW) return top.map((e) => ({ ...e, status: "unknown" }));
	return Promise.all(
		top.map(async (e) => {
			try {
				const instance = await env.OP_WORKFLOW.get(e.instanceId);
				const s = await instance.status();
				return { ...e, status: s.status };
			} catch {
				return { ...e, status: "unknown" };
			}
		}),
	);
}

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
	if (env.OAUTH_KV) await indexDurableRun(env, { instanceId: instance.id, opId, startedAt: Date.now() });
	return { instanceId: instance.id };
}

export const run: Fn = {
	name: "run",
	surface: "front",
	// A run has side effects (op leaves, sinks) and starting a Workflow is not idempotent,
	// so it must never be served from cache.
	cacheable: false,
	description:
		"Run a composable op (a named suxlib Op tree) by id. {op}: the registered op id (call with a bad id to see the list; MVP ships `echo`). {input}: the op's input value (any JSON). {mode}: auto (default — inline for a simple pure/effect pipe, durable when the op fans out (map) or pauses for a human (ask)) | inline (force in-request; returns the op's output) | durable (force a Workflow; returns {instanceId} to poll). The durable runtime persists every step, so a run survives isolate eviction, retries, and multi-day approval pauses. Durable mode needs the OP_WORKFLOW binding. {action}: \"list\" enumerates durable run instances started from this connector (instanceId, opId, startedAt, live status where available) instead of starting/running an op — use it to discover paused `ask` gates without already holding an instanceId.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			op: { type: "string", description: "Registered op id to run (e.g. `echo`). An unknown id returns the known-ops list. Required unless {action} is 'list'." },
			input: { description: "Input value passed to the op tree (any JSON: string, object, array, …)." },
			mode: {
				type: "string",
				enum: ["inline", "durable", "auto"],
				description: "auto (default): inline for a simple op, durable when it fans out or asks. inline: force in-request, return output. durable: force a Workflow, return {instanceId}.",
			},
			action: {
				type: "string",
				enum: ["list"],
				description: "list: enumerate durable run instances (most recent first) instead of running an op.",
			},
		},
	},
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	run: async (env, a) => {
		const action = a?.action ? String(a.action) : "";
		if (action === "list") {
			if (!env.OAUTH_KV) return failWith("not_configured", "run list needs the OAUTH_KV binding.");
			const runs = await listDurableRuns(env);
			return ok(oj({ action, count: runs.length, runs }));
		}
		if (action) return failWith("bad_input", `run: unknown action '${action}'. Use 'list', or omit to run an op.`);

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
