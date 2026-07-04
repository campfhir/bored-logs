import type { LogRecord } from "../logger/adapter";
import type { ClientLogRecord, LogShipmentPayload } from "../adapters/http/types";

// ---------------------------------------------------------------------------
// createLogIngestHandler — a Next.js Route Handler that receives log batches
// shipped from the browser by `useLogger()` and feeds them to a server logger.
//
// It parses and validates the `{ logs: [...] }` body, reconstructs each
// `LogRecord` (preserving the client's timestamp and interpolated message),
// runs an optional per-record `transform` (to enrich with request-derived data
// like IP or session), and dispatches via `logger.ingest`. Returns standard
// `Response`s: 200 `{ accepted }` on success, 400 malformed, 405 wrong method,
// 413 too large, 500 on an unexpected error.
// ---------------------------------------------------------------------------

/** The minimal logger surface the handler needs: an `ingest` sink. Satisfied by `Logger`. */
export interface IngestSink {
  ingest(record: LogRecord): void;
}

/** Options for {@link createLogIngestHandler}. */
export type LogIngestHandlerOptions = {
  /** The server logger (or any {@link IngestSink}) that shipped records are written to. */
  logger: IngestSink;
  /** Reject batches larger than this many records with 413. Defaults to 100. */
  maxBatch?: number;
  /**
   * Optional per-record hook, run after the record is reconstructed and before
   * it is ingested. Return a (possibly modified) record to keep it, or `null`
   * to drop it. Use it to enrich records with server-only data (e.g. the
   * client IP, an authenticated user id) or to enforce allow-lists.
   *
   * @example
   * transform: (record, req) => ({
   *   ...record,
   *   attrs: { ...record.attrs, ip: req.headers.get("x-forwarded-for") },
   * }),
   */
  transform?: (
    record: LogRecord,
    request: Request,
  ) => LogRecord | null | Promise<LogRecord | null>;
  /** Called when handling throws; return value is ignored. Defaults to `console.error`. */
  onError?: (err: unknown, request: Request) => void;
};

/** Type guard for one wire record — tolerant of extra fields, strict on the ones we use. */
function isClientLogRecord(v: unknown): v is ClientLogRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.level === "string" &&
    typeof r.message === "string" &&
    typeof r.template === "string" &&
    typeof r.secureMessage === "boolean" &&
    typeof r.timestamp === "string" &&
    typeof r.attrs === "object" &&
    r.attrs !== null
  );
}

/** Coerce a validated wire record into a server {@link LogRecord}. */
function toLogRecord(r: ClientLogRecord): LogRecord {
  const ts = new Date(r.timestamp);
  return {
    level: r.level,
    message: r.message,
    template: r.template,
    secureMessage: r.secureMessage,
    attrs: r.attrs as Record<string, unknown>,
    // Fall back to "now" if the client sent an unparseable timestamp.
    timestamp: Number.isNaN(ts.getTime()) ? new Date() : ts,
    application: typeof r.application === "string" ? r.application : undefined,
    version: typeof r.version === "string" ? r.version : undefined,
  };
}

/**
 * Build a Next.js Route Handler (`(req: Request) => Promise<Response>`) that
 * ingests logs shipped from the browser by `useLogger()`. Export it as `POST`.
 *
 * @example
 * // app/api/logs/route.ts
 * import { createLogIngestHandler } from "@campfhir/bored-logs/server";
 * import { logger } from "@/lib/logger";
 *
 * export const POST = createLogIngestHandler({ logger });
 */
export function createLogIngestHandler(
  options: LogIngestHandlerOptions,
): (request: Request) => Promise<Response> {
  const maxBatch = options.maxBatch ?? 100;
  const onError =
    options.onError ??
    ((err) => {
      console.error("[bored-logs] log ingest failed:", err);
    });

  return async function handler(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "POST" },
      });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError(400, "invalid JSON body");
    }

    const logs = (body as Partial<LogShipmentPayload> | null)?.logs;
    if (!Array.isArray(logs)) {
      return jsonError(400, "expected a { logs: [...] } body");
    }
    if (logs.length > maxBatch) {
      return jsonError(413, `batch too large (max ${maxBatch})`);
    }

    try {
      let accepted = 0;
      for (const entry of logs) {
        if (!isClientLogRecord(entry)) continue;
        let record = toLogRecord(entry);
        if (options.transform) {
          const next = await options.transform(record, request);
          if (!next) continue;
          record = next;
        }
        options.logger.ingest(record);
        accepted += 1;
      }
      return new Response(JSON.stringify({ accepted }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      onError(err, request);
      return jsonError(500, "failed to ingest logs");
    }
  };
}

/** A small JSON error body helper. */
function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
