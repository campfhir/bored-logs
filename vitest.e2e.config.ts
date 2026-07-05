import { defineConfig } from "vitest/config";

// Live end-to-end tests against a real Postgres. Run with `pnpm test:e2e`
// after `pnpm db:up` (or point DATABASE_URL at any reachable Postgres).
//
// Kept in a separate config from the unit suite: these need the Node
// environment (the `pg` driver, real timers, real sockets) rather than jsdom,
// and a longer timeout for connection + migration.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.e2e.test.ts"],
    // Run e2e files serially — they share one database and truncate between tests.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Live-DB throughput benchmarks — run via `pnpm bench:e2e` (needs `pnpm db:up`).
    benchmark: {
      include: ["src/**/*.e2e.bench.ts"],
    },
  },
});
