/**
 * HTTP log adapter for @campfhir/bored-logs.
 *
 * Exposes {@link HttpAdapter} — a {@link LogAdapter} that batches log records
 * and ships them as JSON to an HTTP(S) ingest endpoint (a `fetch` `POST`, with a
 * `navigator.sendBeacon` fallback on page unload). Universal: it uses only
 * `fetch`/`navigator`/timers, so it runs in the browser (the client `useLogger`
 * transport) as well as in Node/Edge runtimes that need to forward logs to
 * another service.
 *
 * Pair it with `createLogIngestHandler` from `@campfhir/bored-logs/server` to
 * receive the shipped records.
 *
 * @module
 */
import type { LogAdapter, LogRecord } from "../../logger/adapter";
import { LOG_LEVELS } from "../../logger/adapter";
import type { ValueSerializer } from "../../logger/template";
import type { ClientLogRecord, LogShipmentPayload } from "./types";
import { recordToClientRecord, type RedactMode } from "./record";

/** Extra request headers, or a (possibly async) function returning them — e.g. to attach an auth token or CSRF header per flush. */
export type HeadersInput =
  | Record<string, string>
  | (() => Record<string, string> | Promise<Record<string, string>>);

/**
 * Full override for how a batch is delivered. Return once the batch has been
 * sent (or throw to trigger `onError` and a re-queue). When provided, the
 * built-in `fetch` transport is bypassed.
 */
export type HttpTransport = (
  payload: LogShipmentPayload,
  endpoint: string,
) => void | Promise<void>;

/** Constructor options for {@link HttpAdapter}. */
export type HttpAdapterOptions = {
  /** URL the batched logs are `POST`ed to (your ingest Route Handler). */
  endpoint: string;
  /** Minimum level this adapter ships; more-verbose records are dropped. Defaults to "debug" (ship everything the logger passes). */
  level?: string;
  /** Custom level ranks merged into the built-ins for this adapter's gate. */
  levels?: Record<string, number>;
  /** Flush automatically once this many records are queued. Defaults to 20. */
  batchSize?: number;
  /** Flush every this-many milliseconds while records are queued. Defaults to 5000. `0` disables the timer. */
  flushInterval?: number;
  /** Cap on buffered records; when full the oldest are dropped. Defaults to 1000. */
  maxQueue?: number;
  /** Extra headers for the default `fetch` transport. */
  headers?: HeadersInput;
  /** `credentials` mode for the default `fetch` transport (e.g. "include" to send cookies). */
  credentials?: RequestCredentials;
  /** Full delivery override; when set, `headers`/`credentials` are ignored. */
  transport?: HttpTransport;
  /** Flush the queue with `navigator.sendBeacon` when the page is hidden/unloaded. Defaults to true. */
  useBeaconOnUnload?: boolean;
  /** Serializer for interpolated attribute values, matching the logger's. */
  serializeValue?: ValueSerializer;
  /** How `redact()`ed attributes are handled before shipping. Defaults to `"placeholder"`. */
  redactMode?: RedactMode;
  /** Placeholder substituted for `redact()`ed values. Defaults to `"**REDACTED**"`. */
  redactPlaceholder?: string;
  /** Called when a flush fails; the failed batch is re-queued for the next attempt. */
  onError?: (err: unknown, logs: ClientLogRecord[]) => void;
};

const DEFAULTS = {
  batchSize: 20,
  flushInterval: 5000,
  maxQueue: 1000,
  level: "debug",
  useBeaconOnUnload: true,
} as const;

/** A {@link LogAdapter} that batches records and ships them as JSON to an HTTP(S) endpoint. */
export class HttpAdapter implements LogAdapter {
  private _opts: HttpAdapterOptions;
  private _levels: Record<string, number>;
  private _queue: ClientLogRecord[] = [];
  private _timer: ReturnType<typeof setInterval> | null = null;
  /** Server-advertised max records per shipment (learned from responses). */
  private _serverMaxBatch: number | null = null;

  constructor(opts: HttpAdapterOptions) {
    this._opts = opts;
    this._levels = { ...LOG_LEVELS, ...opts.levels };
  }

