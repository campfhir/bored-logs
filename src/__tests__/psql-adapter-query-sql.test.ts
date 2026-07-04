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
import { LOG_LEVELS } from "../logger/adapter";
import type { LogQueryOptions, LogLevel } from "../logger/adapter";
import { parseLogQueryExpr } from "../logger/parseLogQuery";

// ---------------------------------------------------------------------------
// SQL-level validation of PostgresAdapter.query().
//
// We hand the adapter a real Kysely instance backed by a driver that never
// connects — it records every CompiledQuery (sql + parameters) and returns
// zero rows. This exercises the actual Kysely query builder in _queryLogs,
// so we can assert on the real generated SQL and bound parameters for the
// `logs.level in (...)` clause.
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

describe("PostgresAdapter.query — generated SQL for the level filter", () => {
  let adapter: PostgresAdapter;
  let compiled: CompiledQuery[];

  beforeEach(() => {
    const cap = makeCapturingDb();
    compiled = cap.compiled;
    adapter = new PostgresAdapter({ db: cap.db });
  });

  afterEach(async () => {
    await adapter.close();
  });

  /** The compiled main `logs` query (the one carrying the level filter). */
  async function levelQuery(options: LogQueryOptions): Promise<CompiledQuery> {
    await adapter.query(options);
    const q = compiled.find((c) => /"level" in \(/.test(c.sql));
    if (!q) throw new Error("no query with a level IN clause was compiled");
    return q;
  }

  /** String parameters are the levels (dates/limits are Date/number). */
  function levelParams(q: CompiledQuery): string[] {
    return q.parameters.filter((p): p is string => typeof p === "string");
  }

  /** Number of `$n` placeholders inside the level `IN (...)` clause. */
  function inPlaceholderCount(q: CompiledQuery): number {
    const clause = q.sql.match(/"level" in \(([^)]*)\)/);
    if (!clause) throw new Error("no level IN clause found");
    return clause[1].split(",").length;
  }

  /** Uppercased levels whose rank is <= the rank of `name` (this level + more severe). */
  function severitySet(name: string): string[] {
    const threshold = (LOG_LEVELS as Record<string, number>)[name];
    return Object.entries(LOG_LEVELS)
      .filter(([, rank]) => rank <= threshold)
      .map(([level]) => level.toUpperCase())
      .sort();
  }

  it("emits an `IN` clause (set membership), never a `>=` comparison on level", async () => {
    const q = await levelQuery({ level: "info" });
    expect(q.sql).toMatch(/"logs"\."level" in \(\$\d+\)/);
    // No inequality comparison against the level column.
    expect(q.sql).not.toMatch(/"level" >=/);
    expect(q.sql).not.toMatch(/"level" >/);
  });

  it("binds a single `level` as one uppercased parameter", async () => {
    const q = await levelQuery({ level: "info" });
    expect(q.sql).toMatch(/"level" in \(\$\d+\)/); // exactly one placeholder
    expect(levelParams(q)).toEqual(["INFO"]);
  });

  it("binds `levels` as multiple uppercased parameters", async () => {
    const q = await levelQuery({ levels: ["info", "debug"] });
    expect(q.sql).toMatch(/"level" in \(\$\d+, \$\d+\)/); // two placeholders
    expect(levelParams(q).sort()).toEqual(["DEBUG", "INFO"]);
  });

  it("de-dupes `levels` down to a single bound parameter", async () => {
    const q = await levelQuery({ levels: ["debug", "debug"] });
    expect(q.sql).toMatch(/"level" in \(\$\d+\)/); // one placeholder, not two
    expect(levelParams(q)).toEqual(["DEBUG"]);
  });

  describe("minLevel — severity threshold expanded into the IN clause", () => {
    it("still compiles to `IN`, never a `>=` comparison on level", async () => {
      const q = await levelQuery({ minLevel: "warn" });
      expect(q.sql).toMatch(/"logs"\."level" in \(/);
      expect(q.sql).not.toMatch(/"level" >=/);
      expect(q.sql).not.toMatch(/"level" >/);
    });

    it("expands `warn` to warn + everything more severe, uppercased", async () => {
      const q = await levelQuery({ minLevel: "warn" });
      const expected = severitySet("warn"); // CRITICAL, ERROR, SILENT, WARN
      expect(levelParams(q).sort()).toEqual(expected);
      expect(inPlaceholderCount(q)).toBe(expected.length);
      expect(levelParams(q)).not.toContain("INFO");
      expect(levelParams(q)).not.toContain("DEBUG");
    });

    it("expands `error` to only the most severe levels", async () => {
      const q = await levelQuery({ minLevel: "error" });
      const expected = severitySet("error"); // CRITICAL, ERROR, SILENT
      expect(levelParams(q).sort()).toEqual(expected);
      expect(inPlaceholderCount(q)).toBe(expected.length);
    });

    it("expands `debug` (most verbose) to every level", async () => {
      const q = await levelQuery({ minLevel: "debug" });
      const expected = Object.keys(LOG_LEVELS)
        .map((l) => l.toUpperCase())
        .sort();
      expect(levelParams(q).sort()).toEqual(expected);
      expect(inPlaceholderCount(q)).toBe(expected.length);
    });

    // Cast below deliberately violates the LogLevel type to exercise the
    // runtime lowercasing that lets untyped callers use any casing.
    it("is case-insensitive — `WARN` yields the same set as `warn`", async () => {
      const upper = await levelQuery({ minLevel: "WARN" as LogLevel });
      expect(levelParams(upper).sort()).toEqual(severitySet("warn"));
    });

    it("errors on an unknown minLevel without compiling any SQL", async () => {
      const res = await adapter.query({ minLevel: "bogus" as LogLevel });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.err.message).toBe("invalid log level");
        expect(res.err.cause?.message).toContain("bogus");
      }
      expect(compiled).toHaveLength(0);
    });
  });

  it("binds every level when no filter is supplied", async () => {
    const q = await levelQuery({});
    const expected = Object.keys(LOG_LEVELS)
      .map((l) => l.toUpperCase())
      .sort();
    expect(levelParams(q).sort()).toEqual(expected);
  });

  it("places the level parameters after the timestamp-range parameters", async () => {
    const q = await levelQuery({ level: "error" });
    // First two bound params are the start/end Dates, then the level.
    expect(q.parameters[0]).toBeInstanceOf(Date);
    expect(q.parameters[1]).toBeInstanceOf(Date);
    expect(levelParams(q)).toEqual(["ERROR"]);
  });
});

