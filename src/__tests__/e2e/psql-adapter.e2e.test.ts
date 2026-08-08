import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { PostgresAdapter, createLoggerPool } from "../../adapters/psql/adapter";
import { parseLogQueryExpr } from "../../logger/parseLogQuery";
import type { LogRecord, LogRow } from "../../logger/adapter";

// ---------------------------------------------------------------------------
// Live end-to-end tests against a real Postgres.
//
//   pnpm db:up        # start the throwaway Postgres (compose.yaml)
//   pnpm test:e2e     # run this file
//   pnpm db:down      # tear it down
//
// Point DATABASE_URL at any reachable Postgres to run against your own.
// Unlike the SQL-capture unit tests (psql-adapter-query-sql.test.ts), this
// executes the generated SQL, so it proves the OR / AND / grouping filter
// trees actually return the right rows — not just that they compile.
// ---------------------------------------------------------------------------

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/bored_logs_test";

let db: Kysely<any>;
let adapter: PostgresAdapter;

/** Build a LogRecord — only the fields the Postgres adapter reads. */
function rec(
  level: string,
  message: string,
  attrs: Record<string, unknown>,
  timestamp: Date = new Date(),
): LogRecord {
  return {
    level,
    message,
    template: message,
    secureMessage: false,
    attrs,
    timestamp,
  };
}

/** Insert the given records and wait for them to be flushed to the DB. */
async function seed(...records: LogRecord[]): Promise<void> {
  for (const r of records) adapter.write(r);
  await adapter.flush();
}

/** Run a query-string filter through the real DB; return matching messages. */
async function search(query: string): Promise<string[]> {
  const parsed = parseLogQueryExpr(query);
  if (!parsed.ok) throw parsed.err;
  const res = await adapter.query({ attributeFilter: parsed.val ?? undefined });
  if (!res.ok) throw res.err;
  return res.val.map((row: LogRow) => row.message).sort();
}

/** As `search`, but over an explicit (wide) date window rather than the default 24h. */
async function searchWindow(
  query: string,
  start: string,
  end: string,
): Promise<string[]> {
  const parsed = parseLogQueryExpr(query);
  if (!parsed.ok) throw parsed.err;
  const res = await adapter.query({
    attributeFilter: parsed.val ?? undefined,
    start,
    end,
  });
  if (!res.ok) throw res.err;
  return res.val.map((row: LogRow) => row.message).sort();
}

const WIDE_START = "1970-01-01T00:00:00.000Z";
const WIDE_END = "2100-01-01T00:00:00.000Z";

beforeAll(async () => {
  db = new Kysely<any>({
    dialect: new PostgresDialect({
      pool: createLoggerPool({ connectionString: DATABASE_URL }),
    }),
  });
  try {
    await sql`select 1`.execute(db);
  } catch (cause) {
    throw new Error(
      `Cannot reach Postgres at ${DATABASE_URL}. Run \`pnpm db:up\` first, ` +
        `or set DATABASE_URL to a reachable instance.`,
      { cause },
    );
  }
  adapter = new PostgresAdapter({ db });
  await adapter.migrate();
});

afterAll(async () => {
  await adapter?.close();
  await db?.destroy();
});

beforeEach(async () => {
  await sql`truncate logs, log_attr, log_attr_blob, log_purge_job, log_purge_ids restart identity cascade`.execute(db);
});

describe("PostgresAdapter e2e — schema", () => {
  it("reports every migration as applied", async () => {
    const status = await adapter.migrationStatus();
    expect(status.every((s) => s.applied)).toBe(true);
  });
});

