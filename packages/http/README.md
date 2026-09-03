# @campfhir/bored-logs-http

`HttpAdapter` ships batches from any `Logger` to a server running `createLogIngestHandler` (`@campfhir/bored-logs-server`). Uses only `fetch` and WebCrypto, so it runs in browsers, Node ≥ 18, Deno, and Edge runtimes. Also exports the wire types and the end-to-end encryption protocol core shared with the server.

```bash
npm install @campfhir/bored-logs-http
# or
deno add jsr:@campfhir/bored-logs-http
```

Full documentation, including how the packages fit together, lives in the
[bored-logs README](https://github.com/campfhir/bored-logs#readme).
