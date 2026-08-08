import { describe, it, expect, vi } from "vitest";
import { where, literal } from "../logger/query-builder";
import {
  parseLogQueryExpr,
  formatExpr,
  type FilterExpr,
  type LogQueryToken,
  type LogQueryOperator,
} from "../logger/parseLogQuery";
import type { LogQueryOptions, LogRow, QueryableLogAdapter } from "../logger/adapter";
import { createLogger } from "../logger/logger";

// Normal-form helpers mirroring parseLogQueryExpr.test.ts.
function f(
  key: string,
  operator: LogQueryOperator,
  value: string,
  extra?: Partial<LogQueryToken>,
): FilterExpr {
  return { type: "filter", filter: { key, operator, value, ...extra } };
}
const and = (...nodes: FilterExpr[]): FilterExpr => ({ type: "and", nodes });
const or = (...nodes: FilterExpr[]): FilterExpr => ({ type: "or", nodes });
const q = (...terms: FilterExpr[]): FilterExpr => and(...terms.map((t) => or(t)));

describe("where() — operators and value coercion", () => {
  it("maps each operator to the right token", () => {
    expect(where("k").eq("v").build()).toEqual(q(f("k", "=", "v")));
    expect(where("k").notEq("v").build()).toEqual(q(f("k", "=", "v", { negated: true })));
    expect(where("k").contains("v").build()).toEqual(q(f("k", "contains", "v")));
    expect(where("k").notContains("v").build()).toEqual(
      q(f("k", "contains", "v", { negated: true })),
    );
    expect(where("k").gt(1).build()).toEqual(q(f("k", ">", "1")));
    expect(where("k").gte(1).build()).toEqual(q(f("k", ">=", "1")));
    expect(where("k").lt(1).build()).toEqual(q(f("k", "<", "1")));
    expect(where("k").lte(1).build()).toEqual(q(f("k", "<=", "1")));
  });

  it("coerces numbers, booleans, and Dates", () => {
    expect(where("n").eq(42).build()).toEqual(q(f("n", "=", "42")));
    expect(where("b").eq(true).build()).toEqual(q(f("b", "=", "true")));
    const d = new Date("2026-01-02T03:04:05.000Z");
    expect(where("t").gt(d).build()).toEqual(q(f("t", ">", "2026-01-02T03:04:05.000Z")));
  });

  it("isNull / isNotNull produce null-literal tokens", () => {
    expect(where("reason").isNull().build()).toEqual(
      q(f("reason", "=", "null", { nullValue: true })),
    );
    expect(where("reason").isNotNull().build()).toEqual(
      q(f("reason", "=", "null", { nullValue: true, negated: true })),
    );
  });

  it("literal() marks the key as a flat name", () => {
    expect(literal("a.b").eq("x").build()).toEqual(
      q(f("a.b", "=", "x", { literalKey: true })),
    );
  });
});

describe("and / or combination", () => {
  it("combines left-to-right: X.and(Y).or(Z) = (X AND Y) OR Z", () => {
    const x = where("a").eq("1");
    const built = x.and(where("b").eq("2")).or(where("c").eq("3")).build();
    expect(built).toEqual(
      and(
        or(
          and(or(f("a", "=", "1")), or(f("b", "=", "2"))),
          f("c", "=", "3"),
        ),
      ),
    );
  });

  it("flattens chained ANDs into the normal form", () => {
    const built = where("a").eq("1").and(where("b").eq("2")).and(where("c").eq("3")).build();
    expect(built).toEqual(q(f("a", "=", "1"), f("b", "=", "2"), f("c", "=", "3")));
  });

  it("flattens chained ORs", () => {
    const built = where("a").eq("1").or(where("b").eq("2")).or(where("c").eq("3")).build();
    expect(built).toEqual(
      and(or(f("a", "=", "1"), f("b", "=", "2"), f("c", "=", "3"))),
    );
  });

  it("accepts a raw FilterExpr as an operand", () => {
    const raw: FilterExpr = { type: "filter", filter: { key: "x", operator: "=", value: "9" } };
    expect(where("a").eq("1").and(raw).build()).toEqual(
      q(f("a", "=", "1"), f("x", "=", "9")),
    );
  });

  it("is immutable — combining does not mutate the receiver", () => {
    const base = where("a").eq("1");
    base.and(where("b").eq("2"));
    expect(base.build()).toEqual(q(f("a", "=", "1")));
  });
});

describe("round-trip invariant", () => {
  it("parse(format(build())) deep-equals build() for a mixed tree", () => {
    const b = where("session.id")
      .eq("123")
      .and(where("users[*]").eq("123"))
      .and(literal("a.b").contains("x"))
      .or(where("$level").eq("error"))
      .and(where("reason").isNull());
    const built = b.build();
    const reparsed = parseLogQueryExpr(formatExpr(built));
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) expect(reparsed.val).toEqual(built);
  });

  it("toQueryString() emits the formatted expression", () => {
    const b = where("a").eq("1").or(where("b").eq("2"));
    expect(b.toQueryString()).toBe(formatExpr(b.build()));
  });
});

describe("fail-fast validation", () => {
  it("throws on an unparseable $timestamp value", () => {
    expect(() => where("$timestamp").eq("garbage")).toThrowError(TypeError);
    expect(() => where("$timestamp").gt("not-a-date")).toThrowError(TypeError);
    expect(() => where("$timestamp").gt("2026-01-01")).not.toThrow();
    expect(() => where("$timestamp").lte(new Date())).not.toThrow();
  });

  it("throws on malformed bracket paths", () => {
    expect(() => where("users[*")).toThrowError(TypeError);
    expect(() => where("a..b")).toThrowError(TypeError);
    expect(() => where("a[x]")).toThrowError(TypeError);
    // fine as flat keys / valid paths
    expect(() => where("plain")).not.toThrow();
    expect(() => where("users[*]")).not.toThrow();
    // literal() accepts anything — it IS the escape hatch
    expect(() => literal("users[*")).not.toThrow();
  });
});

describe("execute()", () => {
  function stubAdapter(rows: LogRow[] = []): QueryableLogAdapter & { calls: LogQueryOptions[] } {
    const calls: LogQueryOptions[] = [];
    return {
      calls,
      write: vi.fn(),
      query: vi.fn(async (opts: LogQueryOptions) => {
        calls.push(opts);
        return { ok: true as const, val: rows };
      }),
      purge: vi.fn(async () => ({ ok: true as const, val: 0 })),
    };
  }

  it("queries a QueryableLogAdapter directly, merging options", async () => {
    const adapter = stubAdapter();
    const b = where("a").eq("1");
    const res = await b.execute(adapter, { limit: 50, sort: "asc" });
    expect(res.ok).toBe(true);
    expect(adapter.calls[0]).toEqual({
      limit: 50,
      sort: "asc",
      attributeFilter: b.build(),
    });
  });

  it("routes through logger.queryAdapter()", async () => {
    const adapter = stubAdapter();
    const logger = createLogger();
    logger.addAdapter(adapter);
    const res = await where("a").eq("1").execute(logger);
    expect(res.ok).toBe(true);
    expect(adapter.calls).toHaveLength(1);
  });

  it("returns an err Result when the logger has no queryable adapter", async () => {
    const logger = createLogger();
    const res = await where("a").eq("1").execute(logger);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.err.message).toBe("failed to query");
  });
});