describe("PostgresAdapter e2e — write + query round-trip", () => {
  beforeEach(async () => {
    await seed(
      rec("info", "user login", { userId: "42", env: "prod", service: "auth", count: 5 }),
      rec("error", "db connection failed", { userId: "99", env: "staging", service: "db", count: 15 }),
      rec("info", "cache miss", { env: "prod", service: "cache", count: 3 }),
    );
  });

  it("round-trips attributes with their types", async () => {
    const res = await adapter.query({ message: "user login" });
    expect(res.ok).toBe(true);
    const row = res.ok ? res.val[0] : null;
    expect(row?.meta.userId).toBe("42");
    expect(row?.meta.count).toBe(5); // number, not "5"
    expect(row?.level).toBe("INFO");
  });

  it("matches a single attribute (LIKE contains)", async () => {
    expect(await search("env:'prod'")).toEqual(["cache miss", "user login"]);
  });

  it("matches an OR of two attributes (union of both branches)", async () => {
    expect(await search("env:'prod' || env:'staging'")).toEqual([
      "cache miss",
      "db connection failed",
      "user login",
    ]);
  });

  it("does not union across separate OR branches spuriously", async () => {
    expect(await search("service:'auth' || service:'db'")).toEqual([
      "db connection failed",
      "user login",
    ]);
  });

  it("OR binds tighter than whitespace-AND: (a||b) AND c", async () => {
    // (service:db OR service:auth) AND env:prod → only the prod row (auth).
    expect(await search("service:'db' || service:'auth' env:'prod'")).toEqual([
      "user login",
    ]);
  });

  it("grouping overrides precedence: a OR (b AND c)", async () => {
    // service:db OR (service:auth AND env:prod) → the db row and the auth row.
    expect(await search("service:'db' || (service:'auth' env:'prod')")).toEqual([
      "db connection failed",
      "user login",
    ]);
  });

  it("negation compiles to NOT EXISTS and excludes matches", async () => {
    expect(await search("env:!'prod'")).toEqual(["db connection failed"]);
  });

  it("exact match distinguishes from contains", async () => {
    expect(await search("count:='5'")).toEqual(["user login"]);
  });

  it("numeric comparison uses the regex-guarded ::numeric cast", async () => {
    expect(await search("count:>'10'")).toEqual(["db connection failed"]);
  });

  it("bare text matches the message column", async () => {
    expect(await search("login")).toEqual(["user login"]);
  });

  it("a contradictory filter returns zero rows", async () => {
    expect(await search("count:>'10' count:<'3'")).toEqual([]);
  });

  it("filters on the built-in level field (case-insensitive) via the query bar", async () => {
    // `$level:` is the real column, not a stored attribute — must match logs.level.
    expect(await search("$level:'error'")).toEqual(["db connection failed"]);
    expect(await search("$level:='info'")).toEqual(["cache miss", "user login"]);
  });
});

describe("PostgresAdapter e2e — built-in timestamp field", () => {
  beforeEach(async () => {
    // Write through the normal path with explicit instants (as node-pg Dates),
    // so the query param and stored value serialize identically — the boundary
    // stays exact even though the column is `timestamp without time zone`.
    await seed(
      rec("info", "ancient", {}, new Date("2003-01-01T09:00:00Z")),
      rec("info", "midday", {}, new Date("2003-06-15T12:00:00Z")),
      rec("info", "recent", {}, new Date("2020-01-01T00:00:00Z")),
    );
  });

  it("`$timestamp:>` filters chronologically on logs.logged_timestamp", async () => {
    expect(await searchWindow("$timestamp:>'2010-01-01'", WIDE_START, WIDE_END)).toEqual(["recent"]);
  });

  it("`$timestamp:<` filters chronologically on logs.logged_timestamp", async () => {
    expect(await searchWindow("$timestamp:<'2010-01-01'", WIDE_START, WIDE_END)).toEqual([
      "ancient",
      "midday",
    ]);
  });

  it("a bare `$timestamp:` date matches the whole calendar day", async () => {
    expect(await searchWindow("$timestamp:'2003-06-15'", WIDE_START, WIDE_END)).toEqual(["midday"]);
    expect(await searchWindow("$timestamp:'2003-06-16'", WIDE_START, WIDE_END)).toEqual([]);
  });

  it("compares against a full ISO/RFC datetime, not just a date", async () => {
    // 2003-06-15T12:00Z is the 'midday' row; strictly-after excludes it.
    expect(await searchWindow("$timestamp:>'2003-06-15T12:00:00Z'", WIDE_START, WIDE_END)).toEqual([
      "recent",
    ]);
    expect(await searchWindow("$timestamp:>='2003-06-15T12:00:00Z'", WIDE_START, WIDE_END)).toEqual([
      "midday",
      "recent",
    ]);
  });

  it("rejects an unparseable timestamp value as a syntax error (never reaches the DB)", () => {
    const parsed = parseLogQueryExpr("$timestamp:>'not-a-date'");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.err.cause?.message).toMatch(/timestamp value/);
  });
});

