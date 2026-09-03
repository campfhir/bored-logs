import { Kysely, PostgresDialect } from "kysely";
import { ConsoleAdapter, createLogger } from "@campfhir/bored-logs";
import {
  PostgresAdapter,
  createLoggerPool,
  type LoggerTables,
  type LogSchemaOptions,
} from "@campfhir/bored-logs-psql";
import { up } from "@campfhir/bored-logs-psql-migration";

// ---------------------------------------------------------------------------
// A single process-wide logger + Postgres adapter, cached on globalThis so
// Next.js hot-reload (dev) doesn't open a new pool on every module refresh.
// The tables are migrated exactly once, guarded by the `ready` promise.
//
// Packages in play here (the "loadout" — see the Loadout panel in the nav):
//   @campfhir/bored-logs                 createLogger + ConsoleAdapter
//   @campfhir/bored-logs-psql            PostgresAdapter + createLoggerPool
//   @campfhir/bored-logs-psql-migration  up() — the standalone migration runner
// ---------------------------------------------------------------------------

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/bored_logs_demo";

/**
 * Where the log tables live. The demo keeps them in their own schema under a
 * prefix (`logging.demo_logs`, `logging.demo_log_attr`, …) — the layout you'd
 * pick when adding bored-logs to a database that already has tables of its
 * own. Set `LOG_SCHEMA=""` / `LOG_TABLE_PREFIX=""` for the default layout
 * (`public.logs`, …). The SAME options go to the migrator and the adapter.
 */
export const LAYOUT: LogSchemaOptions = {
  schema: process.env.LOG_SCHEMA ?? "logging",
  tablePrefix: process.env.LOG_TABLE_PREFIX ?? "demo_",
};

type BoredLogs = {
  db: Kysely<LoggerTables>;
  adapter: PostgresAdapter;
  logger: ReturnType<typeof createLogger>;
  ready: Promise<unknown>;
};

const globalForLogs = globalThis as unknown as { __boredLogsDemo?: BoredLogs };

function init(): BoredLogs {
  // `LoggerTables` is keyed by the LOGICAL names (logs, log_attr, …); the
  // adapter rewrites them to the physical, prefixed names at query time.
  const db = new Kysely<LoggerTables>({
    dialect: new PostgresDialect({
      pool: createLoggerPool({ connectionString: DATABASE_URL }),
    }),
  });

  // level "debug" so every simulated entry, down to debug, is persisted.
  const adapter = new PostgresAdapter({ db, level: "debug", ...LAYOUT });
  const logger = createLogger({
    level: "debug",
    application: "bored-logs-demo",
  });
  logger.addAdapter(adapter);
  logger.addAdapter(new ConsoleAdapter());

  // Migrate through the migrator package rather than `adapter.migrate()` —
  // this is what a deploy script or a Kysely `Migrator` would call. Idempotent
  // (IF NOT EXISTS), so it is safe on every boot.
  return { db, adapter, logger, ready: up(db, LAYOUT) };
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
    // If the connection fails (e.g., during Next.js build when the DB isn't available yet),
    // clear the cache so the next call retries (don't cache the failure).
    globalForLogs.__boredLogsDemo = undefined;
    // During builds or when the DB is unavailable, silently use a no-op logger instead of crashing.
    if (process.env.NODE_ENV === "production" && process.env.DATABASE_UNAVAILABLE_NOOP === "true") {
      return { db: null as any, adapter: null as any, logger: bl.logger, ready: Promise.resolve() };
    }
    throw err;
  }
}

/** `DATABASE_URL` with credentials stripped, for display. */
export function describeDatabase(): string {
  try {
    const u = new URL(DATABASE_URL);
    return `${u.host}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}
