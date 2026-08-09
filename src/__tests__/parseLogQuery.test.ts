import { describe, it, expect } from "vitest";
import { parseLogQuery, formatToken, findContradictions } from "../logger/parseLogQuery";
import type { LogQueryToken } from "../logger/parseLogQuery";

describe("parseLogQuery", () => {
  it("returns [] for empty string", () => {
    expect(parseLogQuery("")).toEqual([]);
    expect(parseLogQuery("   ")).toEqual([]);
  });

  it("treats bare word as message contains", () => {
    expect(parseLogQuery("error")).toEqual([
      { key: "$message", operator: "contains", value: "error" },
    ]);
  });

  it("parses key:'value' as contains", () => {
    expect(parseLogQuery("level:'error'")).toEqual([
      { key: "level", operator: "contains", value: "error" },
    ]);
  });

  it("parses key:\"value\" with double quotes", () => {
    expect(parseLogQuery('level:"error"')).toEqual([
      { key: "level", operator: "contains", value: "error" },
    ]);
  });

  it("parses key:='value' as exact match", () => {
    expect(parseLogQuery("level:='error'")).toEqual([
      { key: "level", operator: "=", value: "error" },
    ]);
  });

  it("parses key:>'value' as greater-than", () => {
    expect(parseLogQuery("count:>'10'")).toEqual([
      { key: "count", operator: ">", value: "10" },
    ]);
  });

  it("parses key:>='value' as >=", () => {
    expect(parseLogQuery("count:>='10'")).toEqual([
      { key: "count", operator: ">=", value: "10" },
    ]);
  });

  it("parses key:<'value' as less-than", () => {
    expect(parseLogQuery("count:<'10'")).toEqual([
      { key: "count", operator: "<", value: "10" },
    ]);
  });

  it("parses key:<='value' as <=", () => {
    expect(parseLogQuery("count:<='10'")).toEqual([
      { key: "count", operator: "<=", value: "10" },
    ]);
  });

  it("parses key:!'value' as negated contains", () => {
    expect(parseLogQuery("level:!'debug'")).toEqual([
      { key: "level", operator: "contains", value: "debug", negated: true },
    ]);
  });

  it("parses key:!='value' as negated exact match", () => {
    expect(parseLogQuery("level:!='debug'")).toEqual([
      { key: "level", operator: "=", value: "debug", negated: true },
    ]);
  });

  it("parses quoted key with spaces", () => {
    expect(parseLogQuery("'request id':'abc-123'")).toEqual([
      { key: "request id", operator: "contains", value: "abc-123" },
    ]);
  });

  it("parses multiple tokens separated by whitespace", () => {
    const result = parseLogQuery("level:'error' message:'login'");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ key: "level", operator: "contains", value: "error" });
    expect(result[1]).toEqual({ key: "message", operator: "contains", value: "login" });
  });

  it("parses bare word mixed with key tokens", () => {
    const result = parseLogQuery("failed level:'error'");
    expect(result[0]).toEqual({ key: "$message", operator: "contains", value: "failed" });
    expect(result[1]).toEqual({ key: "level", operator: "contains", value: "error" });
  });

  it("handles bare value without quotes (lenient)", () => {
    expect(parseLogQuery("level:error")).toEqual([
      { key: "level", operator: "contains", value: "error" },
    ]);
  });

  it("parses bare key:value followed by a bare word", () => {
    const result = parseLogQuery("key:value bareword");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ key: "key", operator: "contains", value: "value" });
    expect(result[1]).toEqual({ key: "$message", operator: "contains", value: "bareword" });
  });

  it("treats double-quoted phrase not followed by ':' as message contains", () => {
    const result = parseLogQuery('"bareword with space" key:value');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ key: "$message", operator: "contains", value: "bareword with space" });
    expect(result[1]).toEqual({ key: "key", operator: "contains", value: "value" });
  });

  it("treats single-quoted word not followed by ':' as message contains", () => {
    const result = parseLogQuery("'bareword' key:value");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ key: "$message", operator: "contains", value: "bareword" });
    expect(result[1]).toEqual({ key: "key", operator: "contains", value: "value" });
  });

  it("parses multiple bare words as separate message contains tokens", () => {
    const result = parseLogQuery("barword barword");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ key: "$message", operator: "contains", value: "barword" });
    expect(result[1]).toEqual({ key: "$message", operator: "contains", value: "barword" });
  });

  it("parses bare word before a key:value pair", () => {
    const result = parseLogQuery("bareword key:value");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ key: "$message", operator: "contains", value: "bareword" });
    expect(result[1]).toEqual({ key: "key", operator: "contains", value: "value" });
  });

  it("treats key: (colon with space before value) as two message contains tokens", () => {
    // 'key:' with no attached value — key becomes a message term, 'value' becomes another
    const result = parseLogQuery("key: value");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ key: "$message", operator: "contains", value: "key" });
    expect(result[1]).toEqual({ key: "$message", operator: "contains", value: "value" });
  });

  it("parses quoted key with bare (unquoted) value", () => {
    const result = parseLogQuery("'quoted key':bare");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: "quoted key", operator: "contains", value: "bare" });
  });
});

