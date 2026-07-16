import { op, type Op } from "@suxos/lib";

// THE op registry — named op trees that the `run` front-verb and the OpWorkflow
// dispatch by id. Trees are STATIC values (built once at module load, never per
// request), which is what makes durable replay safe (see durable.ts's determinism
// note). `echo` is the tracer-bullet op: a single pure leaf, so the inline path is
// end-to-end testable with no R2/AI/Workflows bindings. Real ops (the PDF pipeline)
// land alongside it as the domain leaves get wired.
export const registry: Record<string, Op> = {
	echo: op("echo", async (x: unknown) => x, { kind: "pure" }),
};
