import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { PostgresAdapter } from "../adapters/psql/adapter";
import type { LogRecord } from "../logger/adapter";

// ---------------------------------------------------------------------------
// application / version are NOT columns — the adapter appends them as
// attributes from the record's dedicated fields. A caller may also pass an
// attribute of the same name (both are legal names), so the two sources must
// reconcile to a single stored attribute instead of writing the key twice.
// ---------------------------------------------------------------------------

function makeCapturingDb() {
  const compiled: CompiledQuery[] = [];

  const connection: DatabaseConnection = {
    async executeQuery<R>(cq: CompiledQuery): Promise<QueryResult<R>> {
      compiled.push(cq);
      // The batch writer needs a log_id back from the `logs` insert.
      if (/insert into "logs"/.test(cq.sql)) {
        return { rows: [{ log_id: "1" }] as unknown as R[] };
      }
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

function baseRecord(attrs: Record<string, unknown>): LogRecord {
  return {
    level: "info",
    message: "m",
    template: "m",
    secureMessage: false,
    attrs,
    timestamp: new Date(0),
  };
}

const attrInsert = (compiled: CompiledQuery[]) =>
  compiled.find((c) => /insert into "log_attr" /.test(c.sql));
const blobInsert = (compiled: CompiledQuery[]) =>
  compiled.find((c) => /insert into "log_attr_blob"/.test(c.sql));

describe("PostgresAdapter — application/version meta attributes", () => {
  let compiled: CompiledQuery[];
  let adapter: PostgresAdapter;

  beforeEach(() => {
    const cap = makeCapturingDb();
    compiled = cap.compiled;
    adapter = new PostgresAdapter({ db: cap.db });
  });

  afterEach(async () => {
    await adapter.close();
  });

  /** Count how many times `key` appears among the log_attr insert parameters. */
  const keyCount = (key: string) =>
    attrInsert(compiled)!.parameters.filter((p) => p === key).length;

  it("appends application and version from the record fields", async () => {
    adapter.write({ ...baseRecord({ userId: "u_1" }), application: "api", version: "0.0.1" });
    await adapter.flush();

    const attr = attrInsert(compiled)!;
    expect(attr.parameters).toContain("api");
    expect(attr.parameters).toContain("0.0.1");
    expect(keyCount("application")).toBe(1);
    expect(keyCount("version")).toBe(1);
  });

  it("does not write the key twice when an attribute shadows the record field", async () => {
    adapter.write({
      ...baseRecord({ application: "worker", version: "9.9.9" }),
      application: "api",
      version: "0.0.1",
    });
    await adapter.flush();

    const attr = attrInsert(compiled)!;
    // Exactly one row per key — the attribute wins, matching the logger's
    // "call site overrides the global" rule.
    expect(keyCount("application")).toBe(1);
    expect(keyCount("version")).toBe(1);
    expect(attr.parameters).toContain("worker");
    expect(attr.parameters).toContain("9.9.9");
    expect(attr.parameters).not.toContain("api");
    expect(attr.parameters).not.toContain("0.0.1");
  });
});
