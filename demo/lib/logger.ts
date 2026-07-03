import { Kysely, PostgresDialect } from "kysely";
import { createLogger } from "@campfhir/bored-logs";
import { PostgresAdapter, createLoggerPool } from "@campfhir/bored-logs/adapters/psql";

// ---------------------------------------------------------------------------
// A single process-wide logger + Postgres adapter, cached on globalThis so
// Next.js hot-reload (dev) doesn't open a new pool on every module refresh.
// The schema is migrated exactly once, guarded by the `ready` promise.
// ---------------------------------------------------------------------------

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/bored_logs_demo";

type BoredLogs = {
  db: Kysely<Record<string, never>>;
  adapter: PostgresAdapter;
  logger: ReturnType<typeof createLogger>;
  ready: Promise<unknown>;
};

const globalForLogs = globalThis as unknown as { __boredLogsDemo?: BoredLogs };

function init(): BoredLogs {
  const db = new Kysely<Record<string, never>>({
    dialect: new PostgresDialect({
      pool: createLoggerPool({ connectionString: DATABASE_URL }),
    }),
  });

  // level "debug" so every simulated entry, down to debug, is persisted.
  const adapter = new PostgresAdapter({ db, level: "debug" });
  const logger = createLogger({ level: "debug", application: "bored-logs-demo" });
  logger.addAdapter(adapter);

  return { db, adapter, logger, ready: adapter.migrate() };
}

export function boredLogs(): BoredLogs {
  if (!globalForLogs.__boredLogsDemo) {
    globalForLogs.__boredLogsDemo = init();
  }
  return globalForLogs.__boredLogsDemo;
}

/**
 * Await the one-time migration, returning the ready logger + adapter. If it
 * failed (e.g. the DB wasn't up on the first request), drop the cached instance
 * so the next call reconnects and retries instead of caching the failure.
 */
export async function ensureBoredLogs(): Promise<BoredLogs> {
  const bl = boredLogs();
  try {
    await bl.ready;
    return bl;
  } catch (err) {
    globalForLogs.__boredLogsDemo = undefined;
    throw err;
  }
}
