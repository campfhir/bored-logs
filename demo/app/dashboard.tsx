"use client";

import { useState, useTransition } from "react";
import {
  LogTable,
  LogTableRowGroup,
  LogCard,
  LogSearchBar,
  LogSearchSyntaxHelp,
  LogLevelFilter,
  PurgeLogsDialog,
} from "@campfhir/bored-logs/components";
import type { SortState, ExtraColumn } from "@campfhir/bored-logs/components";
import type { FilterExpr, LogRow } from "@campfhir/bored-logs";
import { simulate, search, purge } from "./actions";
import { SCENARIOS } from "@/lib/scenarios";
import ThemeToggle from "./theme-toggle";

// The levels the demo actually generates (a curated subset of the built-ins).
const DEMO_LEVELS = ["debug", "info", "warn", "error", "critical"];
const PAGE_SIZE = 20;

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
const COLUMNS: ExtraColumn[] = [
  { key: "service", label: "Service" },
  { key: "statusCode", label: "Status", render: (v) => <StatusBadge value={v} /> },
  { key: "latencyMs", label: "Latency", render: (v) => <Latency value={v} /> },
];

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

export default function Dashboard({ initialLogs }: { initialLogs: LogRow[] }) {
  const [logs, setLogs] = useState<LogRow[]>(initialLogs);
  const [expr, setExpr] = useState<FilterExpr | null>(null);
  const [levels, setLevels] = useState<string[]>([]);
  const [sort, setSort] = useState<SortState>({ column: "timestamp", direction: "desc" });
  const [page, setPage] = useState(1);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  // Purge dialog
  const [showPurge, setShowPurge] = useState(false);
  const [purging, setPurging] = useState(false);
  const [untilDate, setUntilDate] = useState("");

  const pageCount = Math.max(1, Math.ceil(logs.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageLogs = logs.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  function refresh(nextExpr: FilterExpr | null, nextLevels: string[], nextSort: SortState) {
    startTransition(async () => {
      setLogs(await search(nextExpr, nextLevels, nextSort.direction));
      setPage(1);
    });
  }

  function handleSearch(next: FilterExpr | null) {
    setExpr(next);
    refresh(next, levels, sort);
  }

  function handleLevels(next: string[]) {
    setLevels(next);
    refresh(expr, next, sort);
  }

  function handleSort(next: SortState) {
    setSort(next);
    refresh(expr, levels, next);
  }

  async function handleSimulate(id: string) {
    setBusy(id);
    await simulate(id);
    setBusy(null);
    refresh(expr, levels, sort);
  }

  async function handlePurge() {
    setPurging(true);
    await purge(new Date(untilDate).toISOString());
    setPurging(false);
    setShowPurge(false);
    refresh(expr, levels, sort);
  }

  return (
    <main className="mx-auto flex h-dvh max-w-6xl flex-col gap-4 overflow-hidden px-4 py-5 sm:px-6">
      <header className="flex shrink-0 flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            bored-logs <span className="text-slate-400 dark:text-slate-500">demo</span>
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Postgres-backed structured logging · live UI components · OR / AND / grouping search
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <button
            onClick={() => setShowPurge(true)}
            className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-500/20 dark:text-red-300"
          >
            Purge logs…
          </button>
        </div>
      </header>

      {/* Simulate controls */}
      <section className="shrink-0 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/50">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Simulate log activity
        </h2>
        <div className="flex flex-wrap gap-2">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              title={s.description}
              disabled={busy !== null}
              onClick={() => handleSimulate(s.id)}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              {busy === s.id ? "…" : s.label}
            </button>
          ))}
        </div>
      </section>

      {/* Level filter — a first-class field with its own control (not the text bar) */}
      <section className="flex shrink-0 flex-wrap items-center gap-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Level</span>
        <div className="log-levels">
          <LogLevelFilter levels={DEMO_LEVELS} value={levels} onChange={handleLevels} />
        </div>
      </section>

      {/* Search */}
      <section className="shrink-0">
        <div className="mb-2 flex items-center gap-3">
          <div className="log-search flex-1">
            <LogSearchBar
              logs={logs}
              onSearch={handleSearch}
              placeholder="service:'db' || service:'payments'   statusCode:>='500'"
            />
          </div>
          <button
            onClick={() => setShowHelp((v) => !v)}
            className="shrink-0 rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            {showHelp ? "Hide syntax" : "Syntax help"}
          </button>
        </div>
        {showHelp && (
          <div className="log-help rounded-lg border border-slate-200 bg-white p-4 text-sm dark:border-slate-800 dark:bg-slate-900/60">
            <LogSearchSyntaxHelp />
          </div>
        )}
      </section>

      {/* Results — fills remaining viewport height; body scrolls between the
          sticky header row and the sticky pager footer. */}
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-2 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
          <span>{logs.length} result{logs.length === 1 ? "" : "s"}</span>
          <span className={pending ? "text-sky-500" : "invisible"}>loading…</span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {/* Desktop: table */}
          <div className="log-table-wrap log-table">
            <LogTable sort={sort} onSortChange={handleSort} extraColumns={COLUMNS}>
              {pageLogs.map((log) => (
                <LogTableRowGroup key={log.id} log={log} />
              ))}
            </LogTable>
          </div>

          {/* Mobile: cards */}
          <div className="log-cards">
            {pageLogs.map((log) => (
              <LogCard key={log.id} log={log} fields={COLUMNS} />
            ))}
          </div>

          {logs.length === 0 && (
            <p className="px-4 py-10 text-center text-sm text-slate-400">
              No logs yet — hit a “Simulate” button above.
            </p>
          )}
        </div>

        {logs.length > 0 && (
          <div className="shrink-0 border-t border-slate-200 px-4 py-2 dark:border-slate-800">
            <Pager page={currentPage} pageCount={pageCount} onPage={setPage} />
          </div>
        )}
      </section>

      <PurgeLogsDialog
        show={showPurge}
        purging={purging}
        untilDate={untilDate}
        onUntilDateChange={setUntilDate}
        onConfirm={handlePurge}
        onCancel={() => setShowPurge(false)}
      />
    </main>
  );
}
