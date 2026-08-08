/**
 * PostgreSQL log adapter for @campfhir/bored-logs.
 *
 * Exposes {@link PostgresAdapter} — a {@link QueryableLogAdapter} backed by
 * Kysely + `pg` that batches writes, optionally encrypts attribute values,
 * runs boolean attribute-filter queries, and purges old rows — plus the
 * {@link createLoggerPool} factory and the Kysely table row types.
 *
 * @module
 */
import { Kysely, sql } from "kysely";
import { jsonArrayFrom } from "kysely/helpers/postgres";
import { Pool } from "pg";
import type { PoolConfig } from "pg";
import { up as runMigrations, down as rollbackMigrations } from "./migration";

import type {
  QueryableLogAdapter,
  LogRecord,
  LogRow,
  LogQueryOptions,
  QueryError,
  PurgeError,
  PurgeJob,
  PurgeOptions,
  EncryptFn,
  DecryptFn,
  AdapterWarning,
} from "../../logger/adapter";
import type { AttrPath, FilterExpr, LogQueryToken, PathSegment } from "../../logger/parseLogQuery";
import { parseAttrPath } from "../../logger/parseLogQuery";
import { LOG_LEVELS } from "../../logger/adapter";
import { isSecure, isRedacted, REDACTED_PLACEHOLDER } from "../../logger/template";
import type {
  Generated,
  Insertable,
  Selectable,
  Updateable,
  ExpressionBuilder,
  Expression,
  RawBuilder,
  SqlBool,
} from "kysely";
import type { Result } from "../../types";
import { Err } from "../../types";

// ---------------------------------------------------------------------------
// createLoggerPool — pg.Pool with conservative cloud-friendly defaults.
// ---------------------------------------------------------------------------

/**
 * Creates a `pg.Pool` with conservative cloud-friendly defaults (small max
 * connections and short timeouts). Any passed `config` overrides the defaults.
 */
export function createLoggerPool(config: PoolConfig = {}): Pool {
  return new Pool({
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    ...config,
  });
}

// ---------------------------------------------------------------------------
// Kysely table interfaces
// ---------------------------------------------------------------------------

interface LogTable {
  log_id: Generated<string>;
  message: string;
  logged_timestamp: Date;
  level: string;
}

interface LogAttributeTable {
  log_id: string;
  attr_id: Generated<string>;
  val_name: string;
  val: string | null;
  logged_timestamp: Date;
  val_type: string;
  encrypted: Generated<boolean>;
}

interface LogBlobAttributeTable {
  log_id: string;
  attr_id: Generated<string>;
  val_name: string;
  val: Buffer;
  logged_timestamp: Date;
  encrypted: Generated<boolean>;
}

/** Temporary table used inside transactions — must be in the Kysely type map. */
interface TempTableSelectedAttributes {
  val_name: string;
  val: string;
}

/**
 * Minimal Kysely DB interface required by this package.
 * Your application DB type must include (at minimum) these three tables.
 */
export interface LoggerTables {
  logs: LogTable;
  log_attr: LogAttributeTable;
  log_attr_blob: LogBlobAttributeTable;
  selected_attributes: TempTableSelectedAttributes;
}

/** A selected row from the `logs` table. */
export type Log = Selectable<LogTable>;
/** Shape for inserting a new row into the `logs` table. */
export type NewLog = Insertable<LogTable>;
/** Shape for updating an existing `logs` row. */
export type LogUpdate = Updateable<LogTable>;

/** A selected row from the `log_attr` scalar-attribute table. */
export type LogAttribute = Selectable<LogAttributeTable>;
/** Shape for inserting a new row into the `log_attr` table. */
export type NewLogAttribute = Insertable<LogAttributeTable>;

/** A selected row from the `log_attr_blob` binary-attribute table. */
export type LogBlobAttribute = Selectable<LogBlobAttributeTable>;
/** Shape for inserting a new row into the `log_attr_blob` table. */
export type NewLogBlobAttribute = Insertable<LogBlobAttributeTable>;

// ---------------------------------------------------------------------------
// Internal types used by PostgresAdapter
// ---------------------------------------------------------------------------

type DatabaseNonNullTypes = "string" | "number" | "boolean" | "date" | "json" | "binary";
type DatabaseNullType = "null";

/**
 * Serialized attribute map keyed by attribute name — each value carries its
 * stored string form (or `null`), a database value type, and an optional
 * encrypted flag.
 */
export type KeyValueMapping = {
  [key: string]:
    | { val: string; type: DatabaseNonNullTypes; encrypted?: boolean }
    | { val: null; type: DatabaseNullType; encrypted?: boolean };
};

/**
 * A fully materialized log record returned by the internal query path:
 * metadata plus decoded attributes and the names of any encrypted keys.
 */
export type LogEntry = {
  logId: string;
  message: string;
  timestamp: Date;
  level: string;
  attributes: { [key: string]: unknown };
  encryptedKeys: string[];
};

/** Fully-resolved options for the adapter's internal log query builder. */
export type PostgresQueryOptions = {
  id?: string | null;
  limit?: number;
  offset?: number;
  attributeFilter?: FilterExpr;
  logLevels: string[];
  sort: "asc" | "desc";
  dates?: { start?: Date; end?: Date };
  includeBinaryAttributes?: boolean;
  msg: string;
};

// ---------------------------------------------------------------------------
// Semaphore — limits concurrent database connections.
// ---------------------------------------------------------------------------

class Semaphore {
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly max: number) {}

  acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.running--;
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

type LogItem = {
  log_id: string;
  message: string;
  logged_timestamp: Date;
  level: string;
  attributes: {
    log_id: string;
    attr_id: string;
    val_name: string;
    val: string | null;
    val_type: string;
    logged_timestamp: Date;
    encrypted: boolean;
  }[];
};

// ---------------------------------------------------------------------------
// attributeFilter tree → SQL
//
// Compiles a FilterExpr (AND / OR / grouping over attribute filters) into a
// Kysely boolean expression against the main `logs` query. Attribute leaves
// become correlated (NOT) EXISTS subqueries on log_attr; message/msg leaves
// become (NOT) LIKE on logs.message.
// ---------------------------------------------------------------------------

// Built-in query keys map to real columns on the `logs` table rather than to
// stored attributes in `log_attr`. They carry the `$` sigil so an *unprefixed*
// key always means an attribute — `$message`/`$msg` → logs.message,
// `$timestamp` → logs.logged_timestamp, `$level` → logs.level, while a bare
// `message:` / `timestamp:` / `level:` searches an attribute of that name.
function isMessageKey(key: string): boolean {
  return key === "$message" || key === "$msg";
}
function isTimestampKey(key: string): boolean {
  return key === "$timestamp";
}
function isLevelKey(key: string): boolean {
  return key === "$level";
}

