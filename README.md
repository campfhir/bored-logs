# @campfhir/bored-logs

Structured PostgreSQL-backed logging for React + Node — an adapter-based logger with typed message templates, a boolean log-search grammar (nested-attribute queries, a programmatic builder), HTTP log shipping with opt-in end-to-end encryption, React UI components, and Kysely migrations. The examples below use Next.js idioms, but the package is framework-agnostic; see [Using with Vite / React](#using-with-vite--react-non-nextjs) for a plain Vite SPA + Node backend.

## Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Using with Vite / React (non-Next.js)](#using-with-vite--react-non-nextjs)
- [Database setup](#database-setup)
- [Setup](#setup)
- [Using the logger](#using-the-logger)
- [Global attributes](#global-attributes)
  - [Reserved attribute names](#reserved-attribute-names)
  - [Output templates](#output-templates)
- [Secure values](#secure-values)
- [Programmatic query builder](#programmatic-query-builder)
- [Server actions](#server-actions)
- [Client-side logging (`useLogger`)](#client-side-logging-uselogger)
  - [1. Server: an ingest Route Handler](#1-server-an-ingest-route-handler)
  - [2. Client: wrap your app with `LoggerProvider`](#2-client-wrap-your-app-with-loggerprovider)
  - [3. Log from Client Components](#3-log-from-client-components)
  - [`LoggerProvider` options](#loggerprovider-options)
  - [`createLogIngestHandler` options](#createlogingesthandler-options)
  - [Next.js and console output](#nextjs-and-console-output)
- [Shipping logs between applications](#shipping-logs-between-applications)
  - [Authenticating the pipeline](#authenticating-the-pipeline)
  - [End-to-end payload encryption](#end-to-end-payload-encryption)
- [Log search](#log-search)
- [UI components](#ui-components)
  - [LogTable](#logtable)
  - [LogCard](#logcard)
  - [LogSearchBar](#logsearchbar)
  - [LogLevelFilter](#loglevelfilter)
  - [LogDateRangePicker](#logdaterangepicker)
  - [LogSearchSyntaxHelp](#logsearchsyntaxhelp)
  - [PurgeLogsDialog](#purgelogsdialog)
  - [Composing components](#composing-components)
- [Optional: encryption](#optional-encryption)
- [Optional: log levels](#optional-log-levels)
- [Optional: process hooks](#optional-process-hooks)
- [Development](#development)

---

## Prerequisites

Peer dependencies required in your Next.js application:

```bash
npm install kysely pg react
```

`pg` and `kysely` are only required if you are using `PostgresAdapter`. They are not loaded in browser or Edge runtimes.

---

## Installation

```bash
npm install @campfhir/bored-logs
```

**Next.js only:** add the package to `serverExternalPackages` in your `next.config.ts` so Next.js does not attempt to bundle it through webpack:

```typescript
// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@campfhir/bored-logs"],
};

export default nextConfig;
```

On Vite there is no equivalent to configure — see [Using with Vite / React](#using-with-vite--react-non-nextjs).

---

## Using with Vite / React (non-Next.js)

The rest of this README uses Next.js idioms (`instrumentation.ts`, Route Handlers, Server Actions, `serverExternalPackages`). None of them are required — the package is framework-agnostic. This section maps each concept to a plain **Vite React SPA + your own Node/Bun backend** (Express, Fastify, Hono, etc.). Everything else in the README still applies; only the wiring changes.

**The one rule that makes this work:** the browser bundle must never import `@campfhir/bored-logs/server`, `@campfhir/bored-logs/adapters/psql`, `pg`, or `kysely`. Those run on your backend only. In the browser you use just two entrypoints:

| Entrypoint                          | Where it runs | What it gives you                                          |
| ----------------------------------- | ------------- | ---------------------------------------------------------- |
| `@campfhir/bored-logs/client`       | browser       | `LoggerProvider`, `useLogger` (ships logs over HTTP)       |
| `@campfhir/bored-logs/components`   | browser       | `LogTable`, `LogSearchBar`, `PurgeLogsDialog`, etc.        |

Because you only reference the server entrypoints from backend files, Vite naturally keeps them out of the client bundle — no `serverExternalPackages` analog is needed. (If you run Vite in **SSR** mode, add `ssr: { external: ["@campfhir/bored-logs", "pg", "kysely"] }` to `vite.config.ts` so the server build resolves them from `node_modules` at runtime instead of bundling them.)

### Mapping Next.js concepts to your Vite stack

| Next.js (as written in this README)                | Vite / React equivalent                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `next.config` → `serverExternalPackages`           | Nothing to do for an SPA. For Vite SSR, use `ssr.external` (above).                                                       |
| `instrumentation.ts` → `register()`                | Register the `PostgresAdapter` **once at your backend's startup** (server entry file). No `NEXT_RUNTIME` guard needed — your backend is always Node. |
| Route Handler `app/api/logs/route.ts`              | Mount `createLogIngestHandler` on **your backend router** (see below).                                                    |
| Server Actions (`"use server"` `queryLogs`/`purgeLogs`) | Plain **REST endpoints** on your backend that call `adapter.query()` / `adapter.purge()`; the SPA calls them with `fetch`. |
| `@/lib/db`, `@/lib/logger`                          | The same files, imported by your backend. `createLogger` is safe to import anywhere; `db` + `PostgresAdapter` are backend-only. |

### 1. Backend: create the logger, DB, and run migrations

Follow [Database setup](#database-setup) and [Setup](#setup) as written — the code is identical. The only change: instead of `instrumentation.ts`, add the `PostgresAdapter` in your server's bootstrap, once, before it starts listening. No dynamic import or runtime guard is required:

```typescript
// server/logger.ts  (backend only)
import { PostgresAdapter } from "@campfhir/bored-logs/adapters/psql";
import { logger } from "./lib/logger"; // createLogger({ ... }) as in Setup
import { db } from "./lib/db";

await new PostgresAdapter({ db }).migrate();       // idempotent — safe every startup
logger.addAdapter(new PostgresAdapter({ db, level: "info" }));
```

### 2. Backend: the ingest endpoint

`createLogIngestHandler` returns a standard `(request: Request) => Promise<Response>` (Web Fetch API), so it drops straight into any Web-standard router. With **Hono**:

```typescript
import { Hono } from "hono";
import { createLogIngestHandler } from "@campfhir/bored-logs/server";
import { logger } from "./logger";

const ingest = createLogIngestHandler({ logger /* , transform, maxBatch */ });

const app = new Hono();
app.post("/api/logs", (c) => ingest(c.req.raw)); // pass the raw Request, return its Response
```

For **Express** (which uses Node req/res, not Fetch), convert with a small adapter such as [`@remix-run/node`'s `createRequestHandler`](https://www.npmjs.com/package/@mjackson/node-fetch-server) helpers, or read the body yourself and call the handler with a synthesized `Request`. All handler options ([`createLogIngestHandler` options](#createlogingesthandler-options)) work unchanged — including `transform`, which receives the `Request` for pulling headers/IP or authorizing.

### 3. Backend: query / purge endpoints

Server Actions become ordinary authenticated routes that call the same adapter methods described in [Server actions](#server-actions):

```typescript
app.post("/api/logs/query", async (c) => {
  // authenticate + authorize the request here
  const options = await c.req.json();
  const result = await logger.queryAdapter().query(options ?? {});
  return result.ok ? c.json(result.val) : c.json({ error: result.err.message }, 500);
});

app.post("/api/logs/purge", async (c) => {
  const { until } = await c.req.json();
  // purge() returns a PurgeJob immediately; deletion runs in the background
  // (see the `purge` section for the full plan/confirm/status flow).
  const result = await logger.queryAdapter().purge(new Date(until));
  return result.ok ? c.json(result.val) : c.json({ error: result.err.message }, 500);
});
```

### 4. Client: provider, hook, and UI components

Everything from [Client-side logging](#client-side-logging-uselogger) and [UI components](#ui-components) works **unchanged** — these are plain React. The only difference from the Next.js examples is that the `"use client"` directive is unnecessary (it's a no-op in Vite; leave it off or ignore it). Wrap your app once:

```tsx
// src/main.tsx
import { LoggerProvider } from "@campfhir/bored-logs/client";

createRoot(document.getElementById("root")!).render(
  <LoggerProvider endpoint="/api/logs" application="web" level="info" credentials="include">
    <App />
  </LoggerProvider>,
);
```

Then `useLogger()` in components, and build your log-viewer UI with the [components](#ui-components) — pointing the `onSearch` / purge handlers at the REST endpoints from step 3 (via `fetch`) instead of Server Actions. During local dev, proxy `/api` to your backend with Vite's `server.proxy` so the endpoint URLs stay relative.

> **Console output.** The [Next.js and console output](#nextjs-and-console-output) caveats about `NEXT_RUNTIME` and `compiler.removeConsole` don't apply. Vite/esbuild can strip `console.*` in production via `esbuild: { drop: ["console"] }` — if you set that, `ConsoleAdapter` output disappears (the `HttpAdapter`/`PostgresAdapter` still ship and persist). `secure()`/`redact()` masking still auto-detects browser vs. server by `typeof window`.

---

## Database setup

### 1. Create a Kysely instance

Use `createLoggerPool` for Azure-friendly connection pool defaults (`max: 2`, short idle timeout):

```typescript
// src/lib/db.ts
import { Kysely, PostgresDialect } from "kysely";
import { createLoggerPool } from "@campfhir/bored-logs/adapters/psql";

export const db = new Kysely<any>({
  dialect: new PostgresDialect({
    pool: createLoggerPool({ connectionString: process.env.DATABASE_URL }),
  }),
});
```

Or pass your own `pg.Pool` directly if you have one already.

### 2. Run the migration

Call `migrate()` on your `PostgresAdapter` instance once at startup or in a migration script. No tracking table is used — migrations are idempotent (`CREATE TABLE IF NOT EXISTS`) so it is safe to call on every startup.

```typescript
import { PostgresAdapter } from "@campfhir/bored-logs/adapters/psql";
import { db } from "@/lib/db";

const adapter = new PostgresAdapter({ db });
await adapter.migrate();
```

Roll back one step with `rollback()`:

```typescript
await adapter.rollback();
```

Check which migrations have run with `migrationStatus()`:

```typescript
const status = await adapter.migrationStatus();
// [{ name: "001_logs", applied: true }, { name: "002_attr_val_name_index", applied: true },
//  { name: "003_purge_jobs", applied: true }, { name: "004_e2e_clients", applied: true }]
```

#### Running migrations outside the adapter lifecycle

The `adapters/psql/migration` entrypoint exposes every migration directly, so you can run them from a standalone migration script without constructing a `PostgresAdapter`.

The idempotent `up()` / `down()` helpers run **all** migrations (in order / reverse order). No tracking table is used, so they are safe to call on every startup:

```typescript
import { up, down } from "@campfhir/bored-logs/adapters/psql/migration";

await up(db);   // apply every migration, in order
await down(db); // reverse every migration

// Run only specific migrations (applied in canonical order regardless of the
// order listed); unknown names throw:
await up(db, { only: ["002_attr_val_name_index"] });
```

For tracked, versioned migrations, hand the provided `MigrationProvider` to Kysely's own [`Migrator`](https://kysely.dev/docs/migrations) — this records applied migrations in a `kysely_migration` table and unlocks `migrateToLatest`, `migrateUp`, `migrateDown`, and `migrateTo`:

```typescript
import { Migrator } from "kysely";
import { migrationProvider } from "@campfhir/bored-logs/adapters/psql/migration";

const migrator = new Migrator({ db, provider: migrationProvider });
const { error, results } = await migrator.migrateToLatest();
```

The raw `MIGRATIONS` map (keyed by name) and the ordered `migrationNames` array are also exported if you need to compose or introspect them.

---

## Setup

Create a logger instance in a shared module. `createLogger` is runtime-agnostic — safe to import anywhere.

```typescript
// src/lib/logger.ts
import { createLogger, ConsoleAdapter } from "@campfhir/bored-logs";

export const logger = createLogger({
  application: process.env.APP_NAME,
  version: process.env.APP_VERSION,
});

logger.addAdapter(
  new ConsoleAdapter({ level: process.env.CONSOLE_LOG_LEVEL ?? "info" }),
);
```

Add the `PostgresAdapter` in `instrumentation.ts` via dynamic import so that `pg`/`kysely` are only loaded in the Node.js runtime:

```typescript
// src/instrumentation.ts
import { logger } from "@/lib/logger";
import { db } from "@/lib/db";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { PostgresAdapter } =
      await import("@campfhir/bored-logs/adapters/psql");

    logger.addAdapter(
      new PostgresAdapter({
        db,
        level: process.env.LOG_DB_LEVEL ?? "info",
        onWarning(w) {
          if (w.type === "attr_keys_truncated") {
            console.error("[bored-logs] attribute keys truncated", w);
          } else if (w.type === "attr_value_truncated") {
            console.error("[bored-logs] attribute value truncated", w);
          }
        },
      }),
    );
  }
}
```

### `createLogger` options

| Option           | Type                         | Default                                | Description                                                                         |
| ---------------- | ---------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| `level`          | `string`                     | `"debug"`                              | Global minimum threshold — records below this are never dispatched                  |
| `application`    | `string`                     | —                                      | Attached to every log record                                                        |
| `version`        | `string`                     | —                                      | Attached to every log record                                                        |
| `bufferLimit`    | `number`                     | `500`                                  | Max records buffered before first adapter is registered                             |
| `levels`         | `Record<string, number>`     | —                                      | Extra custom levels merged into the built-ins (see [Custom levels](#custom-levels)) |
| `serializeValue` | `(value: unknown) => string` | JSON for objects, `String()` otherwise | How non-string attribute values are rendered into message templates                 |
| `attributes`     | `Record<string, unknown>`    | —                                      | Attributes attached to every record (see [Global attributes](#global-attributes))   |

Any **other** key you pass becomes a global attribute, so `createLogger({ commit: "e02350" })` stamps `commit` on every record. Use the explicit `attributes` bag when an attribute name collides with one of the option names above.

### `PostgresAdapter` options

| Option           | Type                             | Default                                | Description                                                                                                                   |
| ---------------- | -------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `db`             | `Kysely<any>`                    | required                               | Kysely instance with the logger tables                                                                                        |
| `level`          | `string`                         | `process.env.LOG_DB_LEVEL \|\| "info"` | Adapter-level filter                                                                                                          |
| `encrypt`        | `(plaintext: string) => Buffer`  | —                                      | Encrypts attribute values at rest                                                                                             |
| `decrypt`        | `(ciphertext: string) => string` | —                                      | Required when `encrypt` is provided                                                                                           |
| `maxConnections` | `number`                         | `2`                                    | Max concurrent DB operations                                                                                                  |
| `onWarning`      | `(w: AdapterWarning) => void`    | —                                      | Called when an attribute key or value is truncated                                                                            |
| `levels`         | `Record<string, number>`         | —                                      | Custom levels merged into the built-ins (only needed for standalone use — a registered adapter receives them from the logger) |
| `purgeConfirmationThreshold` | `number`             | `10 000`                               | Impacted rows (logs + attrs) at/above which [`purge`](#purge--asynchronous-with-confirmation) waits for `confirmPurge`        |
| `purgeBatchSize` | `number`                         | `1 000`                                | Logs deleted per background purge batch                                                                                       |
| `purgeLockTtlMs` | `number`                         | `60 000`                               | TTL on a purge job's processing lock (heartbeat-extended); a dead instance's jobs become sweepable after it lapses           |
| `purgeSweepIntervalMs` | `number`                   | `60 000`                               | Interval between automatic `sweepPurgeJobs()` runs; `0` disables                                                             |
| `purgeJobRetentionMs`  | `number`                   | `86 400 000` (24 h)                    | How long terminal (completed / failed) purge job rows are kept before the sweep prunes them; `0` keeps them forever          |

`db` may be typed `Kysely<LoggerTables>` (exported from `@campfhir/bored-logs/adapters/psql`) for full type-safety on the logger tables. `encrypt`/`decrypt` handle **at-rest** attribute encryption in Postgres — distinct from the [end-to-end wire encryption](#end-to-end-payload-encryption) between shipper and server.

### `ConsoleAdapter` options

| Option          | Type                     | Default  | Description                                                                                                                   |
| --------------- | ------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `level`         | `string`                 | `"info"` | Adapter-level filter                                                                                                          |
| `showTimestamp` | `boolean`                | `true`   | Include the `[ISO timestamp]` prefix in output                                                                                |
| `showLevel`     | `boolean`                | `true`   | Include the level prefix in output                                                                                            |
| `maskSecure`    | `boolean`                | server: `true`, browser: `false` | Mask `secure()`/`redact()` values in output. Auto-detects the environment; set explicitly to override            |
| `levels`        | `Record<string, number>` | —        | Custom levels merged into the built-ins (only needed for standalone use — a registered adapter receives them from the logger) |

---

## Using the logger

Import your logger instance and call it anywhere on the server.

Message templates use `{key}` placeholders. TypeScript enforces that every placeholder key is present in the attributes object. Extra keys are always allowed.

```typescript
import { logger } from "@/lib/logger";

logger.info("User {userId} signed in", { userId: "u_123" });
logger.warn("Rate limit approaching", { remaining: 5 });
logger.error("Payment failed", { orderId: "ord_456", error: err });

// Extra keys beyond the template placeholders are fine
logger.info("Order {orderId} placed", {
  orderId: "o_1",
  amount: 49.99,
  currency: "USD",
});

// Any level via log() — first argument is the level name
logger.log("request", "Incoming request", { method: "GET", path: "/api/data" });
logger.log("sql", "Query executed", { duration: 42 });
logger.log("critical", "Database unreachable");

// Every log method returns the logger, so calls chain
logger
  .info("Job {jobId} started", { jobId: "j_1" })
  .debug("Config loaded", { entries: 42 })
  .info("Job {jobId} finished", { jobId: "j_1" });
```

Named methods exist for every built-in level: `critical`, `error`, `warn`, `info`, `http`, `verbose`, `cache`, `request`, `response`, `sql`, `debug`. Use `log(level, …)` for any **registered** level. `level` is typed to the registered levels, so an unregistered name is a compile error — register custom levels via `createLogger({ levels })` / `addLevels()` (see [Custom levels](#custom-levels)). To emit a dynamically computed level string, cast it to a known level (`logger.log(dynamic as LogLevel, …)`).

### Log levels

| Level                        | Number | Use for                     |
| ---------------------------- | ------ | --------------------------- |
| `silent` / `critical`        | 0      | Suppress all / fatal errors |
| `error`                      | 1      | Errors                      |
| `warn`                       | 2      | Warnings                    |
| `info`                       | 3      | General info                |
| `http` / `verbose` / `cache` | 4      | HTTP, verbose, cache events |
| `request` / `response`       | 5      | Request/response pairs      |
| `sql`                        | 6      | Database queries            |
| `debug`                      | 7      | Debug output                |

### Adjusting levels at runtime

The logger's `level` is a global minimum threshold. Each adapter also has its own `level` property for finer control.

```typescript
// Global threshold — records below this never reach any adapter
logger.level = "debug";

// Per-adapter level — only affects that adapter
for (const adapter of logger.adapters) {
  if (adapter instanceof ConsoleAdapter) adapter.level = "warn";
  if (adapter instanceof PostgresAdapter) adapter.level = "info";
}
```

### Custom levels

Registering a custom level has two sides: the **runtime rank** and the **type**.

**Runtime** — supply the level name and its severity rank (lower = more severe) via the `levels` option or `addLevels()`:

```typescript
// At construction
const logger = createLogger({ levels: { audit: 3, silly: 8 } });
logger.log("silly", "Something ridiculous happened");

// Or after the fact — addLevels() returns the same instance, widened
const l = createLogger().addLevels({ audit: 3 });
l.log("audit", "User {userId} changed role", { userId: "u_1" });
```

Custom levels are propagated to every registered adapter automatically (when the adapter is added and whenever `addLevels` runs), so adapter-level write filtering and `query()` account for them — a record stored at a custom level is returned by an unfiltered query and matched by `minLevel`/`levels`/`level`. If you construct an adapter standalone (e.g. a `PostgresAdapter` used only for querying, never registered on the logger), pass the same map via the adapter's `levels` option.

**Type** — the level names understood by `LogLevel`-typed APIs (the `query` filters, `LogLevel`, etc.) come from the exported `LogLevels` interface. Register custom levels type-side by augmenting it via declaration merging — carry the rank as the value so it mirrors the runtime map:

```typescript
// types/bored-logs.d.ts (or any ambient .d.ts in your project)
declare module "@campfhir/bored-logs" {
  interface LogLevels {
    audit: 3;
    silly: 8;
  }
}
```

Once augmented, `queryLogs({ minLevel: "audit" })` type-checks, while a typo like `"aduit"` is a compile error. The augmentation is type-only — you still register the runtime rank (`levels` / `addLevels`) as above.

---

## Global attributes

Attributes you want on **every** record — a build commit, a region, a request id — are declared once on `createLogger` instead of repeated at each call site. Any option key that isn't a known `createLogger` option becomes a global attribute:

```typescript
const logger = createLogger({
  application: "checkout",
  version: "0.0.1",
  commit: "e02350",
  region: process.env.AWS_REGION,
});

logger.info("Order placed", { orderId: "o_1" });
// record.attrs → { commit: "e02350", region: "us-west-2", orderId: "o_1" }
```

Globals land in `record.attrs`, so every adapter sees them and the Postgres adapter makes them searchable (`commit:e02350` in [log search](#log-search)) — exactly like an attribute you passed by hand.

### Reserved attribute names

Only the five `$`-prefixed built-in names — `$message`, `$level`, `$timestamp`, `$application`, `$version` — are reserved, so a built-in can never be displaced. They are a compile error as attribute names, and stripped at runtime for untyped callers. **Every ordinary name is yours**, including `message`, `level`, and `timestamp`:

```typescript
logger.info("Done", { timestamp: Date.now(), level: "urgent" }); // ✓
logger.info("Done", { $timestamp: Date.now() }); // ✗ compile error
```

The `$` sigil is the same convention MongoDB uses for reserved operators inside a user-controlled document, and it is deliberately *not* `_`, which in TypeScript already means "private/internal" — this package uses `_name` for its own private class fields.

`application` and `version` are ordinary attributes too — the Postgres adapter fills them in from the logger's `application` / `version` options when the record doesn't carry its own. Passing either at a call site overrides that record's value, the same way any call-site attribute overrides a global:

```typescript
const logger = createLogger({ application: "api" });
logger.info("Task ran", { application: "worker" }); // stored application = "worker"
```

The same sigil applies in [log search](#log-search), so those names stay unambiguous there too: `$timestamp:` searches the `logs` column and `timestamp:` searches your attribute.

**Function values are resolved at each log call**, so an attribute can be computed fresh per record:

```typescript
const logger = createLogger({
  timestamp: () => new Date().toISOString(),
  requestId: () => getRequestContext()?.id,
});
```

A resolver runs **once per `log()` call**, not once per adapter, so every sink sees the same value. If a resolver throws, its attribute is simply omitted — logging never breaks the call site.

Globals also satisfy `{key}` placeholders in a message template, and TypeScript knows it — you don't have to pass them:

```typescript
logger.info("Built from {commit}"); // no attrs argument needed
logger.info("Built from {commit} by {user}", { user: "ada" }); // only `user` is required
```

Call-site attributes win over a global of the same name. Read or replace the map at runtime via `logger.attributes`:

```typescript
logger.attributes = { ...logger.attributes, deploymentId: "d_9" };
```

### Output templates

`logger.template()` sets the layout of the rendered log line, so every record comes out with the same shape. It returns the logger, so it chains off `createLogger`:

```typescript
const logger = createLogger({
  version: "0.0.1",
  commit: "e02350",
}).template("{$timestamp} {$message} {$version} {commit}");

logger.info("something something {userId}", { userId: "123" });
// 2026-08-03T10:22:59.000Z something something 123 0.0.1 e02350
```

The message is interpolated first, then dropped into `{$message}`. The result is written to `record.formatted`; `record.message` and `record.template` are untouched, so search and querying still work on the message alone.

Placeholders come from **two disjoint namespaces**, so it is always obvious which is which:

| Placeholder                                                              | Resolves from                                                          |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `{$message}` `{$level}` `{$timestamp}` `{$application}` `{$version}`     | The record itself. Always wins — no attribute can displace a built-in  |
| anything else, e.g. `{commit}`                                           | The attributes: globals first, then the call site, which wins          |

The `$` sigil makes a built-in unmistakable at a glance, and it keeps every ordinary name available to you. The two namespaces never collide, so `{$message}` and `{message}` are genuinely different things — the record's message, versus an attribute that happens to be called `message`. Same for `{$application}` (the logger's `application` option) and `{application}` (whatever attribute that record carries). The identical sigil selects built-in columns in [log search](#built-in-fields).

Anything unresolved is left literal (`{nope}` stays `{nope}`), and `secure()` / `redact()` values are always masked — a formatted line is safe to print anywhere. `ConsoleAdapter` prints `formatted` verbatim when it is present, without adding its own timestamp/level prefix or attribute pairs, since the template already decides the layout. Pass `null` to clear the template and restore the default formatting.

#### Timestamp rendering

`{$timestamp}` defaults to ISO-8601 UTC. `renderTimestamp()` changes how it renders — **storage is unaffected**; the database always records the full timestamp with offset:

```typescript
// Presets: "iso" (default) | "epoch" | "time" | "date" | "datetime"
logger.template("{$timestamp} {$message}").renderTimestamp("time");
// 11:22:59 AM  something something 123

// Locale-aware, via Intl.DateTimeFormat options (+ optional locale)
logger.renderTimestamp({ locale: "de-DE", dateStyle: "short", timeStyle: "medium" });
// 03.08.26, 11:22:59  something something 123

// Or any custom format via a callback
logger.renderTimestamp((d) => d.toLocaleString());
```

The `time` / `date` / `datetime` presets use the host's locale via `Intl.DateTimeFormat`; pass the options-object form to pin a locale or time zone explicitly. A callback that throws falls back to ISO rather than breaking the log call, and `renderTimestamp(null)` resets to ISO. The renderer only touches the `{$timestamp}` built-in — an attribute of yours named `timestamp` is rendered like any other attribute.

> Records fed in through `logger.ingest()` (browser logs shipped to an ingest handler) arrive already complete and are **not** re-rendered or given the server's global attributes.

---

## Secure values

Wrap individual attribute values — or an entire message template — with `secure()` to mark them for encryption at rest. On the **server** the console adapter masks secure values as `[secure]` (a server console is a shared, often-aggregated environment); in the **browser** it shows the real value (private devtools). Override this per-adapter with `maskSecure`.

```typescript
import { logger, secure } from "@/lib/logger"; // re-export secure from your lib, or import directly
import { secure } from "@campfhir/bored-logs";

// Secure individual attribute values
logger.info("Sensitive event", { ssn: secure("123-45-6789"), userId: "u_1" });

// Secure the entire message template (whole message stored encrypted)
logger.info(secure("SSN submitted {ssn}"), { ssn: "123-45-6789" });
```

Encryption only takes effect when `encrypt`/`decrypt` are provided to `PostgresAdapter`. Without them, secure values are stored as plaintext but are still redacted from console output.

### `redact()` — never transmit or persist

`redact()` is the counterpart to `secure()` for data that should stay on the box it originates on. Where `secure()` says *"send this to my server so it can be encrypted at rest,"* `redact()` says *"show this in local output, but never ship or store it in plaintext."*

```typescript
import { redact } from "@campfhir/bored-logs";

logger.info("Auth attempt {token}", { token: redact(rawToken), userId: "u_1" });
```

| Boundary                          | `secure(v)`                          | `redact(v)`                                  |
| --------------------------------- | ------------------------------------ | -------------------------------------------- |
| Browser console (`ConsoleAdapter`)| the **real value** (private devtools)| the **real value**                           |
| Server console (`ConsoleAdapter`) | `[secure]` (shared environment)      | `**REDACTED**`                               |
| Persisted (`PostgresAdapter`)     | encrypted (with `encrypt`/`decrypt`) | `**REDACTED**` placeholder                   |
| Shipped from the browser (`useLogger`) | shipped tagged, encrypted server-side | `**REDACTED**` or omitted — **never in plaintext** |

Console masking is auto-detected (server masks, browser reveals) and can be forced either way with the `ConsoleAdapter` `maskSecure` option.

Both wrappers work in a message template (the placeholder appears in the interpolated message) and as an attribute value. See [Client-side logging](#client-side-logging-uselogger) for how the two behave over the wire.

---

## Programmatic query builder

Build an attribute filter in code — no string grammar, no precedence rules — then run it or hand it anywhere `attributeFilter` is accepted:

```typescript
import { where, literal } from "@campfhir/bored-logs";

const results = await where("session.id").eq("123")
  .and(where("users[*]").eq("123"))     // any array element
  .or(where("$level").eq("error"))      // built-in columns work too
  .execute(logger, { limit: 50 });      // or pass a PostgresAdapter directly

if (results.ok) console.table(results.val);
```

Start a filter with `where(key)` — dotted/bracketed keys are [nested paths](#nested-attribute-paths), `$`-prefixed keys are the built-in columns — or `literal(key)` for a flat attribute whose name contains dots. Then pick an operator:

| Method | Grammar equivalent |
| --- | --- |
| `.eq(v)` / `.notEq(v)` | `key:='v'` / `key:!='v'` |
| `.contains(v)` / `.notContains(v)` | `key:'v'` / `key:!'v'` |
| `.gt(v)` `.gte(v)` `.lt(v)` `.lte(v)` | `key:>'v'` … |
| `.isNull()` / `.isNotNull()` | `key:=null` / `key:!=null` |

Values may be strings, numbers, booleans, or `Date`s (serialized to ISO). Builders are **immutable** — every call returns a new one — and combine **left-to-right**: `X.and(Y).or(Z)` means `(X AND Y) OR Z`, reading like the chain. (The string grammar differs: there `||` binds tighter than AND.)

Terminals:

- **`.build()`** — the `FilterExpr` tree, in the same normal form the string parser produces; pass to `query({ attributeFilter })`.
- **`.toQueryString()`** — the string-grammar form; pasteable into `LogSearchBar` and guaranteed to re-parse to the same tree.
- **`.execute(target, options?)`** — runs the query. `target` is a `Logger` (routes through `queryAdapter()`) or a queryable adapter; `options` is everything `query()` accepts except `attributeFilter`. Returns the same `Result` as `query()`.

Mistakes fail fast at build time instead of silently matching nothing: a malformed bracket path (`where("users[*")`) or an unparseable `$timestamp` value throws a `TypeError` with the fix in the message.

---

## Server actions

Call `adapter.query()` and `adapter.purge()` directly from your own server actions. Wrap them to add authentication and role checks.

```typescript
// src/actions/logs.ts
"use server";

import type { LogQueryOptions } from "@campfhir/bored-logs";
import { logger } from "@/lib/logger";
import { auth } from "@/lib/auth";
import { requireRole } from "@/lib/utils/permissions";

export async function queryLogs(options?: LogQueryOptions) {
  const session = await auth();
  requireRole(["admin"], session);
  const result = await logger.queryAdapter().query(options ?? {});
  if (!result.ok) throw new Error(result.err.message);
  return result.val;
}

export async function purgeLogs(until: string) {
  const session = await auth();
  requireRole(["admin"], session);
  // Returns immediately with the impacted counts and a job id — the deletion
  // runs in the background. See "purge — asynchronous with confirmation".
  return logger.queryAdapter().purge(new Date(until)); // Result<PurgeJob, PurgeError>
}

export async function confirmPurge(id: string) {
  const session = await auth();
  requireRole(["admin"], session);
  return logger.queryAdapter().confirmPurge(id);
}

export async function purgeStatus(id: string) {
  const session = await auth();
  requireRole(["admin"], session);
  return logger.queryAdapter().purgeStatus(id);
}
```

### `query` options

| Option             | Type                | Default        | Description                                                |
| ------------------ | ------------------- | -------------- | ---------------------------------------------------------- |
| `start`            | ISO string          | 24 hours ago   | Start of time range                                        |
| `end`              | ISO string          | now            | End of time range                                          |
| `level`            | `LogLevel`          | all levels     | Filter by a single exact level                             |
| `levels`           | `LogLevel[]`        | all levels     | Filter by a set of exact levels                            |
| `minLevel`         | `LogLevel`          | all levels     | Severity threshold — this level and everything more severe |
| `message`          | string              | —              | Substring match on the message                             |
| `limit`            | number              | 250 (max 1000) | Number of rows to return                                   |
| `offset`           | number              | 0              | Pagination offset                                          |
| `sort`             | `"asc" \| "desc"`   | `"desc"`       | Sort direction                                             |
| `attributeFilter`  | `FilterExpr`        | —              | Boolean filter tree (`\|\|` / `&&` / grouping) from `parseLogQueryExpr` |

`attributeFilter` is the single filter input: a boolean tree (supports OR/grouping) that matches stored attributes (including [nested paths](#nested-attribute-paths)) and the `$`-prefixed built-in columns (`$message`, `$timestamp`, `$level` — see [Built-in fields](#built-in-fields)). It is ANDed with the timestamp range, level filter, and `message` option. Build it with `parseLogQueryExpr` or the [query builder](#programmatic-query-builder); see [Log search](#log-search).

`level`, `levels`, and `minLevel` are mutually exclusive — the type makes combining them a compile-time error. Omit all three to query every level. `minLevel` uses the same ranking as the emit gate (lower rank = more severe): `minLevel: "warn"` yields `warn`, `error`, `critical`; `minLevel: "debug"` yields everything. These fields are typed as `LogLevel` (`keyof LogLevels`) — to pass a custom level here, augment the `LogLevels` interface (see [Custom levels](#custom-levels)). An unknown level name still returns an `Err("invalid log level")` at runtime.

### `purge` — asynchronous, with confirmation

`purge(until: Date, options?: PurgeOptions): AsyncResult<PurgeJob, PurgeError>`

Purging never blocks the caller on the deletion, so a large purge cannot time out the request that started it:

1. **`purge(until)`** counts the impacted rows up front and **returns immediately** with a `PurgeJob` — the counts (`logCount`, `attrCount`, `totalCount`), an `id`, and a `status`.
2. Below the confirmation threshold the **deletion starts in the background** right away, in small batches (each its own short transaction — nothing runs long enough to hit a statement timeout, and normal writes/queries interleave between batches).
3. At or above the threshold (**default 10 000** impacted rows, logs + attrs) the job parks as `"awaiting-confirmation"` and **nothing is deleted** until you call **`confirmPurge(id)`** — the guard against accidentally grinding the database with an enormous delete.
4. **`purgeStatus(id)`** is the check-in: `status` (`awaiting-confirmation` → `running` → `completed` / `failed` / `aborted`) plus live progress (`deletedLogs`, `deletedAttrs`).

```typescript
const planned = await adapter.purge(new Date("2026-01-01"));
if (planned.ok && planned.val.requiresConfirmation) {
  // surface planned.val.totalCount to the operator, then:
  await adapter.confirmPurge(planned.val.id);
}
// poll purgeStatus(planned.val.id) until status is no longer "running"
```

| Option                          | Type     | Default  | Description                                                     |
| ------------------------------- | -------- | -------- | --------------------------------------------------------------- |
| `options.confirmationThreshold` | `number` | `10 000` | Impacted-row count (logs + attrs) requiring `confirmPurge`      |
| `options.batchSize`             | `number` | `1 000`  | Logs deleted per background batch                               |

Both defaults are configurable on the adapter: `new PostgresAdapter({ db, purgeConfirmationThreshold, purgeBatchSize })`.

**Jobs are persistent and multi-instance safe** (migration `003_purge_jobs`, tables `log_purge_job` + `log_purge_ids`):

- When deletion starts, the impacted log ids are captured into `log_purge_ids` and **drained batch by batch** — each batch is a single atomic statement, progress is exact, and the ids never leave the database (callers only ever see the job id and aggregate counts).
- The whole flow works **across processes**: any instance can `confirmPurge` / `purgeStatus` a job planned by another, since the row is the source of truth.
- A **TTL lock** (`purgeLockTtlMs`, default 60 s, re-extended every batch) ensures exactly one instance processes a job. If that instance dies or is closed mid-run, the job's row stays `"running"` with its lock released/expired, and the **sweep** — automatic every `purgeSweepIntervalMs` (default 60 s, `0` disables), or manual via `adapter.sweepPurgeJobs()` — claims and resumes it from the surviving ids.
- Completion **keeps the job row** (`status: "completed"` + `finishedAt`), so *any* instance — including one that never saw the job — can report the outcome from the id. The sweep prunes terminal (completed / failed) rows after `purgeJobRetentionMs` (default 24 h, `0` = keep forever); a pruned id reports `unknown purge id`.

### `deepPurge` options

`deepPurge(until: Date, opts?: { timeoutMs?: number }): AsyncResult<number, string>`

Deletes all matching records with no record-count limit. Uses a single `DELETE … USING` per table to avoid loading IDs into memory — suitable for large historical purges.

| Parameter        | Type     | Default  | Description                                                              |
| ---------------- | -------- | -------- | ------------------------------------------------------------------------ |
| `until`          | `Date`   | required | Delete records on or before this timestamp                               |
| `opts.timeoutMs` | `number` | `0`      | Postgres `statement_timeout` for the transaction in ms. `0` = no timeout |

### Filter leaves (`LogQueryToken`)

The `FilterExpr` tree passed to `attributeFilter` is built from comparison leaves. You rarely construct these by hand — `parseLogQueryExpr` (from a query string) and the [query builder](#programmatic-query-builder) produce them — but the shape is:

```typescript
type LogQueryToken = {
  key: string;                                          // "$message" when no key was given
  operator: "contains" | "=" | ">" | ">=" | "<" | "<=";
  value: string;
  negated?: boolean;      // NOT — combines with any operator (`key:!='x'`, `key:!>'5'`)
  literalKey?: boolean;   // a quoted key that IS a valid path → treat as a flat name, not a path
  nullValue?: boolean;    // bare `null`/`NULL` → the null literal (value normalized to "null")
  cast?: "string";        // `::string` → force lexicographic comparison (see below)
};
```

Negation composes with every operator, including the comparisons (`key:!>'5'`, `key:!<='x'`). Comparison operators (`>`, `>=`, `<`, `<=`) dispatch on the **filter value's** shape, and each branch only compares against compatibly-typed stored values:

| Filter value looks like | Comparison | Participating rows |
| --- | --- | --- |
| a number (`'100'`) | numeric (`::numeric`) | values whose text is numeric — includes numbers stored as strings |
| an ISO/RFC date (`'2003-01-02'`) | chronological (`::timestamptz`) | values whose text is date-shaped |
| anything else (`'M'`) | lexicographic text | **string-typed values only** |

The casts are regex-guarded so incompatible rows are *excluded* rather than raising errors, and the text branch is gated to string-typed values — so a stored `userId = 123` is never swept into a lexicographic comparison by `userId:<'A'` (where `'123' < 'A'` would spuriously match). There is no cross-type fallback in either direction; the same rules apply inside [nested paths](#nested-attribute-paths).

**Explicit text comparison — `::string`.** Append `::string` to a *quoted* value to opt out of the type dispatch entirely: the comparison is lexicographic and number/date values are **coerced to their text form** and included (`123` compares as `'123'`, dates as their ISO string):

```
count:>'100'::string        # lexicographic — matches count = 20 ('20' > '100')
version:<='v1.10'::string   # order version-ish strings as text
users[*]:>'5'::string       # array elements of any type compare as text
```

The cast works on flat attributes and [nested paths](#nested-attribute-paths) alike; it is rejected on the `$` built-in keys, where the columns are genuinely typed. In the [query builder](#programmatic-query-builder): `where("count").gt("100", { cast: "string" })`.

---

## Client-side logging (`useLogger`)

Client Components run in the browser and can't reach your server logger or the database directly. `LoggerProvider` builds a real client-side `Logger` and `useLogger` returns it — the same typed message-template API as the server logger. Each call fans out to the logger's adapters:

1. a **`ConsoleAdapter`** (on by default) → the browser devtools console;
2. an **`HttpAdapter`** → batches records and ships them over HTTP to a server endpoint you control, where a Route Handler feeds them to your normal server logger (and therefore to `PostgresAdapter`, etc.);
3. **any adapters you pass** via the `adapters` prop — the provider is the place to add more sinks later.

Two package entrypoints are involved:

- `@campfhir/bored-logs/client` — `LoggerProvider`, `useLogger` (a `"use client"` module).
- `@campfhir/bored-logs/adapters/http` — `HttpAdapter`, the universal (browser + Node/Edge) batching HTTP log adapter that does the shipping. Registered for you by `LoggerProvider`, but usable standalone on any logger.
- `@campfhir/bored-logs/server` — `createLogIngestHandler`, which builds the receiving Route Handler.

The ship transport is a plain `POST` of `{ logs: ClientLogRecord[] }` with `content-type: application/json` — a standard `fetch` (with a `sendBeacon` fallback on page unload so in-flight logs aren't lost). Bring your own auth: attach headers or send cookies via the provider options, and enrich or authorize on the server via `transform`.

> **Handling sensitive data.** Two wrappers control what crosses the wire (see [Secure values](#secure-values)):
> - **`secure(value)`** — a sensitive *attribute* is shipped with its tag intact so `PostgresAdapter` **encrypts it at rest** server-side (over HTTPS to your own endpoint). A whole `secure()` *message* has no encryptable column, so its text is shipped as `[secure]`, matching the server logger.
> - **`redact(value)`** — **never shipped in plaintext**: replaced with `**REDACTED**` (or omitted entirely when `redactMode="omit"`). Use it for data that must not leave the browser or reach the logs database.

### 1. Server: an ingest Route Handler

```typescript
// app/api/logs/route.ts
import { createLogIngestHandler } from "@campfhir/bored-logs/server";
import { logger } from "@/lib/logger";
import { auth } from "@/lib/auth";

export const POST = createLogIngestHandler({
  logger,
  // Optional: enrich every record with server-only data, or drop it (return null).
  transform: async (record, request) => {
    const session = await auth();
    return {
      ...record,
      attrs: {
        ...record.attrs,
        userId: session?.user?.id,
        ip: request.headers.get("x-forwarded-for") ?? undefined,
      },
    };
  },
});
```

Records arrive already interpolated and timestamped on the client; the handler reconstructs each `LogRecord` (preserving the client's timestamp) and calls `logger.ingest(record)`, which applies the logger's level gate and dispatches to every adapter **without re-interpolating**.

### 2. Client: wrap your app with `LoggerProvider`

```tsx
// app/providers.tsx
"use client";

import { LoggerProvider } from "@campfhir/bored-logs/client";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <LoggerProvider
      endpoint="/api/logs"
      application="web"
      level="info"
      credentials="include" // send cookies so `auth()` works in the handler
      // console          // ConsoleAdapter is on by default; pass `false` to disable,
      //                  // or an options object (e.g. { level: "warn" }).
      // adapters={[...]} // register additional client adapters here
    >
      {children}
    </LoggerProvider>
  );
}
```

The provider builds one `Logger` per mount with the console + ship adapters (plus any you supply). **Config props are live** — changing `endpoint`, `headers`, `credentials`, `level`, `application`, `version`, `serializeValue`, or `levels` re-syncs the running logger and transport without tearing down the queue. The **structural adapter props `console` and `adapters` are read once at mount** (reactively adding/removing sinks would strand buffered records) — set them when you mount the provider.

### 3. Log from Client Components

```tsx
"use client";

import { useLogger } from "@campfhir/bored-logs/client";

export function CheckoutButton({ cartId }: { cartId: string }) {
  const logger = useLogger();

  return (
    <button
      onClick={async () => {
        logger.info("Checkout started for {cartId}", { cartId });
        try {
          await pay();
        } catch (err) {
          logger.error("Payment failed: {reason}", { reason: String(err), cartId });
        }
      }}
    >
      Pay
    </button>
  );
}
```

`useLogger()` returns a client `Logger` (`ClientLogger`) — `log(level, template, attrs)` plus a method per built-in level (`info`, `error`, …), `flush()`, and `addLevels()`. Server-only methods (`ingest`, `queryAdapter`, process hooks via `on`, `close`) are omitted from the type, since they throw or no-op in the browser. Each call writes to the browser console and queues a shipment; batches flush automatically when the batch fills, on an interval, and on page unload. Need the transport directly (e.g. to read `pending` or force a `flush()`)? Use `useLogShipper()`, which returns the `HttpAdapter`.

`secure()` and `redact()` behave per [the boundary table](#redact--never-transmit): in the **browser console** both show the real value (private devtools); over the wire `secure()` ships tagged for server-side encryption and `redact()` is scrubbed.

### `LoggerProvider` options

| Option              | Type                                                             | Default     | Description                                                              |
| ------------------- | --------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------ |
| `endpoint`          | `string`                                                        | required    | URL the batched logs are `POST`ed to (your ingest Route Handler)         |
| `application`       | `string`                                                        | —           | Stamped on every record                                                  |
| `version`           | `string`                                                        | —           | Stamped on every record                                                  |
| `level`             | `string`                                                        | `"debug"`   | Minimum level the logger emits — gates both console and shipping         |
| `levels`            | `Record<string, number>`                                        | —           | Custom level ranks merged into the built-ins for the client gate         |
| `console`           | `boolean` \| `ConsoleAdapterOptions`                            | `true`      | Include a `ConsoleAdapter` for browser devtools; `false` disables it, or pass options |
| `adapters`          | `LogAdapter[]`                                                  | —           | Extra adapters registered on the client logger (after console + shipping) |
| `batchSize`         | `number`                                                        | `20`        | Flush automatically once this many records are queued                    |
| `flushInterval`     | `number`                                                        | `5000`      | Flush every N ms while records are queued (`0` disables the timer)       |
| `maxQueue`          | `number`                                                        | `1000`      | Cap on buffered records; the oldest are dropped when full                |
| `headers`           | `Record<string,string>` \| `() => Record<string,string>`        | —           | Extra request headers (e.g. a CSRF or auth token); may be async          |
| `credentials`       | `RequestCredentials`                                            | —           | `fetch` credentials mode — use `"include"` to send cookies               |
| `transport`         | `(payload, endpoint) => void \| Promise<void>`                  | `fetch`     | Full delivery override; when set, `headers`/`credentials` are ignored    |
| `useBeaconOnUnload` | `boolean`                                                       | `true`      | Flush via `navigator.sendBeacon` when the page is hidden/unloaded        |
| `serializeValue`    | `(value: unknown) => string`                                    | JSON/String | How non-string attribute values are rendered into message templates      |
| `redactMode`        | `"placeholder" \| "omit"`                                       | `"placeholder"` | Whether a `redact()`ed attribute is scrubbed to a placeholder or dropped |
| `redactPlaceholder` | `string`                                                        | `"**REDACTED**"` | The text substituted for `redact()`ed values                        |
| `onError`           | `(err: unknown, logs: ClientLogRecord[]) => void`               | —           | Called when a flush fails; the failed batch is re-queued for retry       |

### `createLogIngestHandler` options

| Option      | Type                                                                       | Default           | Description                                                                              |
| ----------- | -------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `logger`    | `{ ingest(record): void }`                                                 | required          | Your server logger (any `Logger` satisfies this) that shipped records are written to     |
| `maxBatch`  | `number`                                                                   | `100`             | Reject batches larger than this with `413`                                               |
| `transform` | `(record, request) => LogRecord \| null \| Promise<...>`                   | —                 | Per-record hook to enrich records (IP, session, …) or drop them (return `null`)          |
| `onError`   | `(err: unknown, request: Request) => void`                                 | `console.error`   | Called when handling throws (returns `500`)                                              |

The handler responds with `200` (`{ accepted }`), `400` (malformed body), `405` (non-`POST`), `413` (batch too large), or `500` (ingest threw). Invalid individual records in an otherwise-valid batch are skipped, not fatal.

### Next.js and console output

`ConsoleAdapter` writes with the platform `console`, so **where its lines appear depends on where the code runs** — which in Next.js is not always where you'd expect:

- **Server logger** (`instrumentation.ts`, server actions, route handlers) → the **server terminal / platform logs**. This is the shared, aggregated environment, so `ConsoleAdapter` masks `secure()`/`redact()` there (`maskSecure` defaults to `true`).
- **Client logger** (`useLogger`) → the **browser devtools console** once hydrated, where `maskSecure` defaults to `false` and the real values show. But a Client Component is also rendered **on the server during SSR/prerender**, and any log emitted in that pass runs server-side — it prints to the terminal (masked), not the browser. The adapter keys its masking on `typeof window`, so the same code masks during SSR and reveals after hydration automatically.

Two Next.js config settings to be aware of:

- **`compiler.removeConsole`** strips `console.*` calls from production builds via SWC. If you enable it, `ConsoleAdapter` output disappears in production. Because the adapter routes by severity (`console.error` for `error`/`critical`, `console.warn` for `warn`, else `console.log`), keep the levels you care about by excluding them: `compiler: { removeConsole: { exclude: ["error", "warn"] } }`. Note this only affects the **console** — the `HttpAdapter` (and `PostgresAdapter`) ship/persist independently, so your logs still reach the server even when console output is stripped.
- **`serverExternalPackages`** (or `transpilePackages`) — see [Installation](#installation); unrelated to console output, but required so the server adapters aren't bundled.

---

## Shipping logs between applications

The same `HttpAdapter` → `createLogIngestHandler` pipeline that ships browser logs works **service-to-service**: any number of separate applications ship their logs over HTTPS to one central log server that owns the database.

```
App A (api)     ──┐
App B (worker)  ──┼── HTTPS POST /api/logs ──▶  Log server ── PostgresAdapter ──▶ Postgres
App C (browser) ──┘        (batched JSON)        (ingest + query UI)
```

### The shipping application (App A)

A normal logger with a standalone `HttpAdapter` — no database, no `pg` dependency:

```typescript
// app-a/src/logger.ts
import { createLogger, ConsoleAdapter } from "@campfhir/bored-logs";
import { HttpAdapter } from "@campfhir/bored-logs/adapters/http";

export const logger = createLogger({
  application: "app-a",          // travels on every record — searchable on the server
  version: process.env.APP_VERSION,
});

logger.addAdapter(new ConsoleAdapter());
logger.addAdapter(
  new HttpAdapter({
    endpoint: "https://logs.example.com/api/logs",
    headers: { authorization: `Bearer ${process.env.LOG_SHIP_TOKEN}` },
    batchSize: 50,               // flush every 50 records…
    flushInterval: 5000,         // …or every 5 s, whichever first
    onError: (err) => console.error("[log-ship] delivery failed", err),
  }),
);

// Don't lose the tail on shutdown — flush() drains the HttpAdapter queue.
logger.on("SIGTERM", async () => {});
```

Failed deliveries are re-queued for the next flush (bounded by `maxQueue`, default 1 000, oldest dropped first), so a briefly unreachable log server doesn't lose recent records or block the app.

### The log server (App B)

One ingest endpoint feeding a logger that owns the `PostgresAdapter`. `createLogIngestHandler` returns a standard `(Request) => Promise<Response>`, so it mounts on Next.js, Hono, or anything Fetch-shaped — wrap it for auth:

```typescript
// log-server/app/api/logs/route.ts
import { createLogIngestHandler } from "@campfhir/bored-logs/server";
import { logger } from "@/lib/logger"; // createLogger() + PostgresAdapter

const ingest = createLogIngestHandler({
  logger,
  maxBatch: 100, // advertised to shippers on every response (see below)
  // Enrich or reject per record; the Request is available for headers/IP.
  transform: (record, req) => ({
    ...record,
    attrs: { ...record.attrs, shippedFrom: req.headers.get("x-forwarded-for") },
  }),
});

export async function POST(req: Request): Promise<Response> {
  if (req.headers.get("authorization") !== `Bearer ${process.env.LOG_SHIP_TOKEN}`) {
    return new Response(null, { status: 401 });
  }
  return ingest(req);
}
```

### Semantics across the wire

- **Source identity** — each record carries the *shipper's* `application` / `version` (`ingest()` preserves them rather than stamping the server's own), so one database serves many apps and `application:'app-a'` in [log search](#log-search) isolates a single app's logs.
- **`secure()` values ship tagged** and are encrypted at rest by the log server's `PostgresAdapter` (when configured with `encrypt`/`decrypt`) — the shipping app needs no key material.
- **`redact()` values never leave the shipping app** — scrubbed to the placeholder (or omitted, via `redactMode: "omit"`) before the request is built.
- **Level gating is layered**: the shipper's logger level → its `HttpAdapter.level` (ship less than you print locally, e.g. `level: "info"`) → the log server's own logger/adapter levels.
- **Custom levels** must be registered on both sides (`createLogger({ levels })`) so gating and query defaults recognise them.
- **Timestamps are the shipper's** — records carry the original event time, not arrival time.
- **Batch size negotiates itself** — every ingest response advertises the server's `maxBatch` via the `x-log-max-batch` header. The `HttpAdapter` learns it, chunks future shipments to fit, and recovers from a 413 *within the same flush* by re-sending in smaller chunks (halving against an older server without the header). An outage backlog larger than the server's limit therefore drains in sequential chunks instead of wedging the queue — no need to align `batchSize` and `maxBatch` by hand.

### Authenticating the pipeline

Auth is deliberately **abstracted to your choice** on both ends — the library never dictates a scheme:

- **Client** — `headers` accepts an async function, resolved fresh for every shipment *and* for registration. That's the seam for any token flow:

  ```typescript
  new HttpAdapter({
    endpoint: "https://logs.example.com/api/logs",
    // OAuth2 client-credentials: cache + refresh inside your provider —
    // a fresh Authorization header per shipment, expiry self-heals.
    headers: async () => ({ authorization: `Bearer ${await tokenProvider.get()}` }),
    encryption: {},
  });
  ```

- **Server** — both handlers take an `authorize(request)` hook, called with the raw `Request` before *anything* else (for ingest: before body parsing and before any decryption/signature work, so unauthenticated traffic pays no crypto cost):

  ```typescript
  const authorize = async (request: Request) =>
    verifyAccessToken(request.headers.get("authorization")); // introspection, JWKS, mTLS header — your call

  createLogIngestHandler({ logger, authorize, encryption: { context: e2e } });
  createLogRegistrationHandler(e2e, { authorize }); // TOFU protection uses the SAME policy
  ```

A failed client token simply re-queues the batch; the next flush re-resolves `headers` and retries with a fresh one.

### End-to-end payload encryption

Opt in to encrypting the shipment itself — beyond TLS — so the payload is opaque to TLS-terminating proxies and logging middleboxes, and every batch is **cryptographically signed by the shipping client**:

```typescript
// Shipper — one option:
new HttpAdapter({
  endpoint: "https://logs.example.com/api/logs",
  headers: { authorization: `Bearer ${token}` }, // still sent (auth) — see TOFU note
  encryption: {},                                 // ← that's it
});

// Log server — a shared context feeds both handlers:
import {
  createE2EServerContext, createLogIngestHandler, createLogRegistrationHandler,
} from "@campfhir/bored-logs/server";

const e2e = createE2EServerContext();
export const POST = createLogIngestHandler({ logger, encryption: { context: e2e } });
// mounted at <endpoint>/register (the adapter's default guess):
export const registerPOST = createLogRegistrationHandler(e2e);
```

**How it works (v1 suite `ecdh-p256+a256gcm+ecdsa-p256`):** the adapter registers itself eagerly (at `start()` or the first `write`) — it sends its ECDSA P-256 public signing key, the server answers with its ECDH P-256 public encryption key. Each POST then derives a fresh AES-256-GCM key (ephemeral ECDH + HKDF — single-use, so IV reuse is structurally impossible), ships the **ciphertext as the raw request body**, and carries the envelope in `x-bored-logs-*` headers (`algo`, `client`, `key`, `iv`, `ts`, `nonce`, `sig`). The signature covers every envelope field *and* the ciphertext, so stripping, reordering, algo-downgrade, or clientId substitution all fail verification. The server verifies the signature **first**, then enforces freshness (`clockSkewMs`, default 5 min) and replay protection (per-client nonce cache), then decrypts into the normal ingest pipeline. Plaintext shipping is untouched unless you set `required: true`, which rejects it with `400 encryption-required`.

**Self-healing:** the default registration store is in-memory — a server restart forgets clients. The server answers `401` + `x-bored-logs-error: unknown-client` (or `decrypt-failed` after a key rotation), and the adapter transparently re-registers and re-sends the same batch, in order. Persist across restarts with `await e2e.exportKeys()` → pass back as `keys`, and/or implement `E2ERegistrationStore` against your database. Give shippers a persistent identity via `generateE2ESigningKeys()` → `encryption: { clientId, signingKeys }`.

**What to know before relying on it** (each risk with its built-in mitigation):

- **Registration is trust-on-first-use — mitigated by key pinning (default).** Once a clientId is registered, re-registration with the *same* signing key is idempotent (restart recovery), but a *different* key answers `409 client-key-conflict` — reaching the endpoint no longer suffices to take over an identity. Give stable clients a persistent identity (`generateE2ESigningKeys()` → `encryption.signingKeys`); rotate a client's key deliberately via `store.delete(clientId)`; `registration: "open"` opts back into last-write-wins. Still gate the endpoint: `createLogRegistrationHandler(ctx, { authorize: (req) => … })` runs before anything touches the store (the adapter sends its `headers`/`credentials` to registration too).
- **TLS stays on; rotate the server key.** This is defense-in-depth: a compromise of the server's static key decrypts traffic captured since the last rotation (client ephemerals only protect against *client* compromise). `await ctx.rotateKeys()` on a schedule bounds that window — clients self-heal via `decrypt-failed` → re-register, no coordination needed.
- **Unload never downgrades — and rarely drops.** `sendBeacon` can't carry the envelope, so the unload tail goes through an async seal + keepalive fetch; records that can't be sealed are **dropped, never sent in the clear** (reported via `onError`). `start()` registers the session eagerly, so "not yet registered at unload" is a cold-start corner case, not the norm.
- **Fail-fast without WebCrypto.** Configuring `encryption` in a runtime without `crypto.subtle` (e.g. an insecure `http://` page) throws at construction — you find out at dev time, not by watching every flush fail. Browsers need a secure context (https/localhost); Node ≥ 18, Deno, and Edge are covered.
- **Restart amnesia is optional.** The in-memory store self-heals via re-registration; for zero-re-registration restarts and multi-instance servers, use the durable store — `new PsqlE2ERegistrationStore(db)` (migration `004_e2e_clients`) — plus persisted server keys via `exportKeys()` (keys belong in your secret manager, not the log DB).
- `encryption` + `transport` throws — a custom transport would receive plaintext.
- Batch-size negotiation, `secure()`/`redact()` semantics, and every response shape are unchanged.

In the browser, the same option threads through the provider: `<LoggerProvider endpoint="/api/logs" encryption={{}} />`.

A runnable two-process version of this exact topology lives in [`demos/shipping/`](demos/shipping/); the [web demo](demos/web/) exercises the same pipeline with the browser as the shipping "app"; a Node service differs only in construction (`HttpAdapter` added by hand, flush wired to process exit instead of page unload).

## Log search

Turn an Elasticsearch-style query string into a filter tree:

- **`parseLogQueryExpr`** (recommended) — parses the full boolean grammar (`||`, `&&`/whitespace, `()`) into a `FilterExpr` tree you pass straight to `query({ attributeFilter })`. Returns a `Result` so malformed input (including an unparseable `$timestamp:` date) is a value, not a throw.
- **`parseLogQuery`** — a flat, AND-only tokenizer that returns `LogQueryToken[]` (no OR/grouping, no validation). Useful for building your own tree or chip UI.

### Syntax

| Expression                  | Meaning                        |
| --------------------------- | ------------------------------ |
| `bare word`                 | message contains               |
| `key:'value'`               | attribute contains             |
| `key:='value'`              | attribute exact match          |
| `key:>'value'`              | attribute `>` value            |
| `key:>='value'`             | attribute `>=` value           |
| `key:<'value'`              | attribute `<` value            |
| `key:<='value'`             | attribute `<=` value           |
| `key:!'value'`              | attribute does NOT contain     |
| `key:!='value'`             | attribute does NOT equal       |
| `'key with spaces':'value'` | quoted key                     |
| `a b` / `a && b`            | AND                            |
| `a \|\| b`                  | OR (binds tighter than AND)    |
| `(a b) \|\| c`              | grouping                       |

So `a b \|\| c` reads as `a AND (b OR c)`; write `(a b) \|\| c` for `(a AND b) OR c`. Keys and values accept single or double quotes.

#### Built-in fields

Three `$`-prefixed keys map to real columns on the `logs` table instead of stored attributes — the same sigil the logger uses for [output-template built-ins](#output-templates), and the same five names it reserves. **A key without `$` is always an attribute lookup**, so an attribute named `level` is searchable as `level:` and never collides with the column:

| Key                       | Column               | Behaviour                                                                                                   |
| ------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `$message` / `$msg`       | `logs.message`       | `LIKE` contains. Bare free text (`payment failed`) is shorthand for this                                    |
| `$timestamp`              | `logs.logged_timestamp` | Compared as a proper timestamp. Accepts ISO/RFC date or date-time strings — e.g. `$timestamp:>'2003-01-02'`, `$timestamp:<='2024-06-01T12:00:00Z'`. A bare date with `:` / `:=` (`$timestamp:'2003-01-02'`) matches the whole calendar day. Unparseable values are a parse error. |
| `$level`                  | `logs.level`         | Case-insensitive: `$level:='error'` exact, `$level:'err'` contains. Range operators compare **severity**: `$level:>='error'` = error or more severe (like the `minLevel` option), `$level:<='info'` = info or more verbose, `>`/`<` strict. Custom levels participate by rank; an unknown name with a range operator returns `Err("invalid log level")`. Level *sets* are just ORs: `$level:='warn' \|\| $level:='debug'`. |

Any other key — `$`-less, or `$application` / `$version`, which are stored as ordinary attributes — is an attribute lookup against `log_attr`.

> **`$timestamp:` is intersected with the query's date window.** `query()` always constrains results to `[start, end]` (default: the last 24 hours). A `$timestamp:` term narrows *within* that window — it doesn't widen it. To search historical logs, widen the window via the `start` / `end` options (or the [`LogDateRangePicker`](#logdaterangepicker)).

#### Nested attribute paths

Attributes holding objects or arrays are stored as JSON and can be queried **into** with dot and bracket paths:

```
session.id:'123'          # field of an object attribute
users[*]:='123'           # ANY element of an array attribute (exact match)
users[0]:='123'           # a specific index
cart.items[*].sku:='A-1'  # paths combine — objects inside arrays
scores[*]:>'30'           # numeric comparison across elements
```

Semantics mirror flat attributes: `=` on a path matches both the JSON string `"123"` and the number `123`; comparisons are numeric or chronological when the value looks numeric/ISO-dated; `contains` does substring matching on **string** elements. Negation (`users[*]:!='123'`) matches logs where *no* element matches — including logs without the attribute.

**Bare = path, quoted = literal.** An unquoted dotted key is always a path; quote it to mean a flat attribute literally named with a dot:

```
session.id:'123'          # path: field `id` inside object attr `session`
'session.id':'123'        # literal flat attribute named "session.id"
```

Path segments are **field-name identifiers** — they may not contain the grammar's operator characters (`= < > ! | & ( ) , ' " \` or whitespace/`:`). JSON permits any string as a property name, but a key like `a.b|c` is treated as a flat attribute name, not a path (only clean segments walk into nested structure). `application` / `version` and every `$`-built-in stay ordinary keys as before.

> **Migration note (0.5.0):** previously an unquoted `a.b:'x'` matched a flat attribute named `a.b`. It is now a path — add quotes to keep the old meaning. The search-bar autocomplete inserts dotted flat keys pre-quoted.

Two storage-driven caveats: path filters never match **encrypted** attributes (the ciphertext can't be traversed — so negated path filters *do* match them), and never match attributes whose JSON exceeds 2 000 bytes (routed to unindexed blob storage, same as flat filters).

#### Null literals

An **unquoted** `null` / `NULL` with `:=` or `:` matches the null literal; a **quoted** `'null'` matches the string:

```
reason:=null              # attribute stored as null
reason:!=null             # attribute absent, non-null, or anything else
reason:null               # accepted shorthand for :=null (reason:!null likewise)
session.id:=null          # explicit JSON null at a path (missing keys do NOT match)
reason:='null'            # the four-character string "null"
```

Only presence checks are valid — ordering against null is meaningless, so `reason:>null` (and `>=`, `<`, `<=`) is a **syntax error** rather than a query that silently matches nothing. Quote it (`reason:>'null'`) to lexicographically compare the string.

```typescript
import { parseLogQueryExpr, formatExpr, isUnsatisfiable } from "@campfhir/bored-logs";

const res = parseLogQueryExpr("$level:'error' (service:'db' || service:'payments')");
if (res.ok) {
  const expr = res.val; // FilterExpr | null (null for empty input)
  const result = await queryLogs({ attributeFilter: expr ?? undefined });
} else {
  // res.err.message === QUERY_SYNTAX_ERROR; res.err.cause has the detail
  console.warn(res.err.cause?.message);
}
```

`formatExpr(expr)` renders a tree back to a query string (round-trips through the parser); `formatToken(token)` does the same for a single leaf — useful for filter chips.

Detect impossible filters before hitting the database:

```typescript
import { parseLogQueryExpr, findContradictions, isUnsatisfiable } from "@campfhir/bored-logs";

const { val: expr } = parseLogQueryExpr("count:>'10' count:<'3'");
findContradictions(expr);   // contradicting pairs (works on a tree or a flat token[])
isUnsatisfiable(expr);      // true → the whole query can never match, reject it
```

`findContradictions` reasons over the DNF, so `||` operands are treated as alternatives — a contradiction in one branch doesn't flag the other.

> **Filtering by level:** a `$level:` term matches the real `logs.level` column (see [Built-in fields](#built-in-fields)). Severity thresholds work right in the query string — `$level:>='warn'` is "warn and above" — or via the `level` / `levels` / `minLevel` query options (see [`LogLevelFilter`](#loglevelfilter)).

The flat `parseLogQuery` tokenizer remains for simple AND-only cases — fold its tokens into an `and` tree to pass as `attributeFilter`:

```typescript
import { parseLogQuery, type FilterExpr } from "@campfhir/bored-logs";

const tokens = parseLogQuery("request_id:'abc' status:'ok'");
const attributeFilter: FilterExpr = {
  type: "and",
  nodes: tokens.map((filter) => ({ type: "filter", filter })),
};
const options: LogQueryOptions = { attributeFilter };
```

---

## UI components

All components are **style-less and composable** — no class names are applied internally. Style via the `className` prop on the root element or target the `data-*` attributes provided for each meaningful element. Components are standalone; compose them yourself.

Import from the dedicated entry point to preserve the `"use client"` boundary:

```typescript
import {
  LogTable,
  LogTableRow,
  LogTableRowGroup,
  LogTableRowExpanded,
  formatTimestamp,
  LogCard,
  LogSearchBar,
  LogLevelFilter,
  LogDateRangePicker,
  LogSearchSyntaxHelp,
  PurgeLogsDialog,
} from "@campfhir/bored-logs/components";
import type {
  LogQueryToken,
  SortState,
  ExtraColumn,
  LogTableProps,
  LogTableRowProps,
  LogTableRowGroupProps,
  LogTableRowExpandedProps,
  LogCardProps,
  LogCardField,
  LogSearchBarProps,
  LogLevelFilterProps,
  LogDateRangePickerProps,
  LogDateRange,
  QuickRange,
} from "@campfhir/bored-logs/components";
```

### `LogTable`

`LogTable` renders the `<table>` shell — headers, optional footer, and shared column config — and you compose the body from row primitives passed as `children`. It does not fetch or sort data itself. Does not include a search bar or purge dialog — compose those yourself.

```tsx
"use client";

import { useState } from "react";
import {
  LogTable,
  LogTableRow,
  LogTableRowGroup,
} from "@campfhir/bored-logs/components";
import type { LogRow } from "@campfhir/bored-logs";
import type { SortState } from "@campfhir/bored-logs/components";

export default function LogsPage() {
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [sort, setSort] = useState<SortState>({
    column: "timestamp",
    direction: "desc",
  });

  return (
    <LogTable
      sort={sort}
      onSortChange={setSort}
      extraColumns={[
        { key: "request_id", label: "Request ID" },
        { key: "service" },
      ]}
      footer={<button onClick={() => {}}>Load more</button>}
    >
      {logs.map((log) => (
        <LogTableRowGroup key={log.id} log={log} />
      ))}
    </LogTable>
  );
}
```

| Prop             | Type                        | Default | Description                                                                           |
| ---------------- | --------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `children`       | `ReactNode`                 | —       | Row content — compose from `LogTableRow` / `LogTableRowGroup` / `LogTableRowExpanded` |
| `sort`           | `SortState`                 | —       | Controlled sort state (`{ column, direction }`)                                       |
| `onSortChange`   | `(sort: SortState) => void` | —       | Called when a header is clicked; enables sortable headers                             |
| `extraColumns`   | `ExtraColumn[]`             | `[]`    | Additional columns beyond the built-in timestamp/level/message                        |
| `footer`         | `ReactNode`                 | —       | Content rendered in a `<tfoot>` row spanning all columns                              |
| `className`      | `string`                    | —       | Applied to the root `<table>`                                                         |
| `theadClassName` | `string`                    | —       | Applied to `<thead>`                                                                  |
| `tfootClassName` | `string`                    | —       | Applied to `<tfoot>`                                                                  |

**Built-in columns**: `timestamp`, `level`, `message`. Each `<th>` has a `data-column` attribute; the active sort column also has `data-sort="asc"|"desc"`. The `extraColumns` you pass to `LogTable` are shared with the row primitives via context, so a row renders the matching cells automatically.

#### Row primitives

- **`LogTableRow`** — one `<tr>` for a log row. Renders timestamp/level/message plus a cell per `extraColumn`. Props: `log: LogRow`, `onClick?: (log) => void` (sets `data-clickable` and makes the row interactive), `className?`. The level cell contains `<span data-level={log.level}>`.
- **`LogTableRowGroup`** — a `LogTableRow` with built-in expand/collapse state. Clicking the row toggles an expanded detail row beneath it. Props: `log: LogRow`, `className?`, `expandedClassName?`, and `children?` (the expanded panel content — defaults to a `<pre>` JSON dump of `log.meta`).
- **`LogTableRowExpanded`** — a full-width detail `<tr data-expanded>` spanning all columns. Props: `children: ReactNode`, `open?: boolean` (renders nothing when `false`), `className?`. Use this directly when you manage expand state yourself.
- **`formatTimestamp(ts: string | null): string`** — the timestamp formatter used internally; exported for reuse. Returns `"—"` for `null`.

```tsx
// Manual expand control instead of LogTableRowGroup
{
  logs.map((log) => (
    <>
      <LogTableRow key={log.id} log={log} onClick={() => toggle(log.id)} />
      <LogTableRowExpanded open={openIds.has(log.id)}>
        <MyDetailPanel log={log} />
      </LogTableRowExpanded>
    </>
  ));
}
```

#### `ExtraColumn`

```typescript
type ExtraColumn = {
  key: string; // column id and default header label
  label?: string; // override header label
  value?: (log: LogRow) => unknown; // custom value accessor (defaults to log.meta[key])
  render?: (value: unknown, log: LogRow) => ReactNode; // custom cell renderer
};
```

Meta keys are read via `log.meta[key]` by default. Use `value` to surface top-level fields or computed values:

```tsx
extraColumns={[
  // meta key
  { key: "request_id", label: "Request ID" },
  // top-level field via value accessor
  { key: "id", label: "ID", value: (log) => log.id },
  // custom renderer
  {
    key: "level",
    label: "Badge",
    value: (log) => log.level,
    render: (value) => <span className={`badge badge-${value}`}>{String(value)}</span>,
  },
]}
```

### `LogCard`

A single log rendered as a card, for narrow / mobile layouts where a table doesn't fit. Fields reuse the same [`ExtraColumn`](#extracolumn) shape as `LogTable`'s `extraColumns`, so one config drives both views. Expand/collapse is built in (click or keyboard on the header), mirroring `LogTableRowGroup`.

```tsx
import { LogCard } from "@campfhir/bored-logs/components";

// Same column config as the table
const columns = [
  { key: "service", label: "Service" },
  { key: "statusCode", label: "Status", render: (v) => <StatusBadge value={v} /> },
];

// Table on desktop, cards on mobile (toggle with CSS/media queries)
{logs.map((log) => (
  <LogCard key={log.id} log={log} fields={columns} />
))}
```

| Prop                | Type             | Default          | Description                                                     |
| ------------------- | ---------------- | ---------------- | -------------------------------------------------------------- |
| `log`               | `LogRow`         | —                | The log to render                                              |
| `fields`            | `LogCardField[]` | `[]`             | Meta fields to show as labelled rows (same shape as `ExtraColumn`) |
| `children`          | `ReactNode`      | JSON of `.meta`  | Expanded detail content                                        |
| `defaultOpen`       | `boolean`        | `false`          | Render expanded initially                                     |
| `className`         | `string`         | —                | Applied to the root `<article data-log-card>`                 |
| `headerClassName`   | `string`         | —                | Applied to the clickable `<header>`                          |
| `bodyClassName`     | `string`         | —                | Applied to the message `<p>`                                  |
| `expandedClassName` | `string`         | —                | Applied to the detail panel                                  |

Renders `<article data-log-card data-level="…">` containing a `[data-log-card-header]` (with the `[data-level]` badge + `[data-log-card-time]`), a `[data-log-card-message]`, an optional `[data-log-card-fields]` list (each `[data-log-card-field]` has a `<dt>` label and `<dd data-column="…">` value), and, when open, a `[data-log-card-detail]` panel. Style via those hooks; `LogCardField` is an alias of `ExtraColumn`.

### `LogSearchBar`

Boolean search bar with optional autocomplete. Parses the query syntax described in [Log search](#log-search) — including `||` (OR), `&&`/whitespace (AND), and `()` grouping — and emits the parsed `FilterExpr` tree on each commit or removal. Pass it straight to `query({ attributeFilter })`.

```tsx
import { LogSearchBar } from "@campfhir/bored-logs/components";
import type { LogRow, FilterExpr } from "@campfhir/bored-logs";
import { queryLogs } from "@/actions/logs";

<LogSearchBar
  logs={logs} // enables key/operator/value autocomplete
  onSearch={async (expr: FilterExpr | null) => {
    const res = await queryLogs({ attributeFilter: expr ?? undefined });
    if (res.ok) setLogs(res.val);
  }}
  placeholder="$level:'error' (service:'db' || service:'payments')"
/>;
```

| Prop          | Type                                   | Default       | Description                                                                 |
| ------------- | -------------------------------------- | ------------- | -------------------------------------------------------------------------- |
| `onSearch`    | `(expr: FilterExpr \| null) => void`   | —             | Called with the full boolean tree after each commit/removal; `null` when empty |
| `logs`        | `LogRow[]`                             | —             | When provided, enables autocomplete from real key/value data               |
| `placeholder` | `string`                               | example query | Input placeholder shown when no chips are active                            |
| `hidden`      | `boolean`                              | `false`       | Renders nothing when `true`                                                 |
| `debounceMs`  | `number`                              | `400`         | Delay before a syntax error / empty-result warning is shown                 |
| `className`   | `string`                               | —             | Applied to the root `<div>`                                                 |

**Chips.** Each top-level AND branch becomes one chip: `a:'1' b:'2'` → two chips, while `a:'1' || b:'2'` and `(a b) || c` commit as one boolean chip. **Click a chip to edit it** — its expression returns to the input (the chip is dropped until you re-commit with Enter). Click `×` on a chip or press **Backspace** on an empty input to remove it; a clear-all `×` appears when there is any input or chip. Each chip exposes a `data-log-filter-chip-edit` button (the label) and a separate remove button.

**Validation** (debounced by `debounceMs`, so it never fires mid-keystroke). A syntax error (`role="alert"`, `data-log-search-error`, plus `aria-invalid` on the input) is flagged after the pause — or immediately on Enter, which blocks the commit. A contradictory query that can never match (`isUnsatisfiable`) shows a warning (`role="status"`, `data-log-search-warning`).

**Autocomplete behaviour** (requires `logs` prop):

- Typing a partial key shows matching key suggestions. The built-in fields (`$timestamp`, `$level`, `$message`) are always offered, listed first, and tagged (`data-kind="builtin"` plus an `aria-hidden` "built-in" label) so it's clear you're picking the built-in column; a same-named attribute (e.g. an attribute literally called `level`) is offered as its own separate `data-kind="attribute"` entry, since the `$` sigil keeps the two unambiguous. Group-aware — fires on the term after `(`, `||`, `&&`.
- After `key:`, operator suggestions appear (`'`, `='`, `!'`, `!='`, `>'`, `>='`, `<'`, `<='`).
- After `key:'`, value suggestions show unique values for that key from `logs`.
- **Tab** cycles through suggestions; **Enter** accepts the highlighted suggestion (or commits if none selected); **Escape** dismisses suggestions for the current stage.
- Escape on key stage: suppresses suggestions while still typing the key; suggestions resume when `:` is typed.
- Escape on value stage: suppresses suggestions for that value; resets when the token is committed.
- Operator stage suggestions are never suppressed by Escape.

> **Note — built-in fields.** `$timestamp`, `$level`, and `$message` map to real `logs` columns rather than stored attributes (see [Built-in fields](#built-in-fields)); the autocomplete tags them `builtin` and lists them first. Because of the `$` sigil, a same-named attribute is offered as its own separate entry. Severity thresholds work right in the search bar — `$level:>='warn'` is "warn and above" (see [Built-in fields](#built-in-fields)) — or via the dedicated [`LogLevelFilter`](#loglevelfilter) + `query({ levels })` when you want the level filter as a separate UI control.

### `LogLevelFilter`

A dedicated, controlled control for the log level — a group of toggle buttons, one per level. Selecting levels produces the array you pass to `query({ levels })`. Style-less like the rest.

```tsx
import { LogLevelFilter } from "@campfhir/bored-logs/components";
import { queryLogs } from "@/actions/logs";

const [levels, setLevels] = useState<string[]>([]);

<LogLevelFilter
  levels={["debug", "info", "warn", "error", "critical"]} // optional; defaults to built-ins
  value={levels}
  onChange={async (next) => {
    setLevels(next);
    const res = await queryLogs({ levels: next.length ? next : undefined });
    if (res.ok) setLogs(res.val);
  }}
/>;
```

| Prop        | Type                          | Default        | Description                                                        |
| ----------- | ----------------------------- | -------------- | ----------------------------------------------------------------- |
| `value`     | `string[]`                    | —              | Selected levels (controlled); empty means no level filter          |
| `onChange`  | `(levels: string[]) => void`  | —              | Called with the next selection when a level is toggled             |
| `levels`    | `string[]`                    | built-in names | Selectable level options, in display order                         |
| `className` | `string`                     | —              | Applied to the root `<div role="group">`                          |

Renders a `<div role="group" data-log-level-filter>` of `<button>`s. Each button has `data-level="<name>"` and, when selected, `data-selected` (plus `aria-pressed`) — style the selected state per level. Selecting several levels reads as "any of" via the level `IN (…)` clause.

### `LogDateRangePicker`

A controlled, style-less date-range control. It pairs an explicit start/end range — a separate date and time input per bound, validated so start is on or before end — with configurable quick "last X" presets, and emits ISO-8601 strings ready for `query({ start, end })`. Picking a date defaults its time to the start (`00:00`) or end (`23:59`) of that day, so a date applies on its own without also setting a time (a single `datetime-local` reports nothing until both parts are filled).

```tsx
import { LogDateRangePicker } from "@campfhir/bored-logs/components";
import type { LogDateRange } from "@campfhir/bored-logs/components";
import { queryLogs } from "@/actions/logs";

const [range, setRange] = useState<LogDateRange>({ start: null, end: null });

<LogDateRangePicker
  value={range}
  onChange={async (next) => {
    setRange(next);
    const res = await queryLogs({ start: next.start ?? undefined, end: next.end ?? undefined });
    if (res.ok) setLogs(res.val);
  }}
/>;
```

| Prop              | Type                              | Default                | Description                                                                 |
| ----------------- | --------------------------------- | ---------------------- | --------------------------------------------------------------------------- |
| `value`           | `LogDateRange`                    | —                      | `{ start, end }` as ISO-8601 strings (or `null`), controlled                |
| `onChange`        | `(range: LogDateRange) => void`   | —                      | Called with the next range on any valid change; an invalid range is not emitted |
| `quickRanges`     | `QuickRange[]`                    | `DEFAULT_QUICK_RANGES` | Presets — each is `{ label, resolve(now) => { start, end? } }`              |
| `hideQuickRanges` | `boolean`                         | `false`                | Hide the preset buttons, leaving only the start/end inputs                  |
| `hideCustomRange` | `boolean`                         | `false`                | Hide the start/end inputs, leaving only the presets                         |
| `className`       | `string`                          | —                      | Applied to the root `<div data-log-date-range>`                             |

Define your own presets by resolving each option to a concrete range (return `end` as `null`/omitted for an open upper bound):

```tsx
import type { QuickRange } from "@campfhir/bored-logs/components";

const quickRanges: QuickRange[] = [
  { label: "Today", resolve: (now) => ({ start: new Date(now.setHours(0, 0, 0, 0)) }) },
  { label: "Last 90 days", resolve: (now) => ({ start: new Date(now.getTime() - 90 * 86_400_000), end: now }) },
];
```

The default presets (`DEFAULT_QUICK_RANGES`) are last 15 min, hour, 24 hours, 7 days, and 30 days. An invalid range (start after end) surfaces a `role="alert"` message (`data-log-date-range-error`) and sets `aria-invalid` on the inputs; the presets group is a `<div role="group" data-log-date-range-quick>` and each bound is a `<div data-log-date-range-start>` / `-end` wrapping its date + time inputs.

### `LogSearchSyntaxHelp`

Standalone syntax reference component — place it anywhere in your layout as a tooltip or help text.

```tsx
import { LogSearchSyntaxHelp } from "@campfhir/bored-logs/components";

<LogSearchSyntaxHelp className="my-tooltip" />;
```

Renders a `<span data-log-search-syntax-help>` containing a `<dl>` with operator syntax entries. Style freely via `className` or the `data-log-search-syntax-help` attribute.

### `PurgeLogsDialog`

A fully controlled purge confirmation dialog. It renders the date picker and Cancel/Purge buttons; you own the open state, the selected date, and the purge call itself. Renders nothing when `show` is `false`.

```tsx
"use client";

import { useState } from "react";
import { PurgeLogsDialog } from "@campfhir/bored-logs/components";
import { purgeLogs } from "@/actions/logs";

function PurgeButton() {
  const [show, setShow] = useState(false);
  const [purging, setPurging] = useState(false);
  const [untilDate, setUntilDate] = useState("");

  async function handleConfirm() {
    setPurging(true);
    await purgeLogs(untilDate);
    setPurging(false);
    setShow(false);
  }

  return (
    <>
      <button onClick={() => setShow(true)}>Purge logs</button>
      <PurgeLogsDialog
        show={show}
        purging={purging}
        untilDate={untilDate}
        onUntilDateChange={setUntilDate}
        onConfirm={handleConfirm}
        onCancel={() => setShow(false)}
      />
    </>
  );
}
```

| Prop                | Type                      | Required | Description                                                                    |
| ------------------- | ------------------------- | -------- | ------------------------------------------------------------------------------ |
| `show`              | `boolean`                 | yes      | Whether the dialog is rendered                                                 |
| `purging`           | `boolean`                 | yes      | Disables inputs and shows "Purging…" on the confirm button                     |
| `untilDate`         | `string`                  | yes      | The selected date (`<input type="date">` value); Purge is disabled while empty |
| `onUntilDateChange` | `(value: string) => void` | yes      | Called when the date input changes                                             |
| `onConfirm`         | `() => void`              | yes      | Called when Purge is clicked                                                   |
| `onCancel`          | `() => void`              | yes      | Called when Cancel is clicked                                                  |
| `className`         | `string`                  | no       | Applied to the root `<div role="dialog">`                                      |

### Composing components

```tsx
"use client";

import { useState } from "react";
import {
  LogSearchBar,
  LogSearchSyntaxHelp,
  LogTable,
  LogTableRowGroup,
  PurgeLogsDialog,
} from "@campfhir/bored-logs/components";
import type { LogRow, FilterExpr } from "@campfhir/bored-logs";
import type { SortState } from "@campfhir/bored-logs/components";
import { purgeLogs, queryLogs } from "@/actions/logs";

export default function LogsPage() {
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [expr, setExpr] = useState<FilterExpr | null>(null);
  const [sort, setSort] = useState<SortState>({
    column: "timestamp",
    direction: "desc",
  });

  const [showPurge, setShowPurge] = useState(false);
  const [purging, setPurging] = useState(false);
  const [untilDate, setUntilDate] = useState("");

  async function handleSearch(next: FilterExpr | null) {
    setExpr(next);
    // The tree carries message terms, attribute terms, and OR / AND / grouping.
    const result = await queryLogs({
      attributeFilter: next ?? undefined,
      sort: sort.direction,
    });
    if (result.ok) setLogs(result.val);
  }

  async function handlePurge() {
    setPurging(true);
    await purgeLogs(untilDate);
    setPurging(false);
    setShowPurge(false);
  }

  return (
    <div>
      <LogSearchSyntaxHelp />
      <LogSearchBar logs={logs} onSearch={handleSearch} />
      <button onClick={() => setShowPurge(true)}>Purge logs</button>
      <PurgeLogsDialog
        show={showPurge}
        purging={purging}
        untilDate={untilDate}
        onUntilDateChange={setUntilDate}
        onConfirm={handlePurge}
        onCancel={() => setShowPurge(false)}
      />
      <LogTable
        sort={sort}
        onSortChange={setSort}
        extraColumns={[{ key: "request_id", label: "Request ID" }]}
      >
        {logs.map((log) => (
          <LogTableRowGroup key={log.id} log={log} />
        ))}
      </LogTable>
    </div>
  );
}
```

---

## Optional: encryption

Provide `encrypt` and `decrypt` to `PostgresAdapter` to store attribute values encrypted at rest. The interpolated `message` field is never encrypted; use `secure()` on the template to encrypt the whole message.

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const KEY = Buffer.from(process.env.LOG_ENCRYPTION_KEY!, "hex"); // 32 bytes

function encrypt(plaintext: string): Buffer {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", KEY, iv);
  return Buffer.concat([iv, cipher.update(plaintext, "utf-8"), cipher.final()]);
}

function decrypt(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, "base64url");
  const iv = buf.subarray(0, 16);
  const decipher = createDecipheriv("aes-256-cbc", KEY, iv);
  return decipher.update(buf.subarray(16)) + decipher.final("utf-8");
}

// Pass to PostgresAdapter in instrumentation.ts
new PostgresAdapter({ db, encrypt, decrypt });
```

---

## Optional: log levels

Configure adapter log levels via environment variables or directly at runtime:

| Variable            | Adapter  | Default  |
| ------------------- | -------- | -------- |
| `CONSOLE_LOG_LEVEL` | console  | `"info"` |
| `LOG_DB_LEVEL`      | database | `"info"` |

```typescript
// Runtime adjustment
logger.level = "debug"; // global threshold
consoleAdapter.level = "warn"; // console only
postgresAdapter.level = "info"; // database only
```

---

## Optional: process hooks

Register cleanup handlers for process lifecycle events using `logger.on()`. The logger flushes and closes before calling your callback so no records are lost on exit. Handlers are chained — `logger.on()` returns `this`.

```typescript
import { logger } from "@/lib/logger";

logger
  .on("SIGINT", async () => {
    /* cleanup after logger flushes */
  })
  .on("SIGTERM", async () => {})
  .on("beforeExit", async () => {})
  .on("uncaughtException", async (err) => {})
  .on("unhandledRejection", async (reason) => {});
```

Safe to call in browser and Edge runtimes — silently ignored when `process` is not available.

## Development

```bash
pnpm test        # unit + component suite (jsdom, no database)
```

### Demo app

A full-stack showcase (Next.js + Postgres, Tailwind, all the UI components wired
to a live database) lives in the GitHub repository under
[`demos/web/`](https://github.com/campfhir/bored-logs/tree/main/demos/web). It is **not**
included in the published npm or JSR package — clone the repo to run it:

```bash
git clone https://github.com/campfhir/bored-logs.git
cd bored-logs
pnpm install
pnpm demo        # build + run the demo and Postgres in Docker → http://localhost:3000
pnpm demo:down   # stop and wipe it
```

See the [demo README](https://github.com/campfhir/bored-logs/blob/main/demos/web/README.md)
for running it locally without Docker.

A second demo, [`demos/shipping/`](https://github.com/campfhir/bored-logs/tree/main/demos/shipping),
runs the [cross-application shipping](#shipping-logs-between-applications) topology across two
runtimes — a **Deno** worker sealing end-to-end-encrypted batches to a **Node + Express** log
server — proving the library's runtime-agnostic wire path and the encrypt/register/verify flow.

### Live end-to-end tests

The unit suite validates the generated SQL without a database (it captures each
compiled query). The e2e suite goes further: it executes that SQL against a real
Postgres, proving the OR / AND / grouping filter trees return the correct rows.

A throwaway Postgres is defined in `compose.yaml` (host port `5433`, in-memory,
nothing persisted):

```bash
pnpm db:up       # start Postgres and wait until healthy
pnpm test:e2e    # run the live suite (src/**/*.e2e.test.ts)
pnpm db:down     # stop and remove it
```

To run against your own instance instead of the compose container, set
`DATABASE_URL`:

```bash
DATABASE_URL=postgres://user:pass@host:5432/db pnpm test:e2e
```

The e2e suite is kept out of `pnpm test` (it needs the Node environment and a
reachable database) and uses its own config, `vitest.e2e.config.ts`.
