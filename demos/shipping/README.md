# Shipping demo — App A (Deno) → App B (Node/Express) → Postgres

A runnable version of the [Shipping logs between applications](../../README.md#shipping-logs-between-applications) topology, deliberately built on **two different runtimes**:

```
app-a/    Deno worker      — createLogger + HttpAdapter (fetch-only, no DB, no pg)
             │  HTTPS POST /api/logs (batched JSON, bearer auth)
             ▼
server-b/ Node + Express   — createLogIngestHandler behind a ~15-line
                             Node-req → Fetch-Request bridge, PostgresAdapter,
                             and a GET /logs?q= query endpoint
```

Why two runtimes: the shipping side of the library is fetch-and-timers only, so it runs anywhere (Deno here, browsers in the [web demo](../web/), Node/Bun/Edge elsewhere); and Express — which speaks Node `req`/`res`, not Fetch — shows the bridge pattern for mounting the ingest handler on non-Fetch routers.

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
```

Both consume the library from `../../../src` (tsconfig `paths` for tsx, an import map + sloppy imports for Deno) under its published name — no build step; the `link:` dependency (→ `dist`) is the fallback.

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

Try the self-healing: while `app-a` is running (`ORDERS=200 deno task start`), restart `server-b`. The new process generates fresh keys and an empty registration store — the shipper hits `401 unknown-client`, transparently re-registers, and continues without losing a record. Persist keys across restarts with `await e2e.exportKeys()`.

## What to look for

- **Source identity** — every record carries App A's `application` / `version` (plus the `region` global attribute), so one database serves many apps and `application:'app-a'` isolates them.
- **`transform` enrichment** — the server stamps `shippedFrom` onto each record from the request.
- **Sensitivity across the wire** — `paymentToken` was `secure()` (shipped tagged, `[secure]` in the message; encrypted at rest if the server's `PostgresAdapter` is given `encrypt`/`decrypt`), while `debugTrace` was `redact()` and never crossed the wire.
- **End-to-end encryption** — the wire carries only ciphertext + envelope headers; run `server-b` with a proxy/tcpdump between the two and there is no JSON to read. `redact()` still never leaves App A; `secure()` plaintext is now ALSO protected in transit beyond TLS.
- **Batch-size negotiation** — every ingest response advertises `x-log-max-batch`; the `HttpAdapter` learns it and chunks, so shipper and server never need manual alignment.
- **Auth** — one bearer token (`LOG_SHIP_TOKEN`, default `demo-secret`) checked before the handler runs.
