import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger } from "../logger/logger";
import { ConsoleAdapter } from "../logger/console-adapter";
import { secure, redact, resolveAttributes, BUILTIN_TEMPLATE_KEYS } from "../logger/template";
import type { LogRecord } from "../logger/adapter";

function makeCapture() {
  const records: LogRecord[] = [];
  const adapter = {
    write: vi.fn((r: LogRecord) => {
      records.push(r);
    }),
  };
  return { adapter, records };
}

// ---------------------------------------------------------------------------
// resolveAttributes() — the primitive behind global attributes.
// ---------------------------------------------------------------------------

describe("resolveAttributes", () => {
  it("passes static values through", () => {
    expect(resolveAttributes({ commit: "e02350", build: 7 })).toEqual({
      commit: "e02350",
      build: 7,
    });
  });

  it("invokes function values", () => {
    expect(resolveAttributes({ pid: () => 42 })).toEqual({ pid: 42 });
  });

  it("omits an attribute whose resolver throws", () => {
    const resolved = resolveAttributes({
      ok: "yes",
      boom: () => {
        throw new Error("nope");
      },
    });
    expect(resolved).toEqual({ ok: "yes" });
  });

  it("keeps secure() and redact() wrappers intact", () => {
    const resolved = resolveAttributes({ token: () => secure("abc") });
    expect(resolved.token).toEqual(secure("abc"));
  });
});

// ---------------------------------------------------------------------------
// Global attributes — declared on createLogger, always attached.
// ---------------------------------------------------------------------------

describe("global attributes", () => {
  it("attaches extra createLogger keys to every record", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ commit: "e02350", region: "us-west-2" });
    logger.addAdapter(adapter);

    logger.info("first");
    logger.warn("second");

    expect(records[0].attrs).toMatchObject({ commit: "e02350", region: "us-west-2" });
    expect(records[1].attrs).toMatchObject({ commit: "e02350", region: "us-west-2" });
  });

  it("does not treat reserved option keys as attributes", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({
      level: "debug",
      application: "api",
      version: "0.0.1",
      bufferLimit: 10,
      levels: { audit: 3 },
      commit: "e02350",
    });
    logger.addAdapter(adapter);

    logger.info("hello");

    expect(records[0].attrs).toEqual({ commit: "e02350" });
    expect(records[0].application).toBe("api");
    expect(records[0].version).toBe("0.0.1");
  });

  it("resolves function attributes at call time, once per record", () => {
    const { adapter, records } = makeCapture();
    const seq = vi.fn(() => "r1");
    const logger = createLogger({ requestId: seq });
    logger.addAdapter(adapter);
    logger.addAdapter(makeCapture().adapter);

    logger.info("a");
    seq.mockReturnValue("r2");
    logger.info("b");

    expect(seq).toHaveBeenCalledTimes(2); // once per log() call, not per adapter
    expect(records[0].attrs.requestId).toBe("r1");
    expect(records[1].attrs.requestId).toBe("r2");
  });

  it("lets call-site attrs override a global of the same name", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ commit: "e02350" });
    logger.addAdapter(adapter);

    logger.info("deploy {commit}", { commit: "override" });

    expect(records[0].attrs.commit).toBe("override");
    expect(records[0].message).toBe("deploy override");
  });

  it("makes globals available to the message template", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ commit: "e02350" });
    logger.addAdapter(adapter);

    logger.info("built from {commit}");

    expect(records[0].message).toBe("built from e02350");
  });

  it("accepts an explicit `attributes` bag, including option names", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({
      version: "0.0.1",
      attributes: { bufferLimit: "not-an-option", commit: "e02350" },
    });
    logger.addAdapter(adapter);

    logger.info("hi");

    expect(records[0].attrs).toEqual({ bufferLimit: "not-an-option", commit: "e02350" });
    expect(records[0].version).toBe("0.0.1");
  });

  it("exposes globals via the `attributes` accessor and allows mutation", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ commit: "e02350" });
    logger.addAdapter(adapter);

    expect(logger.attributes).toEqual({ commit: "e02350" });

    logger.attributes = { ...logger.attributes, region: "eu-1" };
    logger.info("hi");

    expect(records[0].attrs).toMatchObject({ commit: "e02350", region: "eu-1" });
  });

  it("keeps a global secure() value wrapped in attrs", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ apiKey: secure("sk-123") });
    logger.addAdapter(adapter);

    logger.info("call {apiKey}");

    expect(records[0].message).toBe("call [secure]");
    expect(records[0].attrs.apiKey).toEqual(secure("sk-123"));
  });
});

