// ---------------------------------------------------------------------------
// Shared utility types — inlined so this package has no runtime type deps.
// ---------------------------------------------------------------------------

export class Err<S extends string = string> extends Error {
  message: S;
  cause?: Error | Err<any>;
  meta?: Record<string, any>;

  constructor(s: S, opt?: ErrorOptions) {
    super(s, opt);
    this.message = s;
  }

  addCause(c: Error | Err<any> | string): Err<S> {
    this.cause = typeof c === "string" ? new Err(c) : c;
    return this;
  }

  withMetadata(m: Record<string, any>): Err<S> {
    this.meta = m;
    return this;
  }

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

export type Result<T = unknown, S extends string | unknown = unknown> =
  | OkResult<T>
  | ErrResult<S>;

export type AsyncResult<T, S extends string = string> = Promise<Result<T, S>>;

export type Prettify<T> = { [K in keyof T]: T[K] } & {};
