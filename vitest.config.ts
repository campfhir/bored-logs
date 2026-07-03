import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["src/__tests__/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // Live-DB e2e suite runs via `pnpm test:e2e` (vitest.e2e.config.ts) — it
    // needs the node environment and a real Postgres, so keep it out of `pnpm test`.
    exclude: ["**/node_modules/**", "**/*.e2e.test.ts"],
  },
});
