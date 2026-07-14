import { defineConfig } from "vitest/config";

// Separate from sux/vitest.config.ts (the `npm test` / required-CI suite) on purpose:
// these tests spin up a real `wrangler dev` process and hit it over real HTTP, which
// is slow (~seconds to boot) and needs network egress — neither is appropriate for the
// fast, always-required unit suite. Run via `npm run test:e2e`; wired into CI as a
// separate, non-required job (.github/workflows/e2e-mcp.yml).
export default defineConfig({
	test: {
		include: ["sux/test/e2e/**/*.e2e.test.ts"],
		environment: "node",
		testTimeout: 30_000,
		hookTimeout: 30_000,
		fileParallelism: false,
	},
});