// Matches an ISO-8601 / RFC-3339 date or date-time string (JS-side gate).
const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
// Matches a bare calendar date with no time-of-day component.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Parse an ISO/RFC date-time string into a Date, or null when unparseable. */
function parseDateValue(value: string): Date | null {
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Operator predicate against an arbitrary text-valued SQL expression. Shared
 * by the flat-attribute path (`log_attr.val`) and concrete JSON paths (the
 * `#>>`-extracted text), so both compare with identical semantics.
 */
function textValuePredicate(
  eb: ExpressionBuilder<any, any>,
  ref: RawBuilder<any>,
  token: LogQueryToken,
  /**
   * Type gate for the lexicographic fallback: ordering with a value that is
   * neither numeric nor date-shaped is only meaningful between STRINGS, so the
   * caller supplies a "this value is string-typed" predicate and typed
   * (number/date) rows are excluded instead of being text-compared —
   * `userId:<'A'` must never match `userId = 123` because '123' < 'A'.
   * (The wildcard jsonpath compilation gets this via `@.type() == "string"`.)
   */
  stringTypeGuard: Expression<SqlBool>,
): Expression<SqlBool> {
  const { operator, value } = token;
  if (operator === "contains") return sql<boolean>`${ref} like ${`%${value}%`}`;
  if (operator === "=") return sql<boolean>`${ref} = ${value}`;

  // An explicit ::string cast coerces every value to its stored text form and
  // compares lexicographically — numbers ('123') and dates (ISO text)
  // INCLUDED, which is the opposite of the default string-type gate below.
  if (token.cast === "string") {
    return sql<boolean>`${ref} ${sql.raw(operator)} ${value}`;
  }

  // Comparison operator. Guard the numeric cast with a regex so non-numeric
  // values are excluded rather than raising a cast error.
  const isNumeric = /^-?[0-9]+(\.[0-9]+)?$/.test(value);
  if (isNumeric) {
    const num = parseFloat(value);
    return eb.and([
      sql<boolean>`${ref} ~ '^-?[0-9]+(\\.[0-9]+)?$'`,
      sql<boolean>`${ref}::numeric ${sql.raw(operator)} ${sql.lit(num)}::numeric`,
    ]);
  }
  // Date/time values: compare chronologically via a guarded timestamptz cast so
  // ISO/RFC strings order by instant, not lexically (which breaks across mixed
  // precisions and time zones). The regex guard keeps non-date rows sharing the
  // same attribute name from raising a cast error.
  if (ISO_DATE_RE.test(value)) {
    return eb.and([
      sql<boolean>`${ref} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]+)?)?(Z|[+-][0-9]{2}:?[0-9]{2})?)?$'`,
      sql<boolean>`${ref}::timestamptz ${sql.raw(operator)} ${value}::timestamptz`,
    ]);
  }
  return eb.and([stringTypeGuard, sql<boolean>`${ref} ${sql.raw(operator)} ${value}`]);
}

/** Value predicate inside a log_attr EXISTS subquery. */
function attrValuePredicate(
  eb: ExpressionBuilder<any, any>,
  token: LogQueryToken,
): Expression<SqlBool> {
  // A flat null literal matches by TYPE — that's how `serializeAttrValue`
  // stores a null attribute (val_type='null', val NULL).
  if (token.nullValue) return sql<boolean>`${sql.ref("log_attr.val_type")} = 'null'`;
  return textValuePredicate(
    eb,
    sql.ref("log_attr.val"),
    token,
    sql<boolean>`${sql.ref("log_attr.val_type")} = 'string'`,
  );
}

// ---------------------------------------------------------------------------
// Nested attribute paths — `session.id`, `users[*]`, `cart.items[*].sku`.
//
// The stored shape is one log_attr row per top-level attribute with
// val = JSON.stringify(value), val_type = 'json'. A path leaf keeps the same
// correlated EXISTS shell (val_name matches the BASE attribute) and adds a
// CASE-guarded JSON predicate. CASE guarantees evaluation order, so the
// ::jsonb cast never runs on ciphertext (encrypted), NULL (binary-routed
// oversized values), or non-JSON rows. Consequences: encrypted and oversized
// attributes never match a path filter — and therefore DO match its negation.
// ---------------------------------------------------------------------------

const NUMERIC_RE = /^-?[0-9]+(\.[0-9]+)?$/;

/** Render path segments as a jsonpath spine: `$."items"[*]."sku"`. Member names are JSON-escaped. */
function jsonPathSpine(segments: PathSegment[]): string {
  let out = "$";
  for (const seg of segments) {
    if (seg.type === "member") out += `.${JSON.stringify(seg.name)}`;
    else if (seg.type === "index") out += `[${seg.index}]`;
    else out += "[*]";
  }
  return out;
}

/** Escape a value for use inside a jsonpath `like_regex` pattern. */
function escapeJsonPathRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The jsonpath filter (`? (...)`) and its bound vars for a wildcard-path leaf.
 * Values reach the predicate via jsonpath vars where the grammar allows;
 * `like_regex` and `.datetime()` require literals, so those are regex- and
 * JSON-escaped into the path string — which is itself a bound SQL parameter,
 * so there is no SQL-injection surface either way.
 */
function jsonPathFilter(token: LogQueryToken): { filter: string; vars: Record<string, unknown> } {
  const { operator, value } = token;
  if (token.nullValue) return { filter: "@ == null", vars: {} };

  if (operator === "=") {
    // A query value is always a string; match the JSON string AND the typed
    // form so `users[*]:='123'` finds both "123" and 123 (mirroring how a
    // concrete path's #>> text extraction erases the distinction).
    if (NUMERIC_RE.test(value)) {
      return { filter: "@ == $vs || @ == $vn", vars: { vs: value, vn: parseFloat(value) } };
    }
    if (value === "true" || value === "false") {
      return { filter: "@ == $vs || @ == $vb", vars: { vs: value, vb: value === "true" } };
    }
    return { filter: "@ == $vs", vars: { vs: value } };
  }

  if (operator === "contains") {
    // Substring semantics on string elements only (like_regex is string-typed).
    const re = escapeJsonPathRegex(value);
    return { filter: `@.type() == "string" && @ like_regex ${JSON.stringify(re)}`, vars: {} };
  }

  // Range comparison. Cover JSON numbers AND string-encoded numbers, matching
  // the flat predicate's guarded ::numeric cast semantics.
  if (NUMERIC_RE.test(value)) {
    return {
      filter:
        `(@.type() == "number" && @ ${operator} $vn) || ` +
        `(@.type() == "string" && @ like_regex "^-?[0-9]+(\\\\.[0-9]+)?$" && @.double() ${operator} $vn)`,
      vars: { vn: parseFloat(value) },
    };
  }
  // Chronological comparison for ISO date values. Stored JSON dates are
  // JSON.stringify(Date) output (full ISO-Z), so both sides parse; rows whose
  // strings don't parse are skipped by the `silent` flag.
  if (ISO_DATE_RE.test(value)) {
    const iso = new Date(value).toISOString();
    return {
      filter: `@.type() == "string" && @.datetime() ${operator} ${JSON.stringify(iso)}.datetime()`,
      vars: {},
    };
  }
  return { filter: `@.type() == "string" && @ ${operator} $vs`, vars: { vs: value } };
}

/** The CASE-guarded JSON predicate for a path leaf (see section comment for why CASE). */
function pathPredicate(
  eb: ExpressionBuilder<any, any>,
  path: AttrPath,
  token: LogQueryToken,
): Expression<SqlBool> {
  const hasWildcard = path.segments.some((s) => s.type === "wildcard");

  let inner: Expression<SqlBool>;
  if (hasWildcard && token.cast === "string") {
    // ::string cast — extract every element at the path (any JSON type) and
    // compare its TEXT form, so numbers and dates coerce instead of being
    // type-gated. `#>> '{}'` renders any scalar as its bare text.
    const spine = jsonPathSpine(path.segments);
    const el = sql`(pq.el #>> '{}')`;
    inner = sql<boolean>`exists (select 1 from jsonb_path_query(${sql.ref("log_attr.val")}::jsonb, ${spine}::jsonpath) as pq(el) where ${textValuePredicate(eb, el, token, sql<boolean>`true`)})`;
  } else if (hasWildcard) {
    const { filter, vars } = jsonPathFilter(token);
    const jsonpath = `${jsonPathSpine(path.segments)} ? (${filter})`;
    inner = sql<boolean>`jsonb_path_exists(${sql.ref("log_attr.val")}::jsonb, ${jsonpath}::jsonpath, ${JSON.stringify(vars)}::jsonb, true)`;
  } else {
    // Concrete path. Segments as a bound text[] — integer indexes as strings
    // (#> / #>> index arrays with them).
    const arr = path.segments.map((s) =>
      s.type === "member" ? s.name : String((s as { index: number }).index),
    );
    if (token.nullValue) {
      // #> (jsonb, not text) distinguishes an explicit JSON null from a
      // missing path — #>> renders both as SQL NULL.
      inner = sql<boolean>`${sql.ref("log_attr.val")}::jsonb #> ${arr}::text[] = 'null'::jsonb`;
    } else {
      // Extract text and reuse the exact flat-value operator semantics
      // (#>> renders JSON string "123" and number 123 identically). The
      // string-type gate for lexicographic ordering checks the JSON type of
      // the element at the path.
      const extracted = sql`(${sql.ref("log_attr.val")}::jsonb #>> ${arr}::text[])`;
      inner = textValuePredicate(
        eb,
        extracted,
        token,
        sql<boolean>`jsonb_typeof(${sql.ref("log_attr.val")}::jsonb #> ${arr}::text[]) = 'string'`,
      );
    }
  }

  return sql<boolean>`case when ${sql.ref("log_attr.val_type")} = 'json' and ${sql.ref("log_attr.encrypted")} = false and ${sql.ref("log_attr.val")} is not null then ${inner} else false end`;
}

/** A `timestamp:` leaf → a comparison against the real logs.logged_timestamp column. */
function buildTimestampLeaf(
  eb: ExpressionBuilder<any, any>,
  token: LogQueryToken,
): Expression<SqlBool> {
  const { operator, value, negated } = token;
  const date = parseDateValue(value);
  // An unparseable date matches nothing (its negation matches everything),
  // rather than silently comparing against a non-existent attribute.
  if (date === null) return negated ? sql<boolean>`true` : sql<boolean>`false`;

  let predicate: Expression<SqlBool>;
  if ((operator === "=" || operator === "contains") && DATE_ONLY_RE.test(value)) {
    // A bare date with `=`/`:` means "anywhere on that calendar day".
    const next = new Date(date.getTime() + MS_PER_DAY);
    predicate = eb.and([
      eb("logs.logged_timestamp", ">=", date),
      eb("logs.logged_timestamp", "<", next),
    ]);
  } else if (operator === "contains") {
    predicate = eb("logs.logged_timestamp", "=", date);
  } else {
    predicate = eb("logs.logged_timestamp", operator, date);
  }
  return negated ? eb.not(predicate) : predicate;
}

/** A `level:` leaf → a comparison against the logs.level column (stored uppercased). */
function buildLevelLeaf(
  eb: ExpressionBuilder<any, any>,
  token: LogQueryToken,
): Expression<SqlBool> {
  const { operator, value, negated } = token;
  const upper = value.toUpperCase();
  // Level is set membership, not an ordered scale, so any comparison operator
  // other than `contains` is treated as an exact (case-insensitive) match.
  const predicate =
    operator === "contains"
      ? eb("logs.level", "like", `%${upper}%`)
      : eb("logs.level", "=", upper);
  return negated ? eb.not(predicate) : predicate;
}

// ---------------------------------------------------------------------------
// Purge job helpers
// ---------------------------------------------------------------------------

/** Random purge-job id (crypto.randomUUID with a portable fallback). */
function generatePurgeId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `purge_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Public copy of a purge job, without the internal batch-size field. */
function snapshotPurgeJob(job: PurgeJob & { _batchSize: number }): PurgeJob {
  const { _batchSize, ...pub } = job;
  return { ...pub };
}

/** A single filter leaf → a built-in column comparison or a correlated (NOT) EXISTS on log_attr. */
function buildLeaf(
  eb: ExpressionBuilder<any, any>,
  token: LogQueryToken,
): Expression<SqlBool> {
  if (isMessageKey(token.key)) {
    return eb("logs.message", token.negated ? "not like" : "like", `%${token.value}%`);
  }
  if (isTimestampKey(token.key)) return buildTimestampLeaf(eb, token);
  if (isLevelKey(token.key)) return buildLevelLeaf(eb, token);
  // A bare dotted/bracketed key is a path into a JSON attribute; a quoted key
  // (literalKey) — or a malformed path — stays a flat val_name lookup.
  const path = token.literalKey ? null : parseAttrPath(token.key);
  const exists = eb.exists(
    eb
      .selectFrom("log_attr")
      .select(sql`1`.as("one"))
      .whereRef("log_attr.log_id", "=", "logs.log_id")
      .where("log_attr.val_name", "=", path ? path.base : token.key)
      .where((sub) => (path ? pathPredicate(sub, path, token) : attrValuePredicate(sub, token))),
  );
  return token.negated ? eb.not(exists) : exists;
}

/** Recursively compile a FilterExpr tree into a Kysely boolean expression. */
function buildFilterExpr(
  eb: ExpressionBuilder<any, any>,
  node: FilterExpr,
): Expression<SqlBool> {
  if (node.type === "filter") return buildLeaf(eb, node.filter);
  const children = node.nodes.map((n) => buildFilterExpr(eb, n));
  return node.type === "and" ? eb.and(children) : eb.or(children);
}

// ---------------------------------------------------------------------------
// PostgresAdapterOptions
// ---------------------------------------------------------------------------

/** Whether a named migration's tables are present, as reported by the adapter. */
export type MigrationStatus = {
  name: string;
  /** True when all tables for this migration are present in the database. */
  applied: boolean;
};

/** Constructor options for {@link PostgresAdapter}. */
export type PostgresAdapterOptions = {
  /** Kysely instance. Pass your existing `Kysely<YourDatabase>` directly. */
  db: Kysely<any>;
  /** Minimum level to write to the database. Defaults to "info". */
  level?: string;
  /** Optional encryption function — when provided attribute values are stored encrypted. */
  encrypt?: EncryptFn;
  /** Optional decryption function — required when encrypt is provided. */
  decrypt?: DecryptFn;
  /**
   * Maximum concurrent DB operations. Defaults to 2.
   * Conservative default for cloud-hosted PostgreSQL.
   */
  maxConnections?: number;
  /**
   * Called when an attribute key or value is truncated due to column size limits.
   */
  onWarning?: (warning: AdapterWarning) => void;
  /**
   * Custom levels (name → rank) merged into the built-ins so write filtering
   * and query level defaults recognise them. Registering the adapter on a
   * logger that has custom levels sets these automatically; use this option
   * when constructing the adapter standalone (e.g. for querying only).
   */
  levels?: Record<string, number>;
  /**
   * Impacted-row count (logs + attrs) at or above which `purge()` waits for
   * `confirmPurge()` before deleting anything. Defaults to 10 000. Per-call
   * override via `purge(until, { confirmationThreshold })`.
   */
  purgeConfirmationThreshold?: number;
  /** Logs deleted per background purge batch. Defaults to 1 000. */
  purgeBatchSize?: number;
};

// ---------------------------------------------------------------------------
// Value serialization helpers
// ---------------------------------------------------------------------------

/**
 * Truncates a string so its UTF-8 encoding is at most `maxBytes`, without
 * splitting a multibyte character. Postgres measures varchar limits, bytea
 * sizes, and btree index rows in bytes, so char-based slicing
 * (String.prototype.slice) is not safe for multibyte input.
 */
function truncateUtf8(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) return str;
  // Cut at maxBytes, then back up past any trailing UTF-8 continuation bytes
  // (10xxxxxx) so we never keep half of a multibyte character.
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf-8");
}

function serializeAttrValue(
  key: string,
  value: unknown,
  encrypted: boolean,
  encryptFn: EncryptFn | null,
  MAX_ATTR_VAL_LENGTH: number,
): { val: string | null; type: string; encrypted: boolean } {
  let type: string;
  let val: string | null;

  if (value === null || value === undefined) {
    return { val: null, type: "null", encrypted: false };
  } else if (isRedacted(value)) {
    // Redacted values must never be persisted in plaintext — store the
    // placeholder regardless of the wrapped value.
    return { val: REDACTED_PLACEHOLDER, type: "string", encrypted: false };
  } else if (isSecure(value)) {
    // Unwrap Secure wrapper — treat the inner value as-is with encrypted=true.
    return serializeAttrValue(
      key,
      (value as any).value,
      true,
      encryptFn,
      MAX_ATTR_VAL_LENGTH,
    );
  } else if (value instanceof Date) {
    val = value.toISOString();
    type = "date";
  } else if (typeof value === "number") {
    val = String(value);
    type = "number";
  } else if (typeof value === "boolean") {
    val = String(value);
    type = "boolean";
  } else if (typeof value === "string") {
    val = value;
    type = "string";
  } else if (typeof value === "object") {
    val = JSON.stringify(value);
    type = "json";
  } else {
    val = String(value);
    type = "string";
  }

  if (encrypted && encryptFn && val != null) {
    try {
      val = encryptFn(val).toString("base64url");
    } catch {
      // ignore encryption failure — store plaintext
    }
  }

  // Route oversized values to the (un-indexed, bytea) blob table. The size is
  // measured against the FINAL stored string in UTF-8 bytes — the same units
  // Postgres uses for the btree index on log_attr.val. Measuring the encoded
  // byte length (rather than JS string .length) accounts for both multibyte
  // characters and base64 ciphertext expansion, either of which can push a
  // value past the btree row-size limit (~2704 bytes) even when its character
  // count is under the threshold.
  if (val != null && Buffer.byteLength(val, "utf-8") >= MAX_ATTR_VAL_LENGTH) {
    type = "binary";
  }

  return { val, type, encrypted };
}

// ---------------------------------------------------------------------------
// PostgresAdapter
// ---------------------------------------------------------------------------

/**
 * A {@link QueryableLogAdapter} backed by Kysely + `pg`. Buffers log records
 * and flushes them in batches, optionally encrypts attribute values, resolves
 * boolean attribute-filter queries, and supports bounded and unbounded purges.
 */
export class PostgresAdapter implements QueryableLogAdapter {
  private readonly _db: Kysely<LoggerTables>;
  private _level: string;
  private readonly _encrypt: EncryptFn | null;
  private readonly _decrypt: DecryptFn | null;
  private readonly _encryptionEnabled: boolean;
  private readonly _semaphore: Semaphore;
  private readonly _onWarning: ((warning: AdapterWarning) => void) | null;
  private _levels: Record<string, number>;

  private readonly queue: LogRecord[] = [];
  private isProcessing = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  // ── Purge job state ───────────────────────────────────────────────────────
  private readonly _purgeJobs = new Map<string, PurgeJob & { _batchSize: number }>();
  private readonly _activePurges = new Set<Promise<void>>();
  private _closing = false;
  private readonly _purgeThreshold: number;
  private readonly _purgeBatchSize: number;

  private readonly BATCH_SIZE = 50;
  private readonly FLUSH_INTERVAL_MS = 5000;
  /**
   * Values whose final stored size (UTF-8 bytes) is at or above this are
   * routed to log_attr_blob. Kept below Postgres's ~2704-byte btree row-size
   * limit so `log_attr.val` always fits its index (attr_val_name_idx).
   */
  private readonly MAX_ATTR_VAL_LENGTH = 2000;
  /** Hard cap on blob values in UTF-8 bytes. Larger values are truncated. */
  private readonly MAX_BLOB_VAL_LENGTH = 65_536; // 64 KB
  /**
   * Max attribute-key size in UTF-8 bytes. Kept at the val_name VARCHAR(1024)
   * limit — bytes are always >= characters, so a byte-bounded key also fits the
   * character column, and stays well under the ~2704-byte btree row limit for
   * the log_attr_val_name_idx index.
   */
  private readonly MAX_ATTR_KEY_LENGTH = 1024;
  /** Default impacted-row count at which purge() requires confirmation. */
  private readonly PURGE_CONFIRMATION_THRESHOLD = 10_000;
  /** Default logs deleted per background purge batch. */
  private readonly PURGE_BATCH_SIZE = 1_000;
  /** Retained purge jobs — pruned oldest-finished-first past this cap. */
  private readonly MAX_PURGE_JOBS = 100;

  /** Builds an adapter from the given options and starts the periodic flush timer. */
  constructor(opts: PostgresAdapterOptions) {
    this._db = opts.db;
    this._level = opts.level ?? process.env.LOG_DB_LEVEL ?? "info";
    this._encrypt = opts.encrypt ?? null;
    this._decrypt = opts.decrypt ?? null;
    this._encryptionEnabled = this._encrypt != null && this._decrypt != null;
    this._semaphore = new Semaphore(opts.maxConnections ?? 2);
    this._onWarning = opts.onWarning ?? null;
    this._levels = { ...LOG_LEVELS, ...opts.levels };
    this._purgeThreshold = opts.purgeConfirmationThreshold ?? this.PURGE_CONFIRMATION_THRESHOLD;
    this._purgeBatchSize = opts.purgeBatchSize ?? this.PURGE_BATCH_SIZE;

    this._startFlushTimer();
  }

  /** The minimum level currently written to the database. */
  get level(): string {
    return this._level;
  }

  /** Sets the minimum level written to the database. */
  set level(value: string) {
    this._level = value;
  }

  /** Merges additional custom level ranks into the adapter's level map. */
  setLevels(levels: Record<string, number>): void {
    Object.assign(this._levels, levels);
  }

  // ── LogAdapter.write ────────────────────────────────────────────────────

  /** Enqueues a log record for batched writing, dropping records below the configured level. */
  write(record: LogRecord): void {
    const recordNum =
      this._levels[record.level.toLowerCase()] ?? this._levels.debug;
    const levelNum =
      this._levels[this._level.toLowerCase()] ?? this._levels.info;
    if (recordNum > levelNum) return;

    this.queue.push(record);

    if (this.queue.length >= this.BATCH_SIZE) {
      void this._flushQueue();
    }
  }

  // ── QueryableLogAdapter.query ───────────────────────────────────────────

  /** Queries stored logs by date range, level, message, and attribute filters, returning matching rows. */
  async query(options: LogQueryOptions): Promise<Result<LogRow[], QueryError>> {
    try {
      const start = options.start
        ? new Date(options.start)
        : new Date(Date.now() - 24 * 60 * 60 * 1000);
      const end = options.end ? new Date(options.end) : new Date();
      const limit = Math.min(options.limit ?? 250, 1000);
      const offset = options.offset ?? 0;
      const sort = options.sort ?? "desc";
      const message = options.message ?? "";
      const attributeFilter = options.attributeFilter;

      // Resolve the level filter to an exact-match set (SQL `IN`). `level` and
      // `levels` name exact levels; `minLevel` expands to a severity threshold
      // (this level and everything more severe). Omitting all three queries
      // every level.
      //
      // The LogLevelFilter type already constrains callers to LogLevel, but
      // untyped (JS) callers can still pass anything — reject unknown names
      // with a clear error instead of silently matching nothing.
      const isKnownLevel = (l: string): boolean =>
        this._levels[l.toLowerCase()] !== undefined;
      const invalidLevels = [
        ...(options.level ? [options.level] : []),
        ...(options.levels ?? []),
        ...(options.minLevel ? [options.minLevel] : []),
      ].filter((l) => !isKnownLevel(l));
      if (invalidLevels.length > 0) {
        return {
          ok: false,
          err: new Err("invalid log level").addCause(
            `invalid log level(s): ${invalidLevels.join(", ")}. valid levels: ${Object.keys(this._levels).join(", ")}`,
          ),
        };
      }

      const requestedLevels = new Set<string>(options.levels ?? []);
      if (options.level) requestedLevels.add(options.level);
      if (options.minLevel) {
        const threshold = this._levels[options.minLevel.toLowerCase()];
        for (const [name, rank] of Object.entries(this._levels)) {
          if (rank <= threshold) requestedLevels.add(name);
        }
      }
      const ALL_LOG_LEVELS = Object.keys(this._levels);
      const logLevels =
        requestedLevels.size > 0 ? [...requestedLevels] : ALL_LOG_LEVELS;

      const result = await this._semaphore.run(() =>
        this._queryLogs({
          attributeFilter,
          logLevels,
          sort,
          limit,
          offset,
          dates: { start, end },
          msg: message,
          includeBinaryAttributes: false,
        }),
      );

      if (!result.ok) {
        if (result.err.message === "no logs found")
          return { ok: true, val: [] };
        // Only "failed to query" remains; narrow away the "no logs found" arm.
        return { ok: false, err: result.err as Err<"failed to query"> };
      }

      return {
        ok: true,
        val: result.val.map((row) => ({
          id: row.logId,
          level: row.level,
          message: row.message,
          meta: row.attributes,
          timestamp: row.timestamp.toISOString(),
        })),
      };
    } catch (err) {
      return {
        ok: false,
        err: new Err("failed to query").addCause(
          err instanceof Error ? err : String(err),
        ),
      };
    }
  }

  // ── QueryableLogAdapter.purge — async plan / confirm / status ────────────

  /**
   * Plan a purge of rows with `logged_timestamp <= until` and return
   * immediately: the impacted `logs` / attribute rows are counted up front,
   * and the returned {@link PurgeJob} carries the counts plus an `id` for
   * {@link purgeStatus} / {@link confirmPurge}.
   *
   * When the total is below the confirmation threshold, batched deletion
   * starts in the background right away; at or above it, the job parks as
   * `awaiting-confirmation` and nothing is deleted until {@link confirmPurge}.
   * Each batch is its own short transaction, so no statement runs long enough
   * to hit a timeout regardless of how many rows are purged, and writes
   * interleave between batches.
   */
  async purge(until: Date, options?: PurgeOptions): Promise<Result<PurgeJob, PurgeError>> {
    const threshold = options?.confirmationThreshold ?? this._purgeThreshold;
    const batchSize = options?.batchSize ?? this._purgeBatchSize;
    try {
      const counts = await this._semaphore.run(() => this._countImpacted(until));
      const totalCount = counts.logs + counts.attrs;
      const requiresConfirmation = totalCount >= threshold && totalCount > 0;

      const job: PurgeJob & { _batchSize: number } = {
        id: generatePurgeId(),
        until: until.toISOString(),
        status:
          totalCount === 0 ? "completed" : requiresConfirmation ? "awaiting-confirmation" : "running",
        logCount: counts.logs,
        attrCount: counts.attrs,
        totalCount,
        requiresConfirmation,
        deletedLogs: 0,
        deletedAttrs: 0,
        createdAt: new Date().toISOString(),
        _batchSize: batchSize,
      };
      if (totalCount === 0) job.finishedAt = job.createdAt;
      this._storePurgeJob(job);

      if (job.status === "running") this._startPurge(job);
      return { ok: true, val: snapshotPurgeJob(job) };
    } catch (err) {
      const cause = err instanceof Error ? err : String(err);
      return { ok: false, err: new Err("failed to purge").addCause(cause) };
    }
  }

  /**
   * Confirm an `awaiting-confirmation` purge, starting its background
   * deletion. For a job in any other state this is a no-op that returns the
   * current snapshot, so it can double as a check-in.
   */
  async confirmPurge(id: string): Promise<Result<PurgeJob, PurgeError>> {
    const job = this._purgeJobs.get(id);
    if (!job) {
      return { ok: false, err: new Err("unknown purge id").addCause(`no purge job ${id}`) };
    }
    if (job.status === "awaiting-confirmation") {
      job.status = "running";
      this._startPurge(job);
    }
    return { ok: true, val: snapshotPurgeJob(job) };
  }

  /** Current snapshot of a purge job — status, planned counts, and progress. */
  async purgeStatus(id: string): Promise<Result<PurgeJob, PurgeError>> {
    const job = this._purgeJobs.get(id);
    if (!job) {
      return { ok: false, err: new Err("unknown purge id").addCause(`no purge job ${id}`) };
    }
    return { ok: true, val: snapshotPurgeJob(job) };
  }

  /** Count the rows a purge of `until` would delete (logs, and attr + blob rows). */
  private async _countImpacted(until: Date): Promise<{ logs: number; attrs: number }> {
    const count = async (table: "logs" | "log_attr" | "log_attr_blob"): Promise<number> => {
      const row = await this._db
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("logged_timestamp", "<=", until)
        .executeTakeFirstOrThrow();
      return Number(row.n);
    };
    const logs = await count("logs");
    const attrs = (await count("log_attr")) + (await count("log_attr_blob"));
    return { logs, attrs };
  }

  /** Store a job, pruning the oldest finished jobs past the retention cap. */
  private _storePurgeJob(job: PurgeJob & { _batchSize: number }): void {
    if (this._purgeJobs.size >= this.MAX_PURGE_JOBS) {
      for (const [id, existing] of this._purgeJobs) {
        if (existing.status !== "running" && existing.status !== "awaiting-confirmation") {
          this._purgeJobs.delete(id);
          if (this._purgeJobs.size < this.MAX_PURGE_JOBS) break;
        }
      }
    }
    this._purgeJobs.set(job.id, job);
  }

  /** Kick off the background batched deletion for a running job. */
  private _startPurge(job: PurgeJob & { _batchSize: number }): void {
    job.startedAt = new Date().toISOString();
    const run = this._runPurge(job).finally(() => this._activePurges.delete(run));
    this._activePurges.add(run);
  }

  /** The background loop: one short transaction per batch until done, closed, or failed. */
  private async _runPurge(job: PurgeJob & { _batchSize: number }): Promise<void> {
    const until = new Date(job.until);
    try {
      for (;;) {
        if (this._closing) {
          job.status = "aborted";
          job.finishedAt = new Date().toISOString();
          return;
        }
        const batch = await this._semaphore.run(() => this._purgeBatch(until, job._batchSize));
        job.deletedLogs += batch.logs;
        job.deletedAttrs += batch.attrs;
        if (batch.logs < job._batchSize) break; // final (possibly empty) batch
      }
      job.status = "completed";
      job.finishedAt = new Date().toISOString();
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = new Date().toISOString();
    }
  }

  /** Delete one bounded batch; returns the rows removed per table group. */
  private async _purgeBatch(
    until: Date,
    batchSize: number,
  ): Promise<{ logs: number; attrs: number }> {
    return this._db.transaction().execute(async (tx) => {
      // Capture the bounded set of IDs once so all three DELETEs target
      // exactly the same rows regardless of concurrent inserts.
      await sql`
        CREATE TEMP TABLE _purge_ids ON COMMIT DROP AS
          SELECT log_id FROM logs
          WHERE logged_timestamp <= ${until}
          LIMIT ${sql.lit(batchSize)}
      `.execute(tx);

      const countDeleted = async (query: ReturnType<typeof sql>): Promise<number> => {
        const res = await query.execute(tx);
        const n = (res.rows[0] as { n?: string | number } | undefined)?.n;
        return n != null ? Number(n) : 0;
      };

      const blobs = await countDeleted(sql`
        WITH d AS (
          DELETE FROM log_attr_blob
          USING _purge_ids
          WHERE log_attr_blob.log_id = _purge_ids.log_id
          RETURNING 1
        ) SELECT count(*) AS n FROM d
      `);
      const attrs = await countDeleted(sql`
        WITH d AS (
          DELETE FROM log_attr
          USING _purge_ids
          WHERE log_attr.log_id = _purge_ids.log_id
          RETURNING 1
        ) SELECT count(*) AS n FROM d
      `);
      const logs = await countDeleted(sql`
        WITH d AS (
          DELETE FROM logs
          USING _purge_ids
          WHERE logs.log_id = _purge_ids.log_id
          RETURNING 1
        ) SELECT count(*) AS n FROM d
      `);
      return { logs, attrs: attrs + blobs };
    });
  }

  /**
   * Deletes all log records on or before `until` with no record-count limit.
   * Uses a single DELETE…USING to avoid loading IDs into memory.
   *
   * @param until    Delete records with logged_timestamp <= this date.
   * @param opts.timeoutMs  Postgres statement_timeout for the transaction in ms.
   *                        0 = no timeout (default). Set to e.g. 30_000 for a 30 s cap.
   */
  async deepPurge(
    until: Date,
    opts?: { timeoutMs?: number },
  ): Promise<Result<number, "failed to purge">> {
    const timeoutMs = opts?.timeoutMs ?? 0;
    try {
      const result = await this._db.transaction().execute(async (tx) => {
        await sql`SET LOCAL statement_timeout = ${sql.lit(timeoutMs)}`.execute(
          tx,
        );

        // Delete child rows first (FK constraints), then the parent.
        await sql`
          DELETE FROM log_attr_blob
          USING logs
          WHERE log_attr_blob.log_id = logs.log_id
            AND logs.logged_timestamp <= ${until}
        `.execute(tx);

        await sql`
          DELETE FROM log_attr
          USING logs
          WHERE log_attr.log_id = logs.log_id
            AND logs.logged_timestamp <= ${until}
        `.execute(tx);

        const del = await sql<{ count: string }>`
          WITH deleted AS (
            DELETE FROM logs
            WHERE logged_timestamp <= ${until}
            RETURNING 1
          )
          SELECT count(*) AS count FROM deleted
        `.execute(tx);

        return del.rows[0]?.count != null ? parseInt(del.rows[0].count, 10) : 0;
      });
      return { ok: true, val: result };
    } catch (err) {
      return {
        ok: false,
        err: new Err("failed to purge").addCause(
          err instanceof Error ? err : String(err),
        ),
      };
    }
  }

  // ── Schema migration ────────────────────────────────────────────────────

  /** Run all logger migrations in order. Idempotent — safe to call on startup. */
  async migrate(): Promise<void> {
    await runMigrations(this._db);
  }

  /** Roll back all logger migrations (reverse order). Idempotent — safe to call even if tables do not exist. */
  async rollback(): Promise<void> {
    await rollbackMigrations(this._db);
  }

  /**
   * Returns the applied status of each logger migration by checking actual
   * schema state (table / index existence) — no tracking table is used or
   * required.
   */
  async migrationStatus(): Promise<MigrationStatus[]> {
    const tables = await sql<{ table_name: string }>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN ('logs', 'log_attr', 'log_attr_blob')
    `.execute(this._db);
    const existingTables = new Set(tables.rows.map((r) => r.table_name));

    const indexes = await sql<{ indexname: string }>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname = 'log_attr_val_name_idx'
    `.execute(this._db);
    const existingIndexes = new Set(indexes.rows.map((r) => r.indexname));

    return [
      {
        name: "001_logs",
        applied:
          existingTables.has("logs") &&
          existingTables.has("log_attr") &&
          existingTables.has("log_attr_blob"),
      },
      {
        name: "002_attr_val_name_index",
        applied: existingIndexes.has("log_attr_val_name_idx"),
      },
    ];
  }

  // ── LogAdapter lifecycle ────────────────────────────────────────────────

  /** Flushes any queued records to the database immediately. */
  async flush(): Promise<void> {
    await this._flushQueue();
  }

  /**
   * Stops the flush timer, flushes any remaining queued records, and stops
   * in-flight purges: each finishes its current batch, then its job is marked
   * `aborted`.
   */
  async close(): Promise<void> {
    this._closing = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this._flushQueue();
    await Promise.allSettled([...this._activePurges]);
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  private _startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      void this._flushQueue();
    }, this.FLUSH_INTERVAL_MS);

    if (
      typeof this.flushTimer === "object" &&
      this.flushTimer !== null &&
      "unref" in this.flushTimer
    ) {
      (this.flushTimer as any).unref();
    }
  }

  private async _flushQueue(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;
    const batch = this.queue.splice(0, this.BATCH_SIZE);

    try {
      await this._semaphore.run(() => this._writeBatch(batch));
    } catch {
      this.queue.unshift(...batch);
    } finally {
      this.isProcessing = false;
      if (this.queue.length >= this.BATCH_SIZE) {
        setImmediate(() => void this._flushQueue());
      }
    }
  }

  private async _writeBatch(batch: LogRecord[]): Promise<void> {
    if (batch.length === 0) return;

    await this._db.transaction().execute(async (tx) => {
      for (const record of batch) {
        const res = await (tx as Kysely<LoggerTables>)
          .insertInto("logs")
          .values({
            message: record.message,
            logged_timestamp: record.timestamp,
            level: record.level.toUpperCase(),
          })
          .returning(["log_id"])
          .executeTakeFirstOrThrow();

        // Build the key-value mapping from attrs.
        const kvEntries = this._buildKVMapping(record);

        // Check for keys exceeding the column limit (measured in UTF-8 bytes,
        // matching how Postgres sizes the val_name column and its index).
        const oversizedKeys: Array<{ key: string; length: number }> = [];
        for (const [key] of kvEntries) {
          const byteLength = Buffer.byteLength(key, "utf-8");
          if (byteLength > this.MAX_ATTR_KEY_LENGTH) {
            oversizedKeys.push({ key: key.slice(0, 40), length: byteLength });
          }
        }
        if (oversizedKeys.length > 0) {
          this._onWarning?.({
            type: "attr_keys_truncated",
            keys: oversizedKeys,
            limit: this.MAX_ATTR_KEY_LENGTH,
          });
        }

        const metaAttrs = kvEntries.map(([key, entry]) => ({
          log_id: res.log_id,
          val_name: truncateUtf8(key, this.MAX_ATTR_KEY_LENGTH),
          val: entry.type === "binary" ? null : entry.val,
          val_type: entry.type,
          encrypted: entry.encrypted ?? false,
          logged_timestamp: record.timestamp,
        }));

        if (metaAttrs.length > 0) {
          await (tx as Kysely<LoggerTables>)
            .insertInto("log_attr")
            .columns([
              "log_id",
              "val_name",
              "val",
              "logged_timestamp",
              "val_type",
              "encrypted",
            ])
            .values(metaAttrs)
            .execute();
        }

        const blobAttrs = kvEntries
          .filter(([, e]) => e.type === "binary" && e.val != null)
          .map(([key, entry]) => {
            const val = entry.val as string;
            // Bound the stored bytea by UTF-8 byte length — the size Postgres
            // actually stores — not JS string length.
            const byteLength = Buffer.byteLength(val, "utf-8");
            if (byteLength > this.MAX_BLOB_VAL_LENGTH) {
              this._onWarning?.({
                type: "attr_value_truncated",
                key: key.slice(0, 40),
                length: byteLength,
                limit: this.MAX_BLOB_VAL_LENGTH,
              });
            }
            return {
              log_id: res.log_id,
              val_name: truncateUtf8(key, this.MAX_ATTR_KEY_LENGTH),
              val: Buffer.from(
                truncateUtf8(val, this.MAX_BLOB_VAL_LENGTH),
                "utf-8",
              ),
              encrypted: entry.encrypted ?? false,
              logged_timestamp: record.timestamp,
            };
          });

        if (blobAttrs.length > 0) {
          await (tx as Kysely<LoggerTables>)
            .insertInto("log_attr_blob")
            .columns([
              "log_id",
              "val_name",
              "val",
              "logged_timestamp",
              "encrypted",
            ])
            .values(blobAttrs)
            .execute();
        }
      }
    });
  }

  private _buildKVMapping(
    record: LogRecord,
  ): Array<
    [string, { val: string | null; type: string; encrypted?: boolean }]
  > {
    const result: Array<
      [string, { val: string | null; type: string; encrypted?: boolean }]
    > = [];

    for (const [key, value] of Object.entries(record.attrs)) {
      const encrypted = isSecure(value);
      const entry = serializeAttrValue(
        key,
        value,
        encrypted,
        this._encrypt,
        this.MAX_ATTR_VAL_LENGTH,
      );
      result.push([key, entry]);
    }

    // Append standard meta attributes. `application` / `version` are not
    // columns, so they ride along as attributes — but they are also legal
    // attribute names. An explicit attribute wins (the same "call site
    // overrides the global" rule the logger applies), and skipping it here is
    // what keeps the key from being written twice.
    if (record.application && !("application" in record.attrs)) {
      result.push(["application", { val: record.application, type: "string" }]);
    }
    if (record.version && !("version" in record.attrs)) {
      result.push(["version", { val: record.version, type: "string" }]);
    }

    return result;
  }

  // ── Query internals ─────────────────────────────────────────────────────

  private async _queryLogs(
    opts: PostgresQueryOptions,
  ): Promise<Result<LogEntry[], "no logs found" | "failed to query">> {
    const startOfYesterday = new Date(
      new Date().setDate(new Date().getDate() - 1),
    );
    const endOfToday = new Date(new Date().setHours(23, 59, 59, 999));
    const { sort } = opts;
    const logLevels = opts.logLevels.map((l) => l.toUpperCase());
    const limit = opts.limit ?? 250;
    const offset = opts.offset ?? 0;
    const start = opts.dates?.start ?? startOfYesterday;
    const end = opts.dates?.end ?? endOfToday;

    // Message term. Attribute/message/timestamp/level matching all flows through
    // the `attributeFilter` boolean tree (see buildFilterExpr); this top-level
    // `message` option is a convenience for a plain contains term.
    const msg = opts.msg ?? "";

    // Single-ID lookup.
    if (opts.id != null) {
      const logs = await this._db
        .selectFrom("logs")
        .select((eb) => [
          "log_id",
          "level",
          "logged_timestamp",
          "message",
          jsonArrayFrom(
            eb
              .selectFrom("log_attr")
              .selectAll()
              .whereRef("logs.log_id", "=", "log_attr.log_id"),
          ).as("attributes"),
        ])
        .where("logs.log_id", "=", opts.id)
        .orderBy("logs.logged_timestamp", sort)
        .execute();

      let binaryAttributes: LogBlobAttribute[] = [];
      if (opts.includeBinaryAttributes) {
        binaryAttributes = await this._db
          .selectFrom("log_attr_blob")
          .select([
            "log_id",
            "attr_id",
            "log_attr_blob.val_name",
            "log_attr_blob.val",
            "logged_timestamp",
            "encrypted",
          ])
          .where("log_attr_blob.log_id", "=", opts.id)
          .execute();
      }
      return {
        ok: true,
        val: await this._parseLogs({ logs, binaryAttributes }),
      };
    }

    // Standard query.
    try {
      const logs = await this._db
        .selectFrom("logs")
        .select((eb) => [
          "log_id",
          "level",
          "logged_timestamp",
          "message",
          jsonArrayFrom(
            eb
              .selectFrom("log_attr")
              .selectAll()
              .whereRef("logs.log_id", "=", "log_attr.log_id"),
          ).as("attributes"),
        ])
        .where("logs.logged_timestamp", ">=", start)
        .where("logs.logged_timestamp", "<", end)
        .$if(msg !== "", (qb) => qb.where("logs.message", "like", `%${msg}%`))
        .$if(opts.attributeFilter != null, (qb) =>
          qb.where((eb) => buildFilterExpr(eb, opts.attributeFilter!)),
        )
        .where("logs.level", "in", logLevels)
        .orderBy("logs.logged_timestamp", sort)
        .limit(limit)
        .offset(offset)
        .execute();

      if (logs.length === 0) {
        return { ok: false, err: new Err("no logs found") };
      }

      let binaryAttributes: LogBlobAttribute[] = [];
      if (opts.includeBinaryAttributes) {
        binaryAttributes = await this._db
          .selectFrom("log_attr_blob")
          .selectAll("log_attr_blob")
          .where(
            "log_attr_blob.log_id",
            "in",
            logs.map((l) => l.log_id as unknown as string),
          )
          .execute();
      }

      return {
        ok: true,
        val: await this._parseLogs({ logs, binaryAttributes }),
      };
    } catch (err) {
      return {
        ok: false,
        err: new Err("failed to query").addCause(err as Error),
      };
    }
  }

  private async _parseLogs(opts: {
    logs: LogItem[];
    binaryAttributes?: LogBlobAttribute[];
  }): Promise<LogEntry[]> {
    const { logs } = opts;
    const binaryAttributes = opts.binaryAttributes ?? [];

    if (this._encryptionEnabled && this._decrypt) {
      for (const log of logs) {
        for (const i in log.attributes) {
          const attribute = log.attributes[i];
          if (
            !attribute.encrypted ||
            attribute.val_type === "null" ||
            attribute.val == null
          )
            continue;
          try {
            log.attributes[i].val = this._decrypt!(attribute.val);
          } catch {
            // ignore individual decryption errors
          }
        }
      }
    }

    return logs.map((log) => {
      const attributes = log.attributes.reduce<{ [key: string]: unknown }>(
        (pv, curr) => {
          if (curr.val_type === "null") pv[curr.val_name] = null;
          else if (curr.val_type === "date" && curr.val != null)
            pv[curr.val_name] = new Date(curr.val);
          else if (curr.val_type === "number" && curr.val != null)
            pv[curr.val_name] = parseInt(curr.val, 10);
          else if (curr.val_type === "boolean" && curr.val != null)
            pv[curr.val_name] = curr.val === "true";
          else if (curr.val_type === "json" && curr.val != null) {
            try {
              pv[curr.val_name] = JSON.parse(curr.val);
            } catch {
              pv[curr.val_name] = curr.val;
            }
          } else if (curr.val_type === "binary") {
            const v = binaryAttributes.find(
              (e) => e.log_id === curr.log_id && e.val_name === curr.val_name,
            )?.val;
            if (v != null) {
              try {
                pv[curr.val_name] = JSON.parse(v.toString("utf-8"));
              } catch {
                pv[curr.val_name] = v.toString("utf-8");
              }
            }
          } else {
            pv[curr.val_name] = curr.val;
          }
          return pv;
        },
        {},
      );

      const encryptedKeys = log.attributes
        .filter((a) => a.encrypted)
        .map((a) => a.val_name);

      return {
        timestamp: new Date(log.logged_timestamp),
        level: log.level,
        message: log.message,
        logId: log.log_id,
        attributes,
        encryptedKeys,
      };
    });
  }
}
