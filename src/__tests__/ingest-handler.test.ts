import { describe, it, expect, vi } from "vitest";
import { createLogIngestHandler } from "../server/ingest-handler";
import { createLogger } from "../logger/logger";
import { isSecure } from "../logger/template";
import type { LogAdapter, LogRecord } from "../logger/adapter";
import type { ClientLogRecord } from "../adapters/http/types";

function makeCapture(): { adapter: LogAdapter; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { records, adapter: { write: (r) => void records.push(r) } };
}

function wireRecord(over: Partial<ClientLogRecord> = {}): ClientLogRecord {
  return {
    level: "info",
    message: "Hello Ada",
    template: "Hello {name}",
    secureMessage: false,
    attrs: { name: "Ada" },
    timestamp: "2026-07-04T00:00:00.000Z",
    application: "web",
    ...over,
  };
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/logs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("createLogIngestHandler", () => {
  it("ingests a batch into the logger, preserving message and client timestamp", async () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger();
    logger.addAdapter(adapter);

    const handler = createLogIngestHandler({ logger });
    const res = await handler(post({ logs: [wireRecord(), wireRecord({ level: "error", message: "boom" })] }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 2 });
    expect(records).toHaveLength(2);
    expect(records[0].message).toBe("Hello Ada");
    expect(records[0].timestamp).toBeInstanceOf(Date);
    expect(records[0].timestamp.toISOString()).toBe("2026-07-04T00:00:00.000Z");
    expect(records[1].level).toBe("error");
  });

  it("delivers a shipped secure attribute to the adapter as a Secure wrapper (so it encrypts)", async () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger();
    logger.addAdapter(adapter);

    const handler = createLogIngestHandler({ logger });
    // The wire form of a secure attr — what JSON.stringify(secure(...)) produces.
    await handler(post({ logs: [wireRecord({ attrs: { pan: { _secure: true, value: "4111" } } })] }));

    expect(isSecure(records[0].attrs.pan)).toBe(true);
    expect((records[0].attrs.pan as { value: unknown }).value).toBe("4111");
  });

  it("applies the logger's level gate on ingest", async () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ level: "warn" });
    logger.addAdapter(adapter);

    const handler = createLogIngestHandler({ logger });
    await handler(post({ logs: [wireRecord({ level: "info" }), wireRecord({ level: "error" })] }));

    expect(records.map((r) => r.level)).toEqual(["error"]);
  });

  it("rejects a non-POST method with 405", async () => {
    const logger = createLogger();
    const handler = createLogIngestHandler({ logger });
    const res = await handler(new Request("http://localhost/api/logs", { method: "GET" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("returns 400 for a malformed body", async () => {
    const logger = createLogger();
    const handler = createLogIngestHandler({ logger });
    expect((await handler(post({ notLogs: [] }))).status).toBe(400);
    const bad = new Request("http://localhost/api/logs", { method: "POST", body: "{" });
    expect((await handler(bad)).status).toBe(400);
  });

  it("returns 413 when the batch exceeds maxBatch", async () => {
    const logger = createLogger();
    const handler = createLogIngestHandler({ logger, maxBatch: 1 });
    const res = await handler(post({ logs: [wireRecord(), wireRecord()] }));
    expect(res.status).toBe(413);
  });

  it("skips entries that fail validation without failing the batch", async () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger();
    logger.addAdapter(adapter);
    const handler = createLogIngestHandler({ logger });

    const res = await handler(post({ logs: [wireRecord(), { level: "info" /* missing fields */ }, "nope"] }));
    expect(await res.json()).toEqual({ accepted: 1 });
    expect(records).toHaveLength(1);
  });

  it("runs transform to enrich records and can drop them by returning null", async () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger();
    logger.addAdapter(adapter);

    const handler = createLogIngestHandler({
      logger,
      transform: (record) => {
        if (record.level === "debug") return null;
        return { ...record, attrs: { ...record.attrs, serverStamped: true } };
      },
    });

    await handler(post({ logs: [wireRecord(), wireRecord({ level: "debug" })] }));
    expect(records).toHaveLength(1);
    expect(records[0].attrs.serverStamped).toBe(true);
  });

  it("returns 500 and calls onError when ingest throws", async () => {
    const onError = vi.fn();
    const logger = { ingest: () => { throw new Error("db down"); } };
    const handler = createLogIngestHandler({ logger, onError });
    const res = await handler(post({ logs: [wireRecord()] }));
    expect(res.status).toBe(500);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
