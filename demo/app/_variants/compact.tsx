"use client";

import type { LogRow } from "@campfhir/bored-logs";
import {
  useLogQuery,
  SimulatePanel,
  LevelFilter,
  SearchField,
  DateRangeField,
  ResultsView,
  PurgeControl,
} from "../_lib/shared";

// Compact variant — one dense control bar (search grows, level chips, and
// quick-preset date ranges only) over a tight results table. Suited to
// embedding in an existing admin shell.
export default function CompactVariant({ initialLogs }: { initialLogs: LogRow[] }) {
  const q = useLogQuery(initialLogs);

  return (
    <main className="mx-auto flex h-full max-w-6xl flex-col gap-3 overflow-hidden px-4 py-4 sm:px-6">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="min-w-[16rem] flex-1">
          <SearchField q={q} />
        </div>
        <LevelFilter q={q} />
        {/* Quick presets only — no explicit date inputs in the compact bar. */}
        <DateRangeField q={q} hideCustomRange />
        <PurgeControl q={q} />
      </div>

      <details className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
        <summary className="cursor-pointer select-none">Simulate log activity</summary>
        <SimulatePanel q={q} className="mt-2" />
      </details>

      <ResultsView q={q} dense />
    </main>
  );
}
