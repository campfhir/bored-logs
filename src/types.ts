// ---------------------------------------------------------------------------
// Shared utility types — inlined so this package has no runtime type deps.
// ---------------------------------------------------------------------------

/** A typed {@link Error} whose `message` is a string literal, with chainable cause and metadata. */
export class Err<S extends string = string> extends Error {
  message: S;
  cause?: Error | Err<any>;
  meta?: Record<string, any>;

  constructor(s: S, opt?: ErrorOptions) {
    super(s, opt);
    this.message = s;
  }

  /** Attach an underlying cause (a string is wrapped in a new {@link Err}); returns `this`. */
  addCause(c: Error | Err<any> | string): Err<S> {
    this.cause = typeof c === "string" ? new Err(c) : c;
    return this;
  }

  /** Attach a metadata object; returns `this`. */
  withMetadata(m: Record<string, any>): Err<S> {
    this.meta = m;
    return this;
  }

  /** Render the message plus any cause and metadata as a multi-line string. */
  toString(): string {
    let str = this.message as string;
    if (this.cause) {
      str += `\nCaused by: ${this.cause}`;
    }
    if (this.meta) {
      str += `\nMetadata: ${JSON.stringify(this.meta)}`;
    }
    return str;
  }
}

type OkResult<T = unknown> = T extends void
  ? { ok: true; val?: never; err?: never }
  : { ok: true; val: T; err?: never };

type ErrResult<S extends string | unknown = unknown> = S extends string
  ? { ok: false; val?: never; err: Err<S> }
  : { ok: false; val?: never; err: Err };

/** A success/failure union: `{ ok: true, val }` on success or `{ ok: false, err }` carrying an {@link Err}. */
export type Result<T = unknown, S extends string | unknown = unknown> =
  | OkResult<T>
  | ErrResult<S>;

/** A {@link Result} wrapped in a promise. */
export type AsyncResult<T, S extends string = string> = Promise<Result<T, S>>;

/** Flattens an intersection/mapped type into a single object literal for readable hovers. */
export type Prettify<T> = { [K in keyof T]: T[K] } & {};
