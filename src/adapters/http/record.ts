import type { ClientLogRecord } from "./types";
import type { LogRecord } from "../../logger/adapter";
import {
  type ValueSerializer,
  REDACTED_PLACEHOLDER,
  interpolate,
  isRedacted,
  defaultSerializer,
} from "../../logger/template";

// ---------------------------------------------------------------------------
// Turning log records into the wire form shipped by the HTTP adapter.
//
// Two sensitivity primitives are resolved here:
//   • secure()  — SHIPPED with its tag intact, so `PostgresAdapter` encrypts it
//                 at rest. (A whole `secure()` *message* has no encryptable
//                 column server-side, so its text is redacted to "[secure]",
//                 matching the server logger.)
//   • redact()  — NEVER shipped in plaintext: replaced with the redaction
//                 placeholder, or omitted from `attrs` entirely.
// ---------------------------------------------------------------------------

/** How a `redact()`ed attribute is handled before shipping. */
export type RedactMode = "placeholder" | "omit";

/** Options controlling how sensitive values are resolved for the wire. */
export type ShipOptions = {
  /** Serializer for interpolated attribute values. Defaults to {@link defaultSerializer}. */
  serialize?: ValueSerializer;
  /** Whether a `redact()`ed attribute is replaced with a placeholder or dropped. Defaults to `"placeholder"`. */
  redactMode?: RedactMode;
  /** Placeholder substituted for redacted values. Defaults to {@link REDACTED_PLACEHOLDER}. */
  redactPlaceholder?: string;
};

/**
 * Prepare an attribute map for shipping: `secure()` wrappers are kept intact
 * (so the server can encrypt them), `redact()` values are scrubbed to the
 * placeholder or omitted, and everything else passes through.
 */
function prepareAttrs(
  attrs: Record<string, unknown>,
  mode: RedactMode,
  placeholder: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(attrs)) {
    if (isRedacted(val)) {
      if (mode === "omit") continue;
      out[key] = placeholder;
    } else {
      // Plain values pass through; `secure()` wrappers ship tagged as
      // { _secure: true, value } so the server re-recognises and encrypts them.
      out[key] = val;
    }
  }
  return out;
}

/** Compute the shipped message: a whole secure message is "[secure]"; otherwise interpolate. */
function shipMessage(
  secureMessage: boolean,
  template: string,
  attrs: Record<string, unknown>,
  serialize: ValueSerializer,
  placeholder: string,
): string {
  // A whole secure message cannot be encrypted at rest (no message column
  // encryption), so it is redacted to "[secure]" — matching the server logger.
  return secureMessage
    ? "[secure]"
    : interpolate(template, attrs, serialize, placeholder);
}

/**
 * Convert a fully-formed {@link LogRecord} (as an adapter receives it) into the
 * wire {@link ClientLogRecord}, preserving the record's timestamp,
 * application, and version. This is what the `HttpAdapter` uses.
 */
export function recordToClientRecord(
  record: LogRecord,
  opts: ShipOptions = {},
): ClientLogRecord {
  const serialize = opts.serialize ?? defaultSerializer;
  const mode = opts.redactMode ?? "placeholder";
  const placeholder = opts.redactPlaceholder ?? REDACTED_PLACEHOLDER;

  return {
    level: record.level,
    message: shipMessage(record.secureMessage, record.template, record.attrs, serialize, placeholder),
    template: record.template,
    secureMessage: record.secureMessage,
    attrs: prepareAttrs(record.attrs, mode, placeholder),
    timestamp: record.timestamp.toISOString(),
    application: record.application,
    version: record.version,
  };
}
