// The DURABLE op interpreter — the same `Op` tree suxlib's `runInline` walks, but
// each node mapped onto Cloudflare Workflows primitives so a run survives isolate
// eviction, retries, and multi-day human pauses.
//
// REPLAY DETERMINISM (why this is safe to re-run from the top on every restart):
//   • The `Op` tree is a STATIC SHAPE — the registry factory that builds it is a pure
//     function of no inputs (no `Date.now()` / `Math.random()` / live I/O), so every
//     construction (including one per replay) yields the same tree. The per-run limiter
//     it mints carries only scheduling state; step identity never depends on it.
//     Walking the tree therefore yields the same shape every pass.
//   • Every leaf (and reconcile, and each sink write) runs inside `step.do(name, …)`,
//     so its result is MEMOIZED by the runtime. On replay the body is not re-executed;
//     the persisted return value is handed back. Non-determinism (clocks, network,
//     AI) is therefore only ever observed once, inside a memoized step.
//   • `map`'s item list is whatever the PRIOR piped step returned — and that prior
//     step was itself a memoized `step.do`, so the list is identical across replays.
//     Fan-out indices are stable, so item i always maps to the same sub-steps.
//   • Step names must be UNIQUE and STABLE. We derive them from a positional `path`
//     (`pipe` → `${path}.${i}`, `map` → `${path}.m${i}`) plus the node's own name,
//     so the same logical step gets the same name on every pass and the runtime can
//     line up memoized results.
//
// Concurrency: `map` and `sink` fan out with `Promise.all` of `step.do` — a pattern
// Cloudflare's "Rules of Workflows" explicitly supports ("works correctly across
// engine lifetimes"); only `Promise.race`/`Promise.any` need wrapping. `map` stays
// bounded by the op's own limiter (`node.concurrency`), matching `runInline`.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowTimeoutDuration } from "cloudflare:workers";
import { runReconcile, type Caps, type Op } from "@suxos/lib";
import type { RtEnv } from "../registry.js";

// Above this, the fan-out would blow through the per-instance step ceiling (25k) —
// past the MVP's job (a 2–3 item tracer bullet). Fail loud rather than silently wedge.
const MAP_FANOUT_CEILING = 20_000;

export type OpParams = { opId: string; input: any };

/** Thrown when a human answers an `ask` gate with `{approved: false}` — a graceful
 * reject-and-stop distinct from the wait simply timing out. `instance.status()` surfaces
 * it via `error.name`/`error.message`, so a caller polling status can tell "the human
 * said no" apart from any other run failure without needing a suxlib `Op` schema change. */
export class AskRejectedError extends Error {
	constructor(
		public readonly prompt: string,
		public readonly payload: unknown,
	) {
		super(`ask "${prompt}" was rejected by the answering payload`);
		this.name = "AskRejectedError";
	}
}

/**
 * Interpret one `Op` node against a durable `WorkflowStep`. `path` is the caller's
 * positional address of this node in the tree — the prefix every step name derives
 * from, so names stay unique and stable across replays (see the determinism note).
 */
export async function interpretDurable(node: Op, input: any, step: WorkflowStep, caps: Caps, path: string): Promise<any> {
	switch (node.tag) {
		case "leaf":
			return step.do(`${path}:${node.name}`, () => node.fn(input, caps));
		case "pipe": {
			let v = input;
			let i = 0;
			for (const s of node.steps) v = await interpretDurable(s, v, step, caps, `${path}.${i++}`);
			return v;
		}
		case "map": {
			const items: any[] = input;
			if (items.length > MAP_FANOUT_CEILING) {
				// TODO(slice-2-scale): split into child workflows via env.OP_WORKFLOW.create()
				// above this ceiling, awaited by polling instance status.
				throw new Error(`map fan-out of ${items.length} exceeds the MVP ceiling (${MAP_FANOUT_CEILING}); needs a child-workflow split`);
			}
			const out = new Array(items.length);
			await Promise.all(
				items.map(async (it, i) => {
					await node.concurrency.acquire();
					try {
						out[i] = await interpretDurable(node.op, it, step, caps, `${path}.m${i}`);
						node.concurrency.release(true);
					} catch (e) {
						node.concurrency.release(false);
						throw e;
					}
				}),
			);
			return out;
		}
		case "reconcile":
			return step.do(`${path}:reconcile`, () => runReconcile(node.opts, input, caps.store));
		case "sink": {
			await Promise.all(node.targets.map((t) => step.do(`${path}:sink:${t}`, () => caps.sinks[t].write(input, caps))));
			return input;
		}
		case "ask": {
			// A human pause: block on an external event whose `type` an approver sends
			// back (instance.sendEvent). `Op.timeout` is a looser `string` than the
			// Workflow API's template-literal duration, so we assert the cast here.
			let payload: any;
			try {
				const event = await step.waitForEvent<any>(`${path}:ask`, { type: `ask:${node.prompt}`, timeout: node.timeout as WorkflowTimeoutDuration });
				payload = event?.payload;
			} catch (e) {
				// The Workers API gives no typed way to tell "the wait elapsed" apart
				// from any other rejection (a transport error, a dropped RPC), so we
				// go by message/name — the one signal a real timeout is guaranteed to
				// carry. Anything that doesn't look like a timeout always propagates,
				// even under onTimeout: "proceed": a non-timeout failure here must not
				// silently auto-approve a human-review gate.
				if (node.onTimeout === "fail" || !isWaitForEventTimeout(e)) throw e;
				return input;
			}
			// A human can VETO the gate, not just unblock it, by answering with an
			// explicit `{approved: false}` payload (run action:answer) — `onTimeout`
			// only covers the wait elapsing, not an explicit "no", so without this an
			// `ask` could only ever be delayed, never rejected, short of cancelling the
			// whole instance.
			if (payload && typeof payload === "object" && payload.approved === false) throw new AskRejectedError(node.prompt, payload);
			return input;
		}
		default: {
			const _exhaustive: never = node;
			throw new Error(`interpretDurable: unhandled op tag: ${(node as Op).tag}`);
		}
	}
}

function isWaitForEventTimeout(e: unknown): boolean {
	if (!(e instanceof Error)) return false;
	return /timed?\s*out/i.test(e.name) || /timed?\s*out/i.test(e.message);
}

/**
 * The Workflow entrypoint bound as OP_WORKFLOW. It looks the op tree up in the
 * registry by id and interprets it durably. The registry + caps are imported
 * dynamically so this module (and its unit test) stay free of the `run` front-verb's
 * dependency graph — nothing here is pulled in until an instance actually runs.
 */
export class OpWorkflow extends WorkflowEntrypoint<RtEnv, OpParams> {
	async run(event: WorkflowEvent<OpParams>, step: WorkflowStep): Promise<unknown> {
		const { registry } = await import("./registry.js");
		const { makeCaps } = await import("./caps.js");
		const build = registry[event.payload.opId];
		if (!build) throw new Error(`unknown op: ${event.payload.opId}`);
		return interpretDurable(build(), event.payload.input, step, makeCaps(this.env), "root");
	}
}
