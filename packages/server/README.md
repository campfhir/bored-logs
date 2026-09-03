# @campfhir/bored-logs-server

`createLogIngestHandler` builds a `(Request) => Promise<Response>` handler that accepts batches from `@campfhir/bored-logs-http` / `@campfhir/bored-logs-client` and feeds them to a server `Logger`. Add `createE2EServerContext` + `createLogRegistrationHandler` for end-to-end encrypted shipping. Runtime-agnostic: mount it in Next.js Route Handlers, Express (with a Fetch shim), Hono, Deno, or Bun.

```bash
npm install @campfhir/bored-logs-server
# or
deno add jsr:@campfhir/bored-logs-server
```

Full documentation, including how the packages fit together, lives in the
[bored-logs README](https://github.com/campfhir/bored-logs#readme).
