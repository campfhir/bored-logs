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

/** Replace `{key}` tokens with serialized `attrs` values; secure values render as `[secure]` and missing keys stay literal. */
export function interpolate(
  template: string,
  attrs: Record<string, unknown>,
  serialize: ValueSerializer = defaultSerializer,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const val = attrs[key];
    if (val === undefined) return `{${key}}`;
    if (isSecure(val)) return "[secure]";
    return serialize(val);
  });
}
