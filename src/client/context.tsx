"use client";

import {
  type ReactNode,
  type ReactElement,
  createContext,
  useContext,
  useEffect,
  useRef,
} from "react";
import { createLogger, type Logger } from "../logger/logger";
import { ConsoleAdapter, type ConsoleAdapterOptions } from "../logger/console-adapter";
import type { LogAdapter } from "../logger/adapter";
import type { ValueSerializer } from "../logger/template";
import { HttpAdapter, type HttpAdapterOptions } from "../adapters/http/adapter";
import type { RedactMode } from "../adapters/http/record";
import type { ClientLogRecord } from "../adapters/http/types";

// ---------------------------------------------------------------------------
// LoggerProvider — builds a client-side Logger and supplies it via context.
//
// The logger is a normal `LoggerInstance` with adapters registered in this
// order:
//   1. ConsoleAdapter (unless `console={false}`) — browser devtools output.
//   2. ShipAdapter — batches records and ships them to `endpoint`.
//   3. ...any adapters passed via the `adapters` prop.
//
// One logger is created per provider mount (kept in a ref). Its config props
// (level, application, version, serializeValue, levels) and the shipping options
// are re-synced on every commit; the ship transport's flush timer and
// page-unload beacon are attached on mount and torn down (with a final flush) on
// unmount. Only the *structural* adapter props — `console` and `adapters` — are
// read once at mount, since reactively adding/removing sinks would strand
// buffered records.
// ---------------------------------------------------------------------------

type LoggerContextValue = { logger: Logger; ship: HttpAdapter };

const LoggerContext = createContext<LoggerContextValue | null>(null);

/**
 * The client-facing subset of {@link Logger} returned by {@link useLogger}:
 * `log()` + a method per built-in level, plus `flush()` / `addLevels()`.
 * Server-only methods (`ingest`, `queryAdapter`, process hooks via `on`, and
 * `close`) are omitted — they either throw or no-op in the browser.
 */
export type ClientLogger = Omit<Logger, "on" | "queryAdapter" | "ingest" | "close">;

/** Props for {@link LoggerProvider}. */
export type LoggerProviderProps = {
  // ── Logger ────────────────────────────────────────────────────────────────
  /** Application name stamped on every record. */
  application?: string;
  /** Application version stamped on every record. */
  version?: string;
  /** Minimum level the logger emits; more-verbose records are dropped. Defaults to "debug". */
  level?: string;
  /** Custom level ranks (name → rank) merged into the built-ins. */
  levels?: Record<string, number>;
  /** Custom serializer for non-string attribute values in message templates. */
  serializeValue?: ValueSerializer;

  // ── Console adapter ─────────────────────────────────────────────────────────
  /** Include a `ConsoleAdapter` for browser devtools output. `true` (default), `false` to disable, or options. */
  console?: boolean | ConsoleAdapterOptions;

  // ── Shipping (ShipAdapter) ──────────────────────────────────────────────────
  /** URL the batched logs are `POST`ed to (your ingest Route Handler). */
  endpoint: string;
  /** Flush automatically once this many records are queued. Defaults to 20. */
  batchSize?: number;
  /** Flush every this-many milliseconds while records are queued. Defaults to 5000. `0` disables the timer. */
  flushInterval?: number;
  /** Cap on buffered records; when full the oldest are dropped. Defaults to 1000. */
  maxQueue?: number;
  /** Extra request headers (e.g. an auth/CSRF token); may be async. */
  headers?: HttpAdapterOptions["headers"];
  /** `fetch` credentials mode — use `"include"` to send cookies to the ingest endpoint. */
  credentials?: RequestCredentials;
  /** Full delivery override; when set, `headers`/`credentials` are ignored. */
  transport?: HttpAdapterOptions["transport"];
  /** Flush via `navigator.sendBeacon` when the page is hidden/unloaded. Defaults to true. */
  useBeaconOnUnload?: boolean;
  /** How `redact()`ed attributes are handled before shipping. Defaults to `"placeholder"`. */
  redactMode?: RedactMode;
  /** Placeholder substituted for `redact()`ed values. Defaults to `"**REDACTED**"`. */
  redactPlaceholder?: string;
  /** Called when a flush fails; the failed batch is re-queued for retry. */
  onError?: (err: unknown, logs: ClientLogRecord[]) => void;

  // ── Extra adapters ──────────────────────────────────────────────────────────
  /** Additional adapters to register on the client logger (registered after console + shipping). */
  adapters?: LogAdapter[];

  children?: ReactNode;
};