  /** Merge fresh options in (e.g. when `LoggerProvider` props change). */
  setOptions(opts: HttpAdapterOptions): void {
    this._opts = opts;
    this._levels = { ...this._levels, ...opts.levels };
  }

  /** Merge additional custom level ranks into this adapter's gate (called by the logger). */
  setLevels(levels: Record<string, number>): void {
    Object.assign(this._levels, levels);
  }

  private get _endpoint(): string {
    return this._opts.endpoint;
  }
  private get _batchSize(): number {
    return this._opts.batchSize ?? DEFAULTS.batchSize;
  }
  private get _maxQueue(): number {
    return this._opts.maxQueue ?? DEFAULTS.maxQueue;
  }

  /** The number of records currently buffered (before the next flush). */
  get pending(): number {
    return this._queue.length;
  }

  // ── LogAdapter.write ────────────────────────────────────────────────────────

  /** Level-gate, convert to the wire form, and enqueue the record; flushes early once the batch fills. */
  write(record: LogRecord): void {
    const recordNum = this._levels[record.level.toLowerCase()] ?? this._levels.debug;
    const thresholdNum =
      this._levels[(this._opts.level ?? DEFAULTS.level).toLowerCase()] ??
      this._levels.debug;
    if (recordNum > thresholdNum) return;

    const clientRecord = recordToClientRecord(record, {
      serialize: this._opts.serializeValue,
      redactMode: this._opts.redactMode,
      redactPlaceholder: this._opts.redactPlaceholder,
    });

    this._queue.push(clientRecord);
    // Bound memory: drop the oldest records when over the cap.
    if (this._queue.length > this._maxQueue) {
      this._queue.splice(0, this._queue.length - this._maxQueue);
    }
    if (this._queue.length >= this._batchSize) {
      void this.flush();
    }
  }

  // ── Delivery ────────────────────────────────────────────────────────────────

