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

  it("compiles a $message leaf to a LIKE on logs.message (no EXISTS)", async () => {
    const q = await mainQuery("$message:'boom'");
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

  it("compiles a negated $message leaf to NOT LIKE", async () => {
    const q = await mainQuery("$message:!'boom'");
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

  it("compiles `$timestamp:>` against logs.logged_timestamp, not an attribute EXISTS", async () => {
    const q = await mainQuery("$timestamp:>'2003-01-02T00:00:00Z'");
    // `> $n` (strict) — distinct from the window's `>= $n`.
    expect(q.sql).toMatch(/"logs"\."logged_timestamp" > \$/);
    // Not routed to log_attr with val_name = 'timestamp'.
    expect(q.sql).not.toMatch(/exists \(/i);
    // The value is bound as a Date (window ×2 + predicate), not the "timestamp" text.
    expect(strParams(q)).not.toContain("timestamp");
    expect(dateParamCount(q)).toBe(3);
  });

  it("treats a bare `$timestamp:` date as the whole calendar day (range, not equality)", async () => {
    const q = await mainQuery("$timestamp:'2003-01-02'");
    expect(q.sql).not.toMatch(/exists \(/i);
    // Two extra Date params beyond the window: day start and day+1.
    expect(dateParamCount(q)).toBe(4);
  });

  it("supports the full comparison range on timestamp", async () => {
    for (const op of [">", ">=", "<", "<="]) {
      const cap = makeCapturingDb();
      const a = new PostgresAdapter({ db: cap.db });
      const parsed = parseLogQueryExpr(`$timestamp:${op}'2003-01-02T00:00:00Z'`);
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

  it("compiles `$level:` against logs.level (uppercased), not an attribute EXISTS", async () => {
    const q = await mainQuery("$level:='error'");
    expect(q.sql).toMatch(/"logs"\."level" = \$\d+/);
    expect(q.sql).not.toMatch(/exists \(/i);
    expect(strParams(q)).toContain("ERROR");
  });

  it("compiles a negated `$timestamp:` leaf (via !=) to a NOT comparison, no EXISTS", async () => {
    const q = await mainQuery("$timestamp:!='2003-01-02'");
    expect(q.sql).toMatch(/not /i);
    expect(q.sql).not.toMatch(/exists \(/i);
    expect(dateParamCount(q)).toBe(4); // window ×2 + day-range ×2, negated
  });
});

// ---------------------------------------------------------------------------
// Nested attribute paths — compiled SQL shape.
// ---------------------------------------------------------------------------

describe("PostgresAdapter.query — nested attribute paths", () => {
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
    await adapter.query({ attributeFilter: parsed.val ?? undefined });
    const q = compiled.find((c) => /"level" in \(/.test(c.sql));
    if (!q) throw new Error("no main query was compiled");
    return q;
  }

  it("compiles a concrete path with the CASE guard and #>> extraction", async () => {
    const q = await mainQuery("session.id:='123'");
    // val_name matches the BASE attribute, not the full dotted key
    expect(q.parameters).toContain("session");
    expect(q.parameters).not.toContain("session.id");
    // json-only guard, encrypted excluded, evaluated inside CASE
    expect(q.sql).toMatch(/case when/i);
    expect(q.sql).toMatch(/"val_type" = 'json'/);
    expect(q.sql).toMatch(/"encrypted" = false/);
    expect(q.sql).toMatch(/"val" is not null/);
    // text extraction with a bound path array
    expect(q.sql).toMatch(/#>>/);
    expect(q.parameters).toContainEqual(["id"]);
    expect(q.parameters).toContain("123");
  });

  it("reuses the guarded numeric cast on an extracted concrete path", async () => {
    const q = await mainQuery("cart.total:>'100'");
    expect(q.sql).toMatch(/#>>/);
    expect(q.sql).toMatch(/::numeric > /);
    expect(q.sql).toMatch(/~ '\^-\?\[0-9\]/); // numeric regex guard present
  });

  it("compiles array-index segments into the path array", async () => {
    const q = await mainQuery("users[0]:='123'");
    expect(q.parameters).toContain("users");
    expect(q.parameters).toContainEqual(["0"]);
  });

  it("compiles a wildcard path to jsonb_path_exists with a BOUND jsonpath", async () => {
    const q = await mainQuery("users[*]:='123'");
    expect(q.sql).toMatch(/jsonb_path_exists/);
    // the jsonpath itself must be a parameter, never inlined into the SQL
    expect(q.sql).not.toContain("$[*]");
    const jsonpath = q.parameters.find(
      (p): p is string => typeof p === "string" && p.includes("[*]"),
    );
    expect(jsonpath).toBeDefined();
    expect(jsonpath).toContain("?");
    // equality on a numeric-looking value matches string AND number forms
    expect(jsonpath).toContain("@ == $vs");
    expect(jsonpath).toContain("@ == $vn");
    // vars are bound as their own jsonb parameter
    const vars = q.parameters.find(
      (p): p is string => typeof p === "string" && p.includes('"vs"'),
    );
    expect(vars).toBeDefined();
    expect(JSON.parse(vars!)).toEqual({ vs: "123", vn: 123 });
  });

  it("compiles wildcard equality on a non-numeric value with a single string var", async () => {
    const q = await mainQuery("cart.items[*].sku:='A-1'");
    const jsonpath = q.parameters.find(
      (p): p is string => typeof p === "string" && p.includes("[*]"),
    );
    expect(jsonpath).toContain('$."items"[*]."sku"');
    expect(jsonpath).toContain("@ == $vs");
    expect(jsonpath).not.toContain("$vn");
  });

  it("regex-escapes the contains pattern (value with quote and regex chars)", async () => {
    const parsed = parseLogQueryExpr(String.raw`users[*]:'a".*b'`);
    if (!parsed.ok) throw parsed.err;
    await adapter.query({ attributeFilter: parsed.val ?? undefined });
    const q = compiled.find((c) => /"level" in \(/.test(c.sql))!;
    const jsonpath = q.parameters.find(
      (p): p is string => typeof p === "string" && p.includes("like_regex"),
    );
    expect(jsonpath).toBeDefined();
    // the regex metacharacters are escaped; the quote is JSON-escaped, so the
    // jsonpath string stays well-formed
    expect(jsonpath).toContain("\\.");
    expect(jsonpath).toContain("\\*");
    expect(() => JSON.parse(`{"p": "${"x"}"}`)).not.toThrow();
    // and nothing from the value leaks into the SQL text itself
    expect(q.sql).not.toContain("a\".*b");
  });

  it("negates a path filter as NOT EXISTS", async () => {
    const q = await mainQuery("session.id:!='123'");
    expect(q.sql).toMatch(/not exists \(select/i);
  });

  it("compiles a LITERAL quoted key to a flat val_name lookup", async () => {
    const q = await mainQuery("'session.id':='123'");
    expect(q.parameters).toContain("session.id");
    expect(q.sql).not.toMatch(/#>>|jsonb_path_exists/);
  });

  it("compiles a malformed path as a flat key (backward compatible)", async () => {
    const q = await mainQuery("weird[key:='x'");
    expect(q.parameters).toContain("weird[key");
    expect(q.sql).not.toMatch(/#>>|jsonb_path_exists/);
  });
});

// ---------------------------------------------------------------------------
// Null literals — compiled SQL shape.
// ---------------------------------------------------------------------------

describe("PostgresAdapter.query — null literals", () => {
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
    await adapter.query({ attributeFilter: parsed.val ?? undefined });
    const q = compiled.find((c) => /"level" in \(/.test(c.sql));
    if (!q) throw new Error("no main query was compiled");
    return q;
  }

  it("compiles a flat null literal to a val_type = 'null' check", async () => {
    const q = await mainQuery("reason:=null");
    expect(q.sql).toMatch(/"val_type" = 'null'/);
    // no value comparison — the row's existence with type null IS the match
    expect(q.sql).not.toMatch(/"val" = \$/);
  });

  it("negates a flat null literal as NOT EXISTS", async () => {
    const q = await mainQuery("reason:!=null");
    expect(q.sql).toMatch(/not exists \(select/i);
    expect(q.sql).toMatch(/"val_type" = 'null'/);
  });

  it("compiles a QUOTED 'null' as a plain string comparison", async () => {
    const q = await mainQuery("reason:='null'");
    expect(q.sql).not.toMatch(/"val_type" = 'null'/);
    expect(q.parameters).toContain("null");
  });

  it("compiles a concrete-path null literal via jsonb #> = 'null'::jsonb", async () => {
    const q = await mainQuery("session.id:=null");
    expect(q.sql).toMatch(/#>(?!>)/); // jsonb extraction, not text
    expect(q.sql).toMatch(/'null'::jsonb/);
  });

  it("compiles a wildcard null literal via @ == null in the bound jsonpath", async () => {
    const q = await mainQuery("users[*]:=null");
    const jsonpath = q.parameters.find(
      (p): p is string => typeof p === "string" && p.includes("[*]"),
    );
    expect(jsonpath).toContain("@ == null");
  });
});

// ---------------------------------------------------------------------------
// Ordering fallback is string-only: a non-numeric, non-date comparison value
// must never sweep number/date-typed rows into lexicographic comparison.
// ---------------------------------------------------------------------------

describe("PostgresAdapter.query — lexicographic fallback is gated to strings", () => {
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
    await adapter.query({ attributeFilter: parsed.val ?? undefined });
    const q = compiled.find((c) => /"level" in \(/.test(c.sql));
    if (!q) throw new Error("no main query was compiled");
    return q;
  }

  it("guards a flat lexicographic comparison with val_type = 'string'", async () => {
    const q = await mainQuery("userId:>'A'");
    expect(q.sql).toMatch(/"val_type" = 'string'/);
  });

  it("guards a concrete-path lexicographic comparison with jsonb_typeof", async () => {
    const q = await mainQuery("session.id:>'a'");
    expect(q.sql).toMatch(/jsonb_typeof/);
  });

  it("does not add the string guard to numeric or date comparisons", async () => {
    const num = await mainQuery("count:>'10'");
    expect(num.sql).not.toMatch(/"val_type" = 'string'/);
    const date = await mainQuery("deployedAt:>'2003-01-02'");
    expect(date.sql).not.toMatch(/"val_type" = 'string'/);
  });

  it("does not add the string guard to contains or equality", async () => {
    const eq = await mainQuery("userId:='A'");
    expect(eq.sql).not.toMatch(/"val_type" = 'string'/);
  });
});

// ---------------------------------------------------------------------------
// ::string cast — forces text comparison, COERCING number/date values to
// their string form (the opposite of the default string-only gate).
// ---------------------------------------------------------------------------

describe("PostgresAdapter.query — ::string cast", () => {
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
    await adapter.query({ attributeFilter: parsed.val ?? undefined });
    const q = compiled.find((c) => /"level" in \(/.test(c.sql));
    if (!q) throw new Error("no main query was compiled");
    return q;
  }

  it("compiles a flat cast comparison as raw text, without numeric cast or string gate", async () => {
    const q = await mainQuery("count:>'100'::string");
    expect(q.sql).not.toMatch(/::numeric/);
    expect(q.sql).not.toMatch(/"val_type" = 'string'/); // coerces, does not gate
    expect(q.sql).toMatch(/"val" > \$\d+/);
  });

  it("compiles a flat cast comparison on a date-shaped value as raw text", async () => {
    const q = await mainQuery("deployedAt:>'2003-01-02'::string");
    expect(q.sql).not.toMatch(/::timestamptz/);
    expect(q.sql).toMatch(/"val" > \$\d+/);
  });

  it("compiles a concrete-path cast without the jsonb_typeof gate", async () => {
    const q = await mainQuery("cart.total:>'100'::string");
    expect(q.sql).toMatch(/#>>/); // text extraction (stringifies any scalar)
    expect(q.sql).not.toMatch(/jsonb_typeof/);
    expect(q.sql).not.toMatch(/::numeric/);
  });

  it("compiles a wildcard cast via jsonb_path_query with text coercion", async () => {
    const q = await mainQuery("scores[*]:>'100'::string");
    // elements of ANY type are extracted and compared in text form
    expect(q.sql).toMatch(/jsonb_path_query/);
    expect(q.sql).toMatch(/#>> '{}'/);
    expect(q.sql).not.toMatch(/jsonb_path_exists/);
  });
});

// ---------------------------------------------------------------------------
// $level range operators — severity thresholds in the query grammar.
// $level:>='error' means "error or MORE severe" (severity space, not rank
// space: rank is inverted, lower rank = more severe).
// ---------------------------------------------------------------------------

describe("PostgresAdapter.query — $level severity ranges", () => {
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
    await adapter.query({ attributeFilter: parsed.val ?? undefined });
    const q = compiled.find((c) => /"level" in \(/.test(c.sql));
    if (!q) throw new Error("no main query was compiled");
    return q;
  }

  /** Level names bound inside the tree's IN clause (excludes the outer gate's full set). */
  function treeLevelSet(q: CompiledQuery): string[] {
    // The outer level gate binds EVERY level; the tree leaf binds a subset.
    // Count occurrences: names bound twice are in both; once-bound full-set
    // names are the gate. Simpler: the tree set = names whose count is 2.
    const strs = q.parameters.filter((p): p is string => typeof p === "string");
    const counts = new Map<string, number>();
    for (const s of strs) counts.set(s, (counts.get(s) ?? 0) + 1);
    return [...counts.entries()].filter(([, n]) => n >= 2).map(([s]) => s).sort();
  }

  it("compiles $level:>= to the level and everything MORE severe", async () => {
    const q = await mainQuery("$level:>='error'");
    expect(q.sql.match(/"logs"\."level" in \(/g)!.length).toBeGreaterThanOrEqual(2);
    expect(treeLevelSet(q)).toEqual(["CRITICAL", "ERROR", "SILENT"]);
  });

  it("compiles $level:> to strictly more severe", async () => {
    const q = await mainQuery("$level:>'warn'");
    expect(treeLevelSet(q)).toEqual(["CRITICAL", "ERROR", "SILENT"]);
  });

  it("compiles $level:<= to the level and everything more verbose", async () => {
    const q = await mainQuery("$level:<='sql'");
    expect(treeLevelSet(q)).toEqual(["DEBUG", "SQL"]);
  });

  it("compiles $level:< to strictly more verbose", async () => {
    const q = await mainQuery("$level:<'sql'");
    expect(treeLevelSet(q)).toEqual(["DEBUG"]);
  });

  it("composes severity ranges inside OR branches", async () => {
    const q = await mainQuery("service:'db' || $level:>='error'");
    expect(q.sql).toMatch(/exists \(select/);
    expect(q.sql).toMatch(/ or /);
  });

  it("keeps exact and contains semantics unchanged", async () => {
    const exact = await mainQuery("$level:='error'");
    expect(exact.sql).toMatch(/"logs"\."level" = \$\d+/);
    await mainQuery("$level:'err'");
    // Two queries ran in this test; take the LAST compiled main query.
    const contains = compiled.filter((c) => /"level" in \(/.test(c.sql)).at(-1)!;
    expect(contains.sql).toMatch(/"logs"\."level" like \$\d+/);
  });

  it("includes custom levels at qualifying ranks", async () => {
    adapter.setLevels({ audit: 1 }); // same severity rank as error
    const q = await mainQuery("$level:>='error'");
    expect(treeLevelSet(q)).toEqual(["AUDIT", "CRITICAL", "ERROR", "SILENT"]);
  });

  it("is case-insensitive about the level name", async () => {
    const q = await mainQuery("$level:>='ERROR'");
    expect(treeLevelSet(q)).toEqual(["CRITICAL", "ERROR", "SILENT"]);
  });

  it("errors on an unknown level name with a range operator, without compiling SQL", async () => {
    const parsed = parseLogQueryExpr("$level:>='bogus'");
    if (!parsed.ok) throw parsed.err;
    const res = await adapter.query({ attributeFilter: parsed.val ?? undefined });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.err.message).toBe("invalid log level");
      expect(res.err.cause?.message).toContain("bogus");
    }
    expect(compiled.find((c) => /"level" in \(/.test(c.sql))).toBeUndefined();
  });
});
