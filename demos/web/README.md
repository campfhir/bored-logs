# bored-logs demo

A local full-stack showcase for the **@campfhir/bored-logs** packages — six of
the seven wired into one Next.js app: the Postgres adapter and migrator, the
ingest route, the browser `LoggerProvider`, and the React UI components
(`LogSearchBar`, `LogTable`, `LogSearchSyntaxHelp`, `PurgeLogsDialog`), all
against a real database.

> Not published to npm. It lives in the repo and imports the packages under
> their published names (`@campfhir/bored-logs`, `@campfhir/bored-logs-ui`, …),
> resolved straight to the LOCAL SOURCE in `../../packages/*/src` via tsconfig
> path aliases — so `next dev` picks up library changes live, with no build
> step. (`link:../../packages/*` dependencies remain as the fallback for
> anything that bypasses the aliases.)

## What it demonstrates

- **Seven packages, one app** — the **Loadout** dropdown in the nav lists every
  `@campfhir/bored-logs-*` package the demo is built from, its version, what it
  contributes, and which files import it. `lib/logger.ts` is the server-side
  loadout (`core` + `-psql` + `-psql-migration`), `app/api/logs/route.ts` is
  `-server`, and the browser gets `-client` + `-ui`.
- **Own schema + prefix** — the log tables live in `logging.demo_logs`,
  `logging.demo_log_attr`, … rather than `public.logs`: `lib/logger.ts` passes
  one `{ schema, tablePrefix }` object to both `up()` from
  `@campfhir/bored-logs-psql-migration` and to `PostgresAdapter`, which rewrites
  the logical names at query time. The Loadout panel shows the resolved
  physical names and the migration status. Override with `LOG_SCHEMA` /
  `LOG_TABLE_PREFIX` (empty strings select the default layout).
- **Simulate buttons** write batches of realistic logs (login flows, checkout,
  error bursts, slow requests, random traffic) at every level — these run in a
  **server action**.
- **Ship client-side logs** — a second panel logs from the browser with the
  `useLogger` hook. `LoggerProvider` (in `app/_components/logger-provider.tsx`)
  builds a client `Logger` that writes to the browser console *and* batches
  records to the `POST /api/logs` route (`createLogIngestHandler`, in
  `app/api/logs/route.ts`), which feeds them into the same server logger +
  Postgres adapter. The `secure()` / `redact()` buttons show the split: both
  print their real value to the browser console, but the shipped-and-stored
  record masks them (`[secure]` / `**REDACTED**`).
- **Boolean search** — the `LogSearchBar` parses `||` / `&&` / `()` into a
  `FilterExpr` tree that drives the SQL (`level:'error' (service:'db' || service:'payments')`).
  Syntax errors and contradictory filters are flagged (debounced).
- **LogTable** with level badges, custom columns (service / status / latency),
  and expandable rows showing the full attribute JSON.
- **LogDateRangePicker** — start/end inputs (validated so start ≤ end) plus
  "last X" quick presets, feeding `query({ start, end })`.
- **Autocomplete** in the search bar that tags the built-in fields
  (`timestamp` / `level` / `message`) distinctly from same-named attributes.
- **PurgeLogsDialog** deleting everything before a chosen date.

The same components are shown in three full-page **layout variants**, switchable
from the top nav — **Toolbar** (`/`, filters stacked above results),
**Sidebar** (`/split`, filters in a left rail), and **Compact** (`/compact`, one
dense bar with quick-preset-only date ranges).

## Run it with Docker (recommended)

From the repo root:

```bash
pnpm demo        # build + run Next and Postgres → http://localhost:3000
pnpm demo:down   # stop and wipe the database
```

Or directly with compose:

```bash
cd demos/web
docker compose up --build     # → http://localhost:3000
docker compose down -v        # stop and wipe the database
```

The web image builds the library and the demo together (multi-stage
`Dockerfile`), then serves the production Next.js build against a Postgres
container.

## Run it locally

The demo compiles the library packages from `../../packages/*/src` directly — no library build needed:

```bash
# start a Postgres for the demo (reuses the demo compose db service)
docker compose -f demos/web/compose.yaml up -d db

# run the app
cd demos/web
pnpm install --ignore-workspace   # standalone — don't resolve into the repo workspace
pnpm dev                      # → http://localhost:3000
```

Edits under `../../packages/*/src` hot-reload in the running demo like any app file.

`DATABASE_URL` defaults to `postgres://postgres:postgres@localhost:5433/bored_logs_demo`
(the compose `db` service). Override it to point anywhere:

```bash
DATABASE_URL=postgres://user:pass@host:5432/db pnpm dev
```

The tables are migrated automatically on first request, by
`@campfhir/bored-logs-psql-migration`'s `up()` (see `lib/logger.ts`), into the
schema and prefix selected by `LOG_SCHEMA` (default `logging`) and
`LOG_TABLE_PREFIX` (default `demo_`):

```bash
LOG_SCHEMA=audit LOG_TABLE_PREFIX=app_ pnpm dev   # → audit.app_logs, audit.app_log_attr, …
LOG_SCHEMA= LOG_TABLE_PREFIX= pnpm dev            # → the default public.logs layout
```
