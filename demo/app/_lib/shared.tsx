"use client";

// Shared building blocks for the demo layout variants. Each variant page
// composes these into a different full-page layout; the query state + server
// wiring lives in the useLogQuery hook so the variants stay presentational.

import { useState, useTransition, type ReactNode } from "react";
import {
  LogTable,
  LogTableRowGroup,
  LogCard,
  LogSearchBar,
  LogLevelFilter,
  LogDateRangePicker,
  PurgeLogsDialog,
} from "@campfhir/bored-logs/components";
import type {
  SortState,
  ExtraColumn,
  LogDateRange,
} from "@campfhir/bored-logs/components";
import type { FilterExpr, LogRow } from "@campfhir/bored-logs";
import { simulate, search, purge } from "../actions";
import { SCENARIOS } from "@/lib/scenarios";

// The levels the demo actually generates (a curated subset of the built-ins).
export const DEMO_LEVELS = ["debug", "info", "warn", "error", "critical"];
export const PAGE_SIZE = 20;

function StatusBadge({ value }: { value: unknown }) {
  const code = Number(value);
  if (!Number.isFinite(code)) return <span className="text-slate-400">—</span>;
  const tone =
    code >= 500 ? "bg-red-500/15 text-red-700 dark:text-red-300"
    : code >= 400 ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
    : code >= 300 ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
    : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium tabular-nums ${tone}`}>{code}</span>;
}

function Latency({ value }: { value: unknown }) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return <span className="text-slate-400">—</span>;
  const slow = ms >= 1000;
  return (
    <span className={`tabular-nums ${slow ? "text-amber-600 dark:text-amber-300" : "text-slate-500 dark:text-slate-400"}`}>
      {ms}ms
    </span>
  );
}

// Shared column config — drives both the desktop table and the mobile cards.
export const COLUMNS: ExtraColumn[] = [
  { key: "service", label: "Service" },
  { key: "statusCode", label: "Status", render: (v) => <StatusBadge value={v} /> },
  { key: "latencyMs", label: "Latency", render: (v) => <Latency value={v} /> },
];

// ---------------------------------------------------------------------------
// useLogQuery — all query state + server wiring for a variant
// ---------------------------------------------------------------------------

export type LogQuery = ReturnType<typeof useLogQuery>;

export function useLogQuery(initialLogs: LogRow[]) {
  const [logs, setLogs] = useState<LogRow[]>(initialLogs);
  const [expr, setExpr] = useState<FilterExpr | null>(null);
  const [levels, setLevels] = useState<string[]>([]);
  const [range, setRange] = useState<LogDateRange>({ start: null, end: null });
  const [sort, setSort] = useState<SortState>({ column: "timestamp", direction: "desc" });
  const [page, setPage] = useState(1);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  function refresh(
    nextExpr: FilterExpr | null,
    nextLevels: string[],
    nextSort: SortState,
    nextRange: LogDateRange,
  ) {
    startTransition(async () => {
      setLogs(await search(nextExpr, nextLevels, nextSort.direction, nextRange));
      setPage(1);
    });
  }

  return {
    logs,
    expr,
    levels,
    range,
    sort,
    page,
    setPage,
    pending,
    busy,
    reload: () => refresh(expr, levels, sort, range),
    onSearch(next: FilterExpr | null) {
      setExpr(next);
      refresh(next, levels, sort, range);
    },
    onLevels(next: string[]) {
      setLevels(next);
      refresh(expr, next, sort, range);
    },
    onRange(next: LogDateRange) {
      setRange(next);
      refresh(expr, levels, sort, next);
    },
    onSort(next: SortState) {
      setSort(next);
      refresh(expr, levels, next, range);
    },
    async onSimulate(id: string) {
      setBusy(id);
      await simulate(id);
      setBusy(null);
      refresh(expr, levels, sort, range);
    },
  };
}

// ---------------------------------------------------------------------------
// Presentational building blocks
// ---------------------------------------------------------------------------

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">{children}</span>
  );
}

export function SimulatePanel({ q, className }: { q: LogQuery; className?: string }) {
  return (
    <div className={`flex flex-wrap gap-2 ${className ?? ""}`}>
      {SCENARIOS.map((s) => (
        <button
          key={s.id}
          title={s.description}
          disabled={q.busy !== null}
          onClick={() => q.onSimulate(s.id)}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          {q.busy === s.id ? "…" : s.label}
        </button>
      ))}
    </div>
  );
}

export function LevelFilter({ q }: { q: LogQuery }) {
  return (
    <div className="log-levels">
      <LogLevelFilter levels={DEMO_LEVELS} value={q.levels} onChange={q.onLevels} />
    </div>
  );
}

export function SearchField({ q }: { q: LogQuery }) {
  return (
    <div className="log-search">
      <LogSearchBar
        logs={q.logs}
        onSearch={q.onSearch}
        placeholder="service:'db' || service:'payments'   statusCode:>='500'"
      />
    </div>
  );
}

export function DateRangeField({
  q,
  hideCustomRange,
  hideQuickRanges,
}: {
  q: LogQuery;
  hideCustomRange?: boolean;
  hideQuickRanges?: boolean;
}) {
  return (
    <div className="log-daterange">
      <LogDateRangePicker
        value={q.range}
        onChange={q.onRange}
        hideCustomRange={hideCustomRange}
        hideQuickRanges={hideQuickRanges}
      />
    </div>
  );
}

function Pager({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage: (p: number) => void;
}) {
  const btn =
    "rounded border border-slate-300 px-2 py-1 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800";
  return (
    <div className="flex items-center justify-center gap-1 text-xs">
      {page > 1 && (
        <>
          <button className={btn} onClick={() => onPage(1)} aria-label="First page">« First</button>
          <button className={btn} onClick={() => onPage(page - 1)} aria-label="Previous page">‹ Prev</button>
        </>
      )}
      <span className="px-3 text-slate-500 dark:text-slate-400" aria-live="polite">
        Page {page} of {pageCount}
      </span>
      {page < pageCount && (
        <>
          <button className={btn} onClick={() => onPage(page + 1)} aria-label="Next page">Next ›</button>
          <button className={btn} onClick={() => onPage(pageCount)} aria-label="Last page">Last »</button>
        </>
      )}
    </div>
  );
}

export function ResultsView({ q, dense }: { q: LogQuery; dense?: boolean }) {
  const pageCount = Math.max(1, Math.ceil(q.logs.length / PAGE_SIZE));
  const currentPage = Math.min(q.page, pageCount);
  const pageLogs = q.logs.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
      <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-2 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
        <span>{q.logs.length} result{q.logs.length === 1 ? "" : "s"}</span>
        <span className={q.pending ? "text-sky-500" : "invisible"}>loading…</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className={`log-table-wrap log-table ${dense ? "log-table-dense" : ""}`}>
          <LogTable sort={q.sort} onSortChange={q.onSort} extraColumns={COLUMNS}>
            {pageLogs.map((log) => (
              <LogTableRowGroup key={log.id} log={log} />
            ))}
          </LogTable>
        </div>

        <div className="log-cards">
          {pageLogs.map((log) => (
            <LogCard key={log.id} log={log} fields={COLUMNS} />
          ))}
        </div>

        {q.logs.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-slate-400">
            No logs in range — hit a “Simulate” button, or widen the date range.
          </p>
        )}
      </div>

      {q.logs.length > 0 && (
        <div className="shrink-0 border-t border-slate-200 px-4 py-2 dark:border-slate-800">
          <Pager page={currentPage} pageCount={pageCount} onPage={q.setPage} />
        </div>
      )}
    </section>
  );
}

export function PurgeControl({ q }: { q: LogQuery }) {
  const [show, setShow] = useState(false);
  const [purging, setPurging] = useState(false);
  const [untilDate, setUntilDate] = useState("");

  async function handlePurge() {
    setPurging(true);
    await purge(new Date(untilDate).toISOString());
    setPurging(false);
    setShow(false);
    q.reload();
  }

  return (
    <>
      <button
        onClick={() => setShow(true)}
        className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-500/20 dark:text-red-300"
      >
        Purge logs…
      </button>
      <PurgeLogsDialog
        show={show}
        purging={purging}
        untilDate={untilDate}
        onUntilDateChange={setUntilDate}
        onConfirm={handlePurge}
        onCancel={() => setShow(false)}
      />
    </>
  );
}
