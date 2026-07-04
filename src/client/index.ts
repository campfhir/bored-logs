/**
 * Browser entrypoint (`@campfhir/bored-logs/client`). Client-side logging via a
 * real {@link Logger}: {@link LoggerProvider} builds one with a
 * {@link ConsoleAdapter} (browser devtools) and an {@link HttpAdapter} (batches
 * and ships records to a server ingest endpoint), plus any adapters you pass.
 * {@link useLogger} returns that logger — same typed message-template API as the
 * server logger.
 *
 * Pair this with `createLogIngestHandler` from `@campfhir/bored-logs/server` to
 * receive the shipped records in a Next.js Route Handler.
 *
 * @module
 */

export { LoggerProvider, useLogger, useLogShipper } from "./context";
export type { LoggerProviderProps, ClientLogger } from "./context";

// The HTTP shipping adapter also has a standalone entry: `@campfhir/bored-logs/adapters/http`.
export { HttpAdapter } from "../adapters/http/adapter";
export type {
  HttpAdapterOptions,
  HttpTransport,
  HeadersInput,
} from "../adapters/http/adapter";

// `redactMode` prop / option type. Record conversion is handled internally by
// `HttpAdapter`, so the converter itself is not part of the public surface.
export type { RedactMode } from "../adapters/http/record";

export type { ClientLogRecord, LogShipmentPayload } from "../adapters/http/types";

// Re-exported so consumers can type/annotate the client logger and adapters.
export type { Logger } from "../logger/logger";
export { ConsoleAdapter } from "../logger/console-adapter";
export type { ConsoleAdapterOptions } from "../logger/console-adapter";
export type { LogAdapter, LogRecord } from "../logger/adapter";

// Value wrappers for authoring sensitive client logs:
//   • secure() — shipped and encrypted at rest on the server.
//   • redact() — never shipped in plaintext (placeholder or omitted).
export { secure, isSecure, redact, isRedacted, REDACTED_PLACEHOLDER } from "../logger/template";
export type { Secure, Redacted } from "../logger/template";
