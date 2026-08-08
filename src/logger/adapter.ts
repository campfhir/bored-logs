import type { Result, AsyncResult } from "../types";
import type { FilterExpr } from "./parseLogQuery";

// ---------------------------------------------------------------------------
// Log levels — level name → severity rank (lower number = more severe, higher
// number = more verbose).
//
// Levels are exposed as an *interface* so applications can register custom
// levels — name and rank together — via declaration merging. The merged keys
// flow into `LogLevel` and therefore into every level-typed API (the query
// filters, casts, etc.):
//
// @example
// declare module "@campfhir/bored-logs" {
//   interface LogLevels {
//     audit: 3;
//     silly: 8;
//   }
// }
//
// Augmenting the interface is the type-side declaration only. Register the
// runtime rank too, via `createLogger({ levels: { audit: 3, silly: 8 } })` or
// `logger.addLevels({ audit: 3, silly: 8 })`.
// ---------------------------------------------------------------------------

/**
 * Level name → severity rank map (lower rank = more severe). Exposed as an
 * interface so applications can register custom levels via declaration merging;
 * merged keys flow into {@link LogLevel} and every level-typed API.
 */
export interface LogLevels {
  silent: 0;
  critical: 0;
  error: 1;
  warn: 2;
  info: 3;
  http: 4;
  verbose: 4;
  cache: 4;
  request: 5;
  response: 5;
  sql: 6;
  debug: 7;
}

/** Runtime ranks for the built-in levels. Custom levels are added at runtime. */
export const LOG_LEVELS = {
  silent: 0,
  critical: 0,
  error: 1,
  warn: 2,
  info: 3,
  http: 4,
  verbose: 4,
  cache: 4,
  request: 5,
  response: 5,
  sql: 6,
  debug: 7,
} as const;

// Compile-time guard that the runtime ranks stay in sync with LogLevels.
LOG_LEVELS satisfies LogLevels;

/** Any registered level name — built-in, or custom via {@link LogLevels} augmentation. */
export type LogLevel = keyof LogLevels;

// ---------------------------------------------------------------------------
// LogRecord — the entry passed to adapter.write().
// ---------------------------------------------------------------------------

/** A single log entry passed to {@link LogAdapter.write}. */
export type LogRecord = {
  /** Log level string (e.g. "info", "error"). */
  level: string;
  /** Interpolated message — secure values replaced with "[secure]". */
  message: string;
  /** Original template string before interpolation. */
  template: string;
  /** True when the entire message template was wrapped with secure(). */
  secureMessage: boolean;
  /** Attribute map: the logger's global attributes merged with the caller's, the caller winning. */
  attrs: Record<string, unknown>;
  /**
   * The record rendered through the logger's output template, when one is set
   * via `logger.template()`. Presentation only — `message` remains the
   * canonical, searchable text. `secure()` / `redact()` values are always
   * masked here, so this string is safe to print anywhere.
   */
  formatted?: string;
  timestamp: Date;
  application?: string;
  version?: string;
};

// ---------------------------------------------------------------------------
// LogRow — the query result type returned by QueryableLogAdapter.query().
// ---------------------------------------------------------------------------

/** A stored log entry as returned by {@link QueryableLogAdapter.query}. */
export type LogRow = {
  id: string;
  level: string;
  message: string;
  meta: { [key: string]: unknown };
  timestamp: string | null;
};

// ---------------------------------------------------------------------------
// LogQueryOptions — options accepted by QueryableLogAdapter.query().
// ---------------------------------------------------------------------------

/**
 * Level filtering. Choose exactly one strategy — the mutually-exclusive
 * `never` fields make combining them a compile-time error:
 *
 * - `level`    — a single exact level (SQL `IN` with one value).
 * - `levels`   — a set of exact levels (SQL `IN`), e.g. `["info", "debug"]`.
 * - `minLevel` — a severity threshold: include this level and everything more
 *   severe. Uses the same ranking as the logger's own emit gate
 *   (`LOG_LEVELS`), where a lower rank is more severe. `minLevel: "warn"`
 *   yields `warn`, `error`, `critical` (and `silent`); `minLevel: "debug"`
 *   yields every level.
 *
 * Omit all three to query every level.
 */
export type LogLevelFilter =
  | { level?: LogLevel; levels?: never; minLevel?: never }
  | { level?: never; levels?: LogLevel[]; minLevel?: never }
  | { level?: never; levels?: never; minLevel?: LogLevel };

/** Options accepted by {@link QueryableLogAdapter.query} — time range, message term, paging, sort, level filter, and attribute filters. */
export type LogQueryOptions = {
  start?: string;
  end?: string;
  message?: string;
  limit?: number;
  offset?: number;
  sort?: "asc" | "desc";
  /**
   * Boolean filter tree (AND / OR / grouping) as produced by
   * `parseLogQueryExpr`. Matches attributes, the `message` column, and the
   * built-in `timestamp` / `level` columns (see the query-syntax docs). When
   * present it is ANDed with the timestamp range, the `message` term, and the
   * level filter.
   */
  attributeFilter?: FilterExpr;
} & LogLevelFilter;

// ---------------------------------------------------------------------------
// Adapter interfaces
// ---------------------------------------------------------------------------

