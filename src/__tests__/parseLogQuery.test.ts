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
      { key: "message", operator: "contains", value: "error" },
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
    expect(result[0]).toEqual({ key: "message", operator: "contains", value: "failed" });
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
    expect(result[1]).toEqual({ key: "message", operator: "contains", value: "bareword" });
  });

  it("treats double-quoted phrase not followed by ':' as message contains", () => {
    const result = parseLogQuery('"bareword with space" key:value');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ key: "message", operator: "contains", value: "bareword with space" });
    expect(result[1]).toEqual({ key: "key", operator: "contains", value: "value" });
  });

  it("treats single-quoted word not followed by ':' as message contains", () => {
    const result = parseLogQuery("'bareword' key:value");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ key: "message", operator: "contains", value: "bareword" });
    expect(result[1]).toEqual({ key: "key", operator: "contains", value: "value" });
  });

  it("parses multiple bare words as separate message contains tokens", () => {
    const result = parseLogQuery("barword barword");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ key: "message", operator: "contains", value: "barword" });
    expect(result[1]).toEqual({ key: "message", operator: "contains", value: "barword" });
  });

  it("parses bare word before a key:value pair", () => {
    const result = parseLogQuery("bareword key:value");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ key: "message", operator: "contains", value: "bareword" });
    expect(result[1]).toEqual({ key: "key", operator: "contains", value: "value" });
  });

  it("treats key: (colon with space before value) as two message contains tokens", () => {
    // 'key:' with no attached value — key becomes a message term, 'value' becomes another
    const result = parseLogQuery("key: value");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ key: "message", operator: "contains", value: "key" });
    expect(result[1]).toEqual({ key: "message", operator: "contains", value: "value" });
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
    const t: LogQueryToken = { key: "message", operator: "contains", value: "error" };
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