describe("PostgresAdapter e2e — date/time attribute values", () => {
  beforeEach(async () => {
    await seed(
      rec("info", "deploy jan", { deployedAt: "2003-01-01T00:00:00Z" }),
      rec("info", "deploy jun", { deployedAt: "2003-06-01T00:00:00Z" }),
      rec("info", "deploy dec", { deployedAt: "2003-12-01T00:00:00Z" }),
    );
  });

  it("compares ISO date attribute values chronologically, not lexically", async () => {
    expect(await search("deployedAt:>'2003-03-01'")).toEqual(["deploy dec", "deploy jun"]);
    expect(await search("deployedAt:<'2003-03-01'")).toEqual(["deploy jan"]);
  });
});

describe("PostgresAdapter e2e — async purge", () => {
  /** Poll a purge job until it leaves running/awaiting states (with a deadline). */
  async function awaitPurge(id: string) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const status = await adapter.purgeStatus(id);
      if (!status.ok) throw status.err;
      if (status.val.status !== "running") return status.val;
      if (Date.now() > deadline) throw new Error("purge did not settle in time");
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Seed `n` old (pre-cutoff) logs with one attr each, plus one fresh keeper. */
  async function seedOldRows(n: number): Promise<Date> {
    const old = Array.from({ length: n }, (_, i) => rec("info", `old-${i}`, { i: String(i) }));
    await seed(...old, rec("info", "keep me", { a: "1" }));
    await sql`update logs set logged_timestamp = now() - interval '10 days' where message like 'old-%'`.execute(db);
    await sql`update log_attr set logged_timestamp = now() - interval '10 days'
              where log_id in (select log_id from logs where message like 'old-%')`.execute(db);
    return new Date(Date.now() - 24 * 60 * 60 * 1000);
  }

  it("returns counts immediately and deletes in the background", async () => {
    const cutoff = await seedOldRows(3);

    const res = await adapter.purge(cutoff);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.val.logCount).toBe(3);
    expect(res.val.attrCount).toBe(3);
    expect(res.val.totalCount).toBe(6);
    expect(res.val.requiresConfirmation).toBe(false);

    const done = await awaitPurge(res.val.id);
    expect(done.status).toBe("completed");
    expect(done.deletedLogs).toBe(3);
    expect(done.deletedAttrs).toBe(3);

    const remaining = await adapter.query({});
    expect(remaining.ok && remaining.val.map((r) => r.message)).toEqual(["keep me"]);
  });

  it("requires confirmation above the threshold and deletes nothing until confirmed", async () => {
    const cutoff = await seedOldRows(4); // 4 logs + 4 attrs = 8 impacted

    const res = await adapter.purge(cutoff, { confirmationThreshold: 5 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.val.status).toBe("awaiting-confirmation");

    // Nothing deleted while awaiting.
    await new Promise((r) => setTimeout(r, 100));
    const before = await adapter.query({ start: "1970-01-01T00:00:00.000Z", end: "2100-01-01T00:00:00.000Z" });
    expect(before.ok && before.val).toHaveLength(5);

    const confirmed = await adapter.confirmPurge(res.val.id);
    expect(confirmed.ok).toBe(true);
    const done = await awaitPurge(res.val.id);
    expect(done.status).toBe("completed");
    expect(done.deletedLogs).toBe(4);

    const after = await adapter.query({});
    expect(after.ok && after.val.map((r) => r.message)).toEqual(["keep me"]);
  });

  it("deletes across multiple batches and reports progress totals", async () => {
    const cutoff = await seedOldRows(7);

    const res = await adapter.purge(cutoff, { batchSize: 3 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const done = await awaitPurge(res.val.id);
    expect(done.status).toBe("completed");
    expect(done.deletedLogs).toBe(7);
    expect(done.deletedAttrs).toBe(7);
  });

  it("a purge matching nothing completes immediately", async () => {
    await seed(rec("info", "fresh", { a: "1" }));
    const res = await adapter.purge(new Date("1990-01-01"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.val.status).toBe("completed");
    expect(res.val.totalCount).toBe(0);
  });

  it("purgeStatus on an unknown id errors", async () => {
    const res = await adapter.purgeStatus("does-not-exist");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.err.message).toBe("unknown purge id");
  });
});

describe("PostgresAdapter e2e — purge persistence across instances", () => {
  /** A second adapter over the same DB — simulates another process/instance. */
  function otherInstance(): PostgresAdapter {
    return new PostgresAdapter({ db, purgeSweepIntervalMs: 0 });
  }

  async function awaitPurgeOn(inst: PostgresAdapter, id: string) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const status = await inst.purgeStatus(id);
      if (!status.ok) throw status.err;
      if (status.val.status !== "running") return status.val;
      if (Date.now() > deadline) throw new Error("purge did not settle in time");
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function seedOld(n: number): Promise<Date> {
    const old = Array.from({ length: n }, (_, i) => rec("info", `old-${i}`, { i: String(i) }));
    await seed(...old, rec("info", "keep me", { a: "1" }));
    await sql`update logs set logged_timestamp = now() - interval '10 days' where message like 'old-%'`.execute(db);
    await sql`update log_attr set logged_timestamp = now() - interval '10 days'
              where log_id in (select log_id from logs where message like 'old-%')`.execute(db);
    return new Date(Date.now() - 24 * 60 * 60 * 1000);
  }

  it("a job parked by one instance can be confirmed and processed by another", async () => {
    const cutoff = await seedOld(4);
    const planned = await adapter.purge(cutoff, { confirmationThreshold: 2 });
    expect(planned.ok && planned.val.status).toBe("awaiting-confirmation");
    if (!planned.ok) return;

    const b = otherInstance();
    try {
      // B has no memory of the job — it must find and start it via the DB row.
      const confirmed = await b.confirmPurge(planned.val.id);
      expect(confirmed.ok).toBe(true);
      const done = await awaitPurgeOn(b, planned.val.id);
      expect(done.status).toBe("completed");
      expect(done.deletedLogs).toBe(4);
    } finally {
      await b.close();
    }

    const remaining = await adapter.query({});
    expect(remaining.ok && remaining.val.map((r) => r.message)).toEqual(["keep me"]);
    // The drained id set is gone; the job row REMAINS as the completed record
    // — so even the planning instance (which never processed it) sees the
    // outcome from the row.
    const ids = await sql`select count(*) as n from log_purge_ids`.execute(db);
    expect(Number((ids.rows[0] as { n: string }).n)).toBe(0);
    const fromPlanner = await adapter.purgeStatus(planned.val.id);
    expect(fromPlanner.ok && fromPlanner.val.status).toBe("completed");
    expect(fromPlanner.ok && fromPlanner.val.finishedAt).toBeTruthy();
  });

  it("a third instance that never saw the job reports it completed from the row", async () => {
    const cutoff = await seedOld(2);
    const planned = await adapter.purge(cutoff);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    await awaitPurgeOn(adapter, planned.val.id);

    const c = otherInstance();
    try {
      const seen = await c.purgeStatus(planned.val.id);
      expect(seen.ok && seen.val.status).toBe("completed");
      expect(seen.ok && seen.val.deletedLogs).toBe(2);
    } finally {
      await c.close();
    }
  });

  it("the sweep prunes terminal rows past the retention window", async () => {
    await sql`insert into log_purge_job
        (purge_id, until_ts, status, log_count, attr_count, batch_size,
         requires_confirmation, ids_captured, created_at, finished_at)
      values ('ancient-done', now(), 'completed', 1, 0, 100, false, true,
              now() - interval '3 days', now() - interval '3 days'),
             ('fresh-done', now(), 'completed', 1, 0, 100, false, true,
              now(), now())`.execute(db);

    const b = otherInstance(); // default retention 24h
    try {
      await b.sweepPurgeJobs();
    } finally {
      await b.close();
    }

    const rows = await sql<{ purge_id: string }>`select purge_id from log_purge_job order by purge_id`.execute(db);
    expect(rows.rows.map((r) => r.purge_id)).toEqual(["fresh-done"]);
  });

  it("sweepPurgeJobs resumes an orphaned running job (dead instance, expired lock)", async () => {
    const cutoff = await seedOld(5);

    // Manufacture the aftermath of a crashed instance: a running job row with
    // an expired lock and a captured (partially drained) id set.
    await sql`insert into log_purge_job
        (purge_id, until_ts, status, log_count, attr_count, deleted_logs, deleted_attrs,
         batch_size, requires_confirmation, ids_captured, created_at, started_at,
         locked_by, lock_expires_at)
      values ('orphan-1', ${cutoff}, 'running', 5, 5, 0, 0, 2, false, true,
              now(), now(), 'dead-instance', now() - interval '5 minutes')`.execute(db);
    await sql`insert into log_purge_ids (purge_id, log_id)
      select 'orphan-1', log_id from logs where logged_timestamp <= ${cutoff}`.execute(db);

    const b = otherInstance();
    try {
      const resumed = await b.sweepPurgeJobs();
      expect(resumed).toBe(1);
      const done = await awaitPurgeOn(b, "orphan-1");
      expect(done.status).toBe("completed");
    } finally {
      await b.close();
    }

    const remaining = await adapter.query({});
    expect(remaining.ok && remaining.val.map((r) => r.message)).toEqual(["keep me"]);
    const ids = await sql`select count(*) as n from log_purge_ids`.execute(db);
    expect(Number((ids.rows[0] as { n: string }).n)).toBe(0);
  });

  it("sweepPurgeJobs skips a job whose lock is still fresh", async () => {
    const cutoff = await seedOld(2);
    await sql`insert into log_purge_job
        (purge_id, until_ts, status, log_count, attr_count, batch_size,
         requires_confirmation, ids_captured, created_at, locked_by, lock_expires_at)
      values ('busy-1', ${cutoff}, 'running', 2, 2, 2, false, true, now(),
              'other-live-instance', now() + interval '60 seconds')`.execute(db);
    await sql`insert into log_purge_ids (purge_id, log_id)
      select 'busy-1', log_id from logs where logged_timestamp <= ${cutoff}`.execute(db);

    const b = otherInstance();
    try {
      expect(await b.sweepPurgeJobs()).toBe(0);
    } finally {
      await b.close();
    }
    // Untouched — the live owner keeps it.
    const ids = await sql`select count(*) as n from log_purge_ids`.execute(db);
    expect(Number((ids.rows[0] as { n: string }).n)).toBe(2);
  });

  it("purgeStatus works cross-instance while a job exists", async () => {
    const cutoff = await seedOld(3);
    const planned = await adapter.purge(cutoff, { confirmationThreshold: 2 });
    expect(planned.ok && planned.val.status).toBe("awaiting-confirmation");
    if (!planned.ok) return;

    const b = otherInstance();
    try {
      const seen = await b.purgeStatus(planned.val.id);
      expect(seen.ok).toBe(true);
      if (seen.ok) {
        expect(seen.val.status).toBe("awaiting-confirmation");
        expect(seen.val.logCount).toBe(3);
      }
    } finally {
      await b.close();
    }
    // Clean up: confirm + drain so the truncate-based teardown stays quiet.
    await adapter.confirmPurge(planned.val.id);
    await awaitPurgeOn(adapter, planned.val.id);
  });
});

// ---------------------------------------------------------------------------
// Nested attribute paths + null literals — live semantics. The SQL-capture
// unit tests prove the shape compiles; these prove jsonpath/#>> actually
// match the right rows.
// ---------------------------------------------------------------------------

describe("PostgresAdapter e2e — nested attribute paths", () => {
  beforeEach(async () => {
    await seed(
      rec("info", "checkout", {
        session: { id: "123", region: "us" },
        users: ["123", "456"],
        cart: { items: [{ sku: "A-1", qty: 2 }, { sku: "B-2", qty: 10 }], total: 149.5 },
      }),
      rec("info", "browse", {
        session: { id: "789" },
        users: ["789"],
        scores: [10, 25, 40],
      }),
      rec("info", "flat-name", { "session.id": "123" }),
      rec("info", "plain", { session: "not-json" }),
    );
  });

  it("matches an object field via a dot path", async () => {
    expect(await search("session.id:='123'")).toEqual(["checkout"]);
    expect(await search("session.id:='789'")).toEqual(["browse"]);
  });

  it("dot path does not match a flat attribute of the same dotted name", async () => {
    // "flat-name" stores a literal `session.id` attr — only the quoted form finds it.
    expect(await search("session.id:='123'")).toEqual(["checkout"]);
    expect(await search("'session.id':='123'")).toEqual(["flat-name"]);
  });

  it("matches any array element via [*], exactly", async () => {
    expect(await search("users[*]:='123'")).toEqual(["checkout"]);
    // exact element match — "456" is an element, "45" is not
    expect(await search("users[*]:='45'")).toEqual([]);
  });

  it("matches a specific index via [N]", async () => {
    expect(await search("users[0]:='123'")).toEqual(["checkout"]);
    expect(await search("users[0]:='456'")).toEqual([]);
    expect(await search("users[1]:='456'")).toEqual(["checkout"]);
  });

  it("walks objects inside arrays", async () => {
    expect(await search("cart.items[*].sku:='A-1'")).toEqual(["checkout"]);
    expect(await search("cart.items[*].sku:='C-3'")).toEqual([]);
  });

  it("matches JSON numbers from string query values", async () => {
    expect(await search("cart.items[*].qty:='2'")).toEqual(["checkout"]);
    expect(await search("cart.total:='149.5'")).toEqual(["checkout"]);
  });

  it("compares numerically through wildcard paths", async () => {
    expect(await search("scores[*]:>'30'")).toEqual(["browse"]);
    expect(await search("scores[*]:>'50'")).toEqual([]);
    expect(await search("cart.items[*].qty:>='10'")).toEqual(["checkout"]);
  });

  it("contains matches substrings of string elements", async () => {
    expect(await search("cart.items[*].sku:'A-'")).toEqual(["checkout"]);
    expect(await search("users[*]:'12'")).toEqual(["checkout"]);
  });

  it("negation excludes matching logs (and non-JSON rows match the negation)", async () => {
    expect(await search("users[*]:!='123'")).toEqual([
      "browse",
      "flat-name",
      "plain",
    ]);
  });

  it("a non-object attribute value never matches a path", async () => {
    // "plain" has session = "not-json" (stored as string type)
    expect(await search("session.id:='not-json'")).toEqual([]);
  });
});

describe("PostgresAdapter e2e — null literals", () => {
  beforeEach(async () => {
    await seed(
      rec("info", "null-attr", { reason: null }),
      rec("info", "null-string", { reason: "null" }),
      rec("info", "json-null", { session: { id: null } }),
      rec("info", "json-present", { session: { id: "123" } }),
      rec("info", "no-reason", { other: "x" }),
    );
  });

  it("reason:=null matches the null attribute, not the string", async () => {
    expect(await search("reason:=null")).toEqual(["null-attr"]);
  });

  it("reason:='null' matches the string, not the null attribute", async () => {
    expect(await search("reason:='null'")).toEqual(["null-string"]);
  });

  it("negated null literal excludes only the null attribute", async () => {
    expect(await search("reason:!=null")).toEqual([
      "json-null",
      "json-present",
      "no-reason",
      "null-string",
    ]);
  });

  it("a path null matches JSON null but not a missing key or a value", async () => {
    expect(await search("session.id:=null")).toEqual(["json-null"]);
  });
});

describe("PostgresAdapter e2e — path filters skip encrypted and oversized attrs", () => {
  it("never matches a path into an encrypted json attribute", async () => {
    const enc = new PostgresAdapter({
      db,
      encrypt: (plaintext) => Buffer.from(plaintext, "utf-8"), // identity "cipher" for the test
      decrypt: (ciphertext) => Buffer.from(ciphertext, "base64url").toString("utf-8"),
    });
    enc.write({
      ...rec("info", "secret-session", {}),
      attrs: { session: { _secure: true, value: { id: "123" } } },
    } as LogRecord);
    await enc.flush();
    await enc.close();

    expect(await search("session.id:='123'")).toEqual([]);
  });

  it("never matches a path into an oversized (blob-routed) json attribute", async () => {
    const big = { id: "123", pad: "x".repeat(3000) };
    await seed(rec("info", "oversized", { session: big }));
    expect(await search("session.id:='123'")).toEqual([]);
  });
});

describe("PostgresAdapter e2e — query builder", () => {
  it("executes a composed builder query against the live adapter", async () => {
    const { where } = await import("../../logger/query-builder");
    await seed(
      rec("info", "hit", { session: { id: "123" }, users: ["123"] }),
      rec("error", "level-hit", { other: "x" }),
      rec("info", "miss", { session: { id: "999" }, users: ["999"] }),
    );

    const res = await where("session.id")
      .eq("123")
      .and(where("users[*]").eq("123"))
      .or(where("$level").eq("error"))
      .execute(adapter, { limit: 10 });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.val.map((r) => r.message).sort()).toEqual(["hit", "level-hit"]);
    }
  });
});

