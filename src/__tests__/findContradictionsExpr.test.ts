import { describe, it, expect } from "vitest";
import {
  parseLogQueryExpr,
  findContradictions,
  isUnsatisfiable,
} from "../logger/parseLogQuery";
import type { FilterExpr } from "../logger/parseLogQuery";

/** Parse to a tree, throwing on syntax error (all queries here are valid). */
function tree(s: string): FilterExpr {
  const r = parseLogQueryExpr(s);
  if (!r.ok) throw r.err;
  if (!r.val) throw new Error(`query reduced to null: ${s}`);
  return r.val;
}

// ---------------------------------------------------------------------------
// Tree-aware findContradictions.
//
// A contradiction is a pair of tokens forced to hold *simultaneously* yet
// unsatisfiable. Under OR, the two operands are alternatives, so a
// contradiction in one branch does not contradict the other. We reason over
// the DNF: each conjunctive path is checked independently.
//
//   - findContradictions(tree): every dead-branch pair (deduped).
//   - isUnsatisfiable(tree):    true iff EVERY path is dead (zero rows).
// ---------------------------------------------------------------------------

describe("findContradictions — FilterExpr trees", () => {
  it("accepts a null tree and returns no pairs", () => {
    expect(findContradictions(null)).toEqual([]);
  });

  it("flags a contradiction inside a pure-AND tree (same as flat)", () => {
    expect(findContradictions(tree("a:='1' a:!='1'"))).toHaveLength(1);
  });

  it("does NOT flag a thing OR its negation — OR branches are alternatives", () => {
    // a:='1' || a:!='1' matches everything; the operands never co-occur.
    expect(findContradictions(tree("a:='1' || a:!='1'"))).toEqual([]);
  });

  it("flags a dead OR branch: a>5 AND (a<3 OR x) kills the a<3 branch", () => {
    const pairs = findContradictions(tree("a:>'5' (a:<'3' || x:'y')"));
    expect(pairs).toHaveLength(1);
    expect(pairs[0][0]).toMatchObject({ key: "a", operator: ">", value: "5" });
    expect(pairs[0][1]).toMatchObject({ key: "a", operator: "<", value: "3" });
  });

  it("finds a contradiction in each OR branch", () => {
    // (a>5 a<3) || (b=1 b!=1) — both grouped conjunctions are impossible.
    expect(findContradictions(tree("(a:>'5' a:<'3') || (b:='1' b:!='1')"))).toHaveLength(2);
  });

  it("does not duplicate a pair shared across cartesian-expanded paths", () => {
    // a>5 a<3 appears in both x and y paths; report the pair once.
    expect(findContradictions(tree("a:>'5' a:<'3' (x:'1' || y:'2')"))).toHaveLength(1);
  });

  it("does not flag alternatives across different OR branches", () => {
    // a>5 and a<3 are in separate OR operands — never simultaneous.
    expect(findContradictions(tree("a:>'5' || a:<'3'"))).toEqual([]);
  });

  it("still accepts a flat LogQueryToken[] (back-compat)", () => {
    expect(
      findContradictions([
        { key: "a", operator: "=", value: "1" },
        { key: "a", operator: "=", value: "1", negated: true },
      ]),
    ).toHaveLength(1);
  });
});

describe("isUnsatisfiable", () => {
  it("is false for null / empty", () => {
    expect(isUnsatisfiable(null)).toBe(false);
  });

  it("is false for a satisfiable query", () => {
    expect(isUnsatisfiable(tree("a:'1' b:'2'"))).toBe(false);
  });

  it("is true when the single AND path contradicts", () => {
    expect(isUnsatisfiable(tree("a:='1' a:!='1'"))).toBe(true);
  });

  it("is false when only one OR branch is dead", () => {
    // The a<3 branch dies but the x branch survives.
    expect(isUnsatisfiable(tree("a:>'5' (a:<'3' || x:'y')"))).toBe(false);
  });

  it("is true when every OR branch is dead", () => {
    expect(isUnsatisfiable(tree("(a:>'5' a:<'3') || (b:='1' b:!='1')"))).toBe(true);
  });

  it("is false for a thing OR its negation", () => {
    expect(isUnsatisfiable(tree("a:='1' || a:!='1'"))).toBe(false);
  });
});