/** Derive the {@link HttpAdapterOptions} from the provider props. */
function shipOptionsFrom(props: LoggerProviderProps): HttpAdapterOptions {
  return {
    endpoint: props.endpoint,
    batchSize: props.batchSize,
    flushInterval: props.flushInterval,
    maxQueue: props.maxQueue,
    headers: props.headers,
    credentials: props.credentials,
    transport: props.transport,
    useBeaconOnUnload: props.useBeaconOnUnload,
    serializeValue: props.serializeValue,
    redactMode: props.redactMode,
    redactPlaceholder: props.redactPlaceholder,
    onError: props.onError,
    levels: props.levels,
  };
}

/**
 * Provides a client {@link Logger} — writing to the browser console and
 * shipping to your ingest endpoint — to `useLogger()`. Wrap your app (or the
 * subtree that logs) and point `endpoint` at your ingest Route Handler.
 *
 * @example
 * <LoggerProvider endpoint="/api/logs" application="web" level="info">
 *   <App />
 * </LoggerProvider>
 */
export function LoggerProvider(props: LoggerProviderProps): ReactElement {
  const { children } = props;
  const ref = useRef<LoggerContextValue | null>(null);

  if (ref.current === null) {
    const logger = createLogger({
      application: props.application,
      version: props.version,
      level: props.level ?? "debug",
      levels: props.levels,
      serializeValue: props.serializeValue,
    });

    // 1. Console (browser devtools) — reveals secure/redact values by default
    //    (see ConsoleAdapter.maskSecure).
    if (props.console !== false) {
      logger.addAdapter(
        new ConsoleAdapter(typeof props.console === "object" ? props.console : {}),
      );
    }

    // 2. Shipping to the server over HTTP.
    const ship = new HttpAdapter(shipOptionsFrom(props));
    logger.addAdapter(ship);

    // 3. Any caller-supplied adapters.
    for (const adapter of props.adapters ?? []) logger.addAdapter(adapter);

    ref.current = { logger, ship };
  }

  const { logger, ship } = ref.current;

  // Keep the shipping options and the logger's config props in sync on every
  // commit (covers function props like headers/transport/onError too). The
  // structural `console`/`adapters` props are intentionally not re-applied here
  // — see the note above.
  useEffect(() => {
    ship.setOptions(shipOptionsFrom(props));
    logger.level = props.level ?? "debug";
    logger.application = props.application;
    logger.version = props.version;
    if (props.serializeValue) logger.serializeValue = props.serializeValue;
    if (props.levels) logger.addLevels(props.levels);
  });

  // Start the flush timer + unload beacon on mount; flush and tear down on unmount.
  useEffect(() => {
    const stop = ship.start();
    return () => {
      void logger.flush();
      stop();
    };
  }, [logger, ship]);

  return (
    <LoggerContext.Provider value={ref.current}>{children}</LoggerContext.Provider>
  );
}

/** Read the raw context value (logger + ship adapter). Throws if no provider is mounted above. */
function useLoggerContext(): LoggerContextValue {
  const ctx = useContext(LoggerContext);
  if (!ctx) {
    throw new Error(
      "[bored-logs] useLogger()/useLogShipper() must be used within <LoggerProvider>.",
    );
  }
  return ctx;
}

/**
 * The client {@link Logger} from the nearest {@link LoggerProvider}: writes to
 * the browser console and ships to your ingest endpoint. Same typed
 * message-template API as the server logger.
 *
 * @example
 * const logger = useLogger();
 * logger.info("Checkout opened for {cartId}", { cartId });
 * logger.error("Payment failed: {reason}", { reason, amount });
 */
export function useLogger(): ClientLogger {
  return useLoggerContext().logger;
}

/**
 * The {@link HttpAdapter} backing the client logger — for advanced use such as
 * forcing a `flush()` or reading `pending`. Throws if no provider is mounted.
 */
export function useLogShipper(): HttpAdapter {
  return useLoggerContext().ship;
}
