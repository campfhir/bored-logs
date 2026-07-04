/**
 * Server entrypoint (`@campfhir/bored-logs/server`). The counterpart to the
 * browser `useLogger()` hook: {@link createLogIngestHandler} builds a Next.js
 * Route Handler that receives shipped log batches and feeds them to a server
 * `Logger` via its `ingest` method.
 *
 * @module
 */

export { createLogIngestHandler } from "./ingest-handler";
export type {
  LogIngestHandlerOptions,
  IngestSink,
} from "./ingest-handler";

export type { ClientLogRecord, LogShipmentPayload } from "../adapters/http/types";
