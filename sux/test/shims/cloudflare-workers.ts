// Node-vitest shim for the workerd-only `cloudflare:workers` virtual module.
//
// The node unit tier (sux/vitest.config.ts) runs without workerd, so a VALUE import
// of `cloudflare:workers` — e.g. `WorkflowEntrypoint`, the base class OpWorkflow
// extends — can't resolve in node and fails module load. sux/vitest.config.ts aliases
// `cloudflare:workers` to this file so those modules (op-engine/durable.ts, and the
// worker index.ts that re-exports OpWorkflow) LOAD in node. Real Workflow behavior is
// exercised on workerd (e2e / the cluster-E acceptance test), never here.
//
// Types are unaffected: tsgo resolves `cloudflare:workers` against the ambient
// declarations in worker-configuration.d.ts, not this shim — so type-checking stays
// honest. Only the runtime `WorkflowEntrypoint` value needs a stand-in.
export class WorkflowEntrypoint<Env = unknown, _T = unknown> {
	protected ctx: any;
	protected env: Env;
	constructor(ctx?: any, env?: Env) {
		this.ctx = ctx;
		this.env = env as Env;
	}
}
