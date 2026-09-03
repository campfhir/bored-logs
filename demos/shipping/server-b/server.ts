/**
 * App B — the central log server (Node + Express).
 *
 * Owns the database. Receives batched logs from any number of shipping apps
 * (App A here runs on Deno — see ../app-a) via `createLogIngestHandler`, and
 * exposes a small query endpoint over the same data.
 *
 * The loadout — every package this server is built from:
 *   @campfhir/bored-logs                 createLogger, ConsoleAdapter, parseLogQueryExpr
 *   @campfhir/bored-logs-server          ingest + registration handlers, E2E server context
 *   @campfhir/bored-logs-psql            PostgresAdapter, createLoggerPool, PsqlE2ERegistrationStore
 *   @campfhir/bored-logs-psql-migration  up() — migrations into the server's own schema
 * (App A only needs @campfhir/bored-logs + @campfhir/bored-logs-http.)
 *
 * The log tables live in their OWN schema under a prefix (`log_server.ls_*`,
 * see LAYOUT below). That lets this server share `bored_logs_test` with the
 * repo's live e2e suite, which uses the default layout (`public.logs`, …) —
 * exactly the situation a central log server faces inside an existing
 * database. GET /status reports the resolved layout.
 *
 * `createLogIngestHandler` returns a Web-Fetch `(Request) => Response`
 * handler. Express speaks Node req/res, so a ~15-line bridge synthesizes a
 * `Request` from the Express request and unpacks the `Response` — this is the
 * pattern the README describes for non-Fetch routers.
 *
 *   pnpm start        # → http://localhost:4600  (needs Postgres: `pnpm db:up` at the repo root)
 */
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { Kysely, PostgresDialect, sql } from "kysely";
import { createLogger, ConsoleAdapter, parseLogQueryExpr } from "@campfhir/bored-logs";
import {
  createLogIngestHandler,
  createLogRegistrationHandler,
  createE2EServerContext,
  generateE2EServerKeys,
  type E2EKeyPairJwk,
} from "@campfhir/bored-logs-server";
import {
  PostgresAdapter,
  PsqlE2ERegistrationStore,
  createLoggerPool,
  withLogSchema,
  type LoggerTables,
  type LogSchemaOptions,
} from "@campfhir/bored-logs-psql";
import { up } from "@campfhir/bored-logs-psql-migration";

const PORT = Number(process.env.PORT ?? 4600);
const TOKEN = process.env.LOG_SHIP_TOKEN ?? "demo-secret";
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/bored_logs_test";
const KEYS_FILE = new URL("./server-b-keys.json", import.meta.url);

// ── Table layout ───────────────────────────────────────────────────────────
// One object, passed to the migrator, the adapter, AND the registration store,
// so all three agree on the physical names. `LOG_SCHEMA="" LOG_TABLE_PREFIX=""`
// selects the default layout.
const LAYOUT: LogSchemaOptions = {
  schema: process.env.LOG_SCHEMA ?? "log_server",
  tablePrefix: process.env.LOG_TABLE_PREFIX ?? "ls_",
};

// ── The log server's own logger + the shared Postgres sink ─────────────────
const db = new Kysely<LoggerTables>({
  dialect: new PostgresDialect({ pool: createLoggerPool({ connectionString: DATABASE_URL }) }),
});
await up(db, LAYOUT); // idempotent — creates the schema + prefixed tables on first boot
const adapter = new PostgresAdapter({ db, ...LAYOUT });

const logger = createLogger({ application: "log-server", version: "1.0.0" });
logger.addAdapter(new ConsoleAdapter({ showTimestamp: false }));
logger.addAdapter(adapter);

// ── End-to-end encryption — restart-stable ─────────────────────────────────
// One shared context feeds both the registration endpoint and the ingest
// handler. Two things make it survive a restart without shippers having to
// re-register: the server keypair is persisted to server-b-keys.json (delete
// the file to rotate keys — shippers then get `decrypt-failed`, re-register,
// and carry on), and client registrations live in Postgres via
// PsqlE2ERegistrationStore (same layout as the log tables → `log_server.ls_log_e2e_clients`).
// Registrations are PINNED: a clientId cannot be re-claimed with a different key.
async function loadOrCreateServerKeys(): Promise<E2EKeyPairJwk> {
  try {
    return JSON.parse(await readFile(KEYS_FILE, "utf8")) as E2EKeyPairJwk;
  } catch {
    const keys = await generateE2EServerKeys();
    await writeFile(KEYS_FILE, JSON.stringify(keys, null, 2));
    logger.info("generated a new E2E server keypair → {file}", { file: "server-b-keys.json" });
    return keys;
  }
}
const store = new PsqlE2ERegistrationStore(db, LAYOUT);
const e2e = createE2EServerContext({ keys: await loadOrCreateServerKeys(), store });

