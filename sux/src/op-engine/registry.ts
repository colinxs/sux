import { op, pipe, map, reconcile, ask, sink, aimd, unzip, extract, summarize, type Op } from "@suxos/lib";

// THE op registry — named op trees that the `run` front-verb and the OpWorkflow
// dispatch by id. Each entry is a FACTORY that builds a FRESH tree per invocation,
// not a shared module constant. That matters for two reasons:
//   • Control state is per-run. An op's `map` limiter (`aimd`) carries mutable
//     inflight/backpressure state; a module-level singleton would leak one run's
//     congestion window into the next. Minting the tree per call gives every run a
//     clean limiter.
//   • Replay stays deterministic. The factory is a pure function of no inputs — it
//     reads no clock/random/I-O — so it yields an identical tree SHAPE every call.
//     Durable step names derive from each node's positional path (see durable.ts),
//     never from limiter state, so a fresh tree per replay lines up with the memoized
//     steps exactly. (Building once and sharing would be the bug, not the safety.)
//
// `echo` is the minimal tracer op — a single pure leaf, so the inline path is
// end-to-end testable with no R2/AI/Workflows bindings. `assimilate-pdfs` is the
// real walking-skeleton vertical: unzip a PDF archive, extract each PDF to markdown
// under a bounded fan-out, reconcile into one master, pause for human review, then
// summarize and fan the result out to both the R2 and vault sinks.
export const registry: Record<string, () => Op> = {
	echo: () => op("echo", async (x: unknown) => x, { kind: "pure" }),
	"assimilate-pdfs": () =>
		pipe(
			op("unzip", unzip, { kind: "effect" }),
			map(op("extract", extract, { kind: "effect", heavy: true }), { concurrency: aimd({ start: 4 }) }),
			reconcile({ mode: "faithful-union" }),
			ask("review master?", { timeout: "24 hour", onTimeout: "proceed" }),
			op("summarize", summarize, { kind: "effect" }),
			sink.fanout("r2", "vault"),
		),
};
