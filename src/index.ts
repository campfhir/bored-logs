/**
 * @campfhir/bored-logs — structured PostgreSQL-backed logging for Next.js.
 *
 * Main entry: the {@link createLogger} factory, adapter interfaces and record
 * types, the built-in {@link ConsoleAdapter}, the {@link secure} value wrapper,
 * `Result`/`Err` helpers, and the log-query string parser.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// @campfhir/bored-logs — main entry point
// ---------------------------------------------------------------------------

// Log levels and adapter types
export { LOG_LEVELS, isQueryable } from "./logger/adapter";
export type {
  LogAdapter,
  QueryableLogAdapter,
  LogRecord,
  LogRow,
  LogQueryOptions,
  LogLevelFilter,
  QueryError,
  PurgeError,
  LogLevel,
  LogLevels,
  AdapterWarning,
  EncryptFn,
  DecryptFn,
} from "./logger/adapter";

// Logger instance / factory
export { createLogger } from "./logger/logger";
export type { Logger, LoggerOptions, ProcessEvent } from "./logger/logger";

// Adapters
export { ConsoleAdapter } from "./logger/console-adapter";
export type { ConsoleAdapterOptions } from "./logger/console-adapter";

// Secure / redact value wrappers
export {
  secure,
  isSecure,
  redact,
  isRedacted,
  REDACTED_PLACEHOLDER,
  defaultSerializer,
} from "./logger/template";
export type { Secure, Redacted, ValueSerializer } from "./logger/template";

// Shared utility types
export type { Result, AsyncResult, Prettify } from "./types";
export { Err } from "./types";

// Query string parser (usable server-side or in components)
export {
  parseLogQuery,
  parseLogQueryExpr,
  formatToken,
  formatExpr,
  findContradictions,
  isUnsatisfiable,
  QUERY_SYNTAX_ERROR,
} from "./logger/parseLogQuery";
export type { LogQueryToken, LogQueryOperator, FilterExpr } from "./logger/parseLogQuery";
