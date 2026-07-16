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
		// Boot hooks start a real `wrangler dev` (workerd) process. A cold CI runner
		// downloading the workerd binary + compiling the ~3.5 MB Worker with its Workflow
		// binding blows past 30s (green in ~5s locally where workerd is warm); give the
		// boot a generous cold-start budget so a slow boot isn't read as a test failure.
		hookTimeout: 120_000,
		fileParallelism: false,
	},
});
