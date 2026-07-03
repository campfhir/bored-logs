import type { LogAdapter, LogRecord } from "./adapter";
import { LOG_LEVELS } from "./adapter";
import { isSecure } from "./template";

// ---------------------------------------------------------------------------
// ConsoleAdapter — writes log records to the process console.
// Universal: works in Node.js, browser, and Edge runtimes.
// ---------------------------------------------------------------------------

export type ConsoleAdapterOptions = {
  /** Minimum level to emit. Defaults to "info". */
  level?: string;
  /** Include the timestamp prefix in output. Defaults to true. */
  showTimestamp?: boolean;
  /** Include the level prefix in output. Defaults to true. */
  showLevel?: boolean;
  /**
   * Custom levels (name → rank) merged into the built-ins so this adapter's
   * filtering recognises them. Registering the adapter on a logger that has
   * custom levels sets these automatically; use this option for standalone use.
   */
  levels?: Record<string, number>;
};

export class ConsoleAdapter implements LogAdapter {
  private _level: string;
  private _levels: Record<string, number>;
  showTimestamp: boolean;
  showLevel: boolean;

  constructor(opts: ConsoleAdapterOptions = {}) {
    this._level = opts.level ?? "info";
    this._levels = { ...LOG_LEVELS, ...opts.levels };
    this.showTimestamp = opts.showTimestamp ?? true;
    this.showLevel = opts.showLevel ?? true;
  }

  get level(): string {
    return this._level;
  }

  set level(value: string) {
    this._level = value;
  }

  setLevels(levels: Record<string, number>): void {
    Object.assign(this._levels, levels);
  }

  write(record: LogRecord): void {
    const recordNum = this._levels[record.level.toLowerCase()] ?? this._levels.debug;
    const levelNum = this._levels[this._level.toLowerCase()] ?? this._levels.info;

    if (recordNum > levelNum) return;

    // Build a display string for attrs — redact Secure values.
    const attrParts: string[] = [];
    for (const [key, val] of Object.entries(record.attrs)) {
      if (key === "_secure") continue;
      if (isSecure(val)) {
        attrParts.push(`${key}=[secure]`);
      } else if (val instanceof Date) {
        attrParts.push(`${key}=${val.toISOString()}`);
      } else if (typeof val === "object" && val !== null) {
        attrParts.push(`${key}=${JSON.stringify(val)}`);
      } else {
        attrParts.push(`${key}=${val}`);
      }
    }

    const display = record.secureMessage ? `[secure message]` : record.message;
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
