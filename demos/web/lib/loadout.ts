import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PostgresAdapter, ResolvedLogSchema, MigrationStatus } from "@campfhir/bored-logs-psql";
import { describeDatabase } from "./logger";

// ---------------------------------------------------------------------------
// The demo's "loadout": which @campfhir/bored-logs-* packages this app is
// built from, what each one does here, and how the Postgres adapter is laid
// out. Rendered by app/_components/loadout-panel.tsx via the `loadout` action.
// ---------------------------------------------------------------------------

export type LoadoutPackage = {
  name: string;
  version: string;
  /** What the package contributes to this demo. */
  role: string;
  /** Where in the demo it is imported. */
  usedIn: string;
};

export type Loadout = {
  packages: LoadoutPackage[];
  database: string;
  layout: Pick<ResolvedLogSchema, "schema" | "prefix" | "tables">;
  migrations: MigrationStatus[];
};

const PACKAGES: Array<Omit<LoadoutPackage, "version">> = [
  {
    name: "@campfhir/bored-logs",
    role: "createLogger, ConsoleAdapter, the search grammar (FilterExpr, LOG_LEVELS)",
    usedIn: "lib/logger.ts, lib/split-levels.ts, app/actions.ts",
  },
  {
    name: "@campfhir/bored-logs-psql",
    role: "PostgresAdapter (write · query · purge) + createLoggerPool",
    usedIn: "lib/logger.ts",
  },
  {
    name: "@campfhir/bored-logs-psql-migration",
    role: "up() runs the migrations into the configured schema at startup",
    usedIn: "lib/logger.ts",
  },
  {
    name: "@campfhir/bored-logs-server",
    role: "createLogIngestHandler — receives batches shipped from the browser",
    usedIn: "app/api/logs/route.ts",
  },
  {
    name: "@campfhir/bored-logs-client",
    role: "LoggerProvider, useLogger(), useLogShipper(), secure(), redact()",
    usedIn: "app/_components/logger-provider.tsx, app/_lib/shared.tsx",
  },
  {
    name: "@campfhir/bored-logs-ui",
    role: "LogTable, LogCard, LogSearchBar, LogLevelFilter, LogDateRangePicker, PurgeLogsDialog",
    usedIn: "app/_lib/shared.tsx, app/_variants/*",
  },
];

/**
 * The installed version of a package. The demo resolves the packages to their
 * source via tsconfig `paths`, but the `link:` dependencies still put each
 * package.json under node_modules — in dev and in the Docker image alike.
 */
function packageVersion(name: string): string {
  try {
    const file = join(process.cwd(), "node_modules", name, "package.json");
    return String(JSON.parse(readFileSync(file, "utf8")).version);
  } catch {
    return "workspace";
  }
}

export async function collectLoadout(adapter: PostgresAdapter): Promise<Loadout> {
  const names = adapter.schemaNames;
  return {
    packages: PACKAGES.map((p) => ({ ...p, version: packageVersion(p.name) })),
    database: describeDatabase(),
    layout: { schema: names.schema, prefix: names.prefix, tables: names.tables },
    migrations: await adapter.migrationStatus(),
  };
}