// ---------------------------------------------------------------------------
// Reserved attribute names — the `$`-prefixed built-ins, and only those. The
// sigil exists precisely so that ordinary names stay free.
// ---------------------------------------------------------------------------

describe("reserved attribute names", () => {
  it("reserves exactly the five built-in template keys", () => {
    expect([...BUILTIN_TEMPLATE_KEYS]).toEqual([
      "$message",
      "$level",
      "$timestamp",
      "$application",
      "$version",
    ]);
  });

  it("strips built-in names from call-site attrs", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger();
    logger.addAdapter(adapter);

    logger.info("hi", {
      // @ts-expect-error — `$message` is reserved for the built-in
      $message: "spoof",
      // @ts-expect-error — `$level` is reserved for the built-in
      $level: "spoof",
      // @ts-expect-error — `$timestamp` is reserved for the built-in
      $timestamp: "spoof",
      userId: "u_1",
    });

    expect(records[0].attrs).toEqual({ userId: "u_1" });
  });

  it("strips built-in names from globals, top-level and in the bag", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({
      // @ts-expect-error — `$message` is reserved for the built-in
      $message: "spoof",
      commit: "e02350",
      // @ts-expect-error — `$timestamp` is reserved for the built-in
      attributes: { $timestamp: "spoof", region: "eu-1" },
    });
    logger.addAdapter(adapter);

    logger.info("hi");

    expect(records[0].attrs).toEqual({ commit: "e02350", region: "eu-1" });
  });

  it("strips built-in names assigned through the attributes setter", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger();
    logger.addAdapter(adapter);

    // @ts-expect-error — `$level` is reserved for the built-in
    logger.attributes = { $level: "spoof", region: "eu-1" };
    logger.info("hi");

    expect(records[0].attrs).toEqual({ region: "eu-1" });
  });

  it("leaves ordinary names free, including message/level/timestamp", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ timestamp: () => "wall-clock" });
    logger.addAdapter(adapter);

    logger.info("hi", { message: "inner", level: "urgent" });

    expect(records[0].attrs).toEqual({
      timestamp: "wall-clock",
      message: "inner",
      level: "urgent",
    });
    // The record's own message/level are untouched by the attributes.
    expect(records[0].message).toBe("hi");
    expect(records[0].level).toBe("info");
  });

  it("still allows `application` and `version` as attribute names", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ application: "api", version: "0.0.1" });
    logger.addAdapter(adapter);

    logger.info("hi", { application: "worker", version: "9.9.9" });

    expect(records[0].attrs).toEqual({ application: "worker", version: "9.9.9" });
    // The dedicated record fields are unaffected by the attributes.
    expect(records[0].application).toBe("api");
    expect(records[0].version).toBe("0.0.1");
  });

  it("allows a `_`-prefixed name that is not a built-in", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ $traceId: "t-1" });
    logger.addAdapter(adapter);

    logger.info("hi");

    expect(records[0].attrs).toEqual({ $traceId: "t-1" });
  });
});

// ---------------------------------------------------------------------------
// logger.template() — the output template.
// ---------------------------------------------------------------------------