/**
 * A log sink. Implementations receive each {@link LogRecord} via `write` and
 * may optionally support `flush`, `close`, and receiving the logger's level map.
 */
export interface LogAdapter {
  write(record: LogRecord): void | Promise<void>;
  flush?(): Promise<void>;
  close?(): Promise<void>;
  /**
   * Optional hook: receive the logger's full level map (built-ins merged with
   * any custom levels). The logger calls this when the adapter is registered
   * and whenever new levels are added, so adapter-level write filtering and
   * query defaults account for custom levels. Adapters that do not implement
   * it fall back to the built-in {@link LOG_LEVELS}.
   */
  setLevels?(levels: Record<string, number>): void;
}

// ---------------------------------------------------------------------------
// Error messages — stable string literals so callers can pattern-match on
// `err.message`. The offending detail (bad level, row count, underlying DB
// error) is carried on `err.cause`.
// ---------------------------------------------------------------------------

/** Errors returned by QueryableLogAdapter.query(). */
export type QueryError = "invalid log level" | "failed to query";

/** Errors returned by the purge APIs / PostgresAdapter.deepPurge(). */
export type PurgeError = "failed to purge" | "unknown purge id";

/** Lifecycle states of an asynchronous purge job. */
export type PurgeJobStatus =
  /** The impacted count met the confirmation threshold; nothing is deleted until {@link QueryableLogAdapter.confirmPurge}. */
  | "awaiting-confirmation"
  /** Background batched deletion is in progress. */
  | "running"
  | "completed"
  | "failed"
  /** The adapter was closed mid-purge; deletion stopped after the current batch. */
  | "aborted";

/**
 * The plan/progress snapshot returned by the purge APIs. `purge()` measures
 * the impacted rows up front and returns immediately — deletion happens in
 * the background in small batches, tracked here.
 */
export type PurgeJob = {
  /** Handle for {@link QueryableLogAdapter.purgeStatus} / {@link QueryableLogAdapter.confirmPurge}. */
  id: string;
  /** The cutoff — rows with `logged_timestamp <=` this instant are purged. */
  until: string;
  status: PurgeJobStatus;
  /** Planned number of `logs` rows. */
  logCount: number;
  /** Planned number of attribute rows (`log_attr` + `log_attr_blob`). */
  attrCount: number;
  /** `logCount + attrCount` — compared against the confirmation threshold. */
  totalCount: number;
  /** True when the job started as `awaiting-confirmation`. */
  requiresConfirmation: boolean;
  /** Progress: `logs` rows deleted so far. */
  deletedLogs: number;
  /** Progress: attribute rows deleted so far. */
  deletedAttrs: number;
  /** Present when `status` is `"failed"`. */
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};

/** Options accepted by {@link QueryableLogAdapter.purge}. */
export type PurgeOptions = {
  /**
   * Impacted-row count (logs + attrs) at or above which the purge waits for
   * {@link QueryableLogAdapter.confirmPurge} before deleting. Defaults to the
   * adapter's configured threshold (10 000 unless overridden).
   */
  confirmationThreshold?: number;
  /** Logs deleted per background batch. Defaults to 1 000. */
  batchSize?: number;
};

/** A {@link LogAdapter} that can also read back and purge stored records. */
export interface QueryableLogAdapter extends LogAdapter {
  query(options: LogQueryOptions): AsyncResult<LogRow[], QueryError>;
  /**
   * Plan a purge and return immediately: counts the impacted rows, and either
   * starts background batched deletion (below the confirmation threshold) or
   * parks the job as `awaiting-confirmation`.
   */
  purge(until: Date, options?: PurgeOptions): AsyncResult<PurgeJob, PurgeError>;
  /** Start an `awaiting-confirmation` job; for any other state, returns the current snapshot. */
  confirmPurge(id: string): AsyncResult<PurgeJob, PurgeError>;
  /** Check in on a purge job's progress. */
  purgeStatus(id: string): AsyncResult<PurgeJob, PurgeError>;
}

/** Type guard: true when the adapter implements `query` and `purge`. */
export function isQueryable(adapter: LogAdapter): adapter is QueryableLogAdapter {
  return (
    typeof (adapter as QueryableLogAdapter).query === "function" &&
    typeof (adapter as QueryableLogAdapter).purge === "function"
  );
}

// ---------------------------------------------------------------------------
// Encryption helpers — used by PostgresAdapter.
// ---------------------------------------------------------------------------

/** Encrypts a plaintext string into a ciphertext buffer for secure attribute storage. */
export type EncryptFn = (plaintext: string) => Buffer;
/** Decrypts a stored ciphertext string back into plaintext. */
export type DecryptFn = (ciphertext: string) => string;

// ---------------------------------------------------------------------------
// Warning callback type — surfaced when attribute keys/values are truncated.
// ---------------------------------------------------------------------------

/** A warning surfaced when an adapter truncates over-long attribute keys or values. */
export type AdapterWarning =
  | {
      type: "attr_keys_truncated";
      keys: Array<{ key: string; length: number }>;
      limit: number;
    }
  | {
      type: "attr_value_truncated";
      key: string;
      length: number;
      limit: number;
    };
