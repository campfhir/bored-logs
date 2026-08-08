/**
 * Programmatic query builder — construct an attribute-filter tree without
 * learning the string grammar or its precedence rules.
 *
 * @example
 * const results = await where("session.id").eq("123")
 *   .and(where("users[*]").eq("123"))
 *   .or(where("$level").eq("error"))
 *   .execute(logger, { limit: 50 });
 *
 * Combination is LEFT-TO-RIGHT: `X.and(Y).or(Z)` means `(X AND Y) OR Z`,
 * reading like the chain. (The string grammar differs — there `||` binds
 * tighter than AND — but `toQueryString()` output always re-parses to the
 * same tree, so the two surfaces never disagree about a given query.)
 *
 * @module
 */
import {
  type FilterExpr,
  type LogQueryToken,
  type LogQueryOperator,
  formatExpr,
  parseAttrPath,
} from "./parseLogQuery";
import {
  type LogQueryOptions,
  type LogRow,
  type QueryableLogAdapter,
  type QueryError,
  isQueryable,
} from "./adapter";
import type { LoggerInstance } from "./logger";
import type { AsyncResult } from "../types";
import { Err } from "../types";

/** A value accepted by the builder: coerced to the grammar's string form. */
export type FilterValue = string | number | boolean | Date;

/** The options `execute()` accepts — everything `query()` takes except the filter itself. */
export type ExecuteOptions = Omit<LogQueryOptions, "attributeFilter">;

/** Any logger shape `execute()` can route through — satisfied by `Logger`. */
type QueryableLogger = Pick<LoggerInstance, "queryAdapter">;

function coerce(value: FilterValue): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Fail-fast key validation: a malformed bracket path (`users[*`, `a..b`) is a
 * typo that would otherwise silently compile to a flat key and match nothing.
 * `literal()` skips this — it IS the escape hatch for odd flat names.
 */
