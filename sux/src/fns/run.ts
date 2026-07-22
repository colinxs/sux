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
// Cloudflare Workflow instance state retention tops out at 30d (paid plan; 3d on free) —
// past that the instance itself is gone and `status()` can only ever report "unknown", so
// an index entry has no use surviving longer. Self-evicting here is what actually bounds
// the `sux:run:idx:` keyspace; RUN_INDEX_MAX alone only capped the returned slice, not storage.
const RUN_INDEX_TTL_SECONDS = 30 * 24 * 60 * 60;

type RunIndexEntry = { instanceId: string; opId: string; startedAt: number };

/** Best-effort — an index-write hiccup must never fail the run it's indexing. */
async function indexDurableRun(env: RtEnv, entry: RunIndexEntry): Promise<void> {
	try {
		await env.OAUTH_KV.put(`${RUN_INDEX_PREFIX}${entry.instanceId}`, JSON.stringify(entry), { expirationTtl: RUN_INDEX_TTL_SECONDS });
	} catch (e) {
		console.log(`run: failed to index durable instance ${entry.instanceId}: ${errMsg(e)}`);
	}
}

/** Look up a single indexed run's opId by instanceId (a targeted point-read, unlike
 * listDurableRuns' full-prefix scan) — the opId is what lets `answer` validate a
 * `prompt` against the op tree's actual `ask` gates before sending. Null when the
 * index has no entry (no OAUTH_KV, evicted past RUN_INDEX_TTL_SECONDS, or an instance
 * never indexed) — callers treat that as "can't validate", not "invalid".  */
