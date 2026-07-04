# @campfhir/bored-logs

Structured PostgreSQL-backed logging for Next.js — custom adapter-based logger, typed message templates, React UI components, and Kysely migration.

## Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Database setup](#database-setup)
- [Setup](#setup)
- [Using the logger](#using-the-logger)
- [Secure values](#secure-values)
- [Server actions](#server-actions)
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

Add the package to `serverExternalPackages` in your `next.config.ts` so Next.js does not attempt to bundle it through webpack:

```typescript
// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@campfhir/bored-logs"],
};

export default nextConfig;
```

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
// [{ name: "001_logs", applied: true }, { name: "002_attr_val_name_index", applied: true }]
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

### `ConsoleAdapter` options

| Option          | Type                     | Default  | Description                                                                                                                   |
| --------------- | ------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `level`         | `string`                 | `"info"` | Adapter-level filter                                                                                                          |
| `showTimestamp` | `boolean`                | `true`   | Include the `[ISO timestamp]` prefix in output                                                                                |
| `showLevel`     | `boolean`                | `true`   | Include the level prefix in output                                                                                            |
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
```

Named methods exist for every built-in level: `critical`, `error`, `warn`, `info`, `http`, `verbose`, `cache`, `request`, `response`, `sql`, `debug`. Use `log(level, …)` for any level (including custom ones).

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

## Secure values

Wrap individual attribute values — or an entire message template — with `secure()` to mark them for encryption at rest. The console adapter always redacts secure values as `[secure]`.

```typescript
import { logger, secure } from "@/lib/logger"; // re-export secure from your lib, or import directly
import { secure } from "@campfhir/bored-logs";

// Secure individual attribute values
logger.info("Sensitive event", { ssn: secure("123-45-6789"), userId: "u_1" });

// Secure the entire message template (whole message stored encrypted)
logger.info(secure("SSN submitted {ssn}"), { ssn: "123-45-6789" });
```

Encryption only takes effect when `encrypt`/`decrypt` are provided to `PostgresAdapter`. Without them, secure values are stored as plaintext but are still redacted from console output.

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

export async function purgeLogs(until: string, limit?: number) {
  const session = await auth();
  requireRole(["admin"], session);
  return logger.queryAdapter().purge(new Date(until), limit); // Result<number, string>
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
| `attributeFilters` | `AttributeFilter[]` | —              | Flat attribute filters, all ANDed together                 |
| `attributeFilter`  | `FilterExpr`        | —              | Boolean filter tree (`\|\|` / `&&` / grouping) from `parseLogQueryExpr` |

`attributeFilter` is the tree form (supports OR/grouping) and is ANDed with the timestamp range, level filter, `message`, and any `attributeFilters`. Prefer it for anything beyond a flat AND; see [Log search](#log-search).

`level`, `levels`, and `minLevel` are mutually exclusive — the type makes combining them a compile-time error. Omit all three to query every level. `minLevel` uses the same ranking as the emit gate (lower rank = more severe): `minLevel: "warn"` yields `warn`, `error`, `critical`; `minLevel: "debug"` yields everything. These fields are typed as `LogLevel` (`keyof LogLevels`) — to pass a custom level here, augment the `LogLevels` interface (see [Custom levels](#custom-levels)). An unknown level name still returns an `Err("invalid log level")` at runtime.

### `purge` options

`purge(until: Date, limit?: number): AsyncResult<number, string>`

Deletes up to `limit` records with `logged_timestamp <= until`. Call repeatedly to page through a large backlog. Use `deepPurge` to remove everything in one pass.

| Parameter | Type     | Default                 | Description                                                                                                    |
| --------- | -------- | ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `until`   | `Date`   | required                | Delete records on or before this timestamp                                                                     |
| `limit`   | `number` | `10 000` (max `10 000`) | Maximum records deleted per call. Omitting runs a pre-count; returns `Err` if more than `10 000` records match |

### `deepPurge` options

`deepPurge(until: Date, opts?: { timeoutMs?: number }): AsyncResult<number, string>`

Deletes all matching records with no record-count limit. Uses a single `DELETE … USING` per table to avoid loading IDs into memory — suitable for large historical purges.

| Parameter        | Type     | Default  | Description                                                              |
| ---------------- | -------- | -------- | ------------------------------------------------------------------------ |
| `until`          | `Date`   | required | Delete records on or before this timestamp                               |
| `opts.timeoutMs` | `number` | `0`      | Postgres `statement_timeout` for the transaction in ms. `0` = no timeout |

### `AttributeFilter`

```typescript
type AttributeFilter = {
  key: string;
  operator: "contains" | "=" | ">" | ">=" | "<" | "<=";
  value: string;
  negated?: boolean;
};
```

Numeric comparison operators (`>`, `>=`, `<`, `<=`) compare values numerically when both the stored value and the filter value are numbers; otherwise they compare as text.

---

## Log search

Two parsers turn an Elasticsearch-style query string into filters:

- **`parseLogQueryExpr`** (recommended) — parses the full boolean grammar (`||`, `&&`/whitespace, `()`) into a `FilterExpr` tree you pass straight to `query({ attributeFilter })`. Returns a `Result` so malformed input is a value, not a throw.
- **`parseLogQuery`** — the flat, AND-only parser: returns `LogQueryToken[]` mapping directly to `AttributeFilter[]`. Simpler, but no OR/grouping.

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

```typescript
import { parseLogQueryExpr, formatExpr, isUnsatisfiable } from "@campfhir/bored-logs";

const res = parseLogQueryExpr("level:'error' (service:'db' || service:'payments')");
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

> **`level` is not an attribute.** A `level:` term in `attributeFilter` searches a (non-existent) `level` attribute and matches nothing — filter level through the `level` / `levels` / `minLevel` query options (see [`LogLevelFilter`](#loglevelfilter)).

The flat `parseLogQuery` remains for simple AND-only cases and maps tokens straight onto `attributeFilters`:

```typescript
import { parseLogQuery } from "@campfhir/bored-logs";

const tokens = parseLogQuery("level:='error' request_id:'abc'");
const options: LogQueryOptions = {
  attributeFilters: tokens.map(({ key, operator, value, negated }) => ({ key, operator, value, negated })),
};
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
  placeholder="level:'error' (service:'db' || service:'payments')"
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

- Typing a partial key shows matching key suggestions. The built-in fields (`timestamp`, `level`, `message`) are always offered, listed first, and tagged (`data-kind="builtin"` plus an `aria-hidden` "built-in" label) so it's clear you're picking the built-in field rather than a same-named attribute — a colliding attribute of the same name is not shown twice. Attribute keys carry `data-kind="attribute"`. Group-aware — fires on the term after `(`, `||`, `&&`.
- After `key:`, operator suggestions appear (`'`, `='`, `!'`, `!='`, `>'`, `>='`, `<'`, `<='`).
- After `key:'`, value suggestions show unique values for that key from `logs`.
- **Tab** cycles through suggestions; **Enter** accepts the highlighted suggestion (or commits if none selected); **Escape** dismisses suggestions for the current stage.
- Escape on key stage: suppresses suggestions while still typing the key; suggestions resume when `:` is typed.
- Escape on value stage: suppresses suggestions for that value; resets when the token is committed.
- Operator stage suggestions are never suppressed by Escape.

> **Note — filter on `level` with `LogLevelFilter`, not the search bar.** `level` is a first-class column with its own query option, not a stored attribute. A `level:'error'` term in the search bar becomes an `attributeFilter` leaf, which searches a (non-existent) `level` attribute and matches nothing. Use [`LogLevelFilter`](#loglevelfilter) and pass its value to `query({ levels })`, or lift `level:` terms out of the tree yourself before querying.

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

A controlled, style-less date-range control. It pairs explicit start/end `datetime-local` inputs (validated so start is on or before end) with configurable quick "last X" presets, and emits ISO-8601 strings ready for `query({ start, end })`.

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

The default presets (`DEFAULT_QUICK_RANGES`) are last 15 min, hour, 24 hours, 7 days, and 30 days. An invalid range (start after end) surfaces a `role="alert"` message (`data-log-date-range-error`) and sets `aria-invalid` on both inputs; the presets group is a `<div role="group" data-log-date-range-quick>` and each input is `data-log-date-range-start` / `-end`.

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
[`demo/`](https://github.com/campfhir/bored-logs/tree/main/demo). It is **not**
included in the published npm or JSR package — clone the repo to run it:

```bash
git clone https://github.com/campfhir/bored-logs.git
cd bored-logs
pnpm install
pnpm demo        # build + run the demo and Postgres in Docker → http://localhost:3000
pnpm demo:down   # stop and wipe it
```

See the [demo README](https://github.com/campfhir/bored-logs/blob/main/demo/README.md)
for running it locally without Docker.

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