describe("logger.template()", () => {
  it("returns `this` so it chains", () => {
    const logger = createLogger();
    expect(logger.template("{$message}")).toBe(logger);
  });

  it("renders the documented end-to-end example", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ version: "0.0.1", commit: "e02350" });
    logger.addAdapter(adapter);
    logger.template("{$timestamp} {$message} {$version} {commit}");

    logger.info("something something {userId}", { userId: "123" });

    const iso = records[0].timestamp.toISOString();
    expect(records[0].formatted).toBe(`${iso} something something 123 0.0.1 e02350`);
    // The raw message and template are untouched, so search/query still work.
    expect(records[0].message).toBe("something something 123");
    expect(records[0].template).toBe("something something {userId}");
  });

  it("leaves `formatted` undefined when no template is set", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger();
    logger.addAdapter(adapter);

    logger.info("plain");

    expect(records[0].formatted).toBeUndefined();
  });

  it("clears the template when passed null", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger();
    logger.addAdapter(adapter);

    logger.template("[{$level}] {$message}");
    logger.info("a");
    logger.template(null);
    logger.info("b");

    expect(records[0].formatted).toBe("[info] a");
    expect(records[1].formatted).toBeUndefined();
    expect(logger.outputTemplate).toBeUndefined();
  });

  it("exposes the current template via outputTemplate", () => {
    const logger = createLogger().template("{$message}");
    expect(logger.outputTemplate).toBe("{$message}");
  });

  it("supplies the five $-prefixed built-ins", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ application: "api", version: "1.2.3" });
    logger.addAdapter(adapter);
    logger.template("{$timestamp} [{$level}] {$application}@{$version} {$message}");

    logger.warn("careful");

    const iso = records[0].timestamp.toISOString();
    expect(records[0].formatted).toBe(`${iso} [warn] api@1.2.3 careful`);
  });

  it("renders a bare {message} from the attribute of that name", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger();
    logger.addAdapter(adapter);
    logger.template("{$message} / {message} / {$timestamp} / {timestamp}");

    logger.info("the message", { message: "an attribute", timestamp: "wall-clock" });

    const iso = records[0].timestamp.toISOString();
    expect(records[0].formatted).toBe(`the message / an attribute / ${iso} / wall-clock`);
  });

  it("does not let an attribute displace a built-in", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger();
    logger.addAdapter(adapter);
    logger.template("{$message}|{$level}");

    // Untyped call site — the compiler would reject these, so this exercises
    // the runtime strip that backs the type-level guarantee.
    logger.info("real", { $message: "spoof", $level: "spoof" } as Record<string, unknown>);

    expect(records[0].formatted).toBe("real|info");
  });

  it("distinguishes {application} the attribute from {$application} the field", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ application: "api" });
    logger.addAdapter(adapter);
    logger.template("{$application} vs {application}");

    logger.info("x", { application: "worker" });

    expect(records[0].formatted).toBe("api vs worker");
  });

  it("leaves unknown placeholders literal", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger();
    logger.addAdapter(adapter);
    logger.template("{$message} {nope}");

    logger.info("hi");

    expect(records[0].formatted).toBe("hi {nope}");
  });

  it("keeps a token literal when its resolver throws", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({
      commit: () => {
        throw new Error("git missing");
      },
    });
    logger.addAdapter(adapter);
    logger.template("{$message} {commit}");

    expect(() => logger.info("still logs")).not.toThrow();
    expect(records[0].formatted).toBe("still logs {commit}");
  });

  it("renders a secure message as [secure] and secure/redacted attrs safely", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger();
    logger.addAdapter(adapter);
    logger.template("{$message} {token} {trace}");

    logger.info(secure("top secret"), { token: secure("sk-1"), trace: redact("t-1") });

    expect(records[0].formatted).toBe("[secure] [secure] **REDACTED**");
  });

  it("uses the logger's serializeValue for object attrs", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ serializeValue: () => "<obj>" });
    logger.addAdapter(adapter);
    logger.template("{$message} {payload}");

    logger.info("sent", { payload: { a: 1 } });

    expect(records[0].formatted).toBe("<obj> <obj>");
  });

  it("does not format ingested records", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ commit: "e02350" });
    logger.addAdapter(adapter);
    logger.template("{$message} {commit}");

    logger.ingest({
      level: "info",
      message: "from the browser",
      template: "from the browser",
      secureMessage: false,
      attrs: {},
      timestamp: new Date(),
    });

    expect(records[0].formatted).toBeUndefined();
    expect(records[0].attrs).toEqual({});
  });

  it("formats records that were buffered before an adapter existed", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ commit: "e02350" }).template("{$message} {commit}");

    logger.info("early");
    logger.addAdapter(adapter);

    expect(records[0].formatted).toBe("early e02350");
  });
});