describe("parseLogQuery — special characters in keys and values", () => {
  it("parses key containing ':' when quoted with single quotes", () => {
    expect(parseLogQuery("'ns:field':'value'")).toEqual([
      { key: "ns:field", operator: "contains", value: "value" },
    ]);
  });

  it("parses key containing \"'\" when quoted with double quotes", () => {
    expect(parseLogQuery(`"key's":'value'`)).toEqual([
      { key: "key's", operator: "contains", value: "value" },
    ]);
  });

  it("parses key containing '\"' when quoted with single quotes", () => {
    expect(parseLogQuery(`'key"s':'value'`)).toEqual([
      { key: 'key"s', operator: "contains", value: "value" },
    ]);
  });

  it("parses key containing both ':' and \"'\" via double-quoted key", () => {
    expect(parseLogQuery(`"ns:it's":'value'`)).toEqual([
      { key: "ns:it's", operator: "contains", value: "value" },
    ]);
  });

  it("bare key stops at first ':' — 'a:b' reads 'a' as key, 'b' as value", () => {
    expect(parseLogQuery("a:b")).toEqual([
      { key: "a", operator: "contains", value: "b" },
    ]);
  });

  it("parses value containing '\"' inside single-quoted value", () => {
    expect(parseLogQuery(`key:'say "hello"'`)).toEqual([
      { key: "key", operator: "contains", value: 'say "hello"' },
    ]);
  });

  it("parses value containing \"'\" inside double-quoted value", () => {
    expect(parseLogQuery(`key:"it's here"`)).toEqual([
      { key: "key", operator: "contains", value: "it's here" },
    ]);
  });

  it("parses escaped \"'\" inside single-quoted value", () => {
    // The raw query string is:  key:'it\'s'
    expect(parseLogQuery("key:'it\\'s'")).toEqual([
      { key: "key", operator: "contains", value: "it's" },
    ]);
  });

  it("parses value with mixed '\"' and \"'\" (double outer, single inside)", () => {
    expect(parseLogQuery(`key:"she said 'hi'"`)).toEqual([
      { key: "key", operator: "contains", value: "she said 'hi'" },
    ]);
  });

  it("parses value with mixed '\"' and \"'\" (single outer, double inside)", () => {
    expect(parseLogQuery(`key:'she said "hi"'`)).toEqual([
      { key: "key", operator: "contains", value: 'she said "hi"' },
    ]);
  });
});

