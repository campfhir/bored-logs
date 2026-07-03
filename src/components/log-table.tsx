"use client";

import { createContext, useContext, useState, type ReactNode, type ReactElement } from "react";
import type { LogRow } from "../logger/adapter";

/** The active sort column and direction for {@link LogTable}. */
export type SortState = {
  column: string;
  direction: "asc" | "desc";
};

/** Configuration for an additional column beyond the built-in timestamp/level/message columns. */
export type ExtraColumn = {
  /** Unique column identifier, also used as the default header label. */
  key: string;
  /** Header label — defaults to `key`. */
  label?: string;
  /**
   * How to resolve the cell value from a log row.
   * Defaults to reading `log.meta[key]`.
   */
  value?: (log: LogRow) => unknown;
  /** Custom cell renderer. Receives the resolved value and the full log row. */
  render?: (value: unknown, log: LogRow) => ReactNode;
};

// ---------------------------------------------------------------------------
// Context — shares column config between LogTable and its row primitives
// ---------------------------------------------------------------------------

type LogTableCtx = {
  extraColumns: ExtraColumn[];
  totalColumns: number;
};

const LogTableContext = createContext<LogTableCtx>({
  extraColumns: [],
  totalColumns: 3,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Formats an ISO timestamp for display via `toLocaleString`. Returns `"—"` for
 * a null timestamp and the original string if it can't be parsed as a date.
 */
export function formatTimestamp(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const BUILT_IN_COLUMNS = ["timestamp", "level", "message"] as const;
type BuiltInColumn = (typeof BUILT_IN_COLUMNS)[number];

const BUILT_IN_LABELS: Record<BuiltInColumn, string> = {
  timestamp: "Timestamp",
  level: "Level",
  message: "Message",
};

function SortableHeader({
  column,
  label,
  sort,
  onSortChange,
}: {
  column: string;
  label: string;
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
}) {
  if (!onSortChange) return <th data-column={column}>{label}</th>;

  const active = sort?.column === column;
  const nextDirection = active && sort?.direction === "asc" ? "desc" : "asc";

  return (
    <th
      data-column={column}
      data-sort={active ? sort.direction : undefined}
      onClick={() => onSortChange({ column, direction: nextDirection })}
    >
      {label}
    </th>
  );
}

// ---------------------------------------------------------------------------
// LogTable
// ---------------------------------------------------------------------------

/** Props for {@link LogTable}. */
export type LogTableProps = {
  className?: string;
  theadClassName?: string;
  tfootClassName?: string;
  /** Controlled sort state. The component does not sort data itself. */
  sort?: SortState;
  /** Called when a sortable header is clicked. */
  onSortChange?: (sort: SortState) => void;
  /** Additional columns appended after the built-in timestamp/level/message columns. */
  extraColumns?: ExtraColumn[];
  /** Content rendered inside a `<tfoot>` row spanning all columns. */
  footer?: ReactNode;
  /** Rows — compose with `LogTableRow` and `LogTableRowExpanded`. */
  children?: ReactNode;
};

/**
 * Renders a style-less `<table>` with built-in timestamp/level/message headers
 * plus any `extraColumns`, an optional `<tfoot>`, and controlled, clickable
 * sortable headers. Log rows are composed as children using {@link LogTableRow}
 * and related primitives, which share the column config via context.
 */
export function LogTable({
  className,
  theadClassName,
  tfootClassName,
  sort,
  onSortChange,
  extraColumns = [],
  footer,
  children,
}: LogTableProps): ReactElement {
  const totalColumns = BUILT_IN_COLUMNS.length + extraColumns.length;

  return (
    <LogTableContext.Provider value={{ extraColumns, totalColumns }}>
      <table className={className}>
        <thead className={theadClassName}>
          <tr>
            {BUILT_IN_COLUMNS.map((col) => (
              <SortableHeader
                key={col}
                column={col}
                label={BUILT_IN_LABELS[col]}
                sort={sort}
                onSortChange={onSortChange}
              />
            ))}
            {extraColumns.map((col) => (
              <SortableHeader
                key={col.key}
                column={col.key}
                label={col.label ?? col.key}
                sort={sort}
                onSortChange={onSortChange}
              />
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
        {footer != null && (
          <tfoot className={tfootClassName}>
            <tr>
              <td colSpan={totalColumns}>{footer}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </LogTableContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// LogTableRow
// ---------------------------------------------------------------------------

/** Props for {@link LogTableRow}. */
export type LogTableRowProps = {
  log: LogRow;
  onClick?: (log: LogRow) => void;
  className?: string;
};

/**
 * Renders a single log entry as a `<tr>` with the built-in timestamp, level,
 * and message cells plus any `extraColumns` from the surrounding
 * {@link LogTable}. Optionally calls `onClick` with the log when the row is
 * clicked.
 */
export function LogTableRow({ log, onClick, className }: LogTableRowProps): ReactElement {
  const { extraColumns } = useContext(LogTableContext);

  return (
    <tr
      className={className}
      data-clickable={onClick ? true : undefined}
      onClick={onClick ? () => onClick(log) : undefined}
    >
      <td data-column="timestamp">{formatTimestamp(log.timestamp)}</td>
      <td data-column="level">
        <span data-level={log.level}>{log.level}</span>
      </td>
      <td data-column="message">{log.message}</td>
      {extraColumns.map((col) => {
        const value = col.value ? col.value(log) : log.meta[col.key];
        return (
          <td key={col.key} data-column={col.key}>
            {col.render ? col.render(value, log) : value != null ? String(value) : "—"}
          </td>
        );
      })}
    </tr>
  );
}

// ---------------------------------------------------------------------------
// LogTableRowGroup — convenience wrapper with built-in expand/collapse state
// ---------------------------------------------------------------------------

/** Props for {@link LogTableRowGroup}. */
export type LogTableRowGroupProps = {
  log: LogRow;
  className?: string;
  expandedClassName?: string;
  /** Expanded panel content. Defaults to a JSON dump of `log.meta`. */
  children?: ReactNode;
};

/**
 * A convenience wrapper that pairs a {@link LogTableRow} with a
 * {@link LogTableRowExpanded} panel and manages the expand/collapse state
 * internally — clicking the row toggles the detail panel, which defaults to a
 * JSON dump of `log.meta`.
 */
export function LogTableRowGroup({ log, className, expandedClassName, children }: LogTableRowGroupProps): ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <>
      <LogTableRow log={log} className={className} onClick={() => setOpen((o) => !o)} />
      <LogTableRowExpanded open={open} className={expandedClassName}>
        {children ?? <pre>{JSON.stringify(log.meta, null, 2)}</pre>}
      </LogTableRowExpanded>
    </>
  );
}

// ---------------------------------------------------------------------------
// LogTableRowExpanded
// ---------------------------------------------------------------------------

/** Props for {@link LogTableRowExpanded}. */
export type LogTableRowExpandedProps = {
  children: ReactNode;
  className?: string;
  /** Controls visibility. When false the row is not rendered. */
  open?: boolean;
};

/**
 * Renders an expanded detail `<tr>` whose single cell spans all columns of the
 * surrounding {@link LogTable}. Returns nothing when `open` is false, letting
 * the consumer control visibility.
 */
export function LogTableRowExpanded({ children, className, open = true }: LogTableRowExpandedProps): ReactElement | null {
  const { totalColumns } = useContext(LogTableContext);

  if (!open) return null;

  return (
    <tr data-expanded className={className}>
      <td colSpan={totalColumns}>{children}</td>
    </tr>
  );
}
