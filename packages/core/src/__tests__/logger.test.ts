import { describe, it, expect, vi } from "vitest";
import { createLogger } from "../logger/logger";
import { secure, isSecure, redact, interpolate } from "../logger/template";
import type { LogRecord } from "../logger/adapter";

// ---------------------------------------------------------------------------
// interpolate()
// ---------------------------------------------------------------------------

describe("interpolate", () => {
  it("replaces {key} tokens with values", () => {
    expect(interpolate("Hello {name}", { name: "Alice" })).toBe("Hello Alice");
  });

  it("leaves missing keys as-is", () => {
    expect(interpolate("Hello {name}", {})).toBe("Hello {name}");
  });

  it("replaces Secure values with [secure]", () => {
    expect(interpolate("SSN {ssn}", { ssn: secure("123") })).toBe("SSN [secure]");
  });

  it("replaces Redacted values with the placeholder", () => {
    expect(interpolate("tok {t}", { t: redact("abc") })).toBe("tok **REDACTED**");
    expect(interpolate("tok {t}", { t: redact("abc") }, undefined, "‹x›")).toBe("tok ‹x›");
  });

  it("handles multiple tokens", () => {
    expect(interpolate("{a} and {b}", { a: "foo", b: "bar" })).toBe("foo and bar");
  });
});

// ---------------------------------------------------------------------------
// secure() / isSecure()
// ---------------------------------------------------------------------------

describe("secure", () => {
  it("wraps a value", () => {
    const s = secure("secret");
    expect(isSecure(s)).toBe(true);
    expect(s.value).toBe("secret");
  });

  it("isSecure returns false for plain objects", () => {
    expect(isSecure({ value: "x" })).toBe(false);
    expect(isSecure("string")).toBe(false);
    expect(isSecure(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LoggerInstance
// ---------------------------------------------------------------------------

function makeCapture() {
  const records: LogRecord[] = [];
  const adapter = {
    write: vi.fn((r: LogRecord) => { records.push(r); }),
  };
  return { adapter, records };
}

describe("LoggerInstance", () => {
  it("writes a simple info record", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ level: "info" });
    logger.addAdapter(adapter);

    logger.info("Hello world");

    expect(records).toHaveLength(1);
    expect(records[0].level).toBe("info");
    expect(records[0].message).toBe("Hello world");
    expect(records[0].template).toBe("Hello world");
    expect(records[0].secureMessage).toBe(false);
  });

  it("interpolates template tokens", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ level: "debug" });
    logger.addAdapter(adapter);

    logger.info("User {userId} logged in", { userId: "u_123" });

    expect(records[0].message).toBe("User u_123 logged in");
    expect(records[0].template).toBe("User {userId} logged in");
    expect(records[0].attrs).toMatchObject({ userId: "u_123" });
  });

  it("marks secure message templates", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ level: "debug" });
    logger.addAdapter(adapter);

    logger.info(secure("SSN is {ssn}"), { ssn: "123-45-6789" });

    expect(records[0].message).toBe("[secure]");
    expect(records[0].template).toBe("SSN is {ssn}");
    expect(records[0].secureMessage).toBe(true);
  });

  it("accepts extra keys beyond template placeholders", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ level: "debug" });
    logger.addAdapter(adapter);

    logger.info("User {userId} action", { userId: "u_1", extra: "ok", another: 42 });

    expect(records[0].attrs).toMatchObject({ userId: "u_1", extra: "ok", another: 42 });
  });

  it("defaults level to debug (does not suppress any level)", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger();
    logger.addAdapter(adapter);

    logger.debug("debug msg");
    logger.info("info msg");

    expect(records).toHaveLength(2);
  });

  it("filters records below an explicit logger level", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ level: "warn" });
    logger.addAdapter(adapter);

    logger.debug("suppressed");
    logger.info("suppressed");
    logger.warn("passes");

    expect(records).toHaveLength(1);
    expect(records[0].level).toBe("warn");
  });

  it("level can be updated at runtime", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ level: "warn" });
    logger.addAdapter(adapter);

    logger.debug("suppressed");
    logger.level = "debug";
    logger.debug("passes now");

    expect(records).toHaveLength(1);
    expect(records[0].message).toBe("passes now");
  });

  it("buffers records before first adapter and flushes on addAdapter", () => {
    const logger = createLogger({ level: "info" });

    logger.info("Before adapter 1");
    logger.info("Before adapter 2");

    const { adapter, records } = makeCapture();
    logger.addAdapter(adapter);

    expect(records).toHaveLength(2);
    expect(records[0].message).toBe("Before adapter 1");
    expect(records[1].message).toBe("Before adapter 2");
  });

  it("attaches application and version to records", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ level: "info", application: "myapp", version: "1.2.3" });
    logger.addAdapter(adapter);

    logger.info("Test");

    expect(records[0].application).toBe("myapp");
    expect(records[0].version).toBe("1.2.3");
  });

  it("all named level methods work", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ level: "debug" });
    logger.addAdapter(adapter);

    const levels = ["critical", "error", "warn", "info", "http", "verbose", "cache", "request", "response", "sql", "debug"] as const;
    for (const lvl of levels) {
      logger[lvl](`${lvl} message`);
    }

    const emitted = records.map((r) => r.level);
    for (const lvl of levels) {
      expect(emitted).toContain(lvl);
    }
  });

  it("queryAdapter throws when no queryable adapter is registered", () => {
    const { adapter } = makeCapture();
    const logger = createLogger({ level: "info" });
    logger.addAdapter(adapter);

    expect(() => logger.queryAdapter()).toThrow("No queryable adapter");
  });
});

