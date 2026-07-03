/**
 * Parses an Elasticsearch-style log query string into structured filter tokens.
 *
 * Syntax:
 *   key:'value'            → attribute contains (LIKE %value%)
 *   key:"value"            → attribute contains (LIKE %value%)
 *   key:='value'           → attribute exact match
 *   key:>'value'           → attribute > value
 *   key:>='value'          → attribute >= value
 *   key:<'value'           → attribute < value
 *   key:<='value'          → attribute <= value
 *   key:!'value'           → attribute does NOT contain value
 *   key:!='value'          → attribute does NOT equal value
 *   'key with spaces':'value'  → quoted key, attribute contains
 *   "key with spaces":'value'  → quoted key (double quotes also work)
 *   bare text              → message/msg contains (same as message:'bare text')
 *   message:!'value'       → message does NOT contain value
 *
 * Multiple tokens are ANDed together.
 * Tokens with no key default to key="message", operator="contains".
 *
 * Keys and values support single OR double quote wrapping.
 */

import { Err } from "../types";
import type { Result } from "../types";

export type LogQueryOperator = "contains" | "=" | ">" | ">=" | "<" | "<=";

export interface LogQueryToken {
  key: string; // "message" when no key given
  operator: LogQueryOperator;
  value: string;
  /** When true, the filter is negated (NOT LIKE / NOT IN) */
  negated?: boolean;
}

/**
 * Boolean expression tree produced by {@link parseLogQueryExpr}.
 *
 * Normal form: the (non-null) root is ALWAYS an `and` node whose children are
 * ALWAYS `or` nodes. An `or`'s children are `filter` leaves, or a nested `and`
 * node — the latter only appears when a parenthesized group holds a genuine
 * conjunction used as an OR operand (e.g. `(a b) || c`). Redundant pure-OR
 * parens dissolve. (`||` binds tighter than AND; AND is whitespace or `&&`.)
 */
export type FilterExpr =
  | { type: "and"; nodes: FilterExpr[] }
  | { type: "or"; nodes: FilterExpr[] }
  | { type: "filter"; filter: LogQueryToken };

// ---------------------------------------------------------------------------
// Module-level parser helpers (not exported)
// ---------------------------------------------------------------------------

type Cursor = { input: string; i: number; depth?: number };

function skipWhitespace(cur: Cursor): void {
  while (cur.i < cur.input.length && /\s/.test(cur.input[cur.i])) cur.i++;
}

/**
 * A term-boundary character. Bare keys/values always stop at whitespace, and
 * also at a closing `)` when we're inside a group (`depth > 0`). Outside a
 * group a `)` is ordinary text, so `render(x)` stays a literal bare word.
 */
function isTermStop(cur: Cursor, ch: string): boolean {
  if (/\s/.test(ch)) return true;
  return (cur.depth ?? 0) > 0 && ch === ")";
}

/** True when the cursor sits on a `||` OR operator. */
function atOr(cur: Cursor): boolean {
  return cur.input[cur.i] === "|" && cur.input[cur.i + 1] === "|";
}

/** True when the cursor sits on a `&&` AND operator. */
function atAnd(cur: Cursor): boolean {
  return cur.input[cur.i] === "&" && cur.input[cur.i + 1] === "&";
}

/** True at a right boundary where no operand can follow (EOF or a group close). */
function atOperandBoundary(cur: Cursor): boolean {
  return cur.i >= cur.input.length || ((cur.depth ?? 0) > 0 && cur.input[cur.i] === ")");
}

/** Error message returned by parseLogQueryExpr on malformed `||` / `&&` usage. */
export const QUERY_SYNTAX_ERROR = "invalid query syntax";

/** An error Result carrying {@link QUERY_SYNTAX_ERROR}; assignable to any parse Result. */
type ParseError = { ok: false; err: Err<typeof QUERY_SYNTAX_ERROR> };

function syntaxError(detail: string): ParseError {
  return { ok: false, err: new Err(QUERY_SYNTAX_ERROR).addCause(detail) };
}

function readQuotedValue(cur: Cursor): string | null {
  const q = cur.input[cur.i];
  if (q !== "'" && q !== '"') return null;
  cur.i++; // consume opening quote
  let value = "";
  while (cur.i < cur.input.length) {
    const ch = cur.input[cur.i];
    if (ch === "\\") {
      // escape sequence
      cur.i++;
      if (cur.i < cur.input.length) {
        value += cur.input[cur.i];
        cur.i++;
      }
      continue;
    }
    if (ch === q) {
      cur.i++; // consume closing quote
      return value;
    }
    value += ch;
    cur.i++;
  }
  // Unclosed quote — treat rest as value
  return value;
}