// ---------------------------------------------------------------------------
// Type-level behaviour — these assertions are checked by `tsc --noEmit`.
// ---------------------------------------------------------------------------

describe("attribute typing", () => {
  it("does not require attrs a global already supplies", () => {
    const logger = createLogger({ commit: "e02350" });
    logger.info("built from {commit}"); // no attrs argument needed
    logger.log("debug", "built from {commit}");
    expect(logger.attributes.commit).toBe("e02350");
  });

  it("still requires attrs for placeholders no global covers", () => {
    const logger = createLogger({ commit: "e02350" });
    // @ts-expect-error — {userId} is not a global, so attrs is required
    logger.info("hello {userId}");
    // @ts-expect-error — commit is covered, userId is not
    logger.info("{commit} {userId}", {});
    logger.info("{commit} {userId}", { userId: "1" }); // ok
    expect(logger.outputTemplate).toBeUndefined();
  });

  it("counts names from the `attributes` bag as globals too", () => {
    const logger = createLogger({ attributes: { region: "eu-1" } });
    logger.info("in {region}");
    expect(logger.attributes.region).toBe("eu-1");
  });

  it("keeps custom level inference working alongside globals", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ levels: { audit: 3 }, commit: "e02350" });
    logger.addAdapter(adapter);

    logger.log("audit", "checked {commit}");

    expect(records[0].level).toBe("audit");
    expect(records[0].message).toBe("checked e02350");
  });
});

// ---------------------------------------------------------------------------
// ConsoleAdapter honours the formatted line.
// ---------------------------------------------------------------------------

describe("ConsoleAdapter with a formatted record", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints `formatted` verbatim, without prefix or attr pairs", () => {
    const logger = createLogger({ commit: "e02350" });
    logger.addAdapter(new ConsoleAdapter({ level: "debug" }));
    logger.template("{$level}: {$message} ({commit})");

    logger.info("hello {who}", { who: "world" });

    expect(logSpy).toHaveBeenCalledWith("info: hello world (e02350)");
  });

  it("still applies its own level gate", () => {
    const logger = createLogger({ level: "debug" });
    logger.addAdapter(new ConsoleAdapter({ level: "error" }));
    logger.template("{$message}");

    logger.info("suppressed");

    expect(logSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// logger.renderTimestamp() — controls how {$timestamp} renders. Storage is
// untouched: record.timestamp stays a Date regardless of the renderer.
// ---------------------------------------------------------------------------

describe("logger.renderTimestamp()", () => {
  const FIXED = new Date("2026-08-03T18:22:59.000Z");

  function makeFormatted(logger = createLogger()) {
    const { adapter, records } = makeCapture();
    logger.addAdapter(adapter);
    logger.template("{$timestamp}");
    return { logger, records };
  }

  it("returns `this` so it chains", () => {
    const logger = createLogger();
    expect(logger.renderTimestamp("epoch")).toBe(logger);
  });

  it("defaults to ISO", () => {
    const { logger, records } = makeFormatted();
    logger.info("x");
    expect(records[0].formatted).toBe(records[0].timestamp.toISOString());
  });

  it("accepts a callback", () => {
    const { logger, records } = makeFormatted();
    logger.renderTimestamp((d) => `t=${d.getTime()}`);
    logger.info("x");
    expect(records[0].formatted).toBe(`t=${records[0].timestamp.getTime()}`);
  });

  it("falls back to ISO when the callback throws", () => {
    const { logger, records } = makeFormatted();
    logger.renderTimestamp(() => {
      throw new Error("bad renderer");
    });
    expect(() => logger.info("x")).not.toThrow();
    expect(records[0].formatted).toBe(records[0].timestamp.toISOString());
  });

  it("supports the epoch preset", () => {
    const { logger, records } = makeFormatted();
    logger.renderTimestamp("epoch");
    logger.info("x");
    expect(records[0].formatted).toBe(String(records[0].timestamp.getTime()));
  });

  it("supports the time/date/datetime presets via Intl", () => {
    // Mirror the preset's Intl construction — host locale varies across machines.
    const expected = {
      time: new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }),
      date: new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }),
      datetime: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }),
    } as const;
    for (const preset of ["time", "date", "datetime"] as const) {
      const { logger, records } = makeFormatted();
      logger.renderTimestamp(preset);
      logger.info("x");
      expect(records[0].formatted).toBe(expected[preset].format(records[0].timestamp));
    }
  });

  it("accepts Intl options with a locale", () => {
    const { logger, records } = makeFormatted();
    logger.renderTimestamp({
      locale: "en-US",
      timeZone: "UTC",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    });
    // Freeze the record time by rendering through the renderer contract:
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    });
    logger.info("x");
    expect(records[0].formatted).toBe(fmt.format(records[0].timestamp));
    expect(fmt.format(FIXED)).toBe("18:22"); // semantic anchor for the shape
  });

  it("resets to ISO when passed null", () => {
    const { logger, records } = makeFormatted();
    logger.renderTimestamp("epoch");
    logger.info("a");
    logger.renderTimestamp(null);
    logger.info("b");
    expect(records[0].formatted).toBe(String(records[0].timestamp.getTime()));
    expect(records[1].formatted).toBe(records[1].timestamp.toISOString());
  });

  it("does not change what is stored — record.timestamp stays a Date", () => {
    const { logger, records } = makeFormatted();
    logger.renderTimestamp("epoch");
    logger.info("x");
    expect(records[0].timestamp).toBeInstanceOf(Date);
  });

  it("does not affect a caller's own `timestamp` attribute", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ timestamp: () => "wall-clock" });
    logger.addAdapter(adapter);
    logger.template("{$timestamp} vs {timestamp}").renderTimestamp("epoch");
    logger.info("x");
    expect(records[0].formatted).toBe(
      `${records[0].timestamp.getTime()} vs wall-clock`,
    );
  });

  it("chains off createLogger with template()", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ commit: "e02350" })
      .template("{$timestamp} {$message} {commit}")
      .renderTimestamp("epoch");
    logger.addAdapter(adapter);
    logger.info("deploy");
    expect(records[0].formatted).toBe(
      `${records[0].timestamp.getTime()} deploy e02350`,
    );
  });
});

