import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PostgresAdapter } from "../adapters/psql/adapter";
import { LOG_LEVELS } from "../logger/adapter";
import type { LogQueryOptions, LogLevel } from "../logger/adapter";

// ---------------------------------------------------------------------------
// Level-filter resolution in PostgresAdapter.query().
//
// query() turns the level filter (level | levels | minLevel) into the exact
// `logLevels` set passed to the SQL `IN (...)` clause. We spy on the private
// `_queryLogs` to capture that set without touching a real database.
// ---------------------------------------------------------------------------

const ALL_LEVELS = Object.keys(LOG_LEVELS).sort();

/** Levels whose rank is <= the rank of `name` (this level + everything more severe). */
function atLeastAsSevereAs(name: string): string[] {
  const threshold = (LOG_LEVELS as Record<string, number>)[name];
  return Object.entries(LOG_LEVELS)
    .filter(([, rank]) => rank <= threshold)
    .map(([level]) => level)
    .sort();
}

describe("PostgresAdapter.query — level filtering", () => {
  let adapter: PostgresAdapter;
  let queryLogs: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The db is never touched because we stub _queryLogs below.
    adapter = new PostgresAdapter({ db: {} as never });
    queryLogs = vi
      .spyOn(adapter as unknown as { _queryLogs: () => unknown }, "_queryLogs")
      .mockResolvedValue({ ok: true, val: [] });
  });

  afterEach(async () => {
    await adapter.close();
    vi.restoreAllMocks();
  });

  /** Runs query() with the given options and returns the sorted logLevels passed to _queryLogs. */
  async function capturedLevels(options: LogQueryOptions): Promise<string[]> {
    await adapter.query(options);
    const arg = queryLogs.mock.calls[0]?.[0] as { logLevels: string[] };
    return [...arg.logLevels].sort();
  }

  // ── single exact level ──────────────────────────────────────────────────

  it("resolves a single `level` to exactly that level", async () => {
    expect(await capturedLevels({ level: "info" })).toEqual(["info"]);
  });

  // ── multiple exact levels ─────────────────────────────────────────────────

  it("resolves `levels` to that exact set (no threshold expansion)", async () => {
    expect(await capturedLevels({ levels: ["info", "debug"] })).toEqual([
      "debug",
      "info",
    ]);
  });

  it("de-dupes repeated entries in `levels`", async () => {
    expect(await capturedLevels({ levels: ["debug", "debug"] })).toEqual([
      "debug",
    ]);
  });

  it("does not pull in more-verbose levels — `levels: ['info']` excludes debug", async () => {
    const levels = await capturedLevels({ levels: ["info"] });
    expect(levels).toEqual(["info"]);
    expect(levels).not.toContain("debug");
  });

  // ── minLevel threshold ────────────────────────────────────────────────────

  it("expands `minLevel: 'warn'` to warn and everything more severe", async () => {
    expect(await capturedLevels({ minLevel: "warn" })).toEqual(
      atLeastAsSevereAs("warn"),
    );
    // Sanity: warn keeps the severe levels, drops the verbose ones.
    const levels = await capturedLevels({ minLevel: "warn" });
    expect(levels).toEqual(expect.arrayContaining(["critical", "error", "warn"]));
    expect(levels).not.toContain("info");
    expect(levels).not.toContain("debug");
  });

  it("expands `minLevel: 'error'` to only the most severe levels", async () => {
    expect(await capturedLevels({ minLevel: "error" })).toEqual(
      atLeastAsSevereAs("error"),
    );
  });

  it("expands `minLevel: 'debug'` (most verbose) to every level", async () => {
    expect(await capturedLevels({ minLevel: "debug" })).toEqual(ALL_LEVELS);
  });

  // The type constrains callers to LogLevel, but the runtime still lowercases
  // so untyped (JS) callers can pass any casing. The cast below deliberately
  // violates the type to exercise that.
  it("is case-insensitive for `minLevel`", async () => {
    expect(await capturedLevels({ minLevel: "WARN" as LogLevel })).toEqual(
      atLeastAsSevereAs("warn"),
    );
  });

  // ── invalid levels ──────────────────────────────────────────────────────
  // The casts below feed the runtime values the type forbids, standing in for
  // untyped JS callers. Unknown levels must produce an error, not a silent
  // empty/fallback result, and must never reach the database.

  it("returns an error for an unknown `minLevel` without querying", async () => {
    const res = await adapter.query({ minLevel: "bogus" as LogLevel });
    expect(res.ok).toBe(false);
    // Stable message for pattern matching; offending value lives in the cause.
    if (!res.ok) {
      expect(res.err.message).toBe("invalid log level");
      expect(res.err.cause?.message).toContain("bogus");
    }
    expect(queryLogs).not.toHaveBeenCalled();
  });

  it("returns an error for an unknown single `level`", async () => {
    const res = await adapter.query({ level: "trace" as LogLevel });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.err.message).toBe("invalid log level");
      expect(res.err.cause?.message).toContain("trace");
    }
    expect(queryLogs).not.toHaveBeenCalled();
  });

  it("returns an error when any entry in `levels` is unknown", async () => {
    const res = await adapter.query({
      levels: ["info", "nope"] as LogLevel[],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.err.message).toBe("invalid log level");
      expect(res.err.cause?.message).toContain("nope");
    }
    expect(queryLogs).not.toHaveBeenCalled();
  });

  // ── no filter ─────────────────────────────────────────────────────────────

  it("queries every level when no level filter is supplied", async () => {
    expect(await capturedLevels({})).toEqual(ALL_LEVELS);
  });

  // ── purge validation error (stable message + cause) ─────────────────────────

  it("purge() rejects an over-limit request with a matchable message + cause", async () => {
    // The synchronous limit check returns before any DB access.
    const res = await adapter.purge(new Date(), 10_001);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.err.message).toBe("purge limit exceeded");
      expect(res.err.cause?.message).toContain("10001");
    }
  });
});