describe("PostgresAdapter e2e — typed values never fall back to lexical ordering", () => {
  beforeEach(async () => {
    await seed(
      rec("info", "number-attr", { userId: 123 }),
      rec("info", "string-attr", { userId: "Zed" }),
      rec("info", "date-attr", { userId: new Date("2003-01-02T00:00:00Z") }),
      rec("info", "nested", { session: { id: "abc", count: 42 } }),
    );
  });

  it("a non-numeric comparison value never matches number- or date-typed attrs", async () => {
    // '123' < 'A' and '2003-…' < 'A' lexicographically — the old behavior
    // matched both. Only the string attr may participate.
    expect(await search("userId:<'A'")).toEqual([]);
    expect(await search("userId:>'A'")).toEqual(["string-attr"]);
  });

  it("string ordering still works on string attrs", async () => {
    expect(await search("userId:>'M'")).toEqual(["string-attr"]);
    expect(await search("userId:<'M'")).toEqual([]);
  });

  it("typed comparisons still work on typed attrs", async () => {
    expect(await search("userId:>'100'")).toEqual(["number-attr"]);
    expect(await search("userId:>'2003-01-01'")).toEqual(["date-attr"]);
  });

  it("a concrete-path comparison only orders JSON strings", async () => {
    // session.count = 42 (JSON number): '42' < 'a' lexicographically, but it
    // must not participate. session.id = "abc" > "a" does.
    expect(await search("session.id:>'a'")).toEqual(["nested"]);
    expect(await search("session.count:<'a'")).toEqual([]);
    expect(await search("session.count:>'40'")).toEqual(["nested"]); // numeric still fine
  });
});

