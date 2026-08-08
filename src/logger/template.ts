// ---------------------------------------------------------------------------
// Secure wrapper — marks a value or entire message template as encrypted.
// ---------------------------------------------------------------------------

/** A value or message template marked as secure (to be encrypted / redacted). */
export type Secure<T> = { readonly _secure: true; readonly value: T };

/** Wrap a value as {@link Secure} so it is encrypted at rest and shown as `[secure]`. */
export const secure = <T>(value: T): Secure<T> => ({ _secure: true, value });

/** Type guard: true when the value is a {@link Secure} wrapper. */
export const isSecure = (v: unknown): v is Secure<unknown> =>
  typeof v === "object" &&
  v !== null &&
  "_secure" in v &&
  (v as any)._secure === true;

// ---------------------------------------------------------------------------
// Redact wrapper — marks a value that may be shown in *local* output (e.g. the
// browser console) but must never be shipped to the server or persisted in
// plaintext. Contrast with `secure()`, which is transmitted to your server so
// it can be encrypted at rest. `redact()` is the "this never leaves the box"
// primitive: at every transmit/persist boundary its value is replaced with
// {@link REDACTED_PLACEHOLDER} (or omitted).
// ---------------------------------------------------------------------------

/** The literal substituted for a {@link Redacted} value wherever it would otherwise be shipped or stored. */
export const REDACTED_PLACEHOLDER = "**REDACTED**";

/** A value marked as redact-on-transmit: visible in local output, scrubbed (or omitted) before it is shipped or persisted. */
export type Redacted<T> = { readonly __redacted: true; readonly value: T };

/**
 * Wrap a value so it is visible in local/console output but scrubbed to
 * {@link REDACTED_PLACEHOLDER} (or omitted) before it is shipped to the server
 * or written to a persistent adapter. Use for data that is useful while
 * debugging in the browser but must never be transmitted or stored.
 */
export const redact = <T>(value: T): Redacted<T> => ({ __redacted: true, value });

/** Type guard: true when the value is a {@link Redacted} wrapper. */
export const isRedacted = (v: unknown): v is Redacted<unknown> =>
  typeof v === "object" &&
  v !== null &&
  "__redacted" in v &&
  (v as any).__redacted === true;

// ---------------------------------------------------------------------------
// Global attributes — values attached to every record a logger emits. A value
// may be a function, in which case it is called at each log site so the
// attribute can be computed fresh (a timestamp, a request id, a build stamp).
// ---------------------------------------------------------------------------

/**
 * The `{$name}` placeholders an output template resolves from the record
 * itself. The `$` sigil keeps them in their own namespace — the same
 * convention MongoDB uses for reserved operators inside a user-controlled
 * document — so every ordinary attribute name, including `message`, `level`,
 * and `timestamp`, stays free for callers. These five names are reserved as
 * attribute keys (a compile error, and stripped at runtime) so a built-in can
 * never be displaced. The matching `$key` forms in a log query select the
 * stored column rather than an attribute.
 */
export const BUILTIN_TEMPLATE_KEYS = [
  "$message",
  "$level",
  "$timestamp",
  "$application",
  "$version",
] as const;

/** Union of the {@link BUILTIN_TEMPLATE_KEYS} names. */
export type BuiltinTemplateKey = (typeof BUILTIN_TEMPLATE_KEYS)[number];

/** Makes each name in `K` unusable as a property — assigning one is a compile error. */
export type RejectKeys<K extends string> = { [P in K]?: never };

/** Remove every {@link BUILTIN_TEMPLATE_KEYS} entry from an attribute map, in place. */
export function stripBuiltinAttrs(attrs: Record<string, unknown>): void {
  for (const key of BUILTIN_TEMPLATE_KEYS) {
    if (key in attrs) delete attrs[key];
  }
}

// ---------------------------------------------------------------------------
// Timestamp rendering — how `{$timestamp}` is rendered in an output template.
// Storage is never affected: the record keeps its full Date, and the Postgres
// adapter stores the complete timestamp-with-offset regardless of the format
// chosen here.
// ---------------------------------------------------------------------------

/** Named shorthands for common `{$timestamp}` renderings. */
export type TimestampPreset =
  /** ISO-8601 UTC (`2026-08-03T18:22:59.000Z`) — the default. */
  | "iso"
  /** Milliseconds since the Unix epoch. */
  | "epoch"
  /** Locale time only (`Intl` `timeStyle: "medium"`). */
  | "time"
  /** Locale date only (`Intl` `dateStyle: "medium"`). */
  | "date"
  /** Locale date and time (`Intl` `dateStyle`/`timeStyle: "medium"`). */
  | "datetime";

/**
 * How `{$timestamp}` renders: a {@link TimestampPreset} name, an
 * `Intl.DateTimeFormat` options object (plus an optional `locale`) for
 * locale-aware output, or a `(date: Date) => string` callback for anything
 * else.
 */