function readBareWord(cur: Cursor): string {
  let word = "";
  while (cur.i < cur.input.length && !isTermStop(cur, cur.input[cur.i])) {
    word += cur.input[cur.i];
    cur.i++;
  }
  return word;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse raw query string into tokens.
 * Returns [] for an empty / whitespace-only string.
 */
export function parseLogQuery(raw: string): LogQueryToken[] {
  const input = raw.trim();
  if (!input) return [];

  const tokens: LogQueryToken[] = [];
  const cur: Cursor = { input, i: 0 };

  // depth stays 0/undefined here, so parseFilter reads `||`, `(`, `)` as
  // ordinary text — the flat parser has no notion of grouping or OR.
  while (cur.i < cur.input.length) {
    skipWhitespace(cur);
    if (cur.i >= cur.input.length) break;

    const before = cur.i;
    const token = parseFilter(cur);
    if (token) tokens.push(token);
    if (cur.i === before) cur.i++; // safety: guarantee forward progress
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Boolean-expression parser (recursive descent)
//
//   andExpr := orTerm ((WS | '&&') orTerm)*
//   orTerm  := term ('||' term)*
//   term    := '(' andExpr ')' | filter
//
// OR binds tighter than AND, so `a b || c` reads as `a AND (b OR c)`; use `()`
// to group an AND under an OR, e.g. `(a b) || c`. AND is expressed by
// whitespace or an explicit `&&` (equivalent). `&&`, `||` and `()` are
// structural only at term boundaries — see isTermStop / atOr / atAnd.
// Everything below shares the same filter-reading helpers as parseLogQuery.
// ---------------------------------------------------------------------------

/**
 * Read one `key:[op]value`-or-bare-word term into a token, or null if nothing
 * readable sits at the cursor. Mirrors a single iteration of parseLogQuery's
 * loop, but honours group boundaries (`)` at depth > 0) via isTermStop.
 */
function parseFilter(cur: Cursor): LogQueryToken | null {
  const start = cur.i;
  let key = "";
  let keyWasQuoted = false;

  if (cur.input[cur.i] === "'" || cur.input[cur.i] === '"') {
    const quotedKey = readQuotedValue(cur);
    if (quotedKey !== null && cur.i < cur.input.length && cur.input[cur.i] === ":") {
      key = quotedKey;
      keyWasQuoted = true;
    } else {
      // Not followed by ':', treat the quoted string as a bare message term
      return { key: "message", operator: "contains", value: quotedKey ?? "" };
    }
  } else {
    // Bare key — read up to ':' or a term boundary
    while (
      cur.i < cur.input.length &&
      cur.input[cur.i] !== ":" &&
      !isTermStop(cur, cur.input[cur.i])
    ) {
      key += cur.input[cur.i];
      cur.i++;
    }
  }

  if (!keyWasQuoted && (cur.i >= cur.input.length || cur.input[cur.i] !== ":")) {
    // No colon found — bare word, treat as message contains
    return key ? { key: "message", operator: "contains", value: key } : null;
  }

  // Consume the ':'
  cur.i++;

  // Read optional operator suffix: =, !, !=, >, >=, <, <=
  let operator: LogQueryOperator = "contains";
  let negated: boolean | undefined;
  if (cur.i < cur.input.length) {
    if (cur.input[cur.i] === "!" && cur.input[cur.i + 1] === "=") {
      operator = "="; negated = true; cur.i += 2;
    } else if (cur.input[cur.i] === "!") {
      negated = true; cur.i++;
    } else if (cur.input[cur.i] === "=") {
      operator = "="; cur.i++;
    } else if (cur.input[cur.i] === ">" && cur.input[cur.i + 1] === "=") {
      operator = ">="; cur.i += 2;
    } else if (cur.input[cur.i] === ">") {
      operator = ">"; cur.i++;
    } else if (cur.input[cur.i] === "<" && cur.input[cur.i + 1] === "=") {
      operator = "<="; cur.i += 2;
    } else if (cur.input[cur.i] === "<") {
      operator = "<"; cur.i++;
    }
    // else: stays "contains", next char should be quote
  }

  // Now read the value — quoted or bare word
  let value: string | null = null;
  if (cur.i < cur.input.length && (cur.input[cur.i] === "'" || cur.input[cur.i] === '"')) {
    value = readQuotedValue(cur);
  } else {
    value = readBareWord(cur);
    if (!value) {
      // colon with no value: treat key as bare message word
      return { key: "message", operator: "contains", value: key };
    }
  }

  if (value !== null) {
    return { key, operator, value, negated };
  }
  // fallback
  cur.i = start;
  return { key: "message", operator: "contains", value: readBareWord(cur) };
}

type ParseResult<T> = Result<T, typeof QUERY_SYNTAX_ERROR>;

/**
 * Parse a single term into the list of nodes it contributes to its parent OR
 * chain. A filter yields one leaf; a parenthesized group yields either its
 * spliced OR-terms (a redundant pure-OR group dissolves) or a single nested
 * `and` node (a genuine conjunction is kept). An empty or unclosed group is a
 * syntax error.
 */
function parseTerm(cur: Cursor): ParseResult<FilterExpr[]> {
  if (cur.input[cur.i] === "(") {
    cur.i++;
    cur.depth = (cur.depth ?? 0) + 1;
    const sub = parseAnd(cur);
    if (!sub.ok) return sub;
    skipWhitespace(cur);
    if (cur.i >= cur.input.length || cur.input[cur.i] !== ")") {
      return syntaxError("unclosed group '('");
    }
    cur.i++; // consume ')'
    cur.depth -= 1;
    if (sub.val === null) return syntaxError("empty group '()'");
    // sub.val is an `and` node. A single OR-branch means the parens added no
    // conjunction — splice its terms up so `a (b || c)` ≡ `a AND (b OR c)`.
    const node = sub.val;
    if (node.type === "and" && node.nodes.length === 1) {
      const branch = node.nodes[0];
      return { ok: true, val: branch.type === "or" ? branch.nodes : [branch] };
    }
    return { ok: true, val: [node] };
  }

  const token = parseFilter(cur);
  return { ok: true, val: token === null ? [] : [{ type: "filter", filter: token }] };
}

/** Parse an OR-chain: terms joined by `||`. Malformed `||` usage is an error. */
function parseOrTerm(cur: Cursor): ParseResult<FilterExpr | null> {
  if (atOr(cur)) return syntaxError("'||' has no left operand");

  const terms: FilterExpr[] = [];
  const first = parseTerm(cur);
  if (!first.ok) return first;
  terms.push(...first.val);
  while (true) {
    skipWhitespace(cur);
    if (!atOr(cur)) break;
    cur.i += 2; // consume one '||'
    skipWhitespace(cur);
    if (atOperandBoundary(cur)) return syntaxError("'||' has no right operand");
    if (atOr(cur)) return syntaxError("repeated '||' operator");
    if (atAnd(cur)) return syntaxError("'||' immediately followed by '&&'");
    const next = parseTerm(cur);
    if (!next.ok) return next;
    terms.push(...next.val);
  }

  if (terms.length === 0) return { ok: true, val: null };
  return { ok: true, val: { type: "or", nodes: terms } };
}

/**
 * Parse an AND-expression: OR-chains separated by whitespace or `&&`. This is
 * the top level, so `||` (handled inside parseOrTerm) binds tighter than AND.
 */
function parseAnd(cur: Cursor): ParseResult<FilterExpr | null> {
  const orTerms: FilterExpr[] = [];
  while (true) {
    skipWhitespace(cur);
    if (cur.i >= cur.input.length) break;
    if ((cur.depth ?? 0) > 0 && cur.input[cur.i] === ")") break;

    // Explicit `&&` separator: it needs an operand on both sides. A `&&`
    // followed by `||` is caught by parseOrTerm's leading-`||` check below.
    if (atAnd(cur)) {
      if (orTerms.length === 0) return syntaxError("'&&' has no left operand");
      cur.i += 2; // consume one '&&'
      skipWhitespace(cur);
      if (atOperandBoundary(cur)) return syntaxError("'&&' has no right operand");
      if (atAnd(cur)) return syntaxError("repeated '&&' operator");
    }

    const before = cur.i;
    const orTerm = parseOrTerm(cur);
    if (!orTerm.ok) return orTerm;
    if (orTerm.val) {
      // Flatten a redundant pure-AND group sitting directly in AND context:
      // `or[ and[...] ]` with a single `and` child → splice its OR-terms so
      // `a (b c)` ≡ `a AND b AND c`.
      const node = orTerm.val;
      if (node.type === "or" && node.nodes.length === 1 && node.nodes[0].type === "and") {
        orTerms.push(...node.nodes[0].nodes);
      } else {
        orTerms.push(node);
      }
    }
    if (cur.i === before) cur.i++; // safety: guarantee forward progress
  }
  if (orTerms.length === 0) return { ok: true, val: null };
  return { ok: true, val: { type: "and", nodes: orTerms } };
}

/**
 * Parse a raw query string into a boolean {@link FilterExpr} tree supporting
 * `||` (OR), whitespace or `&&` (AND), and `()` grouping. Returns null for an
 * empty / whitespace-only string (or one that reduces to no filters).
 *
 * Returns an error {@link Result} with message {@link QUERY_SYNTAX_ERROR} when
 * an `||` or `&&` operator is missing an operand (leading, trailing, or
 * doubled), when a group is empty (`()`), or when a `(` is not closed. The
 * offending detail is on `err.cause`. A valid query resolves to `{ ok: true }`
 * with `val` being the tree, or `null` for empty / whitespace-only input.
 *
 * See {@link FilterExpr} for the normalized shape.
 */
export function parseLogQueryExpr(
  raw: string,
): Result<FilterExpr | null, typeof QUERY_SYNTAX_ERROR> {
  const input = raw.trim();
  if (!input) return { ok: true, val: null };
  return parseAnd({ input, i: 0, depth: 0 });
}

const LOWER_OPS = new Set<LogQueryOperator>([">", ">="]);
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
// Matches YYYY-MM-DD, YYYY-MM-DDTHH:MM:SS, with optional milliseconds and Z/offset.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;
const UPPER_OPS = new Set<LogQueryOperator>(["<", "<="]);

function isImpossibleRange(a: LogQueryToken, b: LogQueryToken): boolean {
  if (a.negated || b.negated) return false;

  let lower: LogQueryToken, upper: LogQueryToken;
  if (LOWER_OPS.has(a.operator) && UPPER_OPS.has(b.operator)) {
    lower = a; upper = b;
  } else if (UPPER_OPS.has(a.operator) && LOWER_OPS.has(b.operator)) {
    lower = b; upper = a;
  } else {
    return false;
  }

  if (lower.value === upper.value) {
    // >= x <= x → possible (val = x). Every other combo (> < , > <=, >= <) → impossible.
    return !(lower.operator === ">=" && upper.operator === "<=");
  }

  // Different values: compare numerically, then by date. If lower bound >= upper bound, impossible.
  if (DECIMAL_RE.test(lower.value) && DECIMAL_RE.test(upper.value)) {
    return parseInt(lower.value, 10) >= parseInt(upper.value, 10);
  }

  if (ISO_DATE_RE.test(lower.value) && ISO_DATE_RE.test(upper.value)) {
    return new Date(lower.value) >= new Date(upper.value);
  }

  return false;
}

/** True when two tokens on the same key can never both hold. */
function isContradictoryPair(ta: LogQueryToken, tb: LogQueryToken): boolean {
  if (ta.key !== tb.key) return false;
  return (
    (ta.operator === tb.operator && ta.value === tb.value && !!ta.negated !== !!tb.negated) ||
    isImpossibleRange(ta, tb)
  );
}

/** All contradicting pairs among a single conjunction (set of ANDed tokens). */
function conjunctionContradictions(tokens: LogQueryToken[]): Array<[LogQueryToken, LogQueryToken]> {
  const pairs: Array<[LogQueryToken, LogQueryToken]> = [];
  for (let a = 0; a < tokens.length; a++) {
    for (let b = a + 1; b < tokens.length; b++) {
      if (isContradictoryPair(tokens[a], tokens[b])) pairs.push([tokens[a], tokens[b]]);
    }
  }
  return pairs;
}

/**
 * Disjunctive normal form: flatten a boolean tree into a list of conjunctive
 * paths, each an array of tokens that must all hold together. `or` unions the
 * paths of its operands; `and` takes their cartesian product. Query trees are
 * tiny, so the potential blow-up is a non-issue in practice.
 */
function toDnf(expr: FilterExpr): LogQueryToken[][] {
  switch (expr.type) {
    case "filter":
      return [[expr.filter]];
    case "or":
      return expr.nodes.flatMap(toDnf);
    case "and": {
      let paths: LogQueryToken[][] = [[]];
      for (const child of expr.nodes) {
        const childPaths = toDnf(child);
        const next: LogQueryToken[][] = [];
        for (const prefix of paths) {
          for (const path of childPaths) next.push([...prefix, ...path]);
        }
        paths = next;
      }
      return paths;
    }
  }
}

/** True if the ordered pair (or its reverse) is already present by reference. */
function hasPair(
  pairs: Array<[LogQueryToken, LogQueryToken]>,
  a: LogQueryToken,
  b: LogQueryToken,
): boolean {
  return pairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

/**
 * Returns pairs of tokens that contradict each other — a pair guaranteed to
 * match zero rows wherever both are forced to hold at once.
 *
 * Accepts either a flat {@link LogQueryToken} list (all ANDed) or a boolean
 * {@link FilterExpr} tree (with `||` / `&&` / grouping); pass `null` for an
 * empty tree. For a tree, each conjunctive path through the DNF is checked
 * independently: operands of an `||` are alternatives, so a contradiction in
 * one branch is not a contradiction of the other. A pair that recurs across
 * cartesian-expanded paths is reported once (by token identity).
 *
 * Detects two cases per path:
 *  - Direct negation: same key, operator, and value but one negated (key:='1' key:!='1')
 *  - Impossible range: lower- and upper-bound on the same key where no value
 *    can satisfy both (key:>'1' key:<'1', key:>'5' key:<'3')
 *
 * A non-empty result means at least one branch is dead; to know the *whole*
 * query can never match, use {@link isUnsatisfiable}.
 */
export function findContradictions(
  input: LogQueryToken[] | FilterExpr | null,
): Array<[LogQueryToken, LogQueryToken]> {
  if (input === null) return [];
  if (Array.isArray(input)) return conjunctionContradictions(input);

  const pairs: Array<[LogQueryToken, LogQueryToken]> = [];
  for (const path of toDnf(input)) {
    for (const [a, b] of conjunctionContradictions(path)) {
      if (!hasPair(pairs, a, b)) pairs.push([a, b]);
    }
  }
  return pairs;
}

/**
 * True when a boolean {@link FilterExpr} tree can never match a row: every
 * conjunctive path through its DNF contains a contradiction. `null` (empty
 * query) matches everything, so it is satisfiable. Use this to reject a query
 * before hitting the database.
 */
export function isUnsatisfiable(expr: FilterExpr | null): boolean {
  if (expr === null) return false;
  const paths = toDnf(expr);
  if (paths.length === 0) return false;
  return paths.every((path) => conjunctionContradictions(path).length > 0);
}

/**
 * Format tokens back into a display string (for UI chip rendering etc.)
 */
export function formatToken(token: LogQueryToken): string {
  const isMessage = token.key === "message";
  if (isMessage && token.operator === "contains") {
    // bare message terms have no key prefix; negated ones show message:!'...'
    if (!token.negated) return `"${token.value}"`;
  }
  // Build operator string with inline negation
  let opStr: string;
  if (token.negated) {
    opStr = token.operator === "contains" ? ":!" : `:!${token.operator}`;
  } else {
    opStr = token.operator === "contains" ? ":" : `:${token.operator}`;
  }
  // Quote the key if it contains spaces or special characters
  const key = /[\s:'"=<>!]/.test(token.key)
    ? `'${token.key.replace(/'/g, "\\'")}'`
    : token.key;
  const value = token.value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `${key}${opStr}'${value}'`;
}

/**
 * Format a {@link FilterExpr} tree back into a query string that round-trips
 * through {@link parseLogQueryExpr}. `and` terms are joined with a space and
 * `or` terms with ` || `; an `and` nested inside an `or` is parenthesized so
 * OR's higher precedence doesn't absorb it.
 */
export function formatExpr(expr: FilterExpr): string {
  if (expr.type === "filter") return formatToken(expr.filter);
  if (expr.type === "and") return expr.nodes.map(formatExpr).join(" ");
  // or: join with ` || `, wrapping any nested AND group in parens.
  return expr.nodes
    .map((node) => (node.type === "and" ? `(${formatExpr(node)})` : formatExpr(node)))
    .join(" || ");
}
