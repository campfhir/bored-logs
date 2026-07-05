import { bench, describe } from "vitest";
import { createLogger } from "../logger/logger";
import type { LogAdapter, LogRecord } from "../logger/adapter";

// ---------------------------------------------------------------------------
// Throughput benchmark for the core logger hot path (level gate → interpolate
// → fan-out to adapters). Run with `pnpm bench` / `vitest bench`.
//
// One iteration models a single round-trip through a logging middleware: a
// `request` line in, a `response` line out — two records per request. tinybench
// reports `hz` in iterations/sec, so **hz is requests/sec directly**: an hz of
// 10,000 means the logger sustains 10k rps through this path.
//
// The logger + adapter are built once per benchmark (outside the measured
// function) so the number reflects the log() hot path, not construction. We use
// lightweight in-memory adapters so it reflects the logger itself, not sink I/O
// — the psql adapter's under-load behaviour (batching, semaphore, backpressure)
// is a separate live-DB concern (e2e suite).
// ---------------------------------------------------------------------------

/** Minimal adapter that touches the record like a real sink would, without I/O. */
function countingAdapter(): LogAdapter {
  let count = 0;
  return {
    write(record: LogRecord): void {
      if (record.message.length > 0) count++;
    },
  };
}

/** Emit one request/response pair through `logger`. */
function oneRequest(logger: ReturnType<typeof createLogger>, i: number): void {
  const method = i % 2 === 0 ? "GET" : "POST";
  const path = `/api/resource/${i}`;
  logger.request("{method} {path}", { method, path, ip: "203.0.113.7" });
  logger.response("{method} {path} -> {status} ({ms}ms)", {
    method,
    path,
    status: 200,
    ms: 12,
  });
}

describe("logger throughput (hz = requests/sec)", () => {
  let i = 0;

  const syncLogger = createLogger({ application: "bench", version: "0.0.0" });
  syncLogger.addAdapter(countingAdapter());

  const asyncLogger = createLogger();
  // Real sinks return a Promise from write(); the logger dispatches without
  // awaiting, so the hot path shouldn't be blocked by it.
  asyncLogger.addAdapter({ write: () => Promise.resolve() });

  const gatedLogger = createLogger({ level: "info" });
  gatedLogger.addAdapter(countingAdapter());

  bench("request + response through a sync adapter", () => {
    oneRequest(syncLogger, i++);
  }, { time: 1000 });

  bench("request + response through an async (fire-and-forget) adapter", () => {
    oneRequest(asyncLogger, i++);
  }, { time: 1000 });

  bench("level-gated out (level=info drops request/response)", () => {
    oneRequest(gatedLogger, i++);
  }, { time: 1000 });
});
