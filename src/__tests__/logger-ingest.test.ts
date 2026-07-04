import { describe, it, expect } from "vitest";
import { createLogger } from "../logger/logger";
import type { LogAdapter, LogRecord } from "../logger/adapter";

function makeCapture(): { adapter: LogAdapter; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { records, adapter: { write: (r) => void records.push(r) } };
}

function record(over: Partial<LogRecord> = {}): LogRecord {
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

describe("LoggerInstance.ingest", () => {
  it("dispatches a pre-formed record verbatim, without re-interpolating", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger();
    logger.addAdapter(adapter);

    const rec = record({ message: "already interpolated {kept literal}", template: "t {x}", attrs: { x: 1 } });
    logger.ingest(rec);

    expect(records).toHaveLength(1);
    expect(records[0].message).toBe("already interpolated {kept literal}");
    expect(records[0].timestamp.toISOString()).toBe("2026-07-04T00:00:00.000Z");
  });

  it("respects the level gate", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger({ level: "warn" });
    logger.addAdapter(adapter);

    logger.ingest(record({ level: "info" }));
    logger.ingest(record({ level: "error" }));
    expect(records.map((r) => r.level)).toEqual(["error"]);
  });

  it("buffers before an adapter is registered, then replays on addAdapter", () => {
    const { adapter, records } = makeCapture();
    const logger = createLogger();

    logger.ingest(record({ message: "buffered" }));
    expect(records).toHaveLength(0);

    logger.addAdapter(adapter);
    expect(records).toHaveLength(1);
    expect(records[0].message).toBe("buffered");
  });
});
