/**
 * Initial Kysely migration for the PostgreSQL log adapter.
 *
 * Provides {@link up} and {@link down}: `up` creates the `logs`, `log_attr`,
 * and `log_attr_blob` tables along with their timestamp, level, and attribute
 * indexes (and the target schema, when one is configured); `down` drops those
 * indexes and tables. Table names in the builder calls are LOGICAL — the
 * {@link LogSchemaPlugin} on `db` maps them to their physical names.
 *
 * @module
 */
import { Kysely } from "kysely";
import type { ResolvedLogSchema } from "./schema";

/**
 * Creates the three logging tables:
 *  - `logs`          — one row per log entry
 *  - `log_attr`      — scalar attributes (text / number / boolean / date / json)
 *  - `log_attr_blob` — binary / large attributes (bytea)
 *
 * Also creates indexes for efficient timestamp-range and level queries.
 */
export async function up(db: Kysely<any>, names: ResolvedLogSchema): Promise<void> {
  if (names.schema) {
    await db.schema.createSchema(names.schema).ifNotExists().execute();
  }

  await db.schema
    .createTable("logs")
    .ifNotExists()
    .addColumn("log_id", "bigserial", (cb) => cb.primaryKey().notNull())
    .addColumn("message", "text", (cb) => cb.notNull())
    .addColumn("logged_timestamp", "timestamp", (cb) => cb.notNull())
    .addColumn("level", "varchar(512)", (cb) => cb.notNull())
    .execute();

  await db.schema
    .createTable("log_attr")
    .ifNotExists()
    .addColumn("attr_id", "bigserial", (cb) => cb.notNull())
    .addColumn("log_id", "bigserial", (cb) =>
      cb.references("logs.log_id").notNull(),
    )
    .addColumn("val_name", "varchar(1024)", (cb) => cb.notNull())
    .addColumn("val", "text")
    .addColumn("val_type", "varchar(100)", (cb) => cb.notNull())
    .addColumn("encrypted", "boolean", (cb) => cb.notNull().defaultTo(false))
    .addColumn("logged_timestamp", "timestamp", (cb) => cb.notNull())
    .execute();

  await db.schema
    .createTable("log_attr_blob")
    .ifNotExists()
    .addColumn("attr_id", "bigserial", (cb) => cb.notNull())
    .addColumn("log_id", "bigserial", (cb) =>
      cb.references("logs.log_id").notNull(),
    )
    .addColumn("val_name", "varchar(1024)", (cb) => cb.notNull())
    .addColumn("val", "bytea", (cb) => cb.notNull())
    .addColumn("encrypted", "boolean", (cb) => cb.notNull().defaultTo(false))
    .addColumn("logged_timestamp", "timestamp", (cb) => cb.notNull())
    .execute();

  await db.schema
    .createIndex(names.indexes.logTimestamp)
    .ifNotExists()
    .on("logs")
    .column("logged_timestamp")
    .execute();

  await db.schema
    .createIndex(names.indexes.attrLogTimestamp)
    .ifNotExists()
    .on("log_attr")
    .column("logged_timestamp")
    .execute();

  await db.schema
    .createIndex(names.indexes.attrLog)
    .ifNotExists()
    .on("log_attr")
    .column("log_id")
    .execute();

  await db.schema
    .createIndex(names.indexes.attrValName)
    .ifNotExists()
    .on("log_attr")
    .column("val")
    .execute();

  await db.schema
    .createIndex(names.indexes.logLevel)
    .ifNotExists()
    .on("logs")
    .column("level")
    .execute();
}

/**
 * Reverses {@link up} by dropping the logging indexes and the `log_attr_blob`,
 * `log_attr`, and `logs` tables (in FK-safe order). Safe to call if they do
 * not exist. A configured schema is left in place.
 */
export async function down(db: Kysely<any>, names: ResolvedLogSchema): Promise<void> {
  await db.schema.dropIndex(names.indexes.logTimestamp).ifExists().execute();
  await db.schema.dropIndex(names.indexes.attrLogTimestamp).ifExists().execute();
  await db.schema.dropIndex(names.indexes.attrLog).ifExists().execute();
  await db.schema.dropIndex(names.indexes.attrValName).ifExists().execute();
  await db.schema.dropIndex(names.indexes.logLevel).ifExists().execute();
  await db.schema.dropTable("log_attr_blob").ifExists().execute();
  await db.schema.dropTable("log_attr").ifExists().execute();
  await db.schema.dropTable("logs").ifExists().execute();
}
