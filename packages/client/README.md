# @campfhir/bored-logs-client

`LoggerProvider` builds a browser `Logger` with a `ConsoleAdapter` and an `HttpAdapter` (from `@campfhir/bored-logs-http`); `useLogger()` returns it. Pair it with `createLogIngestHandler` from `@campfhir/bored-logs-server`. Ships with a `"use client"` banner for React Server Components.

```bash
npm install @campfhir/bored-logs-client react
# or
deno add jsr:@campfhir/bored-logs-client
```

Peer dependencies: `react`.

Full documentation, including how the packages fit together, lives in the
[bored-logs README](https://github.com/campfhir/bored-logs#readme).