describe("PostgresAdapter.query — generated SQL for the attributeFilter tree", () => {
  let adapter: PostgresAdapter;
  let compiled: CompiledQuery[];

  beforeEach(() => {
    const cap = makeCapturingDb();
    compiled = cap.compiled;
    adapter = new PostgresAdapter({ db: cap.db });
  });

  afterEach(async () => {
    await adapter.close();
  });

  /** The main `logs` query (identified by its level IN clause). */
  async function mainQuery(query: string): Promise<CompiledQuery> {
    const parsed = parseLogQueryExpr(query);
    if (!parsed.ok) throw parsed.err;
    await adapter.query({ attributeFilter: parsed.val ?? undefined });
    const q = compiled.find((c) => /"level" in \(/.test(c.sql));
    if (!q) throw new Error("no main query was compiled");
    return q;
  }
  const strParams = (q: CompiledQuery): string[] =>
    q.parameters.filter((p): p is string => typeof p === "string");

  it("compiles an attribute leaf to a correlated EXISTS on log_attr", async () => {
    const q = await mainQuery("userId:'42'");
    // correlated subquery against log_attr, matched by name + value LIKE
    expect(q.sql).toMatch(/exists \(select .* from "log_attr"/i);
    expect(q.sql).toMatch(/"log_attr"\."log_id" = "logs"\."log_id"/);
    expect(q.sql).toMatch(/"val_name" = \$\d+/);
    expect(q.sql).toMatch(/"val" like \$\d+/);
    expect(strParams(q)).toContain("userId");
    expect(strParams(q)).toContain("%42%");
  });

  it("compiles a message leaf to a LIKE on logs.message (no EXISTS)", async () => {
    const q = await mainQuery("message:'boom'");
    expect(q.sql).toMatch(/"logs"\."message" like \$\d+/);
    expect(q.sql).not.toMatch(/exists \(/i);
    expect(strParams(q)).toContain("%boom%");
  });

  it("joins AND branches with `and`, not `or`", async () => {
    const q = await mainQuery("a:'1' b:'2'");
    expect((q.sql.match(/exists \(/gi) ?? []).length).toBe(2);
    // no OR between the two attribute predicates
    expect(q.sql).not.toMatch(/exists \([^]*\) or [^]*exists \(/i);
  });

  it("joins OR operands with `or`", async () => {
    const q = await mainQuery("a:'1' || b:'2'");
    expect((q.sql.match(/exists \(/gi) ?? []).length).toBe(2);
    expect(q.sql).toMatch(/ or /);
  });

  it("respects precedence: a AND (b OR c) uses both `and` and `or`", async () => {
    const q = await mainQuery("a:'1' b:'2' || c:'3'");
    expect((q.sql.match(/exists \(/gi) ?? []).length).toBe(3);
    expect(q.sql).toMatch(/ and /);
    expect(q.sql).toMatch(/ or /);
  });

  it("compiles a negated leaf to NOT EXISTS", async () => {
    const q = await mainQuery("userId:!'42'");
    expect(q.sql).toMatch(/not exists \(/i);
    expect(strParams(q)).toContain("%42%");
  });

  it("compiles a negated message leaf to NOT LIKE", async () => {
    const q = await mainQuery("message:!'boom'");
    expect(q.sql).toMatch(/"logs"\."message" not like \$\d+/);
  });

  it("compiles an exact-match leaf to `val = $` (not LIKE)", async () => {
    const q = await mainQuery("userId:='42'");
    expect(q.sql).toMatch(/"val" = \$\d+/);
    expect(strParams(q)).toContain("42");
    expect(strParams(q)).not.toContain("%42%");
  });

  it("compiles a numeric comparison with a numeric cast guarded by a regex", async () => {
    const q = await mainQuery("count:>'10'");
    expect(q.sql).toMatch(/::numeric/);
    expect(q.sql).toMatch(/~/); // regex guard so non-numeric values don't error
  });

  it("does not compile any attribute predicate when no attributeFilter is given", async () => {
    await adapter.query({});
    const q = compiled.find((c) => /"level" in \(/.test(c.sql))!;
    expect(q.sql).not.toMatch(/exists \(/i);
  });

  it("compiles an attribute date comparison with a timestamptz cast guarded by a regex", async () => {
    const q = await mainQuery("deployedAt:>'2003-01-02'");
    expect(q.sql).toMatch(/::timestamptz/);
    expect(q.sql).toMatch(/~/); // regex guard so non-date values don't error
    // The value is bound (as a string) and cast, not lexically compared.
    expect(strParams(q)).toContain("2003-01-02");
  });
});

describe("PostgresAdapter.query — built-in timestamp/level fields (not attributes)", () => {
  let adapter: PostgresAdapter;
  let compiled: CompiledQuery[];

  beforeEach(() => {
    const cap = makeCapturingDb();
    compiled = cap.compiled;
    adapter = new PostgresAdapter({ db: cap.db });
  });

  afterEach(async () => {
    await adapter.close();
  });

  async function mainQuery(query: string): Promise<CompiledQuery> {
    const parsed = parseLogQueryExpr(query);
    if (!parsed.ok) throw parsed.err;
    // Wide window so a `timestamp:` predicate isn't masked by the default range.
    await adapter.query({
      attributeFilter: parsed.val ?? undefined,
      start: "1970-01-01T00:00:00.000Z",
      end: "2100-01-01T00:00:00.000Z",
    });
    const q = compiled.find((c) => /"level" in \(/.test(c.sql));
    if (!q) throw new Error("no main query was compiled");
    return q;
  }
  const strParams = (q: CompiledQuery): string[] =>
    q.parameters.filter((p): p is string => typeof p === "string");
  // Bound Date params. The window always binds two (start/end); a `timestamp:`
  // predicate binds more — so a count > 2 proves the value hit the real column.
  const dateParamCount = (q: CompiledQuery): number =>
    q.parameters.filter((p) => p instanceof Date).length;

  it("compiles `timestamp:>` against logs.logged_timestamp, not an attribute EXISTS", async () => {
    const q = await mainQuery("timestamp:>'2003-01-02T00:00:00Z'");
    // `> $n` (strict) — distinct from the window's `>= $n`.
    expect(q.sql).toMatch(/"logs"\."logged_timestamp" > \$/);
    // Not routed to log_attr with val_name = 'timestamp'.
    expect(q.sql).not.toMatch(/exists \(/i);
    // The value is bound as a Date (window ×2 + predicate), not the "timestamp" text.
    expect(strParams(q)).not.toContain("timestamp");
    expect(dateParamCount(q)).toBe(3);
  });

  it("treats a bare `timestamp:` date as the whole calendar day (range, not equality)", async () => {
    const q = await mainQuery("timestamp:'2003-01-02'");
    expect(q.sql).not.toMatch(/exists \(/i);
    // Two extra Date params beyond the window: day start and day+1.
    expect(dateParamCount(q)).toBe(4);
  });

  it("supports the full comparison range on timestamp", async () => {
    for (const op of [">", ">=", "<", "<="]) {
      const cap = makeCapturingDb();
      const a = new PostgresAdapter({ db: cap.db });
      const parsed = parseLogQueryExpr(`timestamp:${op}'2003-01-02T00:00:00Z'`);
      if (!parsed.ok) throw parsed.err;
      await a.query({
        attributeFilter: parsed.val ?? undefined,
        start: "1970-01-01T00:00:00.000Z",
        end: "2100-01-01T00:00:00.000Z",
      });
      const q = cap.compiled.find((c) => /"level" in \(/.test(c.sql))!;
      expect(q.sql).not.toMatch(/exists \(/i);
      // Window's two Dates + one for the comparison value.
      expect(q.parameters.filter((p) => p instanceof Date)).toHaveLength(3);
      await a.close();
    }
  });

  it("compiles `level:` against logs.level (uppercased), not an attribute EXISTS", async () => {
    const q = await mainQuery("level:='error'");
    expect(q.sql).toMatch(/"logs"\."level" = \$\d+/);
    expect(q.sql).not.toMatch(/exists \(/i);
    expect(strParams(q)).toContain("ERROR");
  });

  it("compiles a negated `timestamp:` leaf (via !=) to a NOT comparison, no EXISTS", async () => {
    const q = await mainQuery("timestamp:!='2003-01-02'");
    expect(q.sql).toMatch(/not /i);
    expect(q.sql).not.toMatch(/exists \(/i);
    expect(dateParamCount(q)).toBe(4); // window ×2 + day-range ×2, negated
  });
});
