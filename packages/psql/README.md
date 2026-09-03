# @campfhir/bored-logs-psql

`PostgresAdapter` is a `QueryableLogAdapter` backed by Kysely + `pg`. It batches writes, optionally encrypts attribute values at rest, compiles the log-search grammar to SQL (including nested JSON paths), and runs confirmable, resumable purges. Pass `schema` / `tablePrefix` / `tables` to keep the log tables out of the way of an existing codebase's tables. Also exports `createLoggerPool` and `PsqlE2ERegistrationStore`.

```bash
npm install @campfhir/bored-logs-psql kysely pg
# or
deno add jsr:@campfhir/bored-logs-psql
```

Peer dependencies: `kysely`, `pg`.

Full documentation, including how the packages fit together, lives in the
[bored-logs README](https://github.com/campfhir/bored-logs#readme).
