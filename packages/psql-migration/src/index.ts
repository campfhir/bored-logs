/**
 * Kysely migrations for the PostgreSQL log adapter.
 *
 * Exposes every migration as an ordered {@link MIGRATIONS} map plus a
 * {@link migrationProvider} you can hand to Kysely's `Migrator` for tracked,
 * versioned migrations (with a `kysely_migration` table). For a zero-config,
 * no-tracking-table setup, the idempotent {@link up} / {@link down} helpers run
 * the migrations directly and accept a `only` filter to run a subset.
 *
 * To place the tables in their own schema or under a prefix (so they never
 * collide with an existing database), pass {@link LogSchemaOptions} — to
 * `up()` / `down()` directly, or via {@link createMigrations} /
 * {@link createMigrationProvider} for the `Migrator` path. The same options
 * go to `PostgresAdapter` so it reads and writes the same tables.
 *
 * @module
 */
import type { Kysely, Migration, MigrationProvider } from "kysely";
import { up as up001, down as down001 } from "./001_logs";
import { up as up002, down as down002 } from "./002_attr_val_name_index";
import { up as up003, down as down003 } from "./003_purge_jobs";
import { up as up004, down as down004 } from "./004_e2e_clients";
import { resolveLogSchema, withLogSchema, type LogSchemaOptions, type ResolvedLogSchema } from "./schema";

export {
  LOG_TABLE_KEYS,
  LogSchemaPlugin,
  resolveLogSchema,
  withLogSchema,
} from "./schema";
export type { LogSchemaOptions, LogTableKey, ResolvedLogSchema } from "./schema";

/** A migration step: receives the (plugin-wrapped) `db` and the resolved names. */
type NamedMigration = {
  up(db: Kysely<any>, names: ResolvedLogSchema): Promise<void>;
  down(db: Kysely<any>, names: ResolvedLogSchema): Promise<void>;
};

const STEPS: Record<string, NamedMigration> = {
  "001_logs": { up: up001, down: down001 },
  "002_attr_val_name_index": { up: up002, down: down002 },
  "003_purge_jobs": { up: up003, down: down003 },
  "004_e2e_clients": { up: up004, down: down004 },
};

/** Migration names in canonical (apply) order. Reverse it for rollback order. */
export const migrationNames: string[] = Object.keys(STEPS);

/**
 * Build the migration map for a given table layout. Each entry is a standard
 * Kysely {@link Migration}: it wraps the `db` it receives with the layout's
 * {@link LogSchemaPlugin} and runs the step against the resolved names.
 * With no options this is the default layout — the same as {@link MIGRATIONS}.
 */
export function createMigrations(options?: LogSchemaOptions): Record<string, Required<Migration>> {
  const names = resolveLogSchema(options);
  const out: Record<string, Required<Migration>> = {};
  for (const name of migrationNames) {
    const step = STEPS[name];
    out[name] = {
      up: (db) => step.up(withLogSchema(db, names), names),
      down: (db) => step.down(withLogSchema(db, names), names),
    };
  }
  return out;
}

/**
 * A Kysely {@link MigrationProvider} for a given table layout. Pass it to a
 * `Migrator` to run these migrations with Kysely's standard tracking table,
 * enabling `migrateToLatest`, `migrateUp`, `migrateDown`, and `migrateTo`.
 *
 * @example
 * import { Migrator } from "kysely";
 * import { createMigrationProvider } from "@campfhir/bored-logs-psql-migration";
 *
 * const provider = createMigrationProvider({ schema: "logging", tablePrefix: "bl_" });
 * const migrator = new Migrator({ db, provider });
 * const { error } = await migrator.migrateToLatest();
 */
export function createMigrationProvider(options?: LogSchemaOptions): MigrationProvider {
  const migrations = createMigrations(options);
  return { getMigrations: () => Promise.resolve({ ...migrations }) };
}

/**
 * Every log-adapter migration for the DEFAULT layout, keyed by name. The keys
 * sort ascending in the exact order the migrations must be applied — the same
 * order Kysely's `Migrator` derives from {@link migrationProvider}.
 */
export const MIGRATIONS: Record<string, Required<Migration>> = createMigrations();

/**
 * A Kysely {@link MigrationProvider} for the default layout — see
 * {@link createMigrationProvider} for a custom schema / prefix.
 *
 * @example
 * import { Migrator } from "kysely";
 * import { migrationProvider } from "@campfhir/bored-logs-psql-migration";
 *
 * const migrator = new Migrator({ db, provider: migrationProvider });
 * const { error } = await migrator.migrateToLatest();
 */
export const migrationProvider: MigrationProvider = {
  getMigrations: () => Promise.resolve({ ...MIGRATIONS }),
};

/** Options for the standalone {@link up} / {@link down} runners. */
export interface MigrationRunOptions extends LogSchemaOptions {
  /**
   * Restrict the run to these migration names. They are always applied in
   * canonical order (reversed for {@link down}), regardless of the order given
   * here. Unknown names throw. Defaults to every migration.
   */
  only?: string[];
}

/** Resolve run options to a fresh, canonically-ordered list of migration names. */
function resolveNames(options?: MigrationRunOptions): string[] {
  if (!options?.only) return [...migrationNames];
  const requested = new Set(options.only);
  const unknown = [...requested].filter((name) => !(name in STEPS));
  if (unknown.length > 0) {
    throw new Error(
      `[bored-logs] unknown migration(s): ${unknown.join(", ")}. ` +
        `known migrations: ${migrationNames.join(", ")}`,
    );
  }
  return migrationNames.filter((name) => requested.has(name));
}

/**
 * Run the log-adapter migrations against `db`, in canonical order. Every
 * migration uses `IF (NOT) EXISTS`, so this is idempotent and safe to call on
 * startup without a tracking table. Pass `{ only }` to run a subset, and
 * `schema` / `tablePrefix` / `tables` to target a custom layout.
 *
 * For tracked, versioned migrations, use {@link migrationProvider} (or
 * {@link createMigrationProvider}) with Kysely's `Migrator` instead.
 */
export async function up(db: Kysely<any>, options?: MigrationRunOptions): Promise<void> {
  const migrations = createMigrations(options);
  for (const name of resolveNames(options)) {
    await migrations[name].up(db);
  }
}

/**
 * Reverse the log-adapter migrations against `db`, in reverse canonical order.
 * Idempotent — safe to call even if the schema does not exist. Pass `{ only }`
 * to roll back a subset; the layout options must match those used for `up`.
 */
export async function down(db: Kysely<any>, options?: MigrationRunOptions): Promise<void> {
  const migrations = createMigrations(options);
  for (const name of resolveNames(options).reverse()) {
    await migrations[name].down(db);
  }
}