describe("PostgresAdapter e2e — ::string cast coerces typed values to text", () => {
  beforeEach(async () => {
    await seed(
      rec("info", "number-attr", { v: 123 }),
      rec("info", "string-attr", { v: "Zed" }),
      rec("info", "date-attr", { v: new Date("2003-01-02T00:00:00Z") }),
      rec("info", "nested", { obj: { n: 42, s: "abc" }, arr: [9, "banana"] }),
    );
  });

  it("orders numbers and dates by their STRING form when cast", async () => {
    // '123' < 'A' < 'Zed' lexically; '2003-…' < 'A' too.
    expect(await search("v:<'A'::string")).toEqual(["date-attr", "number-attr"]);
    expect(await search("v:>'A'::string")).toEqual(["string-attr"]);
  });

  it("uncast comparison still excludes typed values", async () => {
    expect(await search("v:<'A'")).toEqual([]);
  });

  it("coerces JSON numbers at concrete paths", async () => {
    // '42' < 'a' lexically — included only under the cast.
    expect(await search("obj.n:<'a'::string")).toEqual(["nested"]);
    expect(await search("obj.n:<'a'")).toEqual([]);
  });

  it("coerces array elements of any type under a wildcard cast", async () => {
    // '9' > '5' lexically (and 'banana' > '5' too).
    expect(await search("arr[*]:>'5'::string")).toEqual(["nested"]);
    // without the cast, 9 > 5 numerically also matches — but via the number branch
    expect(await search("arr[*]:>'5'")).toEqual(["nested"]);
    // lexical: 'banana' < 'z'; numeric 9 excluded from string compare
    expect(await search("arr[*]:<'z'::string")).toEqual(["nested"]);
  });
});
