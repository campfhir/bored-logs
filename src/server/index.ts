/**
 * Server entrypoint (`@campfhir/bored-logs/server`). The counterpart to the
 * shipping side (`useLogger()` in the browser, or a standalone `HttpAdapter`
 * in any service): {@link createLogIngestHandler} builds a Fetch-shaped
 * handler that receives shipped log batches and feeds them to a server
 * `Logger` via its `ingest` method.
 *
 * For opt-in end-to-end shipment encryption, create a shared
 * {@link createE2EServerContext} and hand it to both the ingest handler
 * (`encryption: { context }`) and {@link createLogRegistrationHandler}.
 *
 * @module
 */

export { createLogIngestHandler, MAX_BATCH_HEADER } from "./ingest-handler";
export type {
  LogIngestHandlerOptions,
  IngestSink,
} from "./ingest-handler";

export type { ClientLogRecord, LogShipmentPayload } from "../adapters/http/types";

// End-to-end shipment encryption (server half)
export {
  createE2EServerContext,
  generateE2EServerKeys,
  MemoryRegistrationStore,
} from "./e2e-context";
export type {
  E2EServerContext,
  E2EServerContextOptions,
  E2ERegistrationStore,
  E2ERegistration,
  E2EKeyPairJwk,
  E2EOpenResult,
} from "./e2e-context";
export { createLogRegistrationHandler } from "./registration-handler";
export type { LogRegistrationHandlerOptions } from "./registration-handler";
export { E2E_HEADERS, E2E_ERROR_HEADER, E2E_ALGO_V1 } from "../adapters/http/e2e-wire";
export type { E2EErrorCode } from "../adapters/http/e2e-wire";
