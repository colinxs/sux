import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["sux/src/**/*.test.ts", "sux/node/**/*.test.ts"],
		environment: "node",
	},
	resolve: {
		// `cloudflare:workers` is a workerd virtual module with no node resolution.
		// The op-engine's OpWorkflow value-imports it (WorkflowEntrypoint base class),
		// and the worker index.ts re-exports OpWorkflow, so the node unit tier needs a
		// stand-in to load those modules. Types still come from worker-configuration.d.ts.
		alias: {
			"cloudflare:workers": fileURLToPath(new URL("./test/shims/cloudflare-workers.ts", import.meta.url).href),
		},
	},
});
