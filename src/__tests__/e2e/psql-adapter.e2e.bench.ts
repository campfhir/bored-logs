import { bench, describe, beforeAll, afterAll } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { PostgresAdapter, createLoggerPool } from "../../adapters/psql/adapter";
import { createLogger } from "../../logger/logger";
import type { LogRecord } from "../../logger/adapter";

// ---------------------------------------------------------------------------
// Live-DB throughput benchmark for the Postgres adapter. Run with:
//
//   pnpm db:up        # start the throwaway Postgres (compose.yaml)
//   pnpm bench:e2e    # run this file (vitest.e2e.config.ts, node env)
//   pnpm db:down      # tear it down
//
// This is the sink-bound counterpart to the core logger bench
// (logger.bench.ts): it measures how fast records land *durably* in Postgres,
// not just how fast log() enqueues them. Each iteration therefore awaits a real
// transaction — the adapter batches writes and flushes fire-and-forget, so
// without awaiting flush() we'd be timing the in-memory queue, not the DB.
//
// To keep every iteration a single deterministic transaction we write a block
// just under the adapter's internal BATCH_SIZE (50): at <50 queued records the
// adapter does not auto-flush in the background, so our awaited flush() writes
// exactly the block in one transaction with nothing racing it.
//
// tinybench reports `hz` in iterations/sec. Convert:
//   records/sec = hz × BLOCK_RECORDS
//   requests/sec (rps) = records/sec ÷ 2   (a request logs request + response)
//
// Note this awaits one transaction per block, so it measures a *durable floor*:
// how fast records provably reach disk when each batch is awaited serially.
// Real usage is fire-and-forget — the adapter self-drains successive batches
// and runs up to `maxConnections` of them concurrently — so live throughput
// runs higher than this number. This is the conservative, reproducible bound.
// ---------------------------------------------------------------------------

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/bored_logs_test";

// Kept below the adapter's BATCH_SIZE (50) so one flush() = one transaction and
// no background auto-flush races our awaited write. 40 records = 20 requests.
const BLOCK_RECORDS = 40;

let db: Kysely<any>;
let adapter: PostgresAdapter;
let logger: ReturnType<typeof createLogger>;

/** Build a LogRecord — only the fields the Postgres adapter reads. */
function rec(i: number): LogRecord {
  const method = i % 2 === 0 ? "GET" : "POST";
  const message = `${method} /api/resource/${i} -> 200 (12ms)`;
  return {
    level: i % 2 === 0 ? "request" : "response",
    message,
    template: message,
    secureMessage: false,
    attrs: { method, path: `/api/resource/${i}`, status: 200, ms: 12, ip: "203.0.113.7" },
    timestamp: new Date(),
  };
}

// Pre-build one block of records so the measured work is the write path, not
// record construction (the through-logger bench below does interpolate live).
const block: LogRecord[] = Array.from({ length: BLOCK_RECORDS }, (_, i) => rec(i));

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
  // Write everything: request/response (rank 5) sit below the adapter's default
  // "info" (rank 3), so without this they'd be gated out and we'd benchmark the
  // level filter instead of real DB writes.
  adapter = new PostgresAdapter({ db, level: "debug" });
  await adapter.migrate();
  await sql`truncate logs, log_attr, log_attr_blob restart identity cascade`.execute(db);

  logger = createLogger({ application: "bench", version: "0.0.0" });
  logger.addAdapter(adapter);
});

afterAll(async () => {
  await adapter?.close();
  await db?.destroy();
});

describe("PostgresAdapter durable-write throughput", () => {
  bench(
    `adapter.write × ${BLOCK_RECORDS} + flush, 1 txn (records/sec = hz × ${BLOCK_RECORDS})`,
    async () => {
      for (const r of block) adapter.write(r);
      await adapter.flush();
    },
    { time: 2000 },
  );

  let i = 0;
  bench(
    `logger request+response × ${BLOCK_RECORDS / 2} + flush, 1 txn (rps = hz × ${BLOCK_RECORDS / 2})`,
    async () => {
      for (let n = 0; n < BLOCK_RECORDS / 2; n++, i++) {
        const method = i % 2 === 0 ? "GET" : "POST";
        const path = `/api/resource/${i}`;
        logger.request("{method} {path}", { method, path, ip: "203.0.113.7" });
        logger.response("{method} {path} -> {status} ({ms}ms)", {
          method,
          path,
          status: 200,
          ms: 12,
        });
      }
      await adapter.flush();
    },
    { time: 2000 },
  );
});