// ---------------------------------------------------------------------------
// Custom level propagation to adapters
// ---------------------------------------------------------------------------

describe("LoggerInstance — custom level propagation", () => {
  it("shares the level map with an adapter on addAdapter (including custom levels)", () => {
    const setLevels = vi.fn();
    const adapter = { write: vi.fn(), setLevels };

    const logger = createLogger({ levels: { audit: 3 } });
    logger.addAdapter(adapter);

    expect(setLevels).toHaveBeenCalledTimes(1);
    expect(setLevels.mock.calls[0][0]).toMatchObject({ audit: 3, info: 3, error: 1 });
  });

  it("propagates levels added after registration via addLevels", () => {
    const setLevels = vi.fn();
    const adapter = { write: vi.fn(), setLevels };

    const logger = createLogger();
    logger.addAdapter(adapter);
    setLevels.mockClear();

    logger.addLevels({ chaos: 9 });

    expect(setLevels).toHaveBeenCalledTimes(1);
    expect(setLevels.mock.calls[0][0]).toMatchObject({ chaos: 9 });
  });

  it("does not throw for adapters that omit setLevels", () => {
    const adapter = { write: vi.fn() };
    const logger = createLogger({ levels: { audit: 3 } });
    expect(() => logger.addAdapter(adapter)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// .on() process hooks
// ---------------------------------------------------------------------------

describe("LoggerInstance.on()", () => {
  it("returns this for chaining", () => {
    const logger = createLogger();
    const result = logger.on("SIGINT", async () => {});
    expect(result).toBe(logger);
  });

  it("registers a process.once handler that flushes before calling user callback", async () => {
    const flushed: string[] = [];
    const called: string[] = [];

    const mockAdapter = {
      write: vi.fn(),
      flush: vi.fn(async () => { flushed.push("flushed"); }),
      close: vi.fn(async () => {}),
    };

    const logger = createLogger();
    logger.addAdapter(mockAdapter);

    let capturedHandler: (() => Promise<void>) | null = null;
    const onceSpy = vi.spyOn(process, "once").mockImplementation(
      (event: string | symbol, listener: (...args: any[]) => void) => {
        if (event === "SIGTERM") capturedHandler = listener as () => Promise<void>;
        return process;
      },
    );

    logger.on("SIGTERM", async () => { called.push("handler"); });

    expect(capturedHandler).not.toBeNull();
    await capturedHandler!();

    expect(flushed).toEqual(["flushed"]);
    expect(called).toEqual(["handler"]);

    onceSpy.mockRestore();
  });
});
