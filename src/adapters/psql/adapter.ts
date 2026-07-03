import { Kysely, sql } from "kysely";
import { jsonArrayFrom } from "kysely/helpers/postgres";
import { Pool } from "pg";
import type { PoolConfig } from "pg";
import { up as up001, down as down001 } from "./migration/001_logs";
import {
  up as up002,
  down as down002,
} from "./migration/002_attr_val_name_index";

import type {
  QueryableLogAdapter,
  LogRecord,
  LogRow,
  LogQueryOptions,
  QueryError,
  PurgeError,
  AttributeFilter,
  EncryptFn,
  DecryptFn,
  AdapterWarning,
} from "../../logger/adapter";
import type { FilterExpr, LogQueryToken } from "../../logger/parseLogQuery";
import { LOG_LEVELS } from "../../logger/adapter";
import { isSecure } from "../../logger/template";
import type {
  Generated,
  Insertable,
  Selectable,
  Updateable,
  ExpressionBuilder,
  Expression,
  SqlBool,
} from "kysely";
import type { Result } from "../../types";
import { Err } from "../../types";

// ---------------------------------------------------------------------------
// createLoggerPool — pg.Pool with conservative cloud-friendly defaults.
// ---------------------------------------------------------------------------

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

export type Log = Selectable<LogTable>;
export type NewLog = Insertable<LogTable>;
export type LogUpdate = Updateable<LogTable>;

export type LogAttribute = Selectable<LogAttributeTable>;
export type NewLogAttribute = Insertable<LogAttributeTable>;

export type LogBlobAttribute = Selectable<LogBlobAttributeTable>;
export type NewLogBlobAttribute = Insertable<LogBlobAttributeTable>;

// ---------------------------------------------------------------------------
// Internal types used by PostgresAdapter
// ---------------------------------------------------------------------------

type DatabaseNonNullTypes = "string" | "number" | "boolean" | "date" | "json" | "binary";
type DatabaseNullType = "null";

export type KeyValueMapping = {
  [key: string]:
    | { val: string; type: DatabaseNonNullTypes; encrypted?: boolean }
    | { val: null; type: DatabaseNullType; encrypted?: boolean };
};

export type LogEntry = {
  logId: string;
  message: string;
  timestamp: Date;
  level: string;
  attributes: { [key: string]: unknown };
  encryptedKeys: string[];
};

