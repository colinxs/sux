import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["sux/src/**/*.test.ts", "sux/node/**/*.test.ts"],
		environment: "node",
	},
});
