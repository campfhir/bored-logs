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
import { E2EClientSession, type E2ESigningKeysJwk } from "./e2e-client";
import { E2E_ERROR_HEADER } from "./e2e-wire";
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
  /**
   * Opt-in end-to-end shipment encryption. The batch is encrypted
   * (ECDH P-256 → HKDF → AES-256-GCM, fresh ephemeral key per POST) and
   * signed (ECDSA P-256); the ciphertext ships as the raw body with the
   * envelope in `x-bored-logs-*` headers. The adapter registers itself at
   * the registration endpoint eagerly (at `start()` or the first `write`,
   * whichever comes first) and transparently re-registers
   * when the server forgets it (restart) or rotates its key. Incompatible
   * with `transport` (which would receive plaintext) — combining them throws.
   * On page unload, `sendBeacon` is never used; records that cannot be
   * sealed are DROPPED, never sent in the clear.
   */
  encryption?: HttpE2EOptions;
};

/** Configuration for {@link HttpAdapterOptions.encryption}. */
export type HttpE2EOptions = {
  /** Registration endpoint URL. Defaults to `endpoint` + `/register`. */
  registrationEndpoint?: string;
  /** Stable client identity. Defaults to a random UUID per session. */
  clientId?: string;
  /** Persistent signing identity (see {@link generateE2ESigningKeys}); omitted → per-session. */
  signingKeys?: E2ESigningKeysJwk;
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
  /** E2E session — lazily created, survives setOptions unless its config changes. */
  private _e2e: E2EClientSession | null = null;

  constructor(opts: HttpAdapterOptions) {
    assertNoTransportWithEncryption(opts);
    assertE2ESupported(opts);
    this._opts = opts;
    this._levels = { ...LOG_LEVELS, ...opts.levels };
  }

  /** Merge fresh options in (e.g. when `LoggerProvider` props change). */
  setOptions(opts: HttpAdapterOptions): void {
    assertNoTransportWithEncryption(opts);
    assertE2ESupported(opts);
    // The E2E session (and its registration) survives option churn unless the
    // fields that define it change — LoggerProvider re-commits every render.
    if (this._e2e && e2eConfigKey(opts) !== e2eConfigKey(this._opts)) {
      this._e2e = null;
    }
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

  /**
   * Kick off (or join) the E2E registration in the background. Errors are
   * routed to `onError`; the actual flush path re-awaits `ensureRegistered`
   * and gets its own error handling.
   */
  private _warmE2E(): void {
    if (!this._opts.encryption) return;
    const session = this._session();
    if (session.isReady) return;
    void session.ensureRegistered().catch((err) => this._opts.onError?.(err, []));
  }

  /** The E2E session for the current options (created on first use). */
  private _session(): E2EClientSession {
    if (!this._e2e) {
      const enc = this._opts.encryption!;
      this._e2e = new E2EClientSession({
        registrationEndpoint:
          enc.registrationEndpoint ?? `${this._endpoint.replace(/\/+$/, "")}/register`,
        clientId: enc.clientId ?? generateClientId(),
        signingKeys: enc.signingKeys,
        resolveHeaders: () => resolveHeaders(this._opts.headers),
        credentials: this._opts.credentials,
      });
    }
    return this._e2e;
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
    // Services typically never call start() — warming here means the session
    // registers as soon as the first record exists, well before any flush.
    this._warmE2E();
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
    let reRegistered = false;
    for (let posts = 0; this._queue.length > 0 && posts < 100; posts++) {
      const size = Math.min(this._queue.length, this._serverMaxBatch ?? this._queue.length);
      const batch = this._queue.splice(0, size);

      try {
        const extra = await resolveHeaders(this._opts.headers);
        let res: Response;
        if (this._opts.encryption) {
          const session = this._session();
          await session.ensureRegistered();
          const sealed = await session.seal(
            new TextEncoder().encode(JSON.stringify({ logs: batch } satisfies LogShipmentPayload)),
          );
          res = await fetch(this._endpoint, {
            method: "POST",
            // E2E headers and content-type spread LAST — user headers cannot
            // displace the envelope.
            headers: { ...extra, ...sealed.headers, "content-type": "application/octet-stream" },
            body: sealed.body as BodyInit,
            credentials: this._opts.credentials,
            keepalive: true,
          });
          this._learnMaxBatch(res);

          // Server restart (unknown-client) or key rotation (decrypt-failed):
          // reset, re-register, retry this chunk — once per flush, mirroring
          // the 413 recovery below.
          const e2eCode = res.headers?.get?.(E2E_ERROR_HEADER);
          if (
            !res.ok &&
            (e2eCode === "unknown-client" || e2eCode === "decrypt-failed") &&
            !reRegistered
          ) {
            reRegistered = true;
            this._queue.unshift(...batch);
            session.reset();
            continue;
          }
        } else {
          res = await fetch(this._endpoint, {
            method: "POST",
            headers: { "content-type": "application/json", ...extra },
            body: JSON.stringify({ logs: batch } satisfies LogShipmentPayload),
            credentials: this._opts.credentials,
            // Let a short send outlive a navigation, so we lose fewer records.
            keepalive: true,
          });
          this._learnMaxBatch(res);
        }

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
    if (this._opts.encryption) {
      // sendBeacon cannot carry the envelope headers and cannot await
      // WebCrypto — with encryption on, the unload tail goes through an
      // async seal + keepalive fetch, and records that cannot be sealed are
      // DROPPED rather than ever sent in the clear.
      while (this._queue.length > 0) {
        const size = Math.min(this._queue.length, this._serverMaxBatch ?? this._queue.length);
        const chunk = this._queue.splice(0, size);
        void this._sealAndSendUnload(chunk);
      }
      return;
    }
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

  /**
   * Best-effort ENCRYPTED unload delivery: seal (only if the session already
   * registered — no registration attempts while the page is going away) and
   * fire a keepalive fetch. Failures drop the records and notify `onError`;
   * nothing is ever sent unencrypted.
   */
  private async _sealAndSendUnload(batch: ClientLogRecord[]): Promise<void> {
    const session = this._e2e;
    try {
      if (!session?.isReady) {
        throw new Error(
          "[bored-logs] e2e session not registered at unload — records dropped (never sent in the clear)",
        );
      }
      const extra = await resolveHeaders(this._opts.headers);
      const sealed = await session.seal(
        new TextEncoder().encode(JSON.stringify({ logs: batch } satisfies LogShipmentPayload)),
      );
      void fetch(this._endpoint, {
        method: "POST",
        headers: { ...extra, ...sealed.headers, "content-type": "application/octet-stream" },
        body: sealed.body as BodyInit,
        credentials: this._opts.credentials,
        keepalive: true,
      }).catch(() => {});
    } catch (err) {
      this._opts.onError?.(err, batch);
    }
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
    // Warm the E2E session immediately: registering now (instead of at the
    // first flush) means the session is almost always ready by the time an
    // unload flush needs to seal — shrinking the drop-on-unload window.
    this._warmE2E();
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

/** Combining a custom transport with encryption would hand it PLAINTEXT — refuse loudly. */
function assertNoTransportWithEncryption(opts: HttpAdapterOptions): void {
  if (opts.transport && opts.encryption) {
    throw new TypeError(
      "[bored-logs] `transport` and `encryption` cannot be combined — a custom " +
        "transport receives the structured plaintext payload, which would bypass " +
        "end-to-end encryption. Drop one of the two options.",
    );
  }
}

/**
 * Fail FAST when encryption is configured in a runtime without WebCrypto
 * (e.g. an insecure browser context) — a loud construction-time error beats
 * every flush failing while records rot in the queue.
 */
function assertE2ESupported(opts: HttpAdapterOptions): void {
  if (!opts.encryption) return;
  if (!(globalThis as { crypto?: Crypto }).crypto?.subtle) {
    throw new Error(
      "[bored-logs] `encryption` is configured but WebCrypto (crypto.subtle) is " +
        "unavailable in this runtime — end-to-end encryption requires a secure " +
        "context (https/localhost) or Node ≥ 18.",
    );
  }
}

/** Identity of an E2E session — changing any of these fields discards it. */
function e2eConfigKey(opts: HttpAdapterOptions): string {
  const e = opts.encryption;
  if (!e) return "";
  return JSON.stringify([
    opts.endpoint,
    e.registrationEndpoint ?? null,
    e.clientId ?? null,
    e.signingKeys?.publicJwk?.x ?? null,
    e.signingKeys?.publicJwk?.y ?? null,
  ]);
}

/** Random client id (crypto.randomUUID with a portable fallback). */
function generateClientId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Resolve the {@link HeadersInput} union into a plain header map. */
async function resolveHeaders(
  headers: HeadersInput | undefined,
): Promise<Record<string, string>> {
  if (!headers) return {};
  return typeof headers === "function" ? await headers() : headers;
}

// ── End-to-end encryption re-exports (this file is the package entry) ──────
export { generateE2ESigningKeys, E2EClientSession } from "./e2e-client";
export type { E2ESigningKeysJwk, E2EClientSessionOptions, SealedShipment } from "./e2e-client";
export { E2E_HEADERS, E2E_ERROR_HEADER, E2E_ALGO_V1 } from "./e2e-wire";
export type { E2EErrorCode } from "./e2e-wire";
