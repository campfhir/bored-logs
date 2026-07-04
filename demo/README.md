# bored-logs demo

A local full-stack showcase for **@campfhir/bored-logs** — the Postgres
adapter and the React UI components (`LogSearchBar`, `LogTable`,
`LogSearchSyntaxHelp`, `PurgeLogsDialog`), wired to a real database.

> Not published to npm. It lives in the repo and links the library from source
> via `link:..`, so it always exercises the current build.

## What it demonstrates

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
cd demo
docker compose up --build     # → http://localhost:3000
docker compose down -v        # stop and wipe the database
```

The web image builds the library and the demo together (multi-stage
`Dockerfile`), then serves the production Next.js build against a Postgres
container.

## Run it locally

The demo links the library's built `dist`, so build the library first:

```bash
# from the repo root
pnpm install
pnpm build

# start a Postgres for the demo (reuses the demo compose db service)
docker compose -f demo/compose.yaml up -d db

# run the app
cd demo
pnpm install
pnpm dev                      # → http://localhost:3000
```

`DATABASE_URL` defaults to `postgres://postgres:postgres@localhost:5433/bored_logs_demo`
(the compose `db` service). Override it to point anywhere:

```bash
DATABASE_URL=postgres://user:pass@host:5432/db pnpm dev
```

The schema is migrated automatically on first request.