export type PostgresQueryOptions = {
  id?: string | null;
  limit?: number;
  offset?: number;
  attributeFilters?: AttributeFilter[];
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

function isMessageKey(key: string): boolean {
  return key === "message" || key === "msg";
}

/** Value predicate inside a log_attr EXISTS subquery. */
function attrValuePredicate(
  eb: ExpressionBuilder<any, any>,
  token: LogQueryToken,
): Expression<SqlBool> {
  const { operator, value } = token;
  if (operator === "contains") return eb("log_attr.val", "like", `%${value}%`);
  if (operator === "=") return eb("log_attr.val", "=", value);

  // Comparison operator. Guard the numeric cast with a regex so non-numeric
  // values are excluded rather than raising a cast error — matches the
  // behaviour of _fetchMatchingIds for the flat attributeFilters path.
  const isNumeric = /^-?[0-9]+(\.[0-9]+)?$/.test(value);
  if (isNumeric) {
    const num = parseFloat(value);
    return eb.and([
      sql<boolean>`log_attr.val ~ '^-?[0-9]+(\\.[0-9]+)?$'`,
      sql<boolean>`log_attr.val::numeric ${sql.raw(operator)} ${sql.lit(num)}::numeric`,
    ]);
  }
  return eb("log_attr.val", operator, value);
}

/** A single filter leaf → message LIKE or a correlated (NOT) EXISTS on log_attr. */
function buildLeaf(
  eb: ExpressionBuilder<any, any>,
  token: LogQueryToken,
): Expression<SqlBool> {
  if (isMessageKey(token.key)) {
    return eb("logs.message", token.negated ? "not like" : "like", `%${token.value}%`);
  }
  const exists = eb.exists(
    eb
      .selectFrom("log_attr")
      .select(sql`1`.as("one"))
      .whereRef("log_attr.log_id", "=", "logs.log_id")
      .where("log_attr.val_name", "=", token.key)
      .where((sub) => attrValuePredicate(sub, token)),
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

export type MigrationStatus = {
  name: string;
  /** True when all tables for this migration are present in the database. */
  applied: boolean;
};

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
  /** Hard ceiling on records deleted per purge() call. */
  private readonly PURGE_MAX = 10_000;

  constructor(opts: PostgresAdapterOptions) {
    this._db = opts.db;
    this._level = opts.level ?? process.env.LOG_DB_LEVEL ?? "info";
    this._encrypt = opts.encrypt ?? null;
    this._decrypt = opts.decrypt ?? null;
    this._encryptionEnabled = this._encrypt != null && this._decrypt != null;
    this._semaphore = new Semaphore(opts.maxConnections ?? 2);
    this._onWarning = opts.onWarning ?? null;
    this._levels = { ...LOG_LEVELS, ...opts.levels };

    this._startFlushTimer();
  }

  get level(): string {
    return this._level;
  }

  set level(value: string) {
    this._level = value;
  }

  setLevels(levels: Record<string, number>): void {
    Object.assign(this._levels, levels);
  }

  // ── LogAdapter.write ────────────────────────────────────────────────────

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
      const attributeFilters = options.attributeFilters ?? [];
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
          attributeFilters,
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

  // ── QueryableLogAdapter.purge ───────────────────────────────────────────

  async purge(until: Date, limit?: number): Promise<Result<number, PurgeError>> {
    if (limit !== undefined && limit > this.PURGE_MAX) {
      return {
        ok: false,
        err: new Err("purge limit exceeded").addCause(
          `limit ${limit} exceeds maximum of ${this.PURGE_MAX}. Use deepPurge() for unbounded deletes.`,
        ),
      };
    }
    const effectiveLimit = limit ?? this.PURGE_MAX;
    try {
      const result = await this._db.transaction().execute(async (tx) => {
        // When no explicit limit is given, count first so we don't silently
        // delete more than PURGE_MAX rows on a caller's behalf.
        if (limit === undefined) {
          const countRow = await tx
            .selectFrom("logs")
            .select((eb) => eb.fn.countAll<number>().as("n"))
            .where("logged_timestamp", "<=", until)
            .executeTakeFirstOrThrow();
          const count = countRow.n;
          if (count > this.PURGE_MAX) {
            throw Object.assign(
              new Error(
                `${count} records match — pass an explicit limit (max ${this.PURGE_MAX}) or use deepPurge() for unbounded deletes.`,
              ),
              { code: "PURGE_LIMIT_EXCEEDED" as const },
            );
          }
        }

        // Capture the bounded set of IDs once so all three DELETEs target
        // exactly the same rows regardless of concurrent inserts.
        await sql`
          CREATE TEMP TABLE _purge_ids ON COMMIT DROP AS
            SELECT log_id FROM logs
            WHERE logged_timestamp <= ${until}
            LIMIT ${sql.lit(effectiveLimit)}
        `.execute(tx);

        const countRow = await sql<{ n: string }>`
          SELECT count(*) AS n FROM _purge_ids
        `.execute(tx);
        const count = countRow.rows[0]?.n != null ? parseInt(countRow.rows[0].n, 10) : 0;
        if (count === 0) return 0;

        await sql`
          DELETE FROM log_attr_blob
          USING _purge_ids
          WHERE log_attr_blob.log_id = _purge_ids.log_id
        `.execute(tx);

        await sql`
          DELETE FROM log_attr
          USING _purge_ids
          WHERE log_attr.log_id = _purge_ids.log_id
        `.execute(tx);

        await sql`
          DELETE FROM logs
          USING _purge_ids
          WHERE logs.log_id = _purge_ids.log_id
        `.execute(tx);

        return count;
      });
      return { ok: true, val: result };
    } catch (err) {
      const cause = err instanceof Error ? err : String(err);
      // The in-transaction count check throws with code PURGE_LIMIT_EXCEEDED —
      // surface it under the same matchable message as the synchronous check.
      const limitExceeded =
        err instanceof Error &&
        (err as { code?: string }).code === "PURGE_LIMIT_EXCEEDED";
      if (limitExceeded) {
        return {
          ok: false,
          err: new Err("purge limit exceeded").addCause(cause),
        };
      }
      return { ok: false, err: new Err("failed to purge").addCause(cause) };
    }
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
    await up001(this._db);
    await up002(this._db);
  }

  /** Roll back all logger migrations (reverse order). Idempotent — safe to call even if tables do not exist. */
  async rollback(): Promise<void> {
    await down002(this._db);
    await down001(this._db);
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

  async flush(): Promise<void> {
    await this._flushQueue();
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this._flushQueue();
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

    // Append standard meta attributes.
    if (record.application) {
      result.push(["application", { val: record.application, type: "string" }]);
    }
    if (record.version) {
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

    const attrFilters = opts.attributeFilters ?? [];
    const msgFilters = attrFilters.filter(
      (f) => f.key === "message" || f.key === "msg",
    );
    const keyFilters = attrFilters.filter(
      (f) => f.key !== "message" && f.key !== "msg",
    );

    const allMsgTerms: string[] = [];
    if (opts.msg) allMsgTerms.push(opts.msg);
    for (const f of msgFilters) {
      if (!f.negated) allMsgTerms.push(f.value);
    }
    const msg = allMsgTerms.join(" ");
    const negatedMsgFilters = msgFilters.filter((f) => f.negated);

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
      const { includeIds: keyFilterIds, excludeIds: keyExcludeIds } =
        await this._resolveKeyFilterIds(keyFilters, start, end);

      if (keyFilterIds !== null && keyFilterIds.length === 0) {
        return { ok: false, err: new Err("no logs found") };
      }

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
        .$if(keyFilterIds !== null, (qb) =>
          qb.where("logs.log_id", "in", keyFilterIds!),
        )
        .$if(keyExcludeIds.size > 0, (qb) =>
          qb.where("logs.log_id", "not in", [...keyExcludeIds]),
        )
        .$call((qb) => {
          let q = qb;
          for (const f of negatedMsgFilters) {
            q = q.where("logs.message", "not like", `%${f.value}%`);
          }
          return q;
        })
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

  private async _fetchMatchingIds(
    filter: NonNullable<PostgresQueryOptions["attributeFilters"]>[number],
    start: Date,
    end: Date,
  ): Promise<Set<string>> {
    const op = filter.operator;
    const kyselyOp = (op === "contains" ? "like" : op) as
      | "like"
      | "="
      | ">"
      | ">="
      | "<"
      | "<=";
    const filterVal = op === "contains" ? `%${filter.value}%` : filter.value;
    const isNumericValue = /^-?[0-9]+(\.[0-9]+)?$/.test(filter.value);
    const isComparisonOp = kyselyOp !== "like" && kyselyOp !== "=";

    const rows = await this._db
      .selectFrom("log_attr")
      .select("log_id")
      .where("val_name", "=", filter.key)
      .where("logged_timestamp", ">=", start)
      .where("logged_timestamp", "<=", end)
      .$call((qb) => {
        if (kyselyOp === "like") {
          return qb.where("val", "like", filterVal);
        }
        if (isComparisonOp && isNumericValue) {
          const numVal = parseFloat(filter.value);
          return qb.where((eb) =>
            eb.and([
              sql<boolean>`val ~ '^-?[0-9]+(\\.[0-9]+)?$'`,
              sql<boolean>`val::numeric ${sql.raw(kyselyOp)} ${sql.lit(numVal)}::numeric`,
            ]),
          );
        }
        return qb.where("val", kyselyOp, filterVal);
      })
      .execute();

    return new Set(rows.map((r) => r.log_id));
  }

  private async _resolveKeyFilterIds(
    keyFilters: NonNullable<PostgresQueryOptions["attributeFilters"]>,
    start: Date,
    end: Date,
  ): Promise<{ includeIds: string[] | null; excludeIds: Set<string> }> {
    const positiveFilters = keyFilters.filter((f) => !f.negated);
    const negatedFilters = keyFilters.filter((f) => f.negated);

    const excludeIds = new Set<string>();
    for (const filter of negatedFilters) {
      const ids = await this._fetchMatchingIds(filter, start, end);
      for (const id of ids) excludeIds.add(id);
    }

    if (positiveFilters.length === 0) {
      return { includeIds: null, excludeIds };
    }

    let intersection: Set<string> | null = null;
    for (const filter of positiveFilters) {
      const ids = await this._fetchMatchingIds(filter, start, end);
      if (intersection === null) {
        intersection = ids;
      } else {
        for (const id of intersection) {
          if (!ids.has(id)) intersection.delete(id);
        }
      }
      if (intersection.size === 0) return { includeIds: [], excludeIds };
    }

    return { includeIds: intersection ? [...intersection] : null, excludeIds };
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