describe("formatToken", () => {
  it("formats bare message contains without key prefix", () => {
    const t: LogQueryToken = { key: "$message", operator: "contains", value: "error" };
    expect(formatToken(t)).toBe('"error"');
  });

  it("formats key:value pair", () => {
    const t: LogQueryToken = { key: "level", operator: "contains", value: "error" };
    expect(formatToken(t)).toBe("level:'error'");
  });

  it("formats exact match with = operator", () => {
    const t: LogQueryToken = { key: "level", operator: "=", value: "error" };
    expect(formatToken(t)).toBe("level:='error'");
  });

  it("formats negated contains", () => {
    const t: LogQueryToken = { key: "level", operator: "contains", value: "debug", negated: true };
    expect(formatToken(t)).toBe("level:!'debug'");
  });

  it("formats negated exact match", () => {
    const t: LogQueryToken = { key: "level", operator: "=", value: "debug", negated: true };
    expect(formatToken(t)).toBe("level:!='debug'");
  });

  it("quotes key with spaces", () => {
    const t: LogQueryToken = { key: "request id", operator: "contains", value: "abc" };
    expect(formatToken(t)).toBe("'request id':'abc'");
  });

  it("quotes key containing ':' and escapes any \"'\" in it", () => {
    const t: LogQueryToken = { key: "ns:field", operator: "contains", value: "x" };
    expect(formatToken(t)).toBe("'ns:field':'x'");
  });

  it("quotes key containing \"'\" and escapes it", () => {
    const t: LogQueryToken = { key: "key's", operator: "contains", value: "x" };
    expect(formatToken(t)).toBe("'key\\'s':'x'");
  });

  it("quotes key containing '\"'", () => {
    const t: LogQueryToken = { key: 'key"s', operator: "contains", value: "x" };
    expect(formatToken(t)).toBe("'key\"s':'x'");
  });

  it("escapes \"'\" in value", () => {
    const t: LogQueryToken = { key: "msg", operator: "contains", value: "it's" };
    expect(formatToken(t)).toBe("msg:'it\\'s'");
  });

  it("escapes backslash in value", () => {
    const t: LogQueryToken = { key: "path", operator: "contains", value: "C:\\Users" };
    expect(formatToken(t)).toBe("path:'C:\\\\Users'");
  });

  it("round-trips: key with ':' and value with \"'\"", () => {
    const original: LogQueryToken = { key: "ns:field", operator: "contains", value: "it's" };
    const [parsed] = parseLogQuery(formatToken(original));
    expect(parsed).toEqual(original);
  });

  it("round-trips: value with mixed quotes", () => {
    const original: LogQueryToken = { key: "msg", operator: "=", value: `she said "hi" and it's fine` };
    const [parsed] = parseLogQuery(formatToken(original));
    expect(parsed).toEqual(original);
  });
});

