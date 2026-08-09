import { Kysely, sql } from "kysely";

/**
 * Durable end-to-end encryption client registrations.
 *
 * `log_e2e_clients` backs `PsqlE2ERegistrationStore` — a first-party
 * `E2ERegistrationStore` so registrations survive restarts and are shared
 * across instances. Only PUBLIC signing keys are stored (JWK, as JSON text);
 * the server's own keypair is deliberately NOT stored here — persist it via
 * `exportKeys()` into your secret manager.
 *
 * Idempotent — safe to run on every startup.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("log_e2e_clients")
    .ifNotExists()
    .addColumn("client_id", "varchar(128)", (col) => col.primaryKey())
    .addColumn("signing_key_jwk", "text", (col) => col.notNull())
    .addColumn("algo", "varchar(64)", (col) => col.notNull())
    .addColumn("registered_at", "timestamp", (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
}

/** Reverses {@link up}: drops the registrations table. Idempotent. */
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("log_e2e_clients").ifExists().execute();
}
