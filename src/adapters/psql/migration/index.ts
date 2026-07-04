/**
 * Kysely migrations for the PostgreSQL log adapter.
 *
 * Exposes every migration as an ordered {@link MIGRATIONS} map plus a
 * {@link migrationProvider} you can hand to Kysely's `Migrator` for tracked,
 * versioned migrations (with a `kysely_migration` table). For a zero-config,
 * no-tracking-table setup, the idempotent {@link up} / {@link down} helpers run
 * the migrations directly and accept a `only` filter to run a subset.
 *
 * @module
 */
import type { Kysely, Migration, MigrationProvider } from "kysely";
import { up as up001, down as down001 } from "./001_logs";
import { up as up002, down as down002 } from "./002_attr_val_name_index";

/**
 * Every log-adapter migration, keyed by name. The keys sort ascending in the
 * exact order the migrations must be applied — the same order Kysely's
 * `Migrator` derives from {@link migrationProvider}.
 */
export const MIGRATIONS: Record<string, Required<Migration>> = {
  "001_logs": { up: up001, down: down001 },
  "002_attr_val_name_index": { up: up002, down: down002 },
};

/** Migration names in canonical (apply) order. Reverse it for rollback order. */
export const migrationNames: string[] = Object.keys(MIGRATIONS);

/**
 * A Kysely {@link MigrationProvider} backed by {@link MIGRATIONS}. Pass it to a
 * `Migrator` to run these migrations with Kysely's standard tracking table,
 * enabling `migrateToLatest`, `migrateUp`, `migrateDown`, and `migrateTo`.
 *
 * @example
 * import { Migrator } from "kysely";
 * import { migrationProvider } from "@campfhir/bored-logs/adapters/psql/migration";
 *
 * const migrator = new Migrator({ db, provider: migrationProvider });
 * const { error } = await migrator.migrateToLatest();
 */
export const migrationProvider: MigrationProvider = {
  getMigrations: () => Promise.resolve({ ...MIGRATIONS }),
};

/** Options for the standalone {@link up} / {@link down} runners. */
export interface MigrationRunOptions {
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
  const unknown = [...requested].filter((name) => !(name in MIGRATIONS));
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
 * startup without a tracking table. Pass `{ only }` to run a subset.
 *
 * For tracked, versioned migrations, use {@link migrationProvider} with
 * Kysely's `Migrator` instead.
 */
export async function up(db: Kysely<any>, options?: MigrationRunOptions): Promise<void> {
  for (const name of resolveNames(options)) {
    await MIGRATIONS[name].up(db);
  }
}

/**
 * Reverse the log-adapter migrations against `db`, in reverse canonical order.
 * Idempotent — safe to call even if the schema does not exist. Pass `{ only }`
 * to roll back a subset.
 */
export async function down(db: Kysely<any>, options?: MigrationRunOptions): Promise<void> {
  for (const name of resolveNames(options).reverse()) {
    await MIGRATIONS[name].down(db);
  }
}