describe("findContradictions", () => {
  it("returns empty array when no tokens", () => {
    expect(findContradictions([])).toEqual([]);
  });

  it("returns empty array when no contradictions", () => {
    const tokens = parseLogQuery("level:='error' message:'login'");
    expect(findContradictions(tokens)).toEqual([]);
  });

  it("detects exact match vs negated exact match on same key and value", () => {
    const tokens = parseLogQuery("key:='1' key:!='1'");
    const pairs = findContradictions(tokens);
    expect(pairs).toHaveLength(1);
    expect(pairs[0][0]).toMatchObject({ key: "key", operator: "=", value: "1", negated: undefined });
    expect(pairs[0][1]).toMatchObject({ key: "key", operator: "=", value: "1", negated: true });
  });

  it("detects contains vs negated contains on same key and value", () => {
    const tokens = parseLogQuery("level:'error' level:!'error'");
    const pairs = findContradictions(tokens);
    expect(pairs).toHaveLength(1);
  });

  it("does not flag same key with different values as a contradiction", () => {
    const tokens = parseLogQuery("level:='error' level:!='debug'");
    expect(findContradictions(tokens)).toEqual([]);
  });

  it("does not flag same key and value with different operators as a contradiction", () => {
    // key:='1' and key:!'1' differ in operator (= vs contains) — not a direct contradiction
    const tokens: LogQueryToken[] = [
      { key: "key", operator: "=", value: "1" },
      { key: "key", operator: "contains", value: "1", negated: true },
    ];
    expect(findContradictions(tokens)).toEqual([]);
  });

  // Range contradictions — same value
  it("detects key:>'x' key:<'x' as impossible (same value, both strict)", () => {
    const tokens = parseLogQuery("key:>'1' key:<'1'");
    expect(findContradictions(tokens)).toHaveLength(1);
  });

  it("detects key:>'x' key:<='x' as impossible (strict lower, non-strict upper = same value)", () => {
    const tokens = parseLogQuery("key:>'1' key:<='1'");
    expect(findContradictions(tokens)).toHaveLength(1);
  });

  it("detects key:>='x' key:<'x' as impossible (non-strict lower, strict upper = same value)", () => {
    const tokens = parseLogQuery("key:>='1' key:<'1'");
    expect(findContradictions(tokens)).toHaveLength(1);
  });

  it("does not flag key:>='x' key:<='x' as impossible (val = x satisfies both)", () => {
    const tokens = parseLogQuery("key:>='1' key:<='1'");
    expect(findContradictions(tokens)).toHaveLength(0);
  });

  // Range contradictions — different numeric values
  it("detects key:>'5' key:<'3' as impossible (lower bound > upper bound)", () => {
    const tokens = parseLogQuery("key:>'5' key:<'3'");
    expect(findContradictions(tokens)).toHaveLength(1);
  });

  it("detects key:>='5' key:<='3' as impossible (lower bound > upper bound)", () => {
    const tokens = parseLogQuery("key:>='5' key:<='3'");
    expect(findContradictions(tokens)).toHaveLength(1);
  });

  it("does not flag key:>'3' key:<'5' as impossible (valid range)", () => {
    const tokens = parseLogQuery("key:>'3' key:<'5'");
    expect(findContradictions(tokens)).toHaveLength(0);
  });

  it("does not flag non-numeric, non-date values it cannot compare", () => {
    const tokens = parseLogQuery("key:>'b' key:<'a'");
    expect(findContradictions(tokens)).toHaveLength(0);
  });

  it("does not misidentify hex strings as numeric", () => {
    const tokens: LogQueryToken[] = [
      { key: "k", operator: ">", value: "0x10" },
      { key: "k", operator: "<", value: "0x01" },
    ];
    expect(findContradictions(tokens)).toHaveLength(0);
  });

  it("does not misidentify scientific notation as numeric", () => {
    const tokens: LogQueryToken[] = [
      { key: "k", operator: ">", value: "1e5" },
      { key: "k", operator: "<", value: "1e2" },
    ];
    expect(findContradictions(tokens)).toHaveLength(0);
  });

  it("does not misidentify a bare year like '2024' as a date", () => {
    const tokens: LogQueryToken[] = [
      { key: "k", operator: ">", value: "2024" },
      { key: "k", operator: "<", value: "2023" },
    ];
    // "2024" matches DECIMAL_RE so it is compared numerically, not as a date
    expect(findContradictions(tokens)).toHaveLength(1);
  });

  it("accepts full ISO datetime with timezone offset", () => {
    const tokens: LogQueryToken[] = [
      { key: "k", operator: ">", value: "2024-06-01T00:00:00+05:30" },
      { key: "k", operator: "<", value: "2024-01-01T00:00:00+05:30" },
    ];
    expect(findContradictions(tokens)).toHaveLength(1);
  });

  it("does not treat an ambiguous string parseable by new Date as a date", () => {
    // "January 1, 2024" is accepted by new Date() but not by ISO_DATE_RE
    const tokens: LogQueryToken[] = [
      { key: "k", operator: ">", value: "January 1, 2024" },
      { key: "k", operator: "<", value: "January 1, 2023" },
    ];
    expect(findContradictions(tokens)).toHaveLength(0);
  });

  // Range contradictions — date values
  it("detects date:>='2024-01-15' date:<='2024-01-01' as impossible (lower date > upper date)", () => {
    const tokens = parseLogQuery("date:>='2024-01-15' date:<='2024-01-01'");
    expect(findContradictions(tokens)).toHaveLength(1);
  });

  it("does not flag date:>='2024-01-01' date:<='2024-01-15' as impossible (valid range)", () => {
    const tokens = parseLogQuery("date:>='2024-01-01' date:<='2024-01-15'");
    expect(findContradictions(tokens)).toHaveLength(0);
  });

  it("detects date:>'2024-01-01' date:<'2024-01-01' as impossible (same date, both strict)", () => {
    const tokens = parseLogQuery("date:>'2024-01-01' date:<'2024-01-01'");
    expect(findContradictions(tokens)).toHaveLength(1);
  });

  it("does not flag date:>='2024-01-01' date:<='2024-01-01' as impossible (val = date is valid)", () => {
    const tokens = parseLogQuery("date:>='2024-01-01' date:<='2024-01-01'");
    expect(findContradictions(tokens)).toHaveLength(0);
  });

  it("detects multiple contradicting pairs", () => {
    const tokens: LogQueryToken[] = [
      { key: "a", operator: "=", value: "1" },
      { key: "a", operator: "=", value: "1", negated: true },
      { key: "b", operator: "contains", value: "x" },
      { key: "b", operator: "contains", value: "x", negated: true },
    ];
    expect(findContradictions(tokens)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Nested attribute paths — bare dotted/bracketed keys are paths; quoted keys
// are literal flat names. parseAttrPath is the shared path grammar.
// ---------------------------------------------------------------------------

import { parseAttrPath } from "../logger/parseLogQuery";

describe("path keys and literalKey", () => {
  it("keeps dots and brackets intact in a bare key", () => {
    expect(parseLogQuery("session.id:'123'")[0]).toEqual({
      key: "session.id", operator: "contains", value: "123", negated: undefined,
    });
    expect(parseLogQuery("cart.items[*].sku:='A-1'")[0]).toEqual({
      key: "cart.items[*].sku", operator: "=", value: "A-1", negated: undefined,
    });
  });

  it("flags a quoted key containing path characters as literal", () => {
    expect(parseLogQuery("'session.id':'123'")[0]).toEqual({
      key: "session.id", operator: "contains", value: "123",
      negated: undefined, literalKey: true,
    });
    expect(parseLogQuery("'users[*]':='x'")[0]).toEqual({
      key: "users[*]", operator: "=", value: "x", negated: undefined, literalKey: true,
    });
  });

  it("does not flag a quoted key without path characters", () => {
    // Shape stability: existing quoted-key queries keep their exact token shape.
    expect(parseLogQuery("'some key':'v'")[0]).toEqual({
      key: "some key", operator: "contains", value: "v", negated: undefined,
    });
  });

  it("formatToken leaves a path key bare and re-quotes a literal key", () => {
    expect(formatToken({ key: "session.id", operator: "=", value: "123" }))
      .toBe("session.id:='123'");
    expect(formatToken({ key: "session.id", operator: "=", value: "123", literalKey: true }))
      .toBe("'session.id':='123'");
  });

  it("round-trips a literal key through format → parse", () => {
    const token = parseLogQuery("'a.b':='x'")[0];
    expect(parseLogQuery(formatToken(token))[0]).toEqual(token);
  });
});

describe("parseAttrPath", () => {
  it("returns null for keys without path syntax", () => {
    expect(parseAttrPath("session")).toBeNull();
    expect(parseAttrPath("$level")).toBeNull();
    expect(parseAttrPath("user_name")).toBeNull();
  });

  it("parses member paths", () => {
    expect(parseAttrPath("session.id")).toEqual({
      base: "session",
      segments: [{ type: "member", name: "id" }],
    });
    expect(parseAttrPath("a.b.c")).toEqual({
      base: "a",
      segments: [{ type: "member", name: "b" }, { type: "member", name: "c" }],
    });
  });

  it("parses index and wildcard segments", () => {
    expect(parseAttrPath("users[*]")).toEqual({
      base: "users", segments: [{ type: "wildcard" }],
    });
    expect(parseAttrPath("users[0]")).toEqual({
      base: "users", segments: [{ type: "index", index: 0 }],
    });
    expect(parseAttrPath("users[12]")).toEqual({
      base: "users", segments: [{ type: "index", index: 12 }],
    });
  });

  it("parses combined paths", () => {
    expect(parseAttrPath("cart.items[*].sku")).toEqual({
      base: "cart",
      segments: [
        { type: "member", name: "items" },
        { type: "wildcard" },
        { type: "member", name: "sku" },
      ],
    });
    expect(parseAttrPath("m[0][1]")).toEqual({
      base: "m",
      segments: [{ type: "index", index: 0 }, { type: "index", index: 1 }],
    });
  });

  it("returns null for malformed paths (treated as flat keys)", () => {
    for (const bad of ["a[", "a[]", "a[x]", "a[1.2]", "a..b", ".a", "a.", "a[*]b", "a[-1]"]) {
      expect(parseAttrPath(bad), bad).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Null literals — bare `null`/`NULL` with = / contains means the null literal;
// quoted 'null' is the string.
// ---------------------------------------------------------------------------

describe("null literals", () => {
  it("flags a bare null value on = and contains", () => {
    expect(parseLogQuery("reason:=null")[0]).toEqual({
      key: "reason", operator: "=", value: "null", negated: undefined, nullValue: true,
    });
    expect(parseLogQuery("reason:=NULL")[0]).toEqual({
      key: "reason", operator: "=", value: "null", negated: undefined, nullValue: true,
    });
    expect(parseLogQuery("reason:null")[0]).toEqual({
      key: "reason", operator: "contains", value: "null", negated: undefined, nullValue: true,
    });
  });

  it("keeps negation", () => {
    expect(parseLogQuery("reason:!=null")[0]).toEqual({
      key: "reason", operator: "=", value: "null", negated: true, nullValue: true,
    });
    expect(parseLogQuery("reason:!null")[0]).toEqual({
      key: "reason", operator: "contains", value: "null", negated: true, nullValue: true,
    });
  });

  it("treats a QUOTED 'null' as the plain string", () => {
    expect(parseLogQuery("reason:='null'")[0]).toEqual({
      key: "reason", operator: "=", value: "null", negated: undefined,
    });
  });

  it("tags a bare null on range operators too (the expr parser rejects those)", () => {
    // The flat tokenizer has no error channel, so it tags the token; the
    // ordered form is rejected as a syntax error by parseLogQueryExpr.
    expect(parseLogQuery("reason:>null")[0]).toEqual({
      key: "reason", operator: ">", value: "null", negated: undefined, nullValue: true,
    });
    // Quoted 'null' keeps string-comparison semantics on every operator.
    expect(parseLogQuery("reason:>'null'")[0]).toEqual({
      key: "reason", operator: ">", value: "null", negated: undefined,
    });
  });

  it("formatToken renders a null literal unquoted and the string quoted", () => {
    expect(formatToken({ key: "reason", operator: "=", value: "null", nullValue: true }))
      .toBe("reason:=null");
    expect(formatToken({ key: "reason", operator: "=", value: "null", negated: true, nullValue: true }))
      .toBe("reason:!=null");
    expect(formatToken({ key: "reason", operator: "contains", value: "null", nullValue: true }))
      .toBe("reason:null");
    expect(formatToken({ key: "reason", operator: "=", value: "null" }))
      .toBe("reason:='null'");
  });

  it("round-trips both forms", () => {
    for (const q of ["reason:=null", "reason:!=null", "reason:null", "reason:='null'"]) {
      const token = parseLogQuery(q)[0];
      expect(parseLogQuery(formatToken(token))[0], q).toEqual(token);
    }
  });
});

// ---------------------------------------------------------------------------
// ::string cast — forces lexicographic comparison. Only valid after a QUOTED
// value: key:>'value'::string.
// ---------------------------------------------------------------------------

describe("::string value cast", () => {
  it("parses the cast after a single- or double-quoted value", () => {
    expect(parseLogQuery("count:>'100'::string")[0]).toEqual({
      key: "count", operator: ">", value: "100", negated: undefined, cast: "string",
    });
    expect(parseLogQuery('count:<="9"::string')[0]).toEqual({
      key: "count", operator: "<=", value: "9", negated: undefined, cast: "string",
    });
  });

  it("applies to equality and contains too (harmless no-op)", () => {
    expect(parseLogQuery("k:='v'::string")[0]).toEqual({
      key: "k", operator: "=", value: "v", negated: undefined, cast: "string",
    });
  });

  it("does not treat ::string in a BARE value as a cast", () => {
    expect(parseLogQuery("k:>abc::string")[0]).toEqual({
      key: "k", operator: ">", value: "abc::string", negated: undefined,
    });
  });

  it("does not consume a near-miss suffix", () => {
    // 'v'::stringify → the cast does not match; the token carries no cast and
    // the suffix is left for the (pre-existing) trailing-junk tokenization.
    const tokens = parseLogQuery("k:>'v'::stringify");
    expect(tokens[0]).toEqual({ key: "k", operator: ">", value: "v", negated: undefined });
    expect(tokens[0]).not.toHaveProperty("cast");
    expect(tokens.length).toBeGreaterThan(1); // suffix did not vanish into the value
  });

  it("formatToken renders and round-trips the cast", () => {
    expect(formatToken({ key: "count", operator: ">", value: "100", cast: "string" }))
      .toBe("count:>'100'::string");
    const token = parseLogQuery("count:>'100'::string")[0];
    expect(parseLogQuery(formatToken(token))[0]).toEqual(token);
  });
});

// ---------------------------------------------------------------------------
// Regressions found by fuzzing (src/__tests__/fuzz.test.ts) — format→parse
// asymmetries. Each fails on the pre-fix parser/formatter.
// ---------------------------------------------------------------------------

describe("formatToken / parse symmetry (fuzz regressions)", () => {
  it("parses negated comparison operators (!<, !>, !<=, !>=)", () => {
    expect(parseLogQuery("k:!<'5'")[0]).toEqual({ key: "k", operator: "<", value: "5", negated: true });
    expect(parseLogQuery("k:!>='5'")[0]).toEqual({ key: "k", operator: ">=", value: "5", negated: true });
    // …and round-trips a negated-comparison token that formatToken emits.
    for (const op of ["<", ">", "<=", ">="] as const) {
      const token = { key: "k", operator: op, value: "5", negated: true };
      expect(parseLogQuery(formatToken(token))[0]).toEqual(token);
    }
  });

  it("escapes backslash and quote in a bare $message value", () => {
    for (const value of [">,13\\", 'has"quote', "back\\slash", 'both"\\here']) {
      const token = { key: "$message", operator: "contains" as const, value };
      expect(parseLogQuery(formatToken(token))[0].value).toBe(value);
    }
  });

  it("escapes backslash in a quoted key", () => {
    const token = { key: "weird\\key", operator: "contains" as const, value: "v" };
    expect(parseLogQuery(formatToken(token))[0].key).toBe("weird\\key");
  });

  it("only flags literalKey for a quoted key that is a valid path", () => {
    // A quoted key that isn't a valid path carries no inert flag.
    expect(parseLogQuery("',a.':'v'")[0]).not.toHaveProperty("literalKey");
    // A quoted valid path IS flagged literal.
    expect(parseLogQuery("'a.b':'v'")[0]).toMatchObject({ literalKey: true });
  });
});

describe("parseAttrPath — operator-laden segments are not paths", () => {
  it("treats identifier segments as paths (letters, digits, _, -, $, @, /)", () => {
    for (const key of ["session.id", "a.b.c", "user-agent.v", "$meta.x", "a.b/c", "x@y.z"]) {
      expect(parseAttrPath(key), key).not.toBeNull();
    }
    expect(parseAttrPath("users[*].sku")).not.toBeNull();
  });

  it("rejects segments containing grammar-operator characters → flat key", () => {
    // A property CAN be named "|=" in JSON, but the unquoted path grammar
    // rejects operator characters — the key is treated as a flat name.
    for (const key of ["c1.|=", "a.b<c", "a.b=c", "a.b!c", "a.b|c", "a.b&c", "a.b'c", 'a.b"c', "a.b\\c"]) {
      expect(parseAttrPath(key), key).toBeNull();
    }
  });

  it("operator-laden keys round-trip as flat names", () => {
    for (const key of ["c1.|=", "a.b<c", "weird=key"]) {
      const token = parseLogQuery(formatToken({ key, operator: "=", value: "v" }))[0];
      expect(token.key).toBe(key);
      expect(token).not.toHaveProperty("literalKey"); // flat, not a path
    }
  });
});
