// ---------------------------------------------------------------------------
// Secure wrapper — marks a value or entire message template as encrypted.
// ---------------------------------------------------------------------------

export type Secure<T> = { readonly _secure: true; readonly value: T };

export const secure = <T>(value: T): Secure<T> => ({ _secure: true, value });

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

export type ExtractTemplateKeys<T extends string | Secure<string>> = ExtractKeys<
  UnwrapTemplate<T>
>;

// ---------------------------------------------------------------------------
// TemplateAttrs — makes the attrs parameter required (and typed) when the
// template contains {key} placeholders; optional otherwise.
// ---------------------------------------------------------------------------

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

export type ValueSerializer = (value: unknown) => string;

export const defaultSerializer: ValueSerializer = (val) => {
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
};

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