async function getIndexedRun(env: RtEnv, instanceId: string): Promise<RunIndexEntry | null> {
	if (!env.OAUTH_KV) return null;
	const raw = await env.OAUTH_KV.get(`${RUN_INDEX_PREFIX}${instanceId}`);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as RunIndexEntry;
	} catch {
		return null;
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

// `auto` routes to the durable runtime exactly when the op needs it: a fan-out (`map`/
// `mapField`, to run items concurrently under retries) or an `ask` (a human pause that
// must survive isolate eviction). A flat pure/effect pipe has neither, so it runs inline
// in-request — cheap, synchronous, no Workflow instance. Exhaustive over every Op tag
// (mirroring durable.ts's interpreter switch, `never` guard included) so a new tag or a
// nesting shape durable.ts already handles can't silently fall through here unnoticed —
// this is the recurring bug shape #915/#926/#945/#681 kept hitting (#963).
export function needsDurable(n: Op): boolean {
	switch (n.tag) {
		case "map":
		case "ask":
			return true;
		case "pipe":
			return n.steps.some(needsDurable);
		case "mapField":
			return needsDurable(n.op);
		case "catch":
			return needsDurable(n.try) || needsDurable(n.catch);
		case "cond":
			return n.cases.some((c) => needsDurable(c.then)) || (n.default !== undefined && needsDurable(n.default));
		case "parallel":
		case "race":
			return n.ops.some(needsDurable);
		case "leaf":
		case "reconcile":
		case "sink":
			return false;
		default: {
			const _exhaustive: never = n;
			throw new Error(`needsDurable: unhandled op tag: ${(n as Op).tag}`);
		}
	}
}

export type AskGate = { prompt: string; timeout: string; onTimeout: "proceed" | "fail" };

// Every op tree is a static shape per opId (registry factories are pure — see
// registry.ts), so its `ask` nodes and their exact prompt text can be discovered ahead
// of any run. Exhaustive over every Op tag (see needsDurable's note) so an `ask` nested
// under `mapField`/`catch` — which durable.ts's interpreter already recurses into — can't
// be silently omitted here, leaving a caller with no way to discover its prompt to answer
// it (#963). This is what lets a caller learn "what can this op pause on"
// (`run action:describe`) instead of having to already know — or go read — the op tree's
// source to construct a matching `run action:answer` call (#715).
export function collectAskGates(n: Op, out: AskGate[] = []): AskGate[] {
	switch (n.tag) {
		case "ask":
			out.push({ prompt: n.prompt, timeout: n.timeout, onTimeout: n.onTimeout });
			break;
		case "pipe":
			for (const s of n.steps) collectAskGates(s, out);
			break;
		case "map":
		case "mapField":
			collectAskGates(n.op, out);
			break;
		case "catch":
			collectAskGates(n.try, out);
			collectAskGates(n.catch, out);
			break;
		case "cond":
			for (const c of n.cases) collectAskGates(c.then, out);
			if (n.default) collectAskGates(n.default, out);
			break;
		case "parallel":
		case "race":
			for (const o of n.ops) collectAskGates(o, out);
			break;
		case "leaf":
		case "reconcile":
		case "sink":
			break;
		default: {
			const _exhaustive: never = n;
			throw new Error(`collectAskGates: unhandled op tag: ${(n as Op).tag}`);
		}
	}
	return out;
}

/** Describe a registered op's `ask` gates (exact prompt text + timeout/onTimeout) without
 * running it — the read side of `run action:describe`. Throws on an unknown opId. */
export function describeOp(opId: string): { opId: string; asks: AskGate[] } {
	const build = registry[opId];
	if (!build) throw new Error(`unknown op: ${opId}`);
	return { opId, asks: collectAskGates(build()) };
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

/** Fetch a durable instance's live status (queued/running/paused/waiting/complete/errored/…,
 * plus `error`/`output` once terminal) — the read side of the durable-run control surface. */
export async function statusVerb(instanceId: string, env: RtEnv): Promise<{ status: string; error?: { name: string; message: string }; output?: unknown }> {
	if (!env.OP_WORKFLOW) throw new Error("run: status needs the OP_WORKFLOW binding.");
	const instance = await env.OP_WORKFLOW.get(instanceId);
	return instance.status();
}

/**
 * Answer an `ask` gate an instance is paused on. `prompt` must match the op tree's
 * `ask(prompt, …)` text exactly — the durable interpreter waits on event type
 * `ask:${prompt}` (durable.ts), so this sends that same event to release the wait.
 * `payload` is handed straight to the waiting `ask` node; omit it (or pass
 * `{approved: true}`) to just unblock, or pass `{approved: false, ...}` to reject
 * the gate (interpretDurable throws AskRejectedError, stopping the run).
 */
export async function answerVerb(instanceId: string, prompt: string, payload: unknown, env: RtEnv): Promise<void> {
	if (!env.OP_WORKFLOW) throw new Error("run: answer needs the OP_WORKFLOW binding.");
	const instance = await env.OP_WORKFLOW.get(instanceId);
	await instance.sendEvent({ type: `ask:${prompt}`, payload: payload === undefined ? { approved: true } : payload });
}

/** Terminate a running/paused durable instance. Throws if it's already errored/terminated/complete. */
export async function cancelVerb(instanceId: string, env: RtEnv): Promise<void> {
	if (!env.OP_WORKFLOW) throw new Error("run: cancel needs the OP_WORKFLOW binding.");
	const instance = await env.OP_WORKFLOW.get(instanceId);
	await instance.terminate();
}

export const run: Fn = {
	name: "run",
	surface: "front",
	// A run has side effects (op leaves, sinks) and starting a Workflow is not idempotent,
	// so it must never be served from cache.
	cacheable: false,
	description:
		"Run a composable op (a named suxlib Op tree) by id. {op}: the registered op id (call with a bad id to see the list; MVP ships `echo`). {input}: the op's input value (any JSON). {mode}: auto (default — inline for a simple pure/effect pipe, durable when the op fans out (map) or pauses for a human (ask)) | inline (force in-request; returns the op's output) | durable (force a Workflow; returns {instanceId} to poll). The durable runtime persists every step, so a run survives isolate eviction, retries, and multi-day approval pauses. Durable mode needs the OP_WORKFLOW binding. {action}: \"list\" enumerates durable run instances started from this connector (instanceId, opId, startedAt, live status where available) instead of starting/running an op — use it to discover paused `ask` gates without already holding an instanceId. \"status\" returns a durable {instanceId}'s live status (plus error/output once terminal). \"describe\" returns {op}'s `ask` gates (exact prompt text + timeout/onTimeout) up front, so a caller can construct a correct `answer` call before ever running the op — needs {op}, no {instanceId}. \"answer\" delivers a payload to an `ask` gate the instance is paused on — needs {instanceId} and {prompt} (the op tree's exact `ask(prompt, ...)` text, as returned by `describe`); {payload} defaults to {approved:true}, pass {approved:false} to reject the gate and stop the run. \"cancel\" terminates a durable instance.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			op: { type: "string", description: "Registered op id to run (e.g. `echo`). An unknown id returns the known-ops list. Required unless {action} is 'list' (and required, not the instanceId, for 'describe')." },
			input: { description: "Input value passed to the op tree (any JSON: string, object, array, …)." },
			mode: {
				type: "string",
				enum: ["inline", "durable", "auto"],
				description: "auto (default): inline for a simple op, durable when it fans out or asks. inline: force in-request, return output. durable: force a Workflow, return {instanceId}.",
			},
			action: {
				type: "string",
				enum: ["list", "status", "describe", "answer", "cancel"],
				description: "list: enumerate durable run instances (most recent first). status: fetch {instanceId}'s live status. describe: return {op}'s `ask` gates (prompt+timeout+onTimeout) without running it. answer: deliver a payload to an `ask` gate ({instanceId}+{prompt}, optional {payload}). cancel: terminate {instanceId}. Omit to run an op.",
			},
			instanceId: { type: "string", description: "Durable instance id (from a prior durable run or `action:list`). Required for status/answer/cancel." },
			prompt: { type: "string", description: "The op tree's exact `ask(prompt, ...)` text — targets the right gate when an instance has more than one. Required for `answer`." },
			payload: { description: "Payload delivered to the waiting `ask` node. Defaults to {approved:true}; {approved:false} rejects the gate. Only used by `answer`." },
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
		if (action === "describe") {
			const opId = a?.op ? String(a.op) : "";
			if (!opId) return failWith("bad_input", "run describe requires an `op` (a registered op id).");
			if (!registry[opId]) return failWith("not_found", `run: unknown op '${opId}'. Known ops: ${Object.keys(registry).join(", ") || "(none)"}.`);
			return ok(oj({ action, ...describeOp(opId) }));
		}
		if (action === "status" || action === "answer" || action === "cancel") {
			const instanceId = a?.instanceId ? String(a.instanceId) : "";
			if (!instanceId) return failWith("bad_input", `run ${action} requires an \`instanceId\`.`);
			try {
				if (action === "status") {
					const status = await statusVerb(instanceId, env);
					return ok(oj({ action, instanceId, ...status }));
				}
				if (action === "answer") {
					const prompt = a?.prompt ? String(a.prompt) : "";
					if (!prompt) return failWith("bad_input", "run answer requires a `prompt` matching the op tree's `ask(prompt, ...)` text.");
					// Validate `prompt` against the instance's own op tree before sending — a
					// mismatch (typo, wrong instance) would otherwise be silently buffered
					// by Workflows (no waitForEvent matches it) while this fn still reported
					// sent:true (#726).  Only possible when the run index still has the
					// instance's opId; falls back to sending unvalidated when it doesn't
					// (index miss is "can't tell", not "reject").
					const entry = await getIndexedRun(env, instanceId);
					if (entry) {
						let asks: AskGate[] = [];
						let resolved = false;
						try {
							asks = describeOp(entry.opId).asks;
							resolved = true;
						} catch {
							// unknown/removed opId — nothing to validate against, fall through to send
						}
						// `resolved` (not `asks.length`) gates validation: an op that resolved with
						// ZERO ask gates must still reject every prompt (nothing it could ever be
						// waiting on), not fall through as if opId resolution had failed (#817).
						if (resolved && !asks.some((g) => g.prompt === prompt)) {
							return failWith("not_found", `run answer: '${prompt}' matches no ask gate on '${entry.opId}'. Valid prompts: ${asks.map((g) => g.prompt).join(", ") || "(none — this op has no ask gates)"}.`);
						}
					}
					await answerVerb(instanceId, prompt, a?.payload, env);
					return ok(oj({ action, instanceId, prompt, sent: true }));
				}
				await cancelVerb(instanceId, env);
				return ok(oj({ action, instanceId, cancelled: true }));
			} catch (e) {
				return failWith("upstream_error", `run ${action} ${instanceId} failed: ${errMsg(e)}`);
			}
		}
		if (action) return failWith("bad_input", `run: unknown action '${action}'. Use 'list', 'status', 'describe', 'answer', 'cancel', or omit to run an op.`);

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
