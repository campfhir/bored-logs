# Shipping demo — App A (Deno) → App B (Node/Express) → Postgres

A runnable version of the [Shipping logs between applications](../../README.md#shipping-logs-between-applications) topology, deliberately built on **two different runtimes**:

```
app-a/    Deno worker      — createLogger + HttpAdapter (fetch-only, no DB, no pg)
                             packages: @campfhir/bored-logs, @campfhir/bored-logs-http
             │  HTTPS POST /api/logs (encrypted batches, bearer auth)
             ▼
server-b/ Node + Express   — the central log server:
                             createLogIngestHandler behind a ~15-line Node-req → Fetch-Request
                             bridge, PostgresAdapter in its OWN schema (log_server.ls_*, migrated
                             by the migrator package), Postgres-backed E2E registrations, a
                             GET /logs?q= query endpoint, and GET /status (the loadout)
                             packages: @campfhir/bored-logs, -server, -psql, -psql-migration
```

Why two runtimes: the shipping side of the library is fetch-and-timers only, so it runs anywhere (Deno here, browsers in the [web demo](../web/), Node/Bun/Edge elsewhere); and Express — which speaks Node `req`/`res`, not Fetch — shows the bridge pattern for mounting the ingest handler on non-Fetch routers.

Why its own schema: `server-b` points at `bored_logs_test`, the same database the repo's live e2e suite uses with the default table layout (`public.logs`, …). Passing `{ schema: "log_server", tablePrefix: "ls_" }` to the migrator, the adapter, and the registration store keeps the server's tables (`log_server.ls_logs`, `log_server.ls_log_e2e_clients`, …) completely apart — the situation a central log server faces when it is dropped into a database that already has tables. `LOG_SCHEMA` / `LOG_TABLE_PREFIX` override it.

## Run it

```bash
# 1. Postgres (from the repo root)
pnpm db:up

# 2. The log server (terminal 1)
cd demos/shipping/server-b
pnpm install --ignore-workspace
pnpm start                       # → http://localhost:4600

# 3. The shipper (terminal 2)
cd demos/shipping/app-a
deno task start                  # processes 20 fake orders, ships, exits

# 4. The loadout — packages, resolved table names, migrations, E2E store
curl -s http://localhost:4600/status | jq
```

Both consume the library packages from `../../../packages/*/src` (tsconfig `paths` for tsx, an import map + sloppy imports for Deno) under their published names (`@campfhir/bored-logs`, `@campfhir/bored-logs-http`, `@campfhir/bored-logs-server`, `@campfhir/bored-logs-psql`, `@campfhir/bored-logs-psql-migration`) — no build step; the `link:` dependencies (→ `dist`) are the fallback.

## Poke at the data

The query endpoint takes the same string grammar as `LogSearchBar`:

```bash
q() { curl -sG "http://localhost:4600/logs" --data-urlencode "q=$1"; }

q "application:'app-a'"                      # only App A's logs
q "application:'log-server'"                 # the log server's own logs
q "session.id:='sess_4' \$level:'error'"     # nested path + built-in column
q "users[*]:='u_0'"                          # array membership
q "cart.items[*].sku:='D-4' cart.total:>'50'" # objects in arrays + numeric compare
q "debugTrace:'trace'"                       # 0 rows — redact() never left App A
```

## End-to-end encryption

The demo ships **encrypted**: `app-a` sets `encryption: { clientId: "app-a" }`, so every batch leaves Deno as AES-256-GCM ciphertext with the `x-bored-logs-*` envelope headers, signed with the client's ECDSA key. `server-b` mounts the registration endpoint at `/api/logs/register` (behind the same bearer check as ingest — registration is trust-on-first-use) and passes the shared `createE2EServerContext()` to the ingest handler, which verifies the signature, checks freshness + replay, and decrypts before the normal pipeline.

`app-a` keeps a persistent signing identity in `app-a/app-a-keys.json` (generated on first run, gitignored) — required because registration is **pinned**: the server binds `app-a` to its first signing key and refuses a different one (`409 client-key-conflict`), so an attacker who can reach the endpoint cannot take the identity over. The registration route is additionally gated by the `authorize` hook (same bearer token as ingest).

`server-b` is **restart-stable**: its keypair is persisted to `server-b/server-b-keys.json` (generated on first boot, gitignored) and registrations live in Postgres through `PsqlE2ERegistrationStore` — given the same `{ schema, tablePrefix }` as the log tables, so they land in `log_server.ls_log_e2e_clients`. Restart `server-b` while `app-a` is running (`ORDERS=200 deno task start`) and shipping simply continues; `GET /status` reports `e2e.registeredClients: 1` before and after.

To see the self-healing path instead, delete `server-b-keys.json` before restarting: the new keypair makes the shipper's next batch fail `decrypt-failed`, it transparently re-registers against the new key, and continues without losing a record.

## What to look for

- **Source identity** — every record carries App A's `application` / `version` (plus the `region` global attribute), so one database serves many apps and `application:'app-a'` isolates them.
- **`transform` enrichment** — the server stamps `shippedFrom` onto each record from the request.
- **Sensitivity across the wire** — `paymentToken` was `secure()` (shipped tagged, `[secure]` in the message; encrypted at rest if the server's `PostgresAdapter` is given `encrypt`/`decrypt`), while `debugTrace` was `redact()` and never crossed the wire.
- **End-to-end encryption** — the wire carries only ciphertext + envelope headers; run `server-b` with a proxy/tcpdump between the two and there is no JSON to read. `redact()` still never leaves App A; `secure()` plaintext is now ALSO protected in transit beyond TLS.
- **Batch-size negotiation** — every ingest response advertises `x-log-max-batch`; the `HttpAdapter` learns it and chunks, so shipper and server never need manual alignment.
- **Auth** — one bearer token (`LOG_SHIP_TOKEN`, default `demo-secret`) checked before the handler runs.
- **Own schema next to someone else's tables** — `\dn` in `psql` shows `log_server` beside `public`; the e2e suite's `logs` table and the server's `log_server.ls_logs` never touch. `GET /status` prints the logical → physical map the adapter resolved.
- **The loadout** — `GET /status` also lists the four packages the server runs on with their versions; App A needs only `@campfhir/bored-logs` + `@campfhir/bored-logs-http`.
