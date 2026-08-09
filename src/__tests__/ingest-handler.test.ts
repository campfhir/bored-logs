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

// ---------------------------------------------------------------------------
// Batch-size advertisement — every response tells the shipper the max.
// ---------------------------------------------------------------------------

describe("createLogIngestHandler — max-batch advertisement", () => {
  it("advertises maxBatch on a 200", async () => {
    const handler = createLogIngestHandler({ logger: createLogger(), maxBatch: 42 });
    const res = await handler(post({ logs: [wireRecord()] }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-log-max-batch")).toBe("42");
  });

  it("advertises the default maxBatch (100)", async () => {
    const handler = createLogIngestHandler({ logger: createLogger() });
    const res = await handler(post({ logs: [wireRecord()] }));
    expect(res.headers.get("x-log-max-batch")).toBe("100");
  });

  it("advertises maxBatch on a 413, in the header and the body", async () => {
    const handler = createLogIngestHandler({ logger: createLogger(), maxBatch: 2 });
    const res = await handler(post({ logs: [wireRecord(), wireRecord(), wireRecord()] }));
    expect(res.status).toBe(413);
    expect(res.headers.get("x-log-max-batch")).toBe("2");
    const body = await res.json();
    expect(body.maxBatch).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// authorize hook — pluggable auth (bearer, OAuth2 introspection, JWT, …).
// ---------------------------------------------------------------------------

describe("createLogIngestHandler — authorize hook", () => {
  it("rejects with 401 before any body processing when authorize returns false", async () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger();
    logger.addAdapter(adapter);

    const seen: string[] = [];
    const handler = createLogIngestHandler({
      logger,
      authorize: async (request) => {
        seen.push(request.headers.get("authorization") ?? "none");
        return request.headers.get("authorization") === "Bearer good";
      },
    });

    const denied = await handler(post({ logs: [wireRecord()] }));
    expect(denied.status).toBe(401);
    expect((await denied.json()).error).toBe("unauthorized");
    expect(records).toHaveLength(0);

    const req = post({ logs: [wireRecord()] });
    req.headers.set("authorization", "Bearer good");
    const allowed = await handler(req);
    expect(allowed.status).toBe(200);
    expect(records).toHaveLength(1);
    expect(seen).toEqual(["none", "Bearer good"]);
  });

  it("runs before decryption — unauthenticated encrypted traffic never reaches the crypto path", async () => {
    const { createE2EServerContext } = await import("../server/e2e-context");
    let opened = 0;
    const ctx = createE2EServerContext();
    const realOpen = ctx.open.bind(ctx);
    ctx.open = (r) => {
      opened++;
      return realOpen(r);
    };

    const handler = createLogIngestHandler({
      logger: createLogger(),
      encryption: { context: ctx },
      authorize: () => false,
    });
    const req = post({ logs: [] });
    req.headers.set("x-bored-logs-algo", "ecdh-p256+a256gcm+ecdsa-p256");
    const res = await handler(req);
    expect(res.status).toBe(401);
    expect(opened).toBe(0); // no signature/decrypt work for unauthenticated traffic
  });
  it("a THROWING authorize fails closed: 500, onError notified, nothing ingested", async () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger();
    logger.addAdapter(adapter);
    const onError = vi.fn();

    const handler = createLogIngestHandler({
      logger,
      onError,
      authorize: async () => {
        throw new Error("introspection service down");
      },
    });
    const res = await handler(post({ logs: [wireRecord()] })); // must NOT reject
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("authorization check failed");
    expect(records).toHaveLength(0);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.any(Request));
  });
});
