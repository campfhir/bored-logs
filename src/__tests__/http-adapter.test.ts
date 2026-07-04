import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HttpAdapter } from "../adapters/http/adapter";
import { buildClientRecord, recordToClientRecord } from "../adapters/http/record";
import { secure, redact, isSecure } from "../logger/template";
import type { LogRecord } from "../logger/adapter";
import type { LogShipmentPayload } from "../adapters/http/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rec(over: Partial<LogRecord> = {}): LogRecord {
  return {
    level: "info",
    message: "hi",
    template: "hi",
    secureMessage: false,
    attrs: {},
    timestamp: new Date("2026-07-04T00:00:00.000Z"),
    ...over,
  };
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): LogShipmentPayload {
  return JSON.parse((fetchMock.mock.calls[call][1] as RequestInit).body as string);
}

// ---------------------------------------------------------------------------
// recordToClientRecord / buildClientRecord — sensitivity resolution
// ---------------------------------------------------------------------------

describe("recordToClientRecord", () => {
  it("preserves the record's timestamp, app, and version", () => {
    const cr = recordToClientRecord(
      rec({ application: "web", version: "1.2.3", message: "Hello Ada", template: "Hello {name}", attrs: { name: "Ada" } }),
    );
    expect(cr).toMatchObject({
      message: "Hello Ada",
      application: "web",
      version: "1.2.3",
      timestamp: "2026-07-04T00:00:00.000Z",
    });
  });

  it("ships secure attributes tagged, and masks them in the message", () => {
    const cr = recordToClientRecord(
      rec({ template: "SSN {ssn}", secureMessage: false, attrs: { ssn: secure("123-45-6789") } }),
    );
    expect(cr.message).toBe("SSN [secure]");
    expect(isSecure(cr.attrs.ssn)).toBe(true);
    expect(JSON.parse(JSON.stringify(cr.attrs.ssn))._secure).toBe(true);
  });

  it("keeps a whole secure message redacted", () => {
    const cr = recordToClientRecord(rec({ secureMessage: true, template: "top {x}", attrs: { x: 1 } }));
    expect(cr.message).toBe("[secure]");
  });

  it("scrubs redact() values in the message and attrs (placeholder)", () => {
    const cr = recordToClientRecord(
      rec({ template: "tok {t}", attrs: { t: redact("abc123"), keep: "ok" } }),
    );
    expect(cr.message).toBe("tok **REDACTED**");
    expect(cr.attrs.t).toBe("**REDACTED**");
    expect(cr.attrs.keep).toBe("ok");
    expect(JSON.stringify(cr)).not.toContain("abc123");
  });

  it("omits redact() attributes in omit mode, honours a custom placeholder", () => {
    const cr = recordToClientRecord(
      rec({ template: "tok {t}", attrs: { t: redact("abc123") } }),
      { redactMode: "omit", redactPlaceholder: "‹x›" },
    );
    expect("t" in cr.attrs).toBe(false);
    expect(cr.message).toBe("tok ‹x›");
  });
});

describe("buildClientRecord (logger-less path)", () => {
  const now = () => new Date("2026-07-04T00:00:00.000Z");
  it("interpolates and stamps from a level+template+attrs", () => {
    const cr = buildClientRecord("info", "Hi {n}", { n: "Ada" }, { application: "web", now });
    expect(cr).toMatchObject({ level: "info", message: "Hi Ada", application: "web", timestamp: "2026-07-04T00:00:00.000Z" });
  });
  it("handles a secure() template", () => {
    const cr = buildClientRecord("info", secure("secret {x}"), { x: "y" }, { now });
    expect(cr.secureMessage).toBe(true);
    expect(cr.message).toBe("[secure]");
  });
});

// ---------------------------------------------------------------------------
// ShipAdapter
// ---------------------------------------------------------------------------

describe("HttpAdapter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not flush before the batch fills, then POSTs the batch as JSON", async () => {
    const a = new HttpAdapter({ endpoint: "/api/logs", batchSize: 3, flushInterval: 0 });
    a.write(rec({ message: "a" }));
    a.write(rec({ message: "b" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(a.pending).toBe(2);

    a.write(rec({ message: "c" })); // hits batchSize -> flush
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/logs");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(bodyOf(fetchMock).logs).toHaveLength(3);
    expect(a.pending).toBe(0);
  });

  it("drops records below the configured level", async () => {
    const a = new HttpAdapter({ endpoint: "/api/logs", level: "warn", batchSize: 10, flushInterval: 0 });
    a.write(rec({ level: "info" }));
    a.write(rec({ level: "debug" }));
    a.write(rec({ level: "error" }));
    expect(a.pending).toBe(1);
    await a.flush();
    expect(bodyOf(fetchMock).logs.map((l) => l.level)).toEqual(["error"]);
  });

  it("resolves sensitive values on write (secure tagged, redact scrubbed)", async () => {
    const a = new HttpAdapter({ endpoint: "/api/logs", flushInterval: 0, redactMode: "omit" });
    a.write(rec({ template: "pay {pan} tok {tok}", attrs: { pan: secure("4111"), tok: redact("t0k3n") } }));
    await a.flush();
    const [shipped] = bodyOf(fetchMock).logs;
    expect(shipped.message).toBe("pay [secure] tok **REDACTED**");
    expect(isSecure(shipped.attrs.pan)).toBe(true);
    expect("tok" in shipped.attrs).toBe(false);
  });

  it("re-queues the batch and calls onError when a flush fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    const onError = vi.fn();
    const a = new HttpAdapter({ endpoint: "/api/logs", flushInterval: 0, onError });
    a.write(rec());
    await a.flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(a.pending).toBe(1);

    await a.flush();
    expect(a.pending).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds the queue to maxQueue, dropping the oldest", () => {
    const a = new HttpAdapter({ endpoint: "/api/logs", batchSize: 1000, maxQueue: 2, flushInterval: 0 });
    a.write(rec({ message: "1" }));
    a.write(rec({ message: "2" }));
    a.write(rec({ message: "3" }));
    expect(a.pending).toBe(2);
  });

  it("flushes on a timer, and start() returns a working teardown", async () => {
    vi.useFakeTimers();
    const a = new HttpAdapter({ endpoint: "/api/logs", batchSize: 1000, flushInterval: 1000 });
    const stop = a.start();
    a.write(rec({ message: "tick" }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    stop();
    a.write(rec({ message: "after-stop" }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("flushBeacon uses navigator.sendBeacon when available", () => {
    const sendBeacon = vi.fn((_url: string, _body?: BodyInit) => true);
    vi.stubGlobal("navigator", { sendBeacon });
    const a = new HttpAdapter({ endpoint: "/api/logs", flushInterval: 0 });
    a.write(rec({ message: "unloading" }));
    a.flushBeacon();
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(sendBeacon.mock.calls[0][0]).toBe("/api/logs");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(a.pending).toBe(0);
  });

  it("merges custom headers (function form) and honours a transport override", async () => {
    const a = new HttpAdapter({ endpoint: "/api/logs", flushInterval: 0, headers: () => ({ "x-csrf": "tok" }) });
    a.write(rec());
    await a.flush();
    expect(((fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>)["x-csrf"]).toBe("tok");

    const transport = vi.fn(async (_p: LogShipmentPayload, _e: string) => {});
    const b = new HttpAdapter({ endpoint: "/api/logs", flushInterval: 0, transport });
    b.write(rec());
    await b.flush();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1]).toBe("/api/logs");
  });
});
