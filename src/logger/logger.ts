import type { LogAdapter, LogRecord, QueryableLogAdapter } from "./adapter";
import { LOG_LEVELS, isQueryable } from "./adapter";
import { type Secure, type TemplateAttrs, type ValueSerializer, interpolate, isSecure, defaultSerializer } from "./template";

// ---------------------------------------------------------------------------
// LoggerInstance
// ---------------------------------------------------------------------------

/** Construction options for a {@link LoggerInstance} / {@link createLogger}. */
export type LoggerOptions = {
  /** Minimum level to pass to adapters. Defaults to "debug". */
  level?: string;
  /** Application name attached to every record. */
  application?: string;
  /** Application version attached to every record. */
  version?: string;
  /** Maximum records to buffer before the first adapter is registered. Defaults to 500. */
  bufferLimit?: number;
  /**
   * Custom serializer for object/non-string values interpolated into message templates.
   * Defaults to `JSON.stringify` for objects and `String()` for primitives.
   */
  serializeValue?: ValueSerializer;
};

// ---------------------------------------------------------------------------
// Process event hooks
// ---------------------------------------------------------------------------

/** Process lifecycle events that {@link LoggerInstance.on} can hook. */
export type ProcessEvent =
  | "SIGINT"
  | "SIGTERM"
  | "beforeExit"
  | "uncaughtException"
  | "unhandledRejection";

type ProcessEventHandlers = {
  SIGINT: () => void | Promise<void>;
  SIGTERM: () => void | Promise<void>;
  beforeExit: () => void | Promise<void>;
  uncaughtException: (err: Error) => void | Promise<void>;
  unhandledRejection: (reason: unknown) => void | Promise<void>;
};

/**
 * A logger. Buffers records until an adapter is registered, then dispatches
 * each interpolated {@link LogRecord} to every adapter that passes the level
 * gate. Prefer {@link createLogger} to construct one.
 */
export class LoggerInstance<TLevels extends Record<string, number> = typeof LOG_LEVELS> {
  private readonly _adapters: LogAdapter[] = [];
  private _buffer: LogRecord[] = [];
  private _level: string;
  private _application?: string;
  private _version?: string;
  private readonly _bufferLimit: number;
  private readonly _levels: Record<string, number>;
  private _serialize: ValueSerializer;

  constructor(opts: LoggerOptions = {}) {
    this._level = opts.level ?? "debug";
    this._application = opts.application;
    this._version = opts.version;
    this._bufferLimit = opts.bufferLimit ?? 500;
    this._levels = { ...LOG_LEVELS } as Record<string, number>;
    this._serialize = opts.serializeValue ?? defaultSerializer;
  }

  // ── Level control ───────────────────────────────────────────────────────

  /** The current minimum emit level. */
  get level(): string {
    return this._level;
  }

  /** Set the minimum emit level; records below it are dropped. */
  set level(value: string) {
    this._level = value;
  }

  /** Application name stamped on every record (mutable so callers — e.g. a provider — can keep it in sync). */
  get application(): string | undefined {
    return this._application;
  }
  set application(value: string | undefined) {
    this._application = value;
  }

  /** Application version stamped on every record. */
  get version(): string | undefined {
    return this._version;
  }
  set version(value: string | undefined) {
    this._version = value;
  }

  /** Serializer for non-string attribute values interpolated into message templates. */
  get serializeValue(): ValueSerializer {
    return this._serialize;
  }
  set serializeValue(value: ValueSerializer) {
    this._serialize = value ?? defaultSerializer;
  }

  // ── Adapter management ──────────────────────────────────────────────────

  /** Register an adapter, sharing the level map and replaying any buffered records to it. */
  addAdapter(adapter: LogAdapter): void {
    // Share the current level map (built-ins + any custom levels) so the
    // adapter's own filtering and query defaults recognise custom levels.
    adapter.setLevels?.({ ...this._levels });
    this._adapters.push(adapter);
    // Flush buffered records to the new adapter.
    if (this._buffer.length > 0) {
      for (const record of this._buffer) {
        this._dispatch(adapter, record);
      }
      // Only clear the buffer once — all future adapters added later won't
      // replay. The assumption is adapters are registered at startup.
      if (this._adapters.length === 1) {
        this._buffer = [];
      }
    }
  }

  /** The registered adapters, in registration order. */
  get adapters(): readonly LogAdapter[] {
    return this._adapters;
  }

  // ── Query adapter ───────────────────────────────────────────────────────

