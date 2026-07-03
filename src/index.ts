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
  AttributeFilter,
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

// Secure wrapper
export { secure, isSecure, defaultSerializer } from "./logger/template";
export type { Secure, ValueSerializer } from "./logger/template";

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
