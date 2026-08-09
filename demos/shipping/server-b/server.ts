/**
 * App B — the central log server (Node + Express).
 *
 * Owns the database. Receives batched logs from any number of shipping apps
 * (App A here runs on Deno — see ../app-a) via `createLogIngestHandler`, and
 * exposes a small query endpoint over the same data.
 *
 * `createLogIngestHandler` returns a Web-Fetch `(Request) => Response`
 * handler. Express speaks Node req/res, so a ~15-line bridge synthesizes a
 * `Request` from the Express request and unpacks the `Response` — this is the
 * pattern the README describes for non-Fetch routers.
 *
 *   pnpm start        # → http://localhost:4600  (needs Postgres: `pnpm db:up` at the repo root)
 */
import express from "express";
import { Kysely, PostgresDialect } from "kysely";
import { createLogger, ConsoleAdapter, parseLogQueryExpr } from "@campfhir/bored-logs";
import {
  createLogIngestHandler,
  createLogRegistrationHandler,
  createE2EServerContext,
} from "@campfhir/bored-logs/server";
import { PostgresAdapter, createLoggerPool, type LoggerTables } from "@campfhir/bored-logs/adapters/psql";

const PORT = Number(process.env.PORT ?? 4600);
const TOKEN = process.env.LOG_SHIP_TOKEN ?? "demo-secret";
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/bored_logs_test";

// ── The log server's own logger + the shared Postgres sink ─────────────────
const db = new Kysely<LoggerTables>({
  dialect: new PostgresDialect({ pool: createLoggerPool({ connectionString: DATABASE_URL }) }),
});
const adapter = new PostgresAdapter({ db });
await adapter.migrate();

const logger = createLogger({ application: "log-server", version: "1.0.0" });
logger.addAdapter(new ConsoleAdapter({ showTimestamp: false }));
logger.addAdapter(adapter);

// ── End-to-end encryption ──────────────────────────────────────────────────
// One shared context feeds both the registration endpoint and the ingest
// handler. Keys are generated at boot (a restart rotates them — shippers
// detect it and transparently re-register); persist across restarts with
// `await e2e.exportKeys()` and pass the result back as `keys`.
const e2e = createE2EServerContext();
const register = createLogRegistrationHandler(e2e);

// ── Ingest endpoint ────────────────────────────────────────────────────────
const ingest = createLogIngestHandler({
  logger,
  maxBatch: 100, // advertised to shippers on every response — they negotiate down
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

// Registration (TOFU — protected by the SAME bearer check as ingest).
app.post("/api/logs/register", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  await toFetchHandler(register, req, res);
});

app.post("/api/logs", express.raw({ type: "*/*", limit: "5mb" }), async (req, res) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  await toFetchHandler(ingest, req, res);
});

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

app.listen(PORT, () => {
  logger.info("log server listening on {port} — POST /api/logs, GET /logs?q=", { port: PORT });
});

// Drain adapters (incl. any in-flight purge batch) on shutdown.
logger.on("SIGTERM", async () => {
  await db.destroy();
  process.exit(0);
});
