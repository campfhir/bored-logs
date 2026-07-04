import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConsoleAdapter } from "../logger/console-adapter";
import type { LogRecord } from "../logger/adapter";
import { secure, redact } from "../logger/template";

function makeRecord(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    level: "info",
    message: "hello world",
    template: "hello world",
    secureMessage: false,
    attrs: {},
    timestamp: new Date("2024-01-15T12:00:00.000Z"),
    ...overrides,
  };
}

describe("ConsoleAdapter", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── showTimestamp ──────────────────────────────────────────────────────────

  describe("showTimestamp", () => {
    it("includes timestamp by default", () => {
      const adapter = new ConsoleAdapter();
      adapter.write(makeRecord());
      expect(consoleSpy.mock.calls[0][0]).toContain("2024-01-15T12:00:00.000Z");
    });

    it("omits timestamp when showTimestamp is false", () => {
      const adapter = new ConsoleAdapter({ showTimestamp: false });
      adapter.write(makeRecord());
      expect(consoleSpy.mock.calls[0][0]).not.toContain(
        "2024-01-15T12:00:00.000Z",
      );
    });

    it("can be toggled at runtime", () => {
      const adapter = new ConsoleAdapter();
      adapter.showTimestamp = false;
      adapter.write(makeRecord());
      expect(consoleSpy.mock.calls[0][0]).not.toContain(
        "2024-01-15T12:00:00.000Z",
      );
    });
  });

  // ── showLevel ──────────────────────────────────────────────────────────────

  describe("showLevel", () => {
    it("includes level by default", () => {
      const adapter = new ConsoleAdapter();
      adapter.write(makeRecord());
      expect(consoleSpy.mock.calls[0][0]).toContain("INFO");
    });

    it("omits level when showLevel is false", () => {
      const adapter = new ConsoleAdapter({ showLevel: false });
      adapter.write(makeRecord());
      expect(consoleSpy.mock.calls[0][0]).not.toContain("INFO");
    });

    it("can be toggled at runtime", () => {
      const adapter = new ConsoleAdapter();
      adapter.showLevel = false;
      adapter.write(makeRecord());
      expect(consoleSpy.mock.calls[0][0]).not.toContain("INFO");
    });
  });

  // ── both off ───────────────────────────────────────────────────────────────

  it("outputs only message when both are disabled", () => {
    const adapter = new ConsoleAdapter({
      showTimestamp: false,
      showLevel: false,
    });
    adapter.write(makeRecord({ message: "bare message" }));
    expect(consoleSpy.mock.calls[0][0]).toBe("bare message");
  });

  // ── attr formatting ────────────────────────────────────────────────────────

  it("appends attrs to the line", () => {
    const adapter = new ConsoleAdapter({
      showTimestamp: false,
      showLevel: false,
    });
    adapter.write(
      makeRecord({ message: "msg", attrs: { userId: "u_1", count: 3 } }),
    );
    const line = consoleSpy.mock.calls[0][0];
    expect(line).toContain("userId=u_1");
    expect(line).toContain("count=3");
  });

  it("masks Secure attr values on the server (maskSecure: true)", () => {
    const adapter = new ConsoleAdapter({
      showTimestamp: false,
      showLevel: false,
      maskSecure: true,
    });
    adapter.write(makeRecord({ attrs: { ssn: secure("123-45-6789") } }));
    const line = consoleSpy.mock.calls[0][0];
    expect(line).toContain("ssn=[secure]");
    expect(line).not.toContain("123-45-6789");
  });

  it("reveals Secure attr values in the browser console (maskSecure: false)", () => {
    const adapter = new ConsoleAdapter({
      showTimestamp: false,
      showLevel: false,
      maskSecure: false,
    });
    adapter.write(makeRecord({ attrs: { ssn: secure("123-45-6789") } }));
    const line = consoleSpy.mock.calls[0][0];
    expect(line).toContain("ssn=123-45-6789");
    expect(line).not.toContain("[secure]");
  });

  it("reveals a secure message template in the browser (maskSecure: false)", () => {
    const adapter = new ConsoleAdapter({
      showTimestamp: false,
      showLevel: false,
      maskSecure: false,
    });
    adapter.write(
      makeRecord({
        secureMessage: true,
        template: "SSN {ssn}",
        message: "[secure]",
        attrs: { ssn: secure("123-45-6789") },
      }),
    );
    const line = consoleSpy.mock.calls[0][0];
    expect(line).toContain("SSN 123-45-6789");
    expect(line).not.toContain("[secure]");
  });

  it("shows the real value for redact() attributes in local console output", () => {
    const adapter = new ConsoleAdapter({
      showTimestamp: false,
      showLevel: false,
      maskSecure: false,
    });
    adapter.write(makeRecord({ attrs: { token: redact("t0k3n") } }));
    const line = consoleSpy.mock.calls[0][0];
    expect(line).toContain("token=t0k3n");
  });

  it("masks redact() attributes on the server (maskSecure: true)", () => {
    const adapter = new ConsoleAdapter({
      showTimestamp: false,
      showLevel: false,
      maskSecure: true,
    });
    adapter.write(makeRecord({ attrs: { token: redact("t0k3n") } }));
    const line = consoleSpy.mock.calls[0][0];
    expect(line).toContain("token=**REDACTED**");
    expect(line).not.toContain("t0k3n");
  });

  it("shows [secure message] for secure templates on the server (maskSecure: true)", () => {
    const adapter = new ConsoleAdapter({
      showTimestamp: false,
      showLevel: false,
      maskSecure: true,
    });
    adapter.write(makeRecord({ secureMessage: true, message: "[secure]" }));
    expect(consoleSpy.mock.calls[0][0]).toContain("[secure message]");
  });

  // ── level routing ──────────────────────────────────────────────────────────

  it("routes error level to console.error", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const adapter = new ConsoleAdapter({ level: "error" });
    adapter.write(makeRecord({ level: "error" }));
    expect(errSpy).toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("routes warn level to console.warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = new ConsoleAdapter({ level: "warn" });
    adapter.write(makeRecord({ level: "warn" }));
    expect(warnSpy).toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  // ── level filtering ────────────────────────────────────────────────────────

  it("suppresses records below the adapter level", () => {
    const adapter = new ConsoleAdapter({ level: "warn" });
    adapter.write(makeRecord({ level: "info" }));
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});
