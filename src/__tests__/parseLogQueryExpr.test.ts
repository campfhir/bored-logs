import { describe, it, expect } from "vitest";
import { parseLogQueryExpr, formatExpr, QUERY_SYNTAX_ERROR } from "../logger/parseLogQuery";
import type { FilterExpr, LogQueryOperator } from "../logger/parseLogQuery";

/** Unwrap the Result for happy-path assertions; throw on a syntax error. */
function parse(s: string): FilterExpr | null {
  const r = parseLogQueryExpr(s);
  if (!r.ok) throw r.err;
  return r.val;
}

// ---------------------------------------------------------------------------
// Normal form: the (non-null) root is ALWAYS an `and` node whose children are
// ALWAYS `or` nodes. An `or`'s children are `filter` leaves, or a nested `and`
// when a parenthesized group holds a genuine conjunction used as an OR operand.
// `||` binds tighter than whitespace-AND, so `a b || c` == `a AND (b OR c)`.
// Redundant pure-OR parens dissolve.
//
// Builders below construct that shape so the expected trees stay readable.
// `f` omits `negated` when falsy to match the parser's token shape.
// ---------------------------------------------------------------------------

function f(
  key: string,
  operator: LogQueryOperator,
  value: string,
  negated?: boolean,
): FilterExpr {
  const filter = negated ? { key, operator, value, negated } : { key, operator, value };
  return { type: "filter", filter };
}
const msg = (value: string, negated?: boolean): FilterExpr =>
  f("message", "contains", value, negated);
const and = (...nodes: FilterExpr[]): FilterExpr => ({ type: "and", nodes });
const or = (...nodes: FilterExpr[]): FilterExpr => ({ type: "or", nodes });
/** Convenience for a pure-AND query: and[ or[t1], or[t2], ... ]. */
const q = (...terms: FilterExpr[]): FilterExpr => and(...terms.map((t) => or(t)));

describe("parseLogQueryExpr — Result shape", () => {
  it("returns { ok: true, val } for a valid query", () => {
    expect(parseLogQueryExpr("level:'error'")).toEqual({
      ok: true,
      val: q(f("level", "contains", "error")),
    });
  });

  it("returns { ok: true, val: null } for empty input", () => {
    expect(parseLogQueryExpr("")).toEqual({ ok: true, val: null });
  });

  it("returns { ok: false } with the syntax-error message for a bad query", () => {
    const r = parseLogQueryExpr("a:'1' ||");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err.message).toBe(QUERY_SYNTAX_ERROR);
  });
});

describe("parseLogQueryExpr — empty / trivial", () => {
  it("returns null for empty string", () => {
    expect(parse("")).toBeNull();
    expect(parse("   ")).toBeNull();
  });

  it("wraps a single term as and[ or[ filter ] ]", () => {
    expect(parse("level:'error'")).toEqual(q(f("level", "contains", "error")));
  });

  it("wraps a single bare word as and[ or[ message ] ]", () => {
    expect(parse("boom")).toEqual(q(msg("boom")));
  });

  it("root is always and, second level always or", () => {
    const root = parse("level:'error'");
    expect(root?.type).toBe("and");
    expect(root?.type === "and" && root.nodes[0].type).toBe("or");
  });
});

describe("parseLogQueryExpr — AND (whitespace)", () => {
  it("collects space-separated terms into one and branch of ors", () => {
    expect(parse("level:'error' message:'login'")).toEqual(
      q(f("level", "contains", "error"), f("message", "contains", "login")),
    );
  });

  it("collects 3+ space-separated terms", () => {
    expect(parse("a:'1' b:'2' c:'3'")).toEqual(
      q(f("a", "contains", "1"), f("b", "contains", "2"), f("c", "contains", "3")),
    );
  });

  it("mixes bare words and key:value terms", () => {
    expect(parse("failed level:'error'")).toEqual(
      q(msg("failed"), f("level", "contains", "error")),
    );
  });
});

describe("parseLogQueryExpr — OR", () => {
  it("joins two terms with || into one or", () => {
    expect(parse("level:'error' || level:'warn'")).toEqual(
      and(or(f("level", "contains", "error"), f("level", "contains", "warn"))),
    );
  });

  it("joins 3+ ||-operands into one or", () => {
    expect(parse("a:'1' || b:'2' || c:'3'")).toEqual(
      and(or(f("a", "contains", "1"), f("b", "contains", "2"), f("c", "contains", "3"))),
    );
  });

  it("ORs bare message words", () => {
    expect(parse("error || warn")).toEqual(and(or(msg("error"), msg("warn"))));
  });
});

