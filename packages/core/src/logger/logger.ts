import type { LogAdapter, LogRecord, QueryableLogAdapter } from "./adapter";
import { LOG_LEVELS, isQueryable } from "./adapter";
import {
  type LogAttributes,
  type RejectKeys,
  type BuiltinTemplateKey,
  type Secure,
  type TemplateAttrs,
  type TimestampFormat,
  type ValueSerializer,
  interpolate,
  isSecure,
  defaultSerializer,
  resolveAttributes,
  resolveTimestampFormat,
  stripBuiltinAttrs,
} from "./template";

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
  /**
   * Attributes attached to every record. Function values are evaluated at each
   * log call. Equivalent to declaring the attributes as top-level options, but
   * explicit — use this bag when an attribute name collides with an option name
   * (`level`, `version`, …).
   */
  attributes?: LogAttributes;
};

/**
 * Option keys the logger consumes itself. Any *other* key passed to
 * {@link createLogger} is treated as a global attribute, so
 * `createLogger({ commit: "e02350" })` stamps `commit` on every record.
 */
const RESERVED_OPTION_KEYS = new Set([
  "level",
  "application",
  "version",
  "bufferLimit",
  "serializeValue",
  "attributes",
  "levels",
]);

/**
 * {@link LoggerOptions} plus arbitrary extra keys, which become global
 * attributes. The open index signature is what lets
 * `createLogger({ commit: "e02350" })` type-check; annotate variables with the
 * closed {@link LoggerOptions} instead if you want typos caught.
 */
export type LoggerOptionsWithAttributes = LoggerOptions &
  { [key: string]: unknown } &
  RejectKeys<BuiltinTemplateKey>;

/** Split an options object into the logger's own options and the global attributes. */
function extractAttributes(opts: LoggerOptionsWithAttributes): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(opts)) {
    if (RESERVED_OPTION_KEYS.has(key)) continue;
    attrs[key] = val;
  }
  Object.assign(attrs, opts.attributes);
  stripBuiltinAttrs(attrs);
  return attrs;
}

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
export class LoggerInstance<
  TLevels extends Record<string, number> = typeof LOG_LEVELS,
  TGlobals extends string = never,
