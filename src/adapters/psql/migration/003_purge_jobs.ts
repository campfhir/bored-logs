import { Kysely, sql } from "kysely";

/**
 * Persistent purge jobs.
 *
 * `log_purge_job` holds one row per in-flight purge (plan counts, progress,
 * and a TTL lock so exactly one instance processes a job at a time).
 * `log_purge_ids` holds the captured set of log ids the job will delete —
 * batches drain it as they go, so progress is exact, a restart resumes where
 * the dead instance stopped, and no temp table is needed. When the id set is
 * empty the job goes terminal — the row is kept (status + finished_at) so any
 * instance can report the outcome; the sweep prunes terminal rows past a
 * retention window.
 *
 * Idempotent — safe to run on every startup.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("log_purge_job")
    .ifNotExists()
    .addColumn("purge_id", "varchar(64)", (col) => col.primaryKey())
    .addColumn("until_ts", "timestamp", (col) => col.notNull())
    .addColumn("status", "varchar(32)", (col) => col.notNull())
    .addColumn("log_count", "bigint", (col) => col.notNull())
    .addColumn("attr_count", "bigint", (col) => col.notNull())
    .addColumn("deleted_logs", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("deleted_attrs", "bigint", (col) => col.notNull().defaultTo(0))
    .addColumn("batch_size", "integer", (col) => col.notNull())
    .addColumn("requires_confirmation", "boolean", (col) => col.notNull())
    .addColumn("ids_captured", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("error", "text")
    .addColumn("created_at", "timestamp", (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn("started_at", "timestamp")
    .addColumn("finished_at", "timestamp")
    .addColumn("locked_by", "varchar(64)")
    .addColumn("lock_expires_at", "timestamp")
    .execute();

  await db.schema
    .createTable("log_purge_ids")
    .ifNotExists()
    .addColumn("purge_id", "varchar(64)", (col) =>
      col.notNull().references("log_purge_job.purge_id").onDelete("cascade"),
    )
    .addColumn("log_id", "bigint", (col) => col.notNull())
    .addPrimaryKeyConstraint("log_purge_ids_pkey", ["purge_id", "log_id"])
    .execute();
}

/** Reverses {@link up}: drops both purge tables. Idempotent. */
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("log_purge_ids").ifExists().execute();
  await db.schema.dropTable("log_purge_job").ifExists().execute();
}