describe("parseLogQueryExpr — explicit && AND", () => {
  it("treats && as equivalent to whitespace", () => {
    expect(parse("a:'1' && b:'2'")).toEqual(parse("a:'1' b:'2'"));
    expect(parse("a:'1' && b:'2'")).toEqual(
      q(f("a", "contains", "1"), f("b", "contains", "2")),
    );
  });

  it("mixes && and whitespace as AND", () => {
    expect(parse("a:'1' b:'2' && c:'3'")).toEqual(
      q(f("a", "contains", "1"), f("b", "contains", "2"), f("c", "contains", "3")),
    );
  });

  it("keeps || binding tighter than &&: a && b || c → a AND (b OR c)", () => {
    expect(parse("a:'1' && b:'2' || c:'3'")).toEqual(
      and(or(f("a", "contains", "1")), or(f("b", "contains", "2"), f("c", "contains", "3"))),
    );
  });

  it("a || b && c → (a OR b) AND c", () => {
    expect(parse("a:'1' || b:'2' && c:'3'")).toEqual(
      and(or(f("a", "contains", "1"), f("b", "contains", "2")), or(f("c", "contains", "3"))),
    );
  });

  it("treats && without surrounding whitespace as literal bare text", () => {
    expect(parse("a&&b")).toEqual(q(msg("a&&b")));
  });

  it("treats && inside a quoted value as literal text", () => {
    expect(parse("msg:'a && b'")).toEqual(q(f("msg", "contains", "a && b")));
  });

});

describe("parseLogQueryExpr — precedence (OR binds tighter than AND)", () => {
  it("a b || c  →  and[ a, (b OR c) ]", () => {
    // The example from review: `key1 key2 || key3` == `key1 AND (key2 OR key3)`
    expect(parse("a:'1' b:'2' || c:'3'")).toEqual(
      and(or(f("a", "contains", "1")), or(f("b", "contains", "2"), f("c", "contains", "3"))),
    );
  });

  it("a || b c  →  and[ (a OR b), c ]", () => {
    expect(parse("a:'1' || b:'2' c:'3'")).toEqual(
      and(or(f("a", "contains", "1"), f("b", "contains", "2")), or(f("c", "contains", "3"))),
    );
  });

  it("a b || c d  →  and[ a, (b OR c), d ]", () => {
    expect(parse("a:'1' b:'2' || c:'3' d:'4'")).toEqual(
      and(
        or(f("a", "contains", "1")),
        or(f("b", "contains", "2"), f("c", "contains", "3")),
        or(f("d", "contains", "4")),
      ),
    );
  });
});

describe("parseLogQueryExpr — grouping with ()", () => {
  it("collapses a redundant single-term group", () => {
    expect(parse("(level:'error')")).toEqual(q(f("level", "contains", "error")));
  });

  it("dissolves a redundant pure-OR group (parens add nothing)", () => {
    // a (b || c)  ≡  a b || c  ≡  a AND (b OR c)
    expect(parse("a:'1' (b:'2' || c:'3')")).toEqual(
      and(or(f("a", "contains", "1")), or(f("b", "contains", "2"), f("c", "contains", "3"))),
    );
  });

  it("dissolves a redundant pure-AND group in AND context", () => {
    // a (b c)  ≡  a AND b AND c
    expect(parse("a:'1' (b:'2' c:'3')")).toEqual(
      q(f("a", "contains", "1"), f("b", "contains", "2"), f("c", "contains", "3")),
    );
  });

  it("keeps a grouped AND used as an OR operand", () => {
    // (a b) || c  →  and[ or[ and[a,b], c ] ]
    expect(parse("(a:'1' b:'2') || c:'3'")).toEqual(
      and(
        or(
          and(or(f("a", "contains", "1")), or(f("b", "contains", "2"))),
          f("c", "contains", "3"),
        ),
      ),
    );
  });

  it("supports nested groups", () => {
    // (a || (b c)) d  →  and[ (a OR (b AND c)), d ]
    expect(parse("(a:'1' || (b:'2' c:'3')) d:'4'")).toEqual(
      and(
        or(
          f("a", "contains", "1"),
          and(or(f("b", "contains", "2")), or(f("c", "contains", "3"))),
        ),
        or(f("d", "contains", "4")),
      ),
    );
  });
});

