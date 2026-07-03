import { Kysely } from "kysely";

/**
 * Creates the three logging tables:
 *  - `logs`          — one row per log entry
 *  - `log_attr`      — scalar attributes (text / number / boolean / date / json)
 *  - `log_attr_blob` — binary / large attributes (bytea)
 *
 * Also creates indexes for efficient timestamp-range and level queries.
 */
export async function up(db: Kysely<any>): Promise<void> {
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
    .createIndex("log_timestamp_idx")
    .ifNotExists()
    .on("logs")
    .column("logged_timestamp")
    .execute();

  await db.schema
    .createIndex("attr_log_timestamp_idx")
    .ifNotExists()
    .on("log_attr")
    .column("logged_timestamp")
    .execute();

  await db.schema
    .createIndex("attr_log_idx")
    .ifNotExists()
    .on("log_attr")
    .column("log_id")
    .execute();

  await db.schema
    .createIndex("attr_val_name_idx")
    .ifNotExists()
    .on("log_attr")
    .column("val")
    .execute();

  await db.schema
    .createIndex("log_level_idx")
    .ifNotExists()
    .on("logs")
    .column("level")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("log_timestamp_idx").ifExists().execute();
  await db.schema.dropIndex("attr_log_timestamp_idx").ifExists().execute();
  await db.schema.dropIndex("attr_log_idx").ifExists().execute();
  await db.schema.dropIndex("attr_val_name_idx").ifExists().execute();
  await db.schema.dropIndex("log_level_idx").ifExists().execute();
  await db.schema.dropTable("log_attr_blob").ifExists().execute();
  await db.schema.dropTable("log_attr").ifExists().execute();
  await db.schema.dropTable("logs").ifExists().execute();
}
