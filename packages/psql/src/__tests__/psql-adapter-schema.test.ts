import { describe, it, expect, afterEach } from "vitest";
import {
  Kysely,
  PostgresAdapter as KyselyPostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from "kysely";
import { PostgresAdapter, PsqlE2ERegistrationStore } from "../index";
import type { LogRecord } from "@campfhir/bored-logs";

// ---------------------------------------------------------------------------
// Custom table layout end to end through the adapter: every statement the
// adapter compiles must reference only the prefixed, schema-qualified names.
// ---------------------------------------------------------------------------

function makeCapturingDb() {
  const compiled: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(cq: CompiledQuery): Promise<QueryResult<R>> {
      compiled.push(cq);
      const s = cq.sql;
      if (/select count\(\*\)/i.test(s)) return { rows: [{ n: 0 }] as unknown as R[] };
      if (/insert into "audit"\."bl_logs"/i.test(s)) return { rows: [{ log_id: "1" }] as unknown as R[] };
      if (/WITH batch AS/i.test(s)) return { rows: [{ blobs: 0, attrs: 0, logs: 0, ids: 0 }] as unknown as R[] };
      if (/WITH deleted AS/i.test(s)) return { rows: [{ count: "0" }] as unknown as R[] };
      return { rows: [] as R[], numAffectedRows: 0n };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      return;
    },
  };
  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return connection;
    },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    async releaseConnection() {},
    async destroy() {},
  };
  const db = new Kysely<any>({
    dialect: {
      createAdapter: () => new KyselyPostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, compiled };
}

const LOGICAL = ["logs", "log_attr", "log_attr_blob", "log_purge_job", "log_purge_ids", "log_e2e_clients"];

/** Fail if any statement mentions a bare (unprefixed) logical table name. */
function expectOnlyPhysicalNames(compiled: CompiledQuery[]) {
  expect(compiled.length).toBeGreaterThan(0);
  for (const { sql } of compiled) {
    for (const t of LOGICAL) {
      // A bare `"logs"` / `"log_attr"` identifier — the prefixed form is "bl_logs".
      expect(sql, sql).not.toMatch(new RegExp(`(?<![a-z_])"${t}"`));
    }
  }
}

const rec = (attrs: Record<string, unknown> = {}): LogRecord => ({
  level: "info",
  message: "hello",
  template: "hello",
  secureMessage: false,
  attrs,
  timestamp: new Date("2024-01-01T00:00:00Z"),
});

describe("PostgresAdapter with { schema, tablePrefix }", () => {
  let adapter: PostgresAdapter;
  afterEach(async () => {
    await adapter?.close();
  });

  const make = () => {
    const cap = makeCapturingDb();
    adapter = new PostgresAdapter({
      db: cap.db,
      schema: "audit",
      tablePrefix: "bl_",
      purgeSweepIntervalMs: 0,
    });
    return cap;
  };

  it("exposes the resolved layout", () => {
    make();
    expect(adapter.schemaNames.schema).toBe("audit");
    expect(adapter.schemaNames.tables.logs).toBe("bl_logs");
    expect(adapter.schemaNames.indexes.logAttrValName).toBe("bl_log_attr_val_name_idx");
  });

  it("writes into the prefixed tables", async () => {
    const { compiled } = make();
    adapter.write(rec({ a: 1, big: "x".repeat(3000) }));
    await adapter.flush();
    expect(compiled.some((c) => /^insert into "audit"\."bl_logs"/.test(c.sql))).toBe(true);
    expect(compiled.some((c) => /^insert into "audit"\."bl_log_attr" /.test(c.sql))).toBe(true);
    expect(compiled.some((c) => /^insert into "audit"\."bl_log_attr_blob"/.test(c.sql))).toBe(true);
    expectOnlyPhysicalNames(compiled);
  });

  it("queries (including attribute filters and jsonArrayFrom) against the prefixed tables", async () => {
    const { compiled } = make();
    const res = await adapter.query({
      level: "info",
      attributeFilter: {
        type: "and",
        nodes: [
          { type: "filter", filter: { key: "user", operator: "=", value: "u1", negated: false } },
          { type: "filter", filter: { key: "cart.items[*].sku", operator: "=", value: "s", negated: false } },
          { type: "filter", filter: { key: "$level", operator: ">=", value: "error", negated: false } },
        ],
      },
    });
    expect(res.ok).toBe(true);
    const q = compiled[0].sql;
    expect(q).toContain('from "audit"."bl_logs"');
    expect(q).toContain('from "audit"."bl_log_attr"');
    expect(q).toContain('"bl_log_attr"."log_id" = "bl_logs"."log_id"');
    expectOnlyPhysicalNames(compiled);
  });

  it("purge planning, id capture, and the batch drain use the prefixed tables", async () => {
    const { compiled } = make();
    const job = await adapter.purge(new Date("2020-01-01"));
    expect(job.ok).toBe(true);
    const all = compiled.map((c) => c.sql);
    expect(all.some((s) => /from "audit"\."bl_logs"/.test(s) && /count\(\*\)/.test(s))).toBe(true);
    expect(all.some((s) => /insert into "audit"\."bl_log_purge_job"/.test(s))).toBe(true);
    expectOnlyPhysicalNames(compiled);
  });

  it("deepPurge's raw SQL is rewritten", async () => {
    const { compiled } = make();
    const res = await adapter.deepPurge(new Date("2020-01-01"));
    expect(res.ok).toBe(true);
    const all = compiled.map((c) => c.sql);
    expect(all.some((s) => /DELETE FROM "audit"\."bl_log_attr_blob"\s+USING "audit"\."bl_logs"/.test(s))).toBe(true);
    expect(all.some((s) => /"bl_log_attr"\."log_id" = "bl_logs"\."log_id"/.test(s))).toBe(true);
    expect(all.some((s) => /DELETE FROM "audit"\."bl_logs"/.test(s))).toBe(true);
    expectOnlyPhysicalNames(compiled);
  });

  it("migrate() / rollback() / migrationStatus() target the layout", async () => {
    const { compiled } = make();
    await adapter.migrate();
    await adapter.rollback();
    const status = await adapter.migrationStatus();
    expect(status.map((s) => s.name)).toEqual([
      "001_logs",
      "002_attr_val_name_index",
      "003_purge_jobs",
      "004_e2e_clients",
    ]);
    const all = compiled.map((c) => c.sql);
    expect(all[0]).toBe('create schema if not exists "audit"');
    expect(all).toContain('drop index if exists "audit"."bl_log_attr_val_name_idx"');
    const statusQuery = compiled.find((c) => /information_schema\.tables/.test(c.sql))!;
    expect(statusQuery.sql).toContain("table_schema = 'audit'");
    expect(statusQuery.parameters).toEqual(expect.arrayContaining(["bl_logs", "bl_log_e2e_clients"]));
    const idx = compiled.find((c) => /pg_indexes/.test(c.sql))!;
    expect(idx.parameters).toContain("bl_log_attr_val_name_idx");
    expectOnlyPhysicalNames(compiled);
  });

  it("PsqlE2ERegistrationStore honours the same layout", async () => {
    const { db, compiled } = makeCapturingDb();
    const store = new PsqlE2ERegistrationStore(db, { schema: "audit", tablePrefix: "bl_" });
    await store.get("c1");
    await store.set({ clientId: "c1", signingKeyJwk: { kty: "EC" }, algo: "a", registeredAt: 0 });
    await store.delete("c1");
    expect(compiled[0].sql).toMatch(/from "audit"\."bl_log_e2e_clients"/);
    expect(compiled[1].sql).toMatch(/^insert into "audit"\."bl_log_e2e_clients"/);
    expect(compiled[2].sql).toMatch(/^delete from "audit"\."bl_log_e2e_clients"/);
    expectOnlyPhysicalNames(compiled);
  });

  it("migrationStatus() without a schema uses current_schema()", async () => {
    const cap = makeCapturingDb();
    adapter = new PostgresAdapter({ db: cap.db, purgeSweepIntervalMs: 0 });
    await adapter.migrationStatus();
    expect(cap.compiled[0].sql).toContain("table_schema = current_schema()");
    expect(cap.compiled[0].parameters).toEqual(LOGICAL);
  });
});