describe("parseLogQueryExpr — operators & negation carry through", () => {
  it("preserves comparison operators inside an OR", () => {
    expect(parse("count:>'10' || count:<='2'")).toEqual(
      and(or(f("count", ">", "10"), f("count", "<=", "2"))),
    );
  });

  it("preserves negation inside branches", () => {
    expect(parse("level:!'debug' || level:!='trace'")).toEqual(
      and(or(f("level", "contains", "debug", true), f("level", "=", "trace", true))),
    );
  });
});

describe("parseLogQueryExpr — || and () are structural only at term boundaries", () => {
  it("treats || inside a quoted value as literal text", () => {
    expect(parse("msg:'a||b'")).toEqual(q(f("msg", "contains", "a||b")));
  });

  it("treats parens inside a quoted value as literal text", () => {
    expect(parse("msg:'(hi)'")).toEqual(q(f("msg", "contains", "(hi)")));
  });

  it("treats mid-word parens in a bare term as literal text", () => {
    expect(parse("render(x)")).toEqual(q(msg("render(x)")));
  });

  it("treats || without surrounding whitespace as literal bare text", () => {
    expect(parse("a||b")).toEqual(q(msg("a||b")));
  });
});

describe("parseLogQueryExpr — operator syntax errors", () => {
  const bad = [
    "|| a:'1'", // leading ||
    "a:'1' ||", // trailing ||
    "a:'1' || || b:'2'", // doubled ||
    "||",
    "&& a:'1'", // leading &&
    "a:'1' &&", // trailing &&
    "a:'1' && && b:'2'", // doubled &&
    "&&",
    "a:'1' || && b:'2'", // || immediately followed by &&
    "a:'1' && || b:'2'", // && immediately followed by ||
    "(a:'1' ||)", // trailing || inside a group
    "()", // empty group
    "(   )", // whitespace-only group
    "a:'1' ()", // empty group as a term
    "(())", // nested empty group
    "(a:'1' b:'2'", // unclosed group
    "(", // lone open paren
    "a:'1' (b:'2'", // unclosed nested group
  ];
  for (const query of bad) {
    it(`rejects ${JSON.stringify(query)}`, () => {
      const r = parseLogQueryExpr(query);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.err.message).toBe(QUERY_SYNTAX_ERROR);
        expect(r.err.cause).toBeDefined(); // detail on the offending operator/group
      }
    });
  }
});

describe("formatExpr", () => {
  it("formats a single filter with no wrappers", () => {
    expect(formatExpr(q(f("level", "contains", "error")))).toBe("level:'error'");
  });

  it("formats a bare message term without a key prefix", () => {
    expect(formatExpr(q(msg("boom")))).toBe('"boom"');
  });

  it("space-joins an AND of terms", () => {
    expect(formatExpr(q(f("a", "contains", "1"), f("b", "contains", "2")))).toBe(
      "a:'1' b:'2'",
    );
  });

  it("joins OR terms with ||", () => {
    expect(
      formatExpr(and(or(f("level", "contains", "error"), f("level", "contains", "warn")))),
    ).toBe("level:'error' || level:'warn'");
  });

  it("parenthesizes an AND nested inside an OR", () => {
    const tree = parse("(a:'1' b:'2') || c:'3'")!;
    expect(formatExpr(tree)).toBe("(a:'1' b:'2') || c:'3'");
  });

  it("does not parenthesize an OR nested inside an AND", () => {
    const tree = parse("a:'1' (b:'2' || c:'3')")!;
    expect(formatExpr(tree)).toBe("a:'1' b:'2' || c:'3'");
  });

  describe("round-trips through parseLogQueryExpr", () => {
    const cases = [
      "level:'error'",
      "a:'1' b:'2'",
      "a:'1' && b:'2'",
      "level:'error' || level:'warn'",
      "a:'1' b:'2' || c:'3'",
      "a:'1' || b:'2' c:'3'",
      "(a:'1' b:'2') || c:'3'",
      "(a:'1' || (b:'2' c:'3')) d:'4'",
      "count:>'10' || count:<='2'",
      "level:!'debug' || level:!='trace'",
      "msg:'it\\'s here'",
    ];
    for (const query of cases) {
      it(query, () => {
        const tree = parse(query)!;
        expect(parse(formatExpr(tree))).toEqual(tree);
      });
    }
  });
});
