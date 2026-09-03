import { defineConfig } from "vitest/config";
import { workspaceAlias } from "./vitest.alias";

export default defineConfig({
  resolve: { alias: workspaceAlias },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["packages/ui/src/__tests__/setup.ts"],
    include: ["packages/*/src/**/*.test.{ts,tsx}"],
    // Live-DB e2e suite runs via `pnpm test:e2e` (vitest.e2e.config.ts) — it
    // needs the node environment and a real Postgres, so keep it out of `pnpm test`.
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.e2e.test.ts"],
    // `pnpm bench` — core logger throughput only. The live-DB adapter bench
    // (*.e2e.bench.ts) needs a real Postgres and runs via `pnpm bench:e2e`.
    benchmark: {
      include: ["packages/*/src/**/*.bench.ts"],
      exclude: ["**/node_modules/**", "**/*.e2e.bench.ts"],
    },
  },
});
