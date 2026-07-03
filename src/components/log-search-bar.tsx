"use client";

import { useRef, useState, useMemo, useEffect, type ReactElement } from "react";
import {
  parseLogQueryExpr,
  formatExpr,
  isUnsatisfiable,
} from "../logger/parseLogQuery";
import type { LogQueryToken, FilterExpr } from "../logger/parseLogQuery";
import type { LogRow } from "../logger/adapter";

// ---------------------------------------------------------------------------
// Autocomplete helpers
// ---------------------------------------------------------------------------

type AutocompleteCtx =
  | { type: "key"; prefix: string }
  | { type: "operator"; key: string; prefix: string }
  | { type: "value"; key: string; opPrefix: string; prefix: string };

type Suggestion = { display: string; insert: string };

const ALWAYS_SUGGESTED_KEYS = ["level", "message", "timestamp"];

function quoteKey(key: string): string {
  return /[\s:'"=<>!]/.test(key) ? `'${key.replace(/'/g, "\\'")}'` : key;
}

function escapeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const OPERATORS: Array<{ prefix: string; label: string }> = [
  { prefix: "'",   label: "' — contains"     },
  { prefix: "='",  label: "=' — equals"      },
  { prefix: "!'",  label: "!' — not contains"},
  { prefix: "!='", label: "!=' — not equals" },
  { prefix: ">'",  label: ">' — greater than"},
  { prefix: ">='", label: ">=\' — gte"       },
  { prefix: "<'",  label: "<' — less than"   },
  { prefix: "<='", label: "<=' — lte"        },
];

/**
 * Index in `draft` where the segment currently being edited begins. The
 * segment is the trailing run after the last whitespace, minus any leading
 * grouping / boolean punctuation (`(`, `||`, `&&`) so autocomplete fires on
 * the term inside a group or after an operator (e.g. `a:'1' || (b:` → `b:`).
 */
function segmentStart(draft: string): number {
  const m = draft.match(/\S*$/);
  const wsStart = m && m.index != null ? m.index : draft.length;
  const stripped = draft.slice(wsStart).replace(/^(\(|\|\||&&)+/, "");
  return draft.length - stripped.length;
}

function parseCtx(draft: string): AutocompleteCtx | null {
  const segment = draft.slice(segmentStart(draft));
  const colonIdx = segment.indexOf(":");

  if (colonIdx === -1) return { type: "key", prefix: segment };

  const key = segment.slice(0, colonIdx);
  const rest = segment.slice(colonIdx + 1);
  const opPrefix = rest.match(/^(!=|!|>=|>|<=|=|<)?/)?.[1] ?? "";
  const afterOp = rest.slice(opPrefix.length);

  if (!afterOp || (afterOp[0] !== "'" && afterOp[0] !== '"')) {
    return { type: "operator", key, prefix: opPrefix };
  }

  const quote = afterOp[0];
  const valuePrefix = afterOp.slice(1);
  if (valuePrefix.includes(quote)) return null; // value already closed

  return { type: "value", key, opPrefix, prefix: valuePrefix };
}

function computeSuggestions(ctx: AutocompleteCtx, logs: LogRow[]): Suggestion[] {
  const lower = ctx.prefix.toLowerCase();

  if (ctx.type === "key") {
    const keys = new Set(ALWAYS_SUGGESTED_KEYS);
    for (const log of logs) {
      for (const k of Object.keys(log.meta)) keys.add(k);
    }
    return [...keys]
      .filter((k) => k.toLowerCase().includes(lower))
      .sort()
      .map((k) => ({ display: k, insert: quoteKey(k) + ":" }));
  }

  if (ctx.type === "operator") {
    return OPERATORS.filter((op) => op.prefix.startsWith(ctx.prefix)).map((op) => ({
      display: op.label,
      insert: op.prefix,
    }));
  }

  // value
  const vals = new Set<string>();
  for (const log of logs) {
    const v = log.meta[ctx.key];
    if (v != null) vals.add(String(v));
  }
  return [...vals]
    .filter((v) => v.toLowerCase().includes(lower))
    .sort()
    .map((v) => ({ display: v, insert: escapeValue(v) + "'" }));
}

function applyInsert(draft: string, ctx: AutocompleteCtx, insert: string): string {
  const start = segmentStart(draft);
  const before = draft.slice(0, start);
  const segment = draft.slice(start);

  if (ctx.type === "key") return before + insert;

  const colonIdx = segment.indexOf(":");
  const keyColon = segment.slice(0, colonIdx + 1);

  if (ctx.type === "operator") return before + keyColon + insert;

  // value: rebuild as key:opPrefix'insert
  const opPart = ctx.opPrefix;
  return before + keyColon + opPart + "'" + insert;
}

// ---------------------------------------------------------------------------
// Expression-tree helpers
// ---------------------------------------------------------------------------

/**
 * Split a parsed query into top-level AND branches — the chips. Normal form
 * makes the root an `and`, so its `or` children each become one chip; a
 * single-term query is one branch.
 */
function toBranches(expr: FilterExpr): FilterExpr[] {
  return expr.type === "and" ? expr.nodes : [expr];
}

/** Combine chips back into a single tree (null when there are none). */
function branchesToExpr(branches: FilterExpr[]): FilterExpr | null {
  return branches.length ? { type: "and", nodes: branches } : null;
}

// ---------------------------------------------------------------------------
// LogSearchSyntaxHelp — standalone, place anywhere in the consumer's layout
// ---------------------------------------------------------------------------

/**
 * A standalone reference that renders the search query syntax (operators,
 * boolean combinators, and grouping) as a definition list. Place it anywhere
 * in the consumer's layout to document {@link LogSearchBar}'s query language.
 */
export function LogSearchSyntaxHelp({ className }: { className?: string }): ReactElement {
  return (
    <span className={className} data-log-search-syntax-help>
      <dl>
        <dt>key:'value'</dt>    <dd>contains</dd>
        <dt>key:='value'</dt>   <dd>equals</dd>
        <dt>key:!'value'</dt>   <dd>not contains</dd>
        <dt>key:!='value'</dt>  <dd>not equals</dd>
        <dt>key:&gt;'value'</dt>  <dd>greater than</dd>
        <dt>key:&gt;='value'</dt> <dd>gte</dd>
        <dt>key:&lt;'value'</dt>  <dd>less than</dd>
        <dt>key:&lt;='value'</dt> <dd>lte</dd>
        <dt>bare text</dt>      <dd>message contains</dd>
        <dt>a b / a &amp;&amp; b</dt> <dd>and</dd>
        <dt>a || b</dt>         <dd>or (binds tighter than and)</dd>
        <dt>(a b) || c</dt>     <dd>grouping</dd>
      </dl>
    </span>
  );
}

// ---------------------------------------------------------------------------
// LogSearchBar
// ---------------------------------------------------------------------------

/** Props for {@link LogSearchBar}. */
export type LogSearchBarProps = {
  className?: string;
  hidden?: boolean;
  /** The full boolean expression tree, or null when the search is empty. */
  onSearch?: (expr: FilterExpr | null) => void;
  placeholder?: string;
  /** When provided, enables key/operator/value autocomplete. */
  logs?: LogRow[];
  /** Debounce (ms) before a syntax error / empty-result warning is shown. */
  debounceMs?: number;
};

/**
 * A style-less search input for building boolean log-query expressions.
 * Committed terms become removable, editable chips; it offers optional
 * key/operator/value autocomplete when `logs` are supplied, debounced syntax
 * and contradiction warnings, and emits the parsed expression tree (or null)
 * via `onSearch`.
 */
export default function LogSearchBar({
  className,
  hidden,
  onSearch,
  placeholder = "level:'error' (env:'prod' || env:'staging')  message:'login'",
  logs,
  debounceMs = 400,
}: LogSearchBarProps): ReactElement | null {
  const [input, setInput] = useState("");
  const [branches, setBranches] = useState<FilterExpr[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  // Track which ctx.type had Esc pressed. Suggestions are suppressed only
  // while the current stage matches. Moving to a different stage (e.g. typing
  // ':' to go from key→operator) naturally clears suppression. Operator stage
  // is never suppressible — there are only a handful of fixed options.
  const [suppressedStage, setSuppressedStage] = useState<string | null>(null);
  // Debounced validation state — never flagged mid-keystroke.
  const [syntaxError, setSyntaxError] = useState<string | null>(null);
  const [emptyResult, setEmptyResult] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const ctx = useMemo(() => (input ? parseCtx(input) : null), [input]);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!logs?.length || !ctx) return [];
    if (ctx.type === suppressedStage) return [];
    return computeSuggestions(ctx, logs);
  }, [suppressedStage, logs, ctx]);

  // Debounced syntax check + empty-result (contradiction) detection. Runs on
  // the draft plus committed chips so the warning reflects the whole query.
  useEffect(() => {
    const trimmed = input.trim();
    const id = setTimeout(() => {
      let draftBranches: FilterExpr[] = [];
      if (trimmed) {
        const r = parseLogQueryExpr(trimmed);
        if (!r.ok) {
          setSyntaxError(r.err.cause?.message ?? r.err.message);
          setEmptyResult(false);
          return;
        }
        if (r.val) draftBranches = toBranches(r.val);
      }
      setSyntaxError(null);
      const all = [...branches, ...draftBranches];
      setEmptyResult(all.length > 0 && isUnsatisfiable({ type: "and", nodes: all }));
    }, debounceMs);
    return () => clearTimeout(id);
  }, [input, branches, debounceMs]);

  if (hidden) return null;

  function emit(next: FilterExpr[]) {
    onSearch?.(branchesToExpr(next));
  }

  function commit(draft: string) {
    const trimmed = draft.trim();
    if (!trimmed) return;
    const r = parseLogQueryExpr(trimmed);
    if (!r.ok) {
      // Commit is an explicit action — flag immediately, don't wait for debounce.
      setSyntaxError(r.err.cause?.message ?? r.err.message);
      return;
    }
    if (!r.val) return;
    const next = [...branches, ...toBranches(r.val)];
    setBranches(next);
    setInput("");
    setSelectedIdx(-1);
    setSuppressedStage(null);
    setSyntaxError(null);
    emit(next);
  }

  function removeBranch(idx: number) {
    const next = branches.filter((_, i) => i !== idx);
    setBranches(next);
    emit(next);
  }

  /**
   * Pull a committed chip back into the input for editing: its formatted
   * expression becomes the draft, the chip is dropped (so it no longer filters
   * until re-committed), and the caret goes to the end. Any in-progress draft
   * is replaced.
   */
  function startEditing(idx: number) {
    const text = formatExpr(branches[idx]);
    const next = branches.filter((_, i) => i !== idx);
    setBranches(next);
    setInput(text);
    setSelectedIdx(-1);
    setSuppressedStage(null);
    setSyntaxError(null);
    emit(next);
    const el = inputRef.current;
    if (el) {
      el.focus();
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => {
          const n = el.value.length;
          el.setSelectionRange(n, n);
        });
      }
    }
  }

  function clearAll() {
    setBranches([]);
    setInput("");
    setSelectedIdx(-1);
    setSuppressedStage(null);
    setSyntaxError(null);
    setEmptyResult(false);
    emit([]);
    inputRef.current?.focus();
  }

  function acceptSuggestion(idx: number) {
    const s = suggestions[idx];
    if (!s || !ctx) return;
    const newInput = applyInsert(input, ctx, s.insert);
    setInput(newInput);
    setSelectedIdx(-1);
    setSuppressedStage(null);
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Tab" && suggestions.length > 0) {
      e.preventDefault();
      setSelectedIdx((prev) => (prev + 1) % suggestions.length);
      return;
    }

    if (e.key === "Enter") {
      if (selectedIdx >= 0 && suggestions[selectedIdx]) {
        e.preventDefault();
        acceptSuggestion(selectedIdx);
      } else {
        e.preventDefault();
        commit(input);
      }
      return;
    }

    if (e.key === "Escape") {
      // Operator stage is never suppressed (fixed small list, always helpful).
      if (ctx?.type && ctx.type !== "operator" && suggestions.length > 0) {
        e.preventDefault();
        setSuppressedStage(ctx.type);
        setSelectedIdx(-1);
      }
      return;
    }

    if (e.key === "Backspace" && !input && branches.length > 0) {
      removeBranch(branches.length - 1);
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setInput(e.target.value);
    setSelectedIdx(-1);
    // Clear a stale syntax error the moment the draft changes; the debounced
    // effect re-evaluates and re-flags only after the user pauses.
    if (syntaxError) setSyntaxError(null);
  }

  return (
    <div className={className} onClick={() => inputRef.current?.focus()}>
      {branches.map((branch, idx) => {
        const label = formatExpr(branch);
        return (
          <span key={idx} data-log-filter-chip>
            <button
              type="button"
              data-log-filter-chip-edit
              aria-label={`Edit filter ${label}`}
              onClick={(e) => {
                e.stopPropagation();
                startEditing(idx);
              }}
            >
              {label}
            </button>
            <button
              type="button"
              aria-label={`Remove filter ${label}`}
              onClick={(e) => {
                e.stopPropagation();
                removeBranch(idx);
              }}
            >
              ×
            </button>
          </span>
        );
      })}

      <input
        ref={inputRef}
        type="text"
        value={input}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={branches.length === 0 ? placeholder : ""}
        aria-autocomplete="list"
        aria-expanded={suggestions.length > 0}
        aria-invalid={syntaxError ? true : undefined}
        aria-activedescendant={
          selectedIdx >= 0 ? `log-search-suggestion-${selectedIdx}` : undefined
        }
      />

      {suggestions.length > 0 && (
        <ul role="listbox" data-log-search-suggestions>
          {suggestions.map((s, i) => (
            <li
              key={i}
              id={`log-search-suggestion-${i}`}
              role="option"
              aria-selected={i === selectedIdx}
              data-selected={i === selectedIdx || undefined}
              onMouseDown={(e) => {
                e.preventDefault(); // keep input focused
                acceptSuggestion(i);
              }}
            >
              {s.display}
            </li>
          ))}
        </ul>
      )}

      {syntaxError && (
        <span role="alert" data-log-search-error>
          {syntaxError}
        </span>
      )}

      {!syntaxError && emptyResult && (
        <span role="status" data-log-search-warning>
          This query can never match — contradictory filters.
        </span>
      )}

      {(branches.length > 0 || input.length > 0) && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={(e) => {
            e.stopPropagation();
            clearAll();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

export type { LogQueryToken, FilterExpr };