  /**
   * Returns the first registered adapter that implements query/purge.
   * Throws if none has been registered yet.
   */
  queryAdapter(): QueryableLogAdapter {
    const adapter = this._adapters.find(isQueryable);
    if (!adapter) {
      throw new Error(
        "[bored-logs] No queryable adapter registered. " +
          "Add a PostgresAdapter before calling queryAdapter().",
      );
    }
    return adapter;
  }

  // ── Custom levels ────────────────────────────────────────────────────────

  /**
   * Register additional log levels. Returns the same instance cast to the
   * wider level map so `log()` autocompletes the new keys.
   *
   * @example
   * const logger = createLogger().addLevels({ silly: 8, chaos: 9 });
   * logger.log("silly", "Something ridiculous happened");
   */
  addLevels<T extends Record<string, number>>(levels: T): LoggerInstance<TLevels & T> {
    Object.assign(this._levels, levels);
    // Propagate to already-registered adapters so their level filtering and
    // query defaults stay in sync with the logger.
    for (const adapter of this._adapters) {
      adapter.setLevels?.({ ...this._levels });
    }
    return this as unknown as LoggerInstance<TLevels & T>;
  }

  // ── Core write ──────────────────────────────────────────────────────────

  /**
   * Emit a record at the given level, interpolating `{key}` placeholders from
   * `attrs`. `level` is restricted to registered levels (`keyof TLevels`);
   * register custom levels via `createLogger({ levels })` / `addLevels()` (and
   * augment the {@link LogLevels} interface) to widen it. To log a dynamically
   * computed level string, cast it to a known level.
   */
  log<T extends string | Secure<string>>(
    level: keyof TLevels & string,
    template: T,
    ...args: TemplateAttrs<T>
  ): void {
    const levelNum = this._levels[level.toLowerCase()] ?? this._levels.debug;
    const thresholdNum = this._levels[this._level.toLowerCase()] ?? this._levels.info;
    if (levelNum > thresholdNum) return;

    const secureMessage = isSecure(template);
    const rawTemplate = secureMessage ? (template as Secure<string>).value : (template as string);
    const attrs = (args[0] ?? {}) as Record<string, unknown>;
    const message = secureMessage ? "[secure]" : interpolate(rawTemplate, attrs, this._serialize);

    const record: LogRecord = {
      level,
      message,
      template: rawTemplate,
      secureMessage,
      attrs,
      timestamp: new Date(),
      application: this._application,
      version: this._version,
    };

    if (this._adapters.length === 0) {
      if (this._buffer.length < this._bufferLimit) {
        this._buffer.push(record);
      }
      return;
    }

    for (const adapter of this._adapters) {
      this._dispatch(adapter, record);
    }
  }

  /**
   * Ingest an already-formed {@link LogRecord} — applies the level gate and
   * buffering, then dispatches to every adapter **without re-interpolating**.
   *
   * Use this for records produced elsewhere and handed to the logger verbatim,
   * such as entries shipped from a browser client via
   * `createLogIngestHandler`. The record's `message`, `attrs`, and `timestamp`
   * are preserved as-is; `application`/`version` are taken from the record (the
   * logger's own defaults are *not* applied, since the record is already
   * complete). Compare with {@link log}, which builds and interpolates a record
   * from a template.
   */
  ingest(record: LogRecord): void {
    const levelNum = this._levels[record.level.toLowerCase()] ?? this._levels.debug;
    const thresholdNum = this._levels[this._level.toLowerCase()] ?? this._levels.info;
    if (levelNum > thresholdNum) return;

    if (this._adapters.length === 0) {
      if (this._buffer.length < this._bufferLimit) {
        this._buffer.push(record);
      }
      return;
    }

    for (const adapter of this._adapters) {
      this._dispatch(adapter, record);
    }
  }

  private _dispatch(adapter: LogAdapter, record: LogRecord): void {
    try {
      const result = adapter.write(record);
      if (result instanceof Promise) {
        result.catch(() => {/* adapter errors are silenced */});
      }
    } catch {
      // adapter errors are silenced
    }
  }

  // ── Named level methods ─────────────────────────────────────────────────

  /** Log at the "critical" level. */
  critical<T extends string | Secure<string>>(
    template: T,
    ...args: TemplateAttrs<T>
  ): void {
    this.log("critical", template, ...args);
  }

  /** Log at the "error" level. */
  error<T extends string | Secure<string>>(
    template: T,
    ...args: TemplateAttrs<T>
  ): void {
    this.log("error", template, ...args);
  }

