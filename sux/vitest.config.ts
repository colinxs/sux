import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["sux/src/**/*.test.ts"],
		environment: "node",
	},
});