// One auth policy for the whole pipeline. Swap the body for anything —
// OAuth2 token introspection, local JWT/JWKS verification, an mTLS header
// from your proxy — both handlers just see the raw Request.
const authorize = async (request: Request): Promise<boolean> =>
  await new Promise((resolve) => setTimeout(() => resolve(request.headers.get("authorization") === `Bearer ${TOKEN}`), 200));

const register = createLogRegistrationHandler(e2e, { authorize });

// ── Ingest endpoint ────────────────────────────────────────────────────────
const ingest = createLogIngestHandler({
  logger,
  maxBatch: 100, // advertised to shippers on every response — they negotiate down
  authorize, // rejected before any body parsing or crypto work
  encryption: { context: e2e }, // decrypt + verify before the normal pipeline
  // Enrich each shipped record with request-derived data.
  transform: (record, req) => ({
    ...record,
    attrs: { ...record.attrs, shippedFrom: req.headers.get("x-forwarded-for") ?? "local" },
  }),
});

/** Bridge one Express request into the Fetch handler and unpack the Response. */
async function toFetchHandler(
  handler: (req: Request) => Promise<Response>,
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const request = new Request(`http://localhost${req.originalUrl}`, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) =>
      v == null ? [] : Array.isArray(v) ? v.map((x): [string, string] => [k, x]) : [[k, String(v)] as [string, string]],
    ),
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
  });
  const response = await handler(request);
  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.send(Buffer.from(await response.arrayBuffer()));
}

const app = express();

// Both endpoints authenticate via their handlers' `authorize` hook — the
// Express layer only bridges.
app.post("/api/logs/register", express.raw({ type: "*/*", limit: "1mb" }), (req, res) =>
  toFetchHandler(register, req, res),
);

app.post("/api/logs", express.raw({ type: "*/*", limit: "5mb" }), (req, res) =>
  toFetchHandler(ingest, req, res),
);

// ── Query endpoint — the same string grammar the search bar uses ───────────
// GET /logs?q=application:'app-a' users[*]:='u_1'
app.get("/logs", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const parsed = parseLogQueryExpr(q);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.err.message, detail: String(parsed.err.cause ?? "") });
    return;
  }
  const result = await adapter.query({ attributeFilter: parsed.val ?? undefined, limit: 50 });
  if (!result.ok) {
    res.status(500).json({ error: result.err.message });
    return;
  }
  res.json({ count: result.val.length, logs: result.val });
});

// ── Status endpoint — the loadout ──────────────────────────────────────────
// GET /status → the packages this server runs on, the resolved table layout,
// migration state, and the E2E registration store's health.
const PACKAGES: Record<string, string> = {
  "@campfhir/bored-logs": "logger, ConsoleAdapter, query grammar",
  "@campfhir/bored-logs-server": "ingest + registration handlers, E2E context",
  "@campfhir/bored-logs-psql": "PostgresAdapter, PsqlE2ERegistrationStore",
  "@campfhir/bored-logs-psql-migration": "up() into the configured schema",
};
function packageVersion(name: string): string {
  try {
    const file = join(process.cwd(), "node_modules", name, "package.json");
    return String(JSON.parse(readFileSync(file, "utf8")).version);
  } catch {
    return "workspace";
  }
}
app.get("/status", async (_req, res) => {
  const names = adapter.schemaNames;
  // `withLogSchema` gives user code the same logical→physical rewrite the
  // adapter uses, so this counts rows in `log_server.ls_log_e2e_clients`.
  const registered = await sql<{ n: string }>`select count(*) as n from ${sql.table("log_e2e_clients")}`.execute(
    withLogSchema(db, LAYOUT),
  );
  const dbUrl = new URL(DATABASE_URL);
  res.json({
    packages: Object.entries(PACKAGES).map(([name, role]) => ({ name, version: packageVersion(name), role })),
    database: `${dbUrl.host}${dbUrl.pathname}`,
    layout: { schema: names.schema, tablePrefix: names.prefix, tables: names.tables },
    migrations: await adapter.migrationStatus(),
    e2e: {
      store: "postgres",
      keysPersisted: true,
      registeredClients: Number(registered.rows[0]?.n ?? 0),
    },
  });
});

app.listen(PORT, () => {
  logger.info("log server listening on {port} — POST /api/logs, GET /logs?q=, GET /status", { port: PORT });
  logger.info("log tables: {schema}.{prefix}* (LOG_SCHEMA / LOG_TABLE_PREFIX)", {
    schema: adapter.schemaNames.schema ?? "public",
    prefix: adapter.schemaNames.prefix,
  });
});

// Drain adapters (incl. any in-flight purge batch) on shutdown.
logger.on("SIGTERM", async () => {
  await db.destroy();
  process.exit(0);
});