  /** Log at the "warn" level. */
  warn<T extends string | Secure<string>>(
    template: T,
    ...args: TemplateAttrs<T>
  ): void {
    this.log("warn", template, ...args);
  }

  /** Log at the "info" level. */
  info<T extends string | Secure<string>>(
    template: T,
    ...args: TemplateAttrs<T>
  ): void {
    this.log("info", template, ...args);
  }

  /** Log at the "http" level. */
  http<T extends string | Secure<string>>(
    template: T,
    ...args: TemplateAttrs<T>
  ): void {
    this.log("http", template, ...args);
  }

  /** Log at the "verbose" level. */
  verbose<T extends string | Secure<string>>(
    template: T,
    ...args: TemplateAttrs<T>
  ): void {
    this.log("verbose", template, ...args);
  }

  /** Log at the "cache" level. */
  cache<T extends string | Secure<string>>(
    template: T,
    ...args: TemplateAttrs<T>
  ): void {
    this.log("cache", template, ...args);
  }

  /** Log at the "request" level. */
  request<T extends string | Secure<string>>(
    template: T,
    ...args: TemplateAttrs<T>
  ): void {
    this.log("request", template, ...args);
  }

  /** Log at the "response" level. */
  response<T extends string | Secure<string>>(
    template: T,
    ...args: TemplateAttrs<T>
  ): void {
    this.log("response", template, ...args);
  }

  /** Log at the "sql" level. */
  sql<T extends string | Secure<string>>(
    template: T,
    ...args: TemplateAttrs<T>
  ): void {
    this.log("sql", template, ...args);
  }

  /** Log at the "debug" level. */
  debug<T extends string | Secure<string>>(
    template: T,
    ...args: TemplateAttrs<T>
  ): void {
    this.log("debug", template, ...args);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Flush all adapters that implement `flush`. */
  async flush(): Promise<void> {
    await Promise.all(
      this._adapters.filter((a) => a.flush != null).map((a) => a.flush!()),
    );
  }

  /** Close all adapters that implement `close`. */
  async close(): Promise<void> {
    await Promise.all(
      this._adapters.filter((a) => a.close != null).map((a) => a.close!()),
    );
  }

  // ── Process lifecycle hooks ──────────────────────────────────────────────

  /**
   * Register a process lifecycle handler. The logger flushes and closes
   * before calling your callback so no records are lost on process exit.
   *
   * Safe to call in browser/Edge runtimes — silently ignored when `process`
   * is not available.
   *
   * @example
   * logger
   *   .on("SIGTERM", async () => { await db.end(); })
   *   .on("uncaughtException", async (err) => { await reportError(err); });
   */
  on<E extends ProcessEvent>(event: E, handler: ProcessEventHandlers[E]): this {
    if (typeof process === "undefined" || typeof process.once !== "function") {
      return this;
    }
    const self = this;
    if (
      event === "SIGINT" ||
      event === "SIGTERM" ||
      event === "beforeExit"
    ) {
      process.once(event, async () => {
        await self.flush();
        await self.close();
        await (handler as () => void | Promise<void>)();
      });
    } else if (event === "uncaughtException") {
      process.once("uncaughtException", async (err: Error) => {
        await self.flush();
        await self.close();
        await (handler as (err: Error) => void | Promise<void>)(err);
      });
    } else if (event === "unhandledRejection") {
      process.once("unhandledRejection", async (reason: unknown) => {
        await self.flush();
        await self.close();
        await (handler as (reason: unknown) => void | Promise<void>)(reason);
      });
    }
    return this;
  }
}

// ---------------------------------------------------------------------------
// createLogger — factory for standalone (non-singleton) instances.
// ---------------------------------------------------------------------------

/** Convenience type alias for {@link LoggerInstance}. Use this for type annotations. */
export type Logger<TLevels extends Record<string, number> = typeof LOG_LEVELS> =
  LoggerInstance<TLevels>;

/** Create a standalone {@link LoggerInstance}, optionally registering custom `levels`. */
export function createLogger<TExtra extends Record<string, number> = Record<never, never>>(
  opts?: LoggerOptions & { levels?: TExtra },
): LoggerInstance<typeof LOG_LEVELS & TExtra> {
  const instance = new LoggerInstance(opts) as LoggerInstance<typeof LOG_LEVELS & TExtra>;
  if (opts?.levels) instance.addLevels(opts.levels);
  return instance;
}
