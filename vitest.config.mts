import { defineConfig } from "vitest/config";

export default defineConfig({
	// The generated main.js sits beside main.ts inside a development vault.
	resolve: { extensions: [".ts", ".tsx", ".mjs", ".js", ".json"] },
	test: {
		environment: "node",
		setupFiles: ["tests/setup.ts"],
		include: ["tests/**/*.test.ts"],
		clearMocks: true,
		restoreMocks: true,
	},
});