export type TimestampFormat =
  | TimestampPreset
  | (Intl.DateTimeFormatOptions & { locale?: string | string[] })
  | ((date: Date) => string);

const PRESET_INTL_OPTIONS: Partial<Record<TimestampPreset, Intl.DateTimeFormatOptions>> = {
  time: { timeStyle: "medium" },
  date: { dateStyle: "medium" },
  datetime: { dateStyle: "medium", timeStyle: "medium" },
};

/**
 * Resolve a {@link TimestampFormat} spec into a render function. Intl
 * formatters are constructed once here — not per record — since
 * `Intl.DateTimeFormat` construction is far more expensive than `format()`.
 */
export function resolveTimestampFormat(
  spec: TimestampFormat | null | undefined,
): (date: Date) => string {
  if (spec == null || spec === "iso") return (d) => d.toISOString();
  if (spec === "epoch") return (d) => String(d.getTime());
  if (typeof spec === "function") return spec;
  if (typeof spec === "string") {
    const fmt = new Intl.DateTimeFormat(undefined, PRESET_INTL_OPTIONS[spec]);
    return (d) => fmt.format(d);
  }
  const { locale, ...options } = spec;
  const fmt = new Intl.DateTimeFormat(locale, options);
  return (d) => fmt.format(d);
}

/** A global attribute: either a fixed value or a thunk evaluated at each log call. */
export type AttributeValue = unknown | (() => unknown);

/** A map of always-included attribute names to fixed values or resolver functions. */
export type LogAttributes = Record<string, AttributeValue> & RejectKeys<BuiltinTemplateKey>;

/**
 * Evaluate a {@link LogAttributes} map into plain values: function entries are
 * invoked, everything else passes through. A resolver that throws drops its
 * attribute rather than failing the log call — logging must never be the thing
 * that breaks a request.
 */
export function resolveAttributes(
  attrs: Record<string, AttributeValue>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(attrs)) {
    if (typeof val === "function") {
      try {
        out[key] = (val as () => unknown)();
      } catch {
        // resolver errors are silenced; the attribute is simply absent
      }
    } else {
      out[key] = val;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Template key extraction — pulls {key} placeholder names out of a string.
// ---------------------------------------------------------------------------

type UnwrapTemplate<T> = T extends Secure<infer S extends string>
  ? S
  : T extends string
    ? T
    : never;

type ExtractKeys<T extends string> =
  T extends `${string}{${infer Key}}${infer Rest}` ? Key | ExtractKeys<Rest> : never;

/** Union of the `{key}` placeholder names in a template string (unwrapping {@link Secure}). */
export type ExtractTemplateKeys<T extends string | Secure<string>> = ExtractKeys<
  UnwrapTemplate<T>
>;

// ---------------------------------------------------------------------------
// TemplateAttrs — makes the attrs parameter required (and typed) when the
// template contains {key} placeholders the caller must supply; optional
// otherwise. Placeholders already covered by the logger's global attributes
// (TGlobal) are not the caller's to provide.
// ---------------------------------------------------------------------------

/** The `attrs` argument tuple for a template: required and typed when the template has `{key}` placeholders not covered by `TGlobal`, optional otherwise. */
export type TemplateAttrs<
  T extends string | Secure<string>,
  TGlobal extends string = never,
> = [Exclude<ExtractTemplateKeys<T>, TGlobal>] extends [never]
  ? [attrs?: Record<string, unknown> & RejectKeys<BuiltinTemplateKey>]
  : [
      attrs: Record<Exclude<ExtractTemplateKeys<T>, TGlobal>, unknown> &
        Record<string, unknown> &
        RejectKeys<BuiltinTemplateKey>,
    ];

// ---------------------------------------------------------------------------
// interpolate — replaces {key} tokens with values from attrs.
// Secure values render as "[secure]"; missing keys render as "{key}".
// Objects are serialized with JSON.stringify by default; supply a custom
// serializer via LoggerOptions.serializeValue to override.
// ---------------------------------------------------------------------------

/** Converts an interpolated attribute value into its string representation. */
export type ValueSerializer = (value: unknown) => string;

/** Default {@link ValueSerializer}: `JSON.stringify` for objects, `String()` for primitives. */
export const defaultSerializer: ValueSerializer = (val) => {
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
};

/** Replace `{key}` tokens with serialized `attrs` values; secure values render as `[secure]`, redacted values as `redactPlaceholder`, and missing keys stay literal. */
export function interpolate(
  template: string,
  attrs: Record<string, unknown>,
  serialize: ValueSerializer = defaultSerializer,
  redactPlaceholder: string = REDACTED_PLACEHOLDER,
): string {
  return template.replace(/\{([\w$]+)\}/g, (_, key: string) => {
    const val = attrs[key];
    if (val === undefined) return `{${key}}`;
    if (isSecure(val)) return "[secure]";
    if (isRedacted(val)) return redactPlaceholder;
    return serialize(val);
  });
}
