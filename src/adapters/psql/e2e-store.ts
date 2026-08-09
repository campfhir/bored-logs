/**
 * Durable {@link E2ERegistrationStore} backed by Postgres (migration
 * `004_e2e_clients`) — registrations survive restarts and are shared across
 * instances, so shippers never need to re-register after a server bounce
 * (pair it with persisted server keys via `exportKeys()` for full
 * restart-stability):
 *
 * ```ts
 * const e2e = createE2EServerContext({
 *   keys: persistedKeys,                       // from exportKeys()
 *   store: new PsqlE2ERegistrationStore(db),   // same Kysely as PostgresAdapter
 * });
 * ```
 */
import type { Kysely } from "kysely";
import type { E2ERegistration, E2ERegistrationStore } from "../../server/e2e-context";
import type { LoggerTables } from "./adapter";

/** Postgres-backed registration store — see the module docs. */
export class PsqlE2ERegistrationStore implements E2ERegistrationStore {
  constructor(private readonly _db: Kysely<LoggerTables>) {}

  async get(clientId: string): Promise<E2ERegistration | undefined> {
    const row = await this._db
      .selectFrom("log_e2e_clients")
      .selectAll()
      .where("client_id", "=", clientId)
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      clientId: row.client_id,
      signingKeyJwk: JSON.parse(row.signing_key_jwk) as JsonWebKey,
      algo: row.algo,
      registeredAt: new Date(row.registered_at).getTime(),
    };
  }

  async set(registration: E2ERegistration): Promise<void> {
    const values = {
      client_id: registration.clientId,
      signing_key_jwk: JSON.stringify(registration.signingKeyJwk),
      algo: registration.algo,
      registered_at: new Date(registration.registeredAt),
    };
    await this._db
      .insertInto("log_e2e_clients")
      .values(values)
      .onConflict((oc) =>
        oc.column("client_id").doUpdateSet({
          signing_key_jwk: values.signing_key_jwk,
          algo: values.algo,
          registered_at: values.registered_at,
        }),
      )
      .execute();
  }

  async delete(clientId: string): Promise<void> {
    await this._db.deleteFrom("log_e2e_clients").where("client_id", "=", clientId).execute();
  }
}