  /**
   * Ship the queued records now, draining in server-sized chunks. Resolves
   * once the queue is empty (or delivery failed). Implements
   * {@link LogAdapter.flush}.
   *
   * Batch-size negotiation: every ingest-handler response advertises the
   * server's `maxBatch` via the `x-log-max-batch` header, which this adapter
   * learns and uses to chunk future shipments. A 413 is recovered *within the
   * same flush* — the batch is re-queued and re-sent in smaller chunks (from
   * the advertised limit, or by halving against an older server without the
   * header) — so an outage backlog larger than the server's limit can never
   * wedge the queue. Network failures re-queue the chunk (bounded by
   * `maxQueue`) and stop; the next flush retries.
   */
  async flush(): Promise<void> {
    if (this._queue.length === 0) return;

    if (this._opts.transport) {
      // A custom transport returns no Response, so there is nothing to learn
      // from — ship everything in one call, as before.
      const batch = this._queue.splice(0, this._queue.length);
      try {
        await this._opts.transport({ logs: batch }, this._endpoint);
      } catch (err) {
        const room = Math.max(0, this._maxQueue - this._queue.length);
        if (room > 0) this._queue.unshift(...batch.slice(0, room));
        this._opts.onError?.(err, batch);
      }
      return;
    }

    // Safety valve: a pathological server limit of 1 against a full queue
    // means many sequential posts — cap the per-flush drain and leave the
    // remainder for the next flush rather than looping unbounded.
    for (let posts = 0; this._queue.length > 0 && posts < 100; posts++) {
      const size = Math.min(this._queue.length, this._serverMaxBatch ?? this._queue.length);
      const batch = this._queue.splice(0, size);

      try {
        const extra = await resolveHeaders(this._opts.headers);
        const res = await fetch(this._endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...extra },
          body: JSON.stringify({ logs: batch } satisfies LogShipmentPayload),
          credentials: this._opts.credentials,
          // Let a short send outlive a navigation, so we lose fewer records.
          keepalive: true,
        });
        this._learnMaxBatch(res);

        if (res.status === 413) {
          // Too large: put the chunk back (order intact) and retry smaller.
          this._queue.unshift(...batch);
          const advertised = this._serverMaxBatch;
          if (advertised == null || advertised >= batch.length) {
            // No usable advertisement — bisect.
            this._serverMaxBatch = Math.floor(batch.length / 2);
          }
          if ((this._serverMaxBatch ?? 0) < 1) {
            // Even a single record bounces — nothing smaller to try.
            this._serverMaxBatch = 1;
            this._opts.onError?.(
              new Error(`[bored-logs] log shipment failed: HTTP 413`),
              batch,
            );
            return;
          }
          continue;
        }
        if (!res.ok) {
          throw new Error(`[bored-logs] log shipment failed: HTTP ${res.status}`);
        }
      } catch (err) {
        // Re-queue at the front so the next flush retries, without exceeding the cap.
        const room = Math.max(0, this._maxQueue - this._queue.length);
        if (room > 0) this._queue.unshift(...batch.slice(0, room));
        this._opts.onError?.(err, batch);
        return;
      }
    }
  }

  /** Adopt the server's advertised batch limit from a response header. */
  private _learnMaxBatch(res: Response): void {
    const raw = res.headers?.get?.("x-log-max-batch");
    if (raw == null) return;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1) this._serverMaxBatch = n;
  }

  /**
   * Synchronous best-effort flush for page-unload: uses `navigator.sendBeacon`
   * when available (survives the navigation), falling back to a `keepalive`
   * fetch. Records are not re-queued — the page is going away.
   */
  flushBeacon(): void {
    if (this._queue.length === 0) return;
    // Respect the learned server limit — an oversized beacon would bounce
    // with 413 and, on unload, there is no retry.
    if (this._serverMaxBatch != null && this._queue.length > this._serverMaxBatch) {
      while (this._queue.length > this._serverMaxBatch) {
        const chunk = this._queue.splice(0, this._serverMaxBatch);
        this._sendBeaconChunk(chunk);
      }
    }
    const batch = this._queue.splice(0, this._queue.length);
    if (batch.length === 0) return;
    this._sendBeaconChunk(batch);
  }

  /** Best-effort delivery of one chunk via sendBeacon (keepalive fetch fallback). */
  private _sendBeaconChunk(batch: ClientLogRecord[]): void {
    const body = JSON.stringify({ logs: batch } satisfies LogShipmentPayload);

    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const ok = navigator.sendBeacon(
        this._endpoint,
        new Blob([body], { type: "application/json" }),
      );
      if (ok) return;
    }
    // Fallback: fire-and-forget keepalive fetch.
    try {
      void fetch(this._endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        credentials: this._opts.credentials,
        keepalive: true,
      }).catch(() => {});
    } catch {
      // Nothing more we can do as the page unloads.
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Start the periodic-flush timer and (optionally) the page-unload beacon
   * listeners. Returns a teardown function that stops the timer and removes the
   * listeners. Called from `LoggerProvider`'s mount effect.
   */
  start(): () => void {
    this.stopTimer();
    const interval = this._opts.flushInterval ?? DEFAULTS.flushInterval;
    if (interval > 0 && typeof setInterval === "function") {
      this._timer = setInterval(() => {
        void this.flush();
      }, interval);
    }

    const useBeacon = this._opts.useBeaconOnUnload ?? DEFAULTS.useBeaconOnUnload;
    let detachBeacon = () => {};
    if (useBeacon && typeof document !== "undefined") {
      const onHide = () => {
        if (document.visibilityState === "hidden") this.flushBeacon();
      };
      const onPageHide = () => this.flushBeacon();
      document.addEventListener("visibilitychange", onHide);
      window.addEventListener("pagehide", onPageHide);
      detachBeacon = () => {
        document.removeEventListener("visibilitychange", onHide);
        window.removeEventListener("pagehide", onPageHide);
      };
    }

    return () => {
      this.stopTimer();
      detachBeacon();
    };
  }

  private stopTimer(): void {
    if (this._timer != null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

/** Resolve the {@link HeadersInput} union into a plain header map. */
async function resolveHeaders(
  headers: HeadersInput | undefined,
): Promise<Record<string, string>> {
  if (!headers) return {};
  return typeof headers === "function" ? await headers() : headers;
}