// ---------------------------------------------------------------------------
// Custom levels must be accounted for in query() — both when supplied via the
// constructor `levels` option and when pushed in later via setLevels() (which
// is how the logger propagates its own custom levels to registered adapters).
// ---------------------------------------------------------------------------

describe("PostgresAdapter.query — custom levels", () => {
  // A custom level a consumer would register at runtime (via the `levels`
  // option / addLevels) and declare type-side by augmenting `LogLevels`. The
  // `as LogLevel` casts below stand in for that augmentation so the strict
  // filter type accepts the name.
  function makeAdapter(opts?: { levels?: Record<string, number> }) {
    const adapter = new PostgresAdapter({ db: {} as never, levels: opts?.levels });
    const queryLogs = vi
      .spyOn(adapter as unknown as { _queryLogs: () => unknown }, "_queryLogs")
      .mockResolvedValue({ ok: true, val: [] });
    return { adapter, queryLogs };
  }

  async function capture(
    adapter: PostgresAdapter,
    queryLogs: ReturnType<typeof vi.spyOn>,
    options: LogQueryOptions,
  ): Promise<string[]> {
    await adapter.query(options);
    const arg = queryLogs.mock.calls.at(-1)?.[0] as { logLevels: string[] };
    return [...arg.logLevels].sort();
  }

  it("includes constructor-supplied custom levels in the default (no-filter) set", async () => {
    const { adapter, queryLogs } = makeAdapter({ levels: { audit: 3, silly: 8 } });
    const levels = await capture(adapter, queryLogs, {});
    expect(levels).toEqual(expect.arrayContaining(["audit", "silly"]));
    await adapter.close();
  });

  it("accepts a custom level as a valid single `level`", async () => {
    const { adapter, queryLogs } = makeAdapter({ levels: { audit: 3 } });
    expect(await capture(adapter, queryLogs, { level: "audit" as LogLevel })).toEqual([
      "audit",
    ]);
    await adapter.close();
  });

  it("expands `minLevel` using the custom level's rank", async () => {
    // audit shares info's rank (3); minLevel:'audit' includes it plus anything
    // at least as severe, and excludes more-verbose built-ins like debug.
    const { adapter, queryLogs } = makeAdapter({ levels: { audit: 3 } });
    const levels = await capture(adapter, queryLogs, { minLevel: "audit" as LogLevel });
    expect(levels).toEqual(expect.arrayContaining(["audit", "info", "warn", "error"]));
    expect(levels).not.toContain("debug");
    await adapter.close();
  });

  it("learns custom levels pushed in later via setLevels() (logger propagation path)", async () => {
    const { adapter, queryLogs } = makeAdapter();
    // Before propagation the level is unknown → rejected without querying.
    const before = await adapter.query({ level: "audit" as LogLevel });
    expect(before.ok).toBe(false);
    expect(queryLogs).not.toHaveBeenCalled();

    adapter.setLevels({ ...LOG_LEVELS, audit: 3 });

    expect(await capture(adapter, queryLogs, { level: "audit" as LogLevel })).toEqual([
      "audit",
    ]);
    await adapter.close();
  });

  it("does not mutate the shared LOG_LEVELS constant", async () => {
    const { adapter } = makeAdapter({ levels: { audit: 3 } });
    adapter.setLevels({ chaos: 9 });
    expect(LOG_LEVELS).not.toHaveProperty("audit");
    expect(LOG_LEVELS).not.toHaveProperty("chaos");
    await adapter.close();
  });
});
