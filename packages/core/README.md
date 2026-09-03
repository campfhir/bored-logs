# @campfhir/bored-logs

The framework-agnostic core: `createLogger`, the `LogAdapter` / `QueryableLogAdapter` contracts, `secure()` / `redact()`, the log-search parser (`parseLogQueryExpr`) and the `where()` query builder, plus `ConsoleAdapter`. Every other `@campfhir/bored-logs-*` package builds on this one.

```bash
npm install @campfhir/bored-logs
# or
deno add jsr:@campfhir/bored-logs
```

Full documentation, including how the packages fit together, lives in the
[bored-logs README](https://github.com/campfhir/bored-logs#readme).
