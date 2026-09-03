# @campfhir/bored-logs-psql-migration

The versioned Kysely migrations behind `@campfhir/bored-logs-psql`: idempotent `up()` / `down()` runners, a `MigrationProvider` for Kysely's `Migrator`, and `resolveLogSchema` / `withLogSchema` to place the tables in a dedicated schema or under a prefix so they never collide with an existing database.

```bash
npm install @campfhir/bored-logs-psql-migration kysely
# or
deno add jsr:@campfhir/bored-logs-psql-migration
```

Peer dependencies: `kysely`.

Full documentation, including how the packages fit together, lives in the
[bored-logs README](https://github.com/campfhir/bored-logs#readme).
