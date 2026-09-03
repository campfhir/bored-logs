// ---------------------------------------------------------------------------
// Wire format for the HTTP log adapter — shared by the browser client
// (`useLogger` / `HttpAdapter`) and the server ingest handler
// (`createLogIngestHandler`).
//
// These are plain data types — no runtime, no "use client" — so both the
// client and server bundles can import them without pulling in each other's
// code. The only difference from a server-side `LogRecord` is that `timestamp`
// crosses the wire as an ISO-8601 string.
// ---------------------------------------------------------------------------

/**
 * A single log entry as shipped from the browser to the server. Mirrors the
 * server-side `LogRecord`, except `timestamp` is serialized as an ISO-8601
 * string.
 *
 * Sensitivity is resolved before a record becomes a `ClientLogRecord` (see
 * `recordToClientRecord`): `secure()` values are shipped with their tag intact
 * so the server can encrypt them at rest, while `redact()` values are scrubbed
 * to a placeholder (or omitted) and never cross the wire in plaintext.
 */
export type ClientLogRecord = {
  /** Log level string (e.g. "info", "error"). */
  level: string;
  /** Interpolated message — secure values replaced with "[secure]". */
  message: string;
  /** Original template string before interpolation. */
  template: string;
  /** True when the entire message template was wrapped with `secure()`. */
  secureMessage: boolean;
  /** Attribute map — `secure()` values kept as `{ _secure, value }` for server encryption; `redact()` values scrubbed/omitted. */
  attrs: Record<string, unknown>;
  /** Event time on the client, as an ISO-8601 string. */
  timestamp: string;
  application?: string;
  version?: string;
};

/** The JSON body `POST`ed to the ingest endpoint: a batch of client records. */
export type LogShipmentPayload = {
  logs: ClientLogRecord[];
};
