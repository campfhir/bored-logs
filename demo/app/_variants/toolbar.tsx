"use client";

import { useState } from "react";
import type { LogRow } from "@campfhir/bored-logs";
import { LogSearchSyntaxHelp } from "@campfhir/bored-logs/components";
import {
  useLogQuery,
  SimulatePanel,
  LevelFilter,
  SearchField,
  DateRangeField,
  ResultsView,
  PurgeControl,
  SectionLabel,
} from "../_lib/shared";

// Toolbar variant — the classic top-down layout: controls stacked in bands
// above a results panel that fills the remaining viewport height.
export default function ToolbarVariant({ initialLogs }: { initialLogs: LogRow[] }) {
  const q = useLogQuery(initialLogs);
  const [showHelp, setShowHelp] = useState(false);

  return (
    <main className="mx-auto flex h-full max-w-6xl flex-col gap-4 overflow-hidden px-4 py-5 sm:px-6">
      <header className="flex shrink-0 flex-wrap items-end justify-between gap-4">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Postgres-backed structured logging · live UI components · OR / AND / grouping search
        </p>
        <PurgeControl q={q} />
      </header>

      <section className="shrink-0 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/50">
        <SectionLabel>Simulate log activity</SectionLabel>
        <SimulatePanel q={q} className="mt-3" />
      </section>

      <section className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <SectionLabel>Level</SectionLabel>
          <LevelFilter q={q} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SectionLabel>When</SectionLabel>
          <DateRangeField q={q} />
        </div>
      </section>

      <section className="shrink-0">
        <div className="mb-2 flex items-center gap-3">
          <div className="flex-1">
            <SearchField q={q} />
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

      <ResultsView q={q} />
    </main>
  );
}
