import type { LogAdapter, LogRecord } from "./adapter";
import { LOG_LEVELS } from "./adapter";
import { isSecure, isRedacted, interpolate, REDACTED_PLACEHOLDER } from "./template";

// ---------------------------------------------------------------------------
// ConsoleAdapter — writes log records to the process console.
// Universal: works in Node.js, browser, and Edge runtimes.
// ---------------------------------------------------------------------------

/** True when running in a browser-like environment (a DOM `window` is present). */
const IS_BROWSER =
  typeof window !== "undefined" &&
  typeof (window as { document?: unknown }).document !== "undefined";

/** Format a plain (already-unwrapped) attribute value for console output. */
function formatValue(val: unknown): string {
  if (val instanceof Date) return val.toISOString();
  if (typeof val === "object" && val !== null) return JSON.stringify(val);
  return String(val);
}

/** Replace `secure()`/`redact()` wrappers with their real inner value, for local reveal. */
function unwrapSensitive(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(attrs)) {
    out[key] = isSecure(val) || isRedacted(val) ? (val as { value: unknown }).value : val;
  }
  return out;
}

/** Construction options for {@link ConsoleAdapter}. */
export type ConsoleAdapterOptions = {
  /** Minimum level to emit. Defaults to "info". */
  level?: string;
  /** Include the timestamp prefix in output. Defaults to true. */
  showTimestamp?: boolean;
  /** Include the level prefix in output. Defaults to true. */
  showLevel?: boolean;
  /**
   * Mask `secure()` / `redact()` values in the output. Defaults to `true` on
   * the server and `false` in the browser: a server console is a shared,
   * often-aggregated environment, whereas a browser console is the developer's
   * own private devtools where the real value is safe to show. Set explicitly
   * to override the auto-detection.
   */
  maskSecure?: boolean;
  /**
   * Custom levels (name → rank) merged into the built-ins so this adapter's
   * filtering recognises them. Registering the adapter on a logger that has
   * custom levels sets these automatically; use this option for standalone use.
   */
  levels?: Record<string, number>;
};

/**
 * Built-in adapter that writes formatted log lines to the console. Works in
 * Node.js, browser, and Edge runtimes. Masks `secure()`/`redact()` values in
 * server output (a shared environment); reveals them in the browser console
 * (private devtools) unless `maskSecure` is set.
 */
export class ConsoleAdapter implements LogAdapter {
  private _level: string;
  private _levels: Record<string, number>;
  private readonly _maskSecure: boolean;
  showTimestamp: boolean;
  showLevel: boolean;

  constructor(opts: ConsoleAdapterOptions = {}) {
    this._level = opts.level ?? "info";
    this._levels = { ...LOG_LEVELS, ...opts.levels };
    this.showTimestamp = opts.showTimestamp ?? true;
    this.showLevel = opts.showLevel ?? true;
    // Mask on the server (shared); reveal in the browser (private devtools).
    this._maskSecure = opts.maskSecure ?? !IS_BROWSER;
  }

  /** The current minimum level this adapter emits. */
  get level(): string {
    return this._level;
  }

  /** Set the minimum level this adapter emits. */
  set level(value: string) {
    this._level = value;
  }

  /** Merge additional level ranks into this adapter's level map. */
  setLevels(levels: Record<string, number>): void {
    Object.assign(this._levels, levels);
  }

  /** Format and print a record via `console.error`/`warn`/`log` per its severity, unless gated out. */
  write(record: LogRecord): void {
    const recordNum = this._levels[record.level.toLowerCase()] ?? this._levels.debug;
    const levelNum = this._levels[this._level.toLowerCase()] ?? this._levels.info;

    if (recordNum > levelNum) return;

    const mask = this._maskSecure;

    // Build a display string for attrs. On the server (mask=true) secure values
    // show as [secure] and redacted values as the placeholder; in the browser
    // (mask=false) the real value is shown — the console is private devtools.
    const attrParts: string[] = [];
    for (const [key, val] of Object.entries(record.attrs)) {
      if (key === "_secure") continue;
      if (isSecure(val)) {
        attrParts.push(
          mask ? `${key}=[secure]` : `${key}=${formatValue((val as { value: unknown }).value)}`,
        );
      } else if (isRedacted(val)) {
        attrParts.push(
          mask
            ? `${key}=${REDACTED_PLACEHOLDER}`
            : `${key}=${formatValue((val as { value: unknown }).value)}`,
        );
      } else {
        attrParts.push(`${key}=${formatValue(val)}`);
      }
    }

    // The message. On the server, use the pre-interpolated (already-masked)
    // message; secure messages show a placeholder. In the browser, reveal by
    // re-interpolating the raw template — but only when something was actually
    // masked, so a plain message is passed through untouched.
    let display: string;
    if (mask) {
      display = record.secureMessage ? `[secure message]` : record.message;
    } else {
      const hasSensitive =
        record.secureMessage ||
        Object.values(record.attrs).some((v) => isSecure(v) || isRedacted(v));
      display = hasSensitive
        ? interpolate(record.template, unwrapSensitive(record.attrs))
        : record.message;
    }
    const body = attrParts.length > 0 ? `${display}  ${attrParts.join("  ")}` : display;

    const prefix = [
      this.showTimestamp ? `[${record.timestamp.toISOString()}]` : "",
      this.showLevel ? record.level.toUpperCase().padEnd(8) : "",
    ].filter(Boolean).join(" ");

    const line = prefix ? `${prefix} ${body}` : body;

    const num = this._levels[record.level.toLowerCase()] ?? this._levels.info;
    if (num <= this._levels.error) {
      console.error(line);
    } else if (num <= this._levels.warn) {
      console.warn(line);
    } else {
      console.log(line);
    }
  }
}
