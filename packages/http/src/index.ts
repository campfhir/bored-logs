/**
 * `@campfhir/bored-logs-http` — the universal HTTP log-shipping adapter.
 *
 * {@link HttpAdapter} batches records from any `Logger` (browser, Node, Deno,
 * Edge) and POSTs them to an ingest endpoint built with
 * `createLogIngestHandler` from `@campfhir/bored-logs-server`. The wire types
 * and the end-to-end encryption protocol core are exported too, so both halves
 * of the pipeline share one definition of the envelope.
 *
 * React apps: `@campfhir/bored-logs-client` wraps this adapter in a
 * `LoggerProvider` / `useLogger()` pair.
 *
 * @module
 */

export { HttpAdapter } from "./adapter";
export type { HttpAdapterOptions, HttpTransport, HeadersInput } from "./adapter";

// Record conversion — `redactMode` is the public option; the converter is
// exported for custom transports that need the same scrubbing semantics.
export { recordToClientRecord } from "./record";
export type { RedactMode } from "./record";

// Wire types shared with the server ingest handler.
export type { ClientLogRecord, LogShipmentPayload } from "./types";

// End-to-end shipment encryption — client session + the shared protocol core.
export { E2EClientSession, generateE2ESigningKeys } from "./e2e-client";
export type { E2ESigningKeysJwk } from "./e2e-client";
export * from "./e2e-wire";
