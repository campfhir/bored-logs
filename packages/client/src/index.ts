/**
 * Browser entrypoint (`@campfhir/bored-logs-client`). Client-side logging via a
 * real {@link Logger}: {@link LoggerProvider} builds one with a
 * {@link ConsoleAdapter} (browser devtools) and an {@link HttpAdapter} (batches
 * and ships records to a server ingest endpoint), plus any adapters you pass.
 * {@link useLogger} returns that logger — same typed message-template API as the
 * server logger.
 *
 * Pair this with `createLogIngestHandler` from `@campfhir/bored-logs-server` to
 * receive the shipped records in a Next.js Route Handler.
 *
 * @module
 */

export { LoggerProvider, useLogger, useLogShipper } from "./context";
export type { LoggerProviderProps, ClientLogger } from "./context";

// The HTTP shipping adapter also has a standalone entry: `@campfhir/bored-logs-http`.
export { HttpAdapter } from "@campfhir/bored-logs-http";
export type {
  HttpAdapterOptions,
  HttpTransport,
  HeadersInput,
} from "@campfhir/bored-logs-http";

// `redactMode` prop / option type. Record conversion is handled internally by
// `HttpAdapter`, so the converter itself is not part of the public surface.
export type { RedactMode } from "@campfhir/bored-logs-http";

export type { ClientLogRecord, LogShipmentPayload } from "@campfhir/bored-logs-http";

// Re-exported so consumers can type/annotate the client logger and adapters.
export type { Logger } from "@campfhir/bored-logs";
export { ConsoleAdapter } from "@campfhir/bored-logs";
export type { ConsoleAdapterOptions } from "@campfhir/bored-logs";
export type { LogAdapter, LogRecord } from "@campfhir/bored-logs";

// Value wrappers for authoring sensitive client logs:
//   • secure() — shipped and encrypted at rest on the server.
//   • redact() — never shipped in plaintext (placeholder or omitted).
export { secure, isSecure, redact, isRedacted, REDACTED_PLACEHOLDER } from "@campfhir/bored-logs";
export type { Secure, Redacted } from "@campfhir/bored-logs";
