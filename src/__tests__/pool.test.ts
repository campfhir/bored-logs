import { describe, it, expect, afterEach } from "vitest";
import { createLoggerPool } from "../adapters/psql/adapter";

describe("createLoggerPool", () => {
  const pools: ReturnType<typeof createLoggerPool>[] = [];

  afterEach(async () => {
    for (const p of pools) await p.end().catch(() => {});
    pools.length = 0;
  });

  function make(config = {}) {
    const p = createLoggerPool({ connectionString: "postgresql://localhost/test", ...config });
    pools.push(p);
    return p;
  }

  it("defaults max to 2", () => {
    expect(make().options.max).toBe(2);
  });

  it("defaults idleTimeoutMillis to 10_000", () => {
    expect(make().options.idleTimeoutMillis).toBe(10_000);
  });

  it("defaults connectionTimeoutMillis to 5_000", () => {
    expect(make().options.connectionTimeoutMillis).toBe(5_000);
  });

  it("allows overriding max", () => {
    expect(make({ max: 5 }).options.max).toBe(5);
  });

  it("allows overriding idleTimeoutMillis", () => {
    expect(make({ idleTimeoutMillis: 30_000 }).options.idleTimeoutMillis).toBe(30_000);
  });
});
