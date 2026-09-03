import { describe, it, expect } from "vitest";
import {
  Kysely,
  PostgresAdapter as KyselyPostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from "kysely";
import { LOG_TABLE_KEYS, LogSchemaPlugin, resolveLogSchema, withLogSchema } from "../schema";
import { createMigrations, up, down, migrationNames } from "../index";

// ---------------------------------------------------------------------------
// A real Kysely instance over a driver that never connects — it records every
// CompiledQuery so we can assert on the exact SQL the plugin produces.
// ---------------------------------------------------------------------------
function makeCapturingDb() {
  const compiled: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(cq: CompiledQuery): Promise<QueryResult<R>> {
      compiled.push(cq);
      return { rows: [] as R[] };
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

describe("resolveLogSchema", () => {
  it("defaults to the identity layout", () => {
    const r = resolveLogSchema();
    expect(r.isDefault).toBe(true);
    expect(r.schema).toBeUndefined();
    expect(r.prefix).toBe("");
    for (const k of LOG_TABLE_KEYS) expect(r.tables[k]).toBe(k);
    expect(r.indexes).toEqual({
      logTimestamp: "log_timestamp_idx",
      attrLogTimestamp: "attr_log_timestamp_idx",
      attrLog: "attr_log_idx",
      attrValName: "attr_val_name_idx",
      logAttrValName: "log_attr_val_name_idx",
      logLevel: "log_level_idx",
    });
    expect(r.constraints.logPurgeIdsPkey).toBe("log_purge_ids_pkey");
  });

  it("prefixes tables, indexes, and constraints", () => {
    const r = resolveLogSchema({ tablePrefix: "bl_" });
    expect(r.isDefault).toBe(false);
    expect(r.tables.logs).toBe("bl_logs");
    expect(r.tables.log_e2e_clients).toBe("bl_log_e2e_clients");
    expect(r.indexes.logTimestamp).toBe("bl_log_timestamp_idx");
    expect(r.constraints.logPurgeIdsPkey).toBe("bl_log_purge_ids_pkey");
  });

  it("applies explicit table overrides after the prefix", () => {
    const r = resolveLogSchema({ tablePrefix: "bl_", tables: { logs: "app_events" } });
    expect(r.tables.logs).toBe("app_events");
    expect(r.tables.log_attr).toBe("bl_log_attr");
  });

  it("a schema alone is a non-default layout with the default names", () => {
    const r = resolveLogSchema({ schema: "audit" });
    expect(r.isDefault).toBe(false);
    expect(r.schema).toBe("audit");
    expect(r.tables.logs).toBe("logs");
  });

  it("treats an empty schema string as unset", () => {
    expect(resolveLogSchema({ schema: "" }).isDefault).toBe(true);
  });

  it("rejects identifiers that are not plain lowercase Postgres names", () => {
    expect(() => resolveLogSchema({ schema: "Audit" })).toThrow(/invalid schema/);
    expect(() => resolveLogSchema({ schema: "a-b" })).toThrow(/invalid schema/);
    expect(() => resolveLogSchema({ tablePrefix: "1x" })).toThrow(/invalid tablePrefix/);
    expect(() => resolveLogSchema({ tables: { logs: "my logs" } })).toThrow(/invalid tables\.logs/);
    expect(() => resolveLogSchema({ tablePrefix: "x".repeat(60) })).toThrow(/at most 63/);
  });

  it("rejects two logical tables mapped to one physical name", () => {
    expect(() => resolveLogSchema({ tables: { logs: "t", log_attr: "t" } })).toThrow(/both resolve/);
  });
});

describe("LogSchemaPlugin — identifier rewriting", () => {
  const names = resolveLogSchema({ schema: "audit", tablePrefix: "bl_" });

  it("withLogSchema returns the same instance for the default layout", () => {
    const { db } = makeCapturingDb();
    expect(withLogSchema(db)).toBe(db);
    expect(withLogSchema(db, resolveLogSchema())).toBe(db);
    expect(withLogSchema(db, { schema: "audit" })).not.toBe(db);
  });

  it("qualifies table positions and renames column references", async () => {
    const { db, compiled } = makeCapturingDb();
    const ldb = withLogSchema(db, names);
    await ldb
      .selectFrom("logs")
      .select(["logs.log_id", "level"])
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("log_attr")
            .select(sql`1`.as("one"))
            .whereRef("log_attr.log_id", "=", "logs.log_id")
            .where(sql<boolean>`${sql.ref("log_attr.val")} = 'x'`),
        ),
      )
      .execute();
    const q = compiled[0].sql;
    expect(q).toContain('from "audit"."bl_logs"');
    expect(q).toContain('from "audit"."bl_log_attr"');
    // Column references are renamed but NOT schema-qualified.
    expect(q).toContain('"bl_log_attr"."log_id" = "bl_logs"."log_id"');
    expect(q).toContain('"bl_log_attr"."val"');
    expect(q).not.toMatch(/"audit"\."bl_logs"\."log_id"/);
    expect(q).not.toMatch(/(?<![a-z_])"logs"/);
    expect(q).not.toMatch(/(?<![a-z_])"log_attr"/);
  });

  it("rewrites sql.table() inside raw SQL", async () => {
    const { db, compiled } = makeCapturingDb();
    const ldb = withLogSchema(db, names);
    await sql`DELETE FROM ${sql.table("log_attr_blob")} USING ${sql.table("logs")} WHERE ${sql.ref("log_attr_blob.log_id")} = ${sql.ref("logs.log_id")}`.execute(ldb);
    expect(compiled[0].sql).toBe(
      'DELETE FROM "audit"."bl_log_attr_blob" USING "audit"."bl_logs" WHERE "bl_log_attr_blob"."log_id" = "bl_logs"."log_id"',
    );
  });

  it("rewrites insert / update / delete targets", async () => {
    const { db, compiled } = makeCapturingDb();
    const ldb = withLogSchema(db, names);
    await ldb.insertInto("log_purge_job").values({ purge_id: "p" }).execute();
    await ldb.updateTable("log_purge_job").set({ status: "x" }).where("purge_id", "=", "p").execute();
    await ldb.deleteFrom("log_purge_ids").where("purge_id", "=", "p").execute();
    expect(compiled[0].sql).toMatch(/^insert into "audit"\."bl_log_purge_job"/);
    expect(compiled[1].sql).toMatch(/^update "audit"\."bl_log_purge_job"/);
    expect(compiled[2].sql).toMatch(/^delete from "audit"\."bl_log_purge_ids"/);
  });

  it("qualifies FOREIGN KEY targets and DROP INDEX names, but not CREATE INDEX names", async () => {
    const { db, compiled } = makeCapturingDb();
    const ldb = withLogSchema(db, names);
    await ldb.schema
      .createTable("log_attr")
      .addColumn("log_id", "bigint", (c) => c.references("logs.log_id"))
      .execute();
    await ldb.schema.createIndex("bl_attr_log_idx").on("log_attr").column("log_id").execute();
    await ldb.schema.dropIndex("bl_attr_log_idx").ifExists().execute();
    await ldb.schema.dropTable("logs").ifExists().execute();
    expect(compiled[0].sql).toContain('create table "audit"."bl_log_attr"');
    expect(compiled[0].sql).toContain('references "audit"."bl_logs" ("log_id")');
    expect(compiled[1].sql).toBe('create index "bl_attr_log_idx" on "audit"."bl_log_attr" ("log_id")');
    expect(compiled[2].sql).toBe('drop index if exists "audit"."bl_attr_log_idx"');
    expect(compiled[3].sql).toBe('drop table if exists "audit"."bl_logs"');
  });

  it("leaves unrelated tables and already-qualified identifiers alone", async () => {
    const { db, compiled } = makeCapturingDb();
    const ldb = withLogSchema(db, names);
    await ldb.selectFrom("users").selectAll().execute();
    await ldb.selectFrom("other.logs").selectAll().execute();
    expect(compiled[0].sql).toBe('select * from "users"');
    expect(compiled[1].sql).toBe('select * from "other"."logs"');
  });

  it("a prefix without a schema renames without qualifying", async () => {
    const { db, compiled } = makeCapturingDb();
    await withLogSchema(db, { tablePrefix: "p_" }).selectFrom("logs").selectAll().execute();
    await withLogSchema(db, { tablePrefix: "p_" }).schema.dropIndex("p_log_level_idx").execute();
    expect(compiled[0].sql).toBe('select * from "p_logs"');
    expect(compiled[1].sql).toBe('drop index "p_log_level_idx"');
  });

  it("the plugin is a no-op for the default layout", async () => {
    const { db, compiled } = makeCapturingDb();
    const plain = db.withPlugin(new LogSchemaPlugin(resolveLogSchema()));
    await plain.selectFrom("logs").select("logs.log_id").where("level", "=", "INFO").execute();
    await db.selectFrom("logs").select("logs.log_id").where("level", "=", "INFO").execute();
    expect(compiled[0].sql).toBe(compiled[1].sql);
  });
});

describe("migrations under a custom layout", () => {
  it("createMigrations resolves the layout once and runs every step through the plugin", async () => {
    const { db, compiled } = makeCapturingDb();
    await up(db, { schema: "audit", tablePrefix: "bl_" });
    const all = compiled.map((c) => c.sql);
    expect(all[0]).toBe('create schema if not exists "audit"');
    expect(all).toContain(
      'create index if not exists "bl_log_timestamp_idx" on "audit"."bl_logs" ("logged_timestamp")',
    );
    expect(all.some((s) => s.includes('create table if not exists "audit"."bl_log_purge_ids"'))).toBe(true);
    expect(all.some((s) => s.includes('constraint "bl_log_purge_ids_pkey"'))).toBe(true);
    expect(all.some((s) => s.includes('references "audit"."bl_log_purge_job"'))).toBe(true);
    // 002 replaces the value index, both names prefixed and the drop qualified.
    expect(all).toContain('drop index if exists "audit"."bl_attr_val_name_idx"');
    expect(all).toContain(
      'create index if not exists "bl_log_attr_val_name_idx" on "audit"."bl_log_attr" ("val_name")',
    );
    // Nothing escaped the layout.
    for (const s of all) {
      expect(s).not.toMatch(/(?<![a-z_])"logs"/);
      expect(s).not.toMatch(/"log_attr(_blob)?"/);
      expect(s).not.toMatch(/"log_purge_(job|ids)"/);
      expect(s).not.toMatch(/"log_e2e_clients"/);
    }
  });

  it("down() under a layout drops the qualified objects", async () => {
    const { db, compiled } = makeCapturingDb();
    await down(db, { schema: "audit", tablePrefix: "bl_" });
    const all = compiled.map((c) => c.sql);
    expect(all).toContain('drop table if exists "audit"."bl_log_e2e_clients"');
    expect(all).toContain('drop index if exists "audit"."bl_log_timestamp_idx"');
    expect(all[all.length - 1]).toBe('drop table if exists "audit"."bl_logs"');
    // The schema itself is never dropped.
    expect(all.some((s) => /drop schema/i.test(s))).toBe(false);
  });

  it("the default layout compiles to unqualified, unprefixed SQL (existing installs)", async () => {
    const { db, compiled } = makeCapturingDb();
    await up(db);
    const all = compiled.map((c) => c.sql);
    expect(all.some((s) => /create schema/i.test(s))).toBe(false);
    expect(all[0]).toMatch(/^create table if not exists "logs"/);
    expect(all).toContain('create index if not exists "log_attr_val_name_idx" on "log_attr" ("val_name")');
    expect(all).toContain('drop index if exists "attr_val_name_idx"');
  });

  it("createMigrations() keeps the canonical order and the standard Migration shape", () => {
    const m = createMigrations({ tablePrefix: "x_" });
    expect(Object.keys(m)).toEqual(migrationNames);
    for (const name of migrationNames) {
      expect(typeof m[name].up).toBe("function");
      expect(typeof m[name].down).toBe("function");
    }
  });
});
