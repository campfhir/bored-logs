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
// template contains {key} placeholders; optional otherwise.
// ---------------------------------------------------------------------------

/** The `attrs` argument tuple for a template: required and typed when the template has `{key}` placeholders, optional otherwise. */
export type TemplateAttrs<T extends string | Secure<string>> =
  [ExtractTemplateKeys<T>] extends [never]
    ? [attrs?: Record<string, unknown>]
    : [attrs: Record<ExtractTemplateKeys<T>, unknown> & Record<string, unknown>];

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
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const val = attrs[key];
    if (val === undefined) return `{${key}}`;
    if (isSecure(val)) return "[secure]";
    if (isRedacted(val)) return redactPlaceholder;
    return serialize(val);
  });
}