> {
  private readonly _adapters: LogAdapter[] = [];
  private _buffer: LogRecord[] = [];
  private _level: string;
  private _application?: string;
  private _version?: string;
  private readonly _bufferLimit: number;
  private readonly _levels: Record<string, number>;
  private _serialize: ValueSerializer;
  private _attributes: Record<string, unknown>;
  private _outputTemplate?: string;
  private _renderTimestamp: (date: Date) => string = resolveTimestampFormat(null);

  constructor(opts: LoggerOptionsWithAttributes = {}) {
    this._level = opts.level ?? "debug";
    this._application = opts.application;
    this._version = opts.version;
    this._bufferLimit = opts.bufferLimit ?? 500;
    this._levels = { ...LOG_LEVELS } as Record<string, number>;
    this._serialize = opts.serializeValue ?? defaultSerializer;
    this._attributes = extractAttributes(opts);
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

  // ── Global attributes ───────────────────────────────────────────────────

  /**
   * Attributes attached to every record, as declared (function values are
   * returned unevaluated). Assign to replace the whole map.
   *
   * @example
   * logger.attributes = { ...logger.attributes, region: "eu-1" };
   */
  get attributes(): LogAttributes {
    return { ...this._attributes } as LogAttributes;
  }
  set attributes(value: LogAttributes) {
    const next = { ...value } as Record<string, unknown>;
    stripBuiltinAttrs(next);
    this._attributes = next;
  }

  // ── Output template ─────────────────────────────────────────────────────

  /** The current output template, or `undefined` when records are not formatted. */
  get outputTemplate(): string | undefined {
    return this._outputTemplate;
  }

  /**
   * Set the output template used to render each record into
   * {@link LogRecord.formatted}. Returns `this` so it chains off
   * {@link createLogger}. Pass `null` to clear it.
   *
   * Placeholders come from two disjoint namespaces. The `$`-prefixed
   * built-ins — `{$message}`, `{$level}`, `{$timestamp}`, `{$application}`,
   * `{$version}` — always read the record itself and can never be displaced by
   * an attribute. Every other `{key}` resolves from the attributes: the
   * logger's globals first, then the call site, which wins. Unresolved
   * placeholders are left literal, and `secure()` / `redact()` values are
   * always masked.
   *
   * Because the namespaces are disjoint, `{$message}` and `{message}` are
   * different things: the first is the record's message, the second is an
   * attribute that happens to be called `message`.
   *
   * @example
   * const logger = createLogger({ commit: "e02350" })
   *   .template("{$timestamp} [{$level}] {$message} {commit}");
   */
  template(template: string | null): this {
    this._outputTemplate = template ?? undefined;
    return this;
  }

  /**
   * Set how `{$timestamp}` renders in the output template. Returns `this` so
   * it chains. Pass `null` to reset to ISO. Storage is unaffected — the
   * record (and the database) keeps the full timestamp regardless.
   *
   * Accepts a preset name (`"iso"` | `"epoch"` | `"time"` | `"date"` |
   * `"datetime"`), an `Intl.DateTimeFormat` options object with an optional
   * `locale` for locale-aware output, or a `(date: Date) => string` callback
   * for custom formats. A callback that throws falls back to ISO rather than
   * breaking the log call.
   *
   * @example
   * logger.template("{$timestamp} {$message}").renderTimestamp("time");
   * logger.renderTimestamp({ locale: "de-DE", dateStyle: "short", timeStyle: "medium" });
   * logger.renderTimestamp((d) => myFormatter.format(d));
   */
  renderTimestamp(format: TimestampFormat | null): this {
    this._renderTimestamp = resolveTimestampFormat(format);
    return this;
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
  addLevels<T extends Record<string, number>>(levels: T): LoggerInstance<TLevels & T, TGlobals> {
    Object.assign(this._levels, levels);
    // Propagate to already-registered adapters so their level filtering and
    // query defaults stay in sync with the logger.
    for (const adapter of this._adapters) {
      adapter.setLevels?.({ ...this._levels });
    }
    return this as unknown as LoggerInstance<TLevels & T, TGlobals>;
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
    ...args: TemplateAttrs<T, TGlobals>
  ): this {
    const levelNum = this._levels[level.toLowerCase()] ?? this._levels.debug;
    const thresholdNum = this._levels[this._level.toLowerCase()] ?? this._levels.info;
    if (levelNum > thresholdNum) return this;

    const secureMessage = isSecure(template);
    const rawTemplate = secureMessage ? (template as Secure<string>).value : (template as string);
    // Globals are resolved once per call — not once per adapter — so a
    // resolver like `() => new Date()` yields one value across every sink.
    const attrs = { ...resolveAttributes(this._attributes), ...(args[0] ?? {}) };
    // Globals are stripped when they are set; only a call site can reintroduce
    // a reserved name (from untyped JS, or a spread the compiler can't see).
    stripBuiltinAttrs(attrs);
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
    if (this._outputTemplate) record.formatted = this._render(record);

    if (this._adapters.length === 0) {
      if (this._buffer.length < this._bufferLimit) {
        this._buffer.push(record);
      }
      return this;
    }

    for (const adapter of this._adapters) {
      this._dispatch(adapter, record);
    }
    return this;
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
  ingest(record: LogRecord): this {
    const levelNum = this._levels[record.level.toLowerCase()] ?? this._levels.debug;
    const thresholdNum = this._levels[this._level.toLowerCase()] ?? this._levels.info;
    if (levelNum > thresholdNum) return this;

    if (this._adapters.length === 0) {
      if (this._buffer.length < this._bufferLimit) {
        this._buffer.push(record);
      }
      return this;
    }

    for (const adapter of this._adapters) {
      this._dispatch(adapter, record);
    }
    return this;
  }

  /** Render a record through the output template. Assumes one is set. */
  private _render(record: LogRecord): string {
    // A throwing timestamp renderer falls back to ISO — logging never breaks.
    let timestamp: string;
    try {
      timestamp = this._renderTimestamp(record.timestamp);
    } catch {
      timestamp = record.timestamp.toISOString();
    }
    // Attributes first — the `$`-prefixed built-ins are applied last so
    // nothing in `attrs` can displace them.
    const context: Record<string, unknown> = {
      ...record.attrs,
      $message: record.message,
      $level: record.level,
      $timestamp: timestamp,
      $application: record.application,
      $version: record.version,
    };
    return interpolate(this._outputTemplate!, context, this._serialize);
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
    ...args: TemplateAttrs<T, TGlobals>
  ): this {
    return this.log("critical", template, ...args);
  }

  /** Log at the "error" level. */
  error<T extends string | Secure<string>>(
    template: T,
    ...args: TemplateAttrs<T, TGlobals>
  ): this {
    return this.log("error", template, ...args);
  }

  /** Log at the "warn" level. */
  warn<T extends string | Secure<string>>(
    template: T,
    ...args: TemplateAttrs<T, TGlobals>
  ): this {
    return this.log("warn", template, ...args);
  }

  /** Log at the "info" level. */
  info<T extends string | Secure<string>>(
    template: T,
    ...args: TemplateAttrs<T, TGlobals>
  ): this {
    return this.log("info", template, ...args);
  }

  /** Log at the "http" level. */
  http<T extends string | Secure<string>>(
    template: T,
    ...args: TemplateAttrs<T, TGlobals>
  ): this {
    return this.log("http", template, ...args);
  }

  /** Log at the "verbose" level. */
  verbose<T extends string | Secure<string>>(
    template: T,
    ...args: TemplateAttrs<T, TGlobals>
  ): this {
    return this.log("verbose", template, ...args);
  }

  /** Log at the "cache" level. */
  cache<T extends string | Secure<string>>(
    template: T,
    ...args: TemplateAttrs<T, TGlobals>
  ): this {
    return this.log("cache", template, ...args);
  }

  /** Log at the "request" level. */
  request<T extends string | Secure<string>>(
    template: T,
    ...args: TemplateAttrs<T, TGlobals>
  ): this {
    return this.log("request", template, ...args);
  }

  /** Log at the "response" level. */
  response<T extends string | Secure<string>>(
    template: T,
    ...args: TemplateAttrs<T, TGlobals>
  ): this {
    return this.log("response", template, ...args);
  }

  /** Log at the "sql" level. */
  sql<T extends string | Secure<string>>(
    template: T,
    ...args: TemplateAttrs<T, TGlobals>
  ): this {
    return this.log("sql", template, ...args);
  }

  /** Log at the "debug" level. */
  debug<T extends string | Secure<string>>(
    template: T,
    ...args: TemplateAttrs<T, TGlobals>
  ): this {
    return this.log("debug", template, ...args);
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
export type Logger<
  TLevels extends Record<string, number> = typeof LOG_LEVELS,
  TGlobals extends string = never,
> = LoggerInstance<TLevels, TGlobals>;

/** The custom `levels` map declared in an options object, if any. */
type LevelsOf<TOpts> = TOpts extends { levels: infer L extends Record<string, number> }
  ? L
  : Record<never, never>;

/** Option keys of `TOpts` that become global attributes — everything but {@link RESERVED_OPTION_KEYS}. */
type GlobalKeysOf<TOpts> =
  | Exclude<
      keyof TOpts & string,
      "level" | "application" | "version" | "bufferLimit" | "serializeValue" | "attributes" | "levels"
    >
  | (TOpts extends { attributes: infer A } ? keyof A & string : never);

/**
 * Create a standalone {@link LoggerInstance}, optionally registering custom
 * `levels`. Any option key that is not a known {@link LoggerOptions} field
 * becomes a global attribute stamped on every record; function values are
 * evaluated at each log call.
 *
 * @example
 * const logger = createLogger({
 *   version: "0.0.1",
 *   commit: "e02350",
 *   requestId: () => currentRequestId(),
 * }).template("{timestamp} {message} {version} {commit}");
 */
export function createLogger<TOpts extends LoggerOptionsWithAttributes>(
  opts?: TOpts,
): LoggerInstance<typeof LOG_LEVELS & LevelsOf<TOpts>, GlobalKeysOf<TOpts>> {
  const instance = new LoggerInstance(opts) as LoggerInstance<
    typeof LOG_LEVELS & LevelsOf<TOpts>,
    GlobalKeysOf<TOpts>
  >;
  const levels = opts?.levels as Record<string, number> | undefined;
  if (levels) instance.addLevels(levels);
  return instance;
}