function validateKey(key: string): void {
  if (/[.[]/.test(key) && !key.startsWith("$") && parseAttrPath(key) === null) {
    throw new TypeError(
      `[bored-logs] "${key}" is not a valid attribute path — expected ` +
        `base ( .member | [index] | [*] )*, e.g. "session.id" or "users[*]". ` +
        `For a flat attribute literally named "${key}", use literal(${JSON.stringify(key)}).`,
    );
  }
}

/** Fail-fast value validation, mirroring the grammar's validateBuiltinLeaf. */
function validateValue(key: string, value: string): void {
  if (key === "$timestamp" && isNaN(new Date(value).getTime())) {
    throw new TypeError(
      `[bored-logs] invalid $timestamp value ${JSON.stringify(value)} — ` +
        `expected an ISO/RFC date or date-time (e.g. "2003-01-02" or a Date)`,
    );
  }
}

/**
 * The key half of a filter — produced by {@link where} / {@link literal};
 * choose an operator to get a combinable {@link QueryBuilder}.
 */
export class WhereClause {
  /** @internal */
  constructor(
    private readonly key: string,
    private readonly literalKey: boolean,
  ) {}

  private token(
    operator: LogQueryOperator,
    value: FilterValue,
    negated?: boolean,
  ): QueryBuilder {
    const str = coerce(value);
    validateValue(this.key, str);
    const token: LogQueryToken = { key: this.key, operator, value: str };
    if (negated) token.negated = true;
    if (this.literalKey) token.literalKey = true;
    return new QueryBuilder({ type: "filter", filter: token });
  }

  /** Exact match (`key:='v'`). For arrays, `where("users[*]").eq(v)` is element equality. */
  eq(value: FilterValue): QueryBuilder {
    return this.token("=", value);
  }

  /** Negated exact match (`key:!='v'`). */
  notEq(value: FilterValue): QueryBuilder {
    return this.token("=", value, true);
  }

  /** Substring match (`key:'v'`). On array/wildcard paths, matches string elements only. */
  contains(value: FilterValue): QueryBuilder {
    return this.token("contains", value);
  }

  /** Negated substring match (`key:!'v'`). */
  notContains(value: FilterValue): QueryBuilder {
    return this.token("contains", value, true);
  }

  /** Greater-than (`key:>'v'`). Numeric or chronological, mirroring the grammar. */
  gt(value: FilterValue): QueryBuilder {
    return this.token(">", value);
  }

  /** Greater-or-equal (`key:>='v'`). */
  gte(value: FilterValue): QueryBuilder {
    return this.token(">=", value);
  }

  /** Less-than (`key:<'v'`). */
  lt(value: FilterValue): QueryBuilder {
    return this.token("<", value);
  }

  /** Less-or-equal (`key:<='v'`). */
  lte(value: FilterValue): QueryBuilder {
    return this.token("<=", value);
  }

  /** Matches the null literal (`key:=null`) — a null attribute or JSON null at a path. */
  isNull(): QueryBuilder {
    const token: LogQueryToken = { key: this.key, operator: "=", value: "null", nullValue: true };
    if (this.literalKey) token.literalKey = true;
    return new QueryBuilder({ type: "filter", filter: token });
  }

  /** Negation of {@link isNull} (`key:!=null`). */
  isNotNull(): QueryBuilder {
    const token: LogQueryToken = {
      key: this.key,
      operator: "=",
      value: "null",
      nullValue: true,
      negated: true,
    };
    if (this.literalKey) token.literalKey = true;
    return new QueryBuilder({ type: "filter", filter: token });
  }
}

/**
 * Start a filter on an attribute key. Dotted/bracketed keys are paths
 * (`session.id`, `users[*]`, `cart.items[*].sku`); `$`-prefixed keys are the
 * built-in columns (`$message`, `$level`, `$timestamp`). Malformed paths throw
 * immediately rather than silently matching nothing.
 */
export function where(key: string): WhereClause {
  validateKey(key);
  return new WhereClause(key, false);
}

/**
 * Start a filter on a FLAT attribute whose name contains path characters —
 * `literal("a.b")` matches an attribute literally named `"a.b"`, where
 * `where("a.b")` would walk into object `a`.
 */
export function literal(key: string): WhereClause {
  return new WhereClause(key, true);
}

// ---------------------------------------------------------------------------
// Normalization into the documented FilterExpr normal form:
// root `and` → children `or` → leaves (or a nested `and` of the same shape,
// when a genuine conjunction is used as an OR operand).
// ---------------------------------------------------------------------------

/** Flatten same-type nesting: and(and(a,b),c) → and(a,b,c); likewise or. */
function flatten(node: FilterExpr): FilterExpr {
  if (node.type === "filter") return node;
  const nodes = node.nodes
    .map(flatten)
    .flatMap((n) => (n.type === node.type ? n.nodes : [n]));
  if (nodes.length === 1) return nodes[0];
  return { type: node.type, nodes };
}

/** Rewrap a flattened tree into the strict and[or[...]] normal form. */
function normalize(node: FilterExpr): FilterExpr {
  const flat = flatten(node);
  const andChildren = flat.type === "and" ? flat.nodes : [flat];
  return {
    type: "and",
    nodes: andChildren.map((child): FilterExpr => {
      if (child.type === "or") {
        return {
          type: "or",
          nodes: child.nodes.map((n) => (n.type === "and" ? normalize(n) : n)),
        };
      }
      // A leaf (or a nested and) becomes a single-child or, exactly as the
      // string parser produces.
      return { type: "or", nodes: [child.type === "and" ? normalize(child) : child] };
    }),
  };
}

/**
 * A composed filter. Immutable: `and`/`or` return new builders. Terminal
 * calls are `build()` (a {@link FilterExpr} for `query({ attributeFilter })`),
 * `toQueryString()` (the string-grammar form), and `execute()`.
 */
export class QueryBuilder {
  /** @internal */
  constructor(private readonly node: FilterExpr) {}

  /** AND this filter with another (left-to-right with any following `or`). */
  and(other: QueryBuilder | FilterExpr): QueryBuilder {
    const rhs = other instanceof QueryBuilder ? other.node : other;
    return new QueryBuilder({ type: "and", nodes: [this.node, rhs] });
  }

  /** OR this filter with another (left-to-right: applies to everything built so far). */
  or(other: QueryBuilder | FilterExpr): QueryBuilder {
    const rhs = other instanceof QueryBuilder ? other.node : other;
    return new QueryBuilder({ type: "or", nodes: [this.node, rhs] });
  }

  /** The filter tree, in the same normal form the string parser produces. */
  build(): FilterExpr {
    return normalize(this.node);
  }

  /** The string-grammar form of this filter — pasteable into `LogSearchBar`. */
  toQueryString(): string {
    return formatExpr(this.build());
  }

  /**
   * Run the query. Accepts a `Logger` (routes through its `queryAdapter()`)
   * or a {@link QueryableLogAdapter} directly; `options` is everything
   * `query()` takes except `attributeFilter`, which this builder supplies.
   */
  async execute(
    target: QueryableLogger | QueryableLogAdapter,
    options: ExecuteOptions = {},
  ): AsyncResult<LogRow[], QueryError> {
    let adapter: QueryableLogAdapter;
    if (typeof (target as QueryableLogger).queryAdapter === "function") {
      try {
        adapter = (target as QueryableLogger).queryAdapter();
      } catch (cause) {
        return {
          ok: false,
          err: new Err("failed to query").addCause(cause as Error),
        };
      }
    } else if (isQueryable(target as QueryableLogAdapter)) {
      adapter = target as QueryableLogAdapter;
    } else {
      return {
        ok: false,
        err: new Err("failed to query").addCause(
          "execute() target is neither a Logger nor a queryable adapter",
        ),
      };
    }
    return adapter.query({ ...options, attributeFilter: this.build() } as LogQueryOptions);
  }
}