// ---------------------------------------------------------------------------
// Chainable log methods — log(), ingest(), and every named level method
// return `this`.
// ---------------------------------------------------------------------------

describe("chainable log methods", () => {
  it("returns `this` from log(), every named level method, and ingest()", () => {
    const logger = createLogger();
    expect(logger.log("info", "x")).toBe(logger);
    expect(logger.critical("x")).toBe(logger);
    expect(logger.error("x")).toBe(logger);
    expect(logger.warn("x")).toBe(logger);
    expect(logger.info("x")).toBe(logger);
    expect(logger.http("x")).toBe(logger);
    expect(logger.verbose("x")).toBe(logger);
    expect(logger.cache("x")).toBe(logger);
    expect(logger.request("x")).toBe(logger);
    expect(logger.response("x")).toBe(logger);
    expect(logger.sql("x")).toBe(logger);
    expect(logger.debug("x")).toBe(logger);
    expect(
      logger.ingest({
        level: "info",
        message: "m",
        template: "m",
        secureMessage: false,
        attrs: {},
        timestamp: new Date(),
      }),
    ).toBe(logger);
  });

  it("returns `this` even when the record is gated out by level", () => {
    const logger = createLogger({ level: "error" });
    expect(logger.debug("dropped")).toBe(logger);
  });

  it("chains multiple log calls, emitting each in order", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ level: "debug" });
    logger.addAdapter(adapter);

    logger
      .info("step {n}", { n: 1 })
      .warn("step {n}", { n: 2 })
      .log("sql", "step {n}", { n: 3 });

    expect(records.map((r) => r.message)).toEqual(["step 1", "step 2", "step 3"]);
    expect(records.map((r) => r.level)).toEqual(["info", "warn", "sql"]);
  });

  it("chains log calls with configuration calls", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ commit: "e02350" });
    logger.addAdapter(adapter);

    logger.info("before").template("{$message} {commit}").info("after");

    expect(records[0].formatted).toBeUndefined();
    expect(records[1].formatted).toBe("after e02350");
  });
});
