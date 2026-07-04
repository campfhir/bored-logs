import { describe, it, expect } from "vitest";
import type { Kysely } from "kysely";
import {
  MIGRATIONS,
  migrationNames,
  migrationProvider,
  up,
  down,
} from "../adapters/psql/migration";

// A chainable no-op Kysely stand-in that records the create/drop schema
// operations each migration issues, so we can assert which migrations ran and
// in what order without a real database.
function makeRecordingDb(ops: string[]): Kysely<any> {
  const TRACKED = new Set(["createTable", "dropTable", "createIndex", "dropIndex"]);
  const chain: any = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "execute") return () => Promise.resolve(undefined);
        if (prop === "then") return undefined; // never look like a thenable
        return (...args: unknown[]) => {
          if (TRACKED.has(prop)) ops.push(`${prop}:${String(args[0])}`);
          return chain;
        };
      },
    },
  );
  return { schema: chain } as unknown as Kysely<any>;
}

describe("migration registry", () => {
  it("orders migrations canonically", () => {
    expect(migrationNames).toEqual(["001_logs", "002_attr_val_name_index"]);
  });

  it("every migration has an up and a down", () => {
    for (const name of migrationNames) {
      expect(typeof MIGRATIONS[name].up).toBe("function");
      expect(typeof MIGRATIONS[name].down).toBe("function");
    }
  });

  it("provider exposes all migrations as a fresh copy", async () => {
    const migrations = await migrationProvider.getMigrations();
    expect(Object.keys(migrations)).toEqual(migrationNames);
    expect(migrations).not.toBe(MIGRATIONS);
  });
});

describe("up()", () => {
  it("runs every migration in canonical order", async () => {
    const ops: string[] = [];
    await up(makeRecordingDb(ops));
    // 001 creates the logs table; 002 swaps the val_name index.
    const createLogs = ops.indexOf("createTable:logs");
    const swapIndex = ops.indexOf("createIndex:log_attr_val_name_idx");
    expect(createLogs).toBeGreaterThanOrEqual(0);
    expect(swapIndex).toBeGreaterThanOrEqual(0);
    expect(createLogs).toBeLessThan(swapIndex);
  });

  it("runs only the requested subset", async () => {
    const ops: string[] = [];
    await up(makeRecordingDb(ops), { only: ["002_attr_val_name_index"] });
    expect(ops).not.toContain("createTable:logs");
    expect(ops).toContain("createIndex:log_attr_val_name_idx");
  });

  it("throws on an unknown migration name before touching the db", async () => {
    const ops: string[] = [];
    await expect(up(makeRecordingDb(ops), { only: ["999_nope"] })).rejects.toThrow(
      /unknown migration/,
    );
    expect(ops).toEqual([]);
  });
});

describe("down()", () => {
  it("rolls back in reverse canonical order", async () => {
    const ops: string[] = [];
    await down(makeRecordingDb(ops));
    // 002 rollback drops log_attr_val_name_idx; 001 rollback drops the tables.
    const dropSwap = ops.indexOf("dropIndex:log_attr_val_name_idx");
    const dropLogs = ops.indexOf("dropTable:logs");
    expect(dropSwap).toBeGreaterThanOrEqual(0);
    expect(dropLogs).toBeGreaterThanOrEqual(0);
    expect(dropSwap).toBeLessThan(dropLogs);
  });

  it("does not mutate the shared migrationNames order", async () => {
    await down(makeRecordingDb([]));
    expect(migrationNames).toEqual(["001_logs", "002_attr_val_name_index"]);
  });
});
