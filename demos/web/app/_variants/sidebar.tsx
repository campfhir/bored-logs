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
  SectionLabel,
} from "../_lib/shared";

// Sidebar variant — filters live in a scrollable left rail; the results panel
// fills the rest. A good fit for dashboards with lots of controls.
export default function SidebarVariant({ initialLogs }: { initialLogs: LogRow[] }) {
  const q = useLogQuery(initialLogs);

  return (
    <main className="mx-auto flex h-full max-w-7xl gap-4 overflow-hidden px-4 py-5 sm:px-6">
      <aside className="flex w-72 shrink-0 flex-col gap-5 overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/50">
        <div className="flex flex-col gap-2">
          <SectionLabel>Search</SectionLabel>
          <SearchField q={q} />
        </div>
        <div className="flex flex-col gap-2">
          <SectionLabel>Level</SectionLabel>
          <LevelFilter q={q} />
        </div>
        <div className="flex flex-col gap-2">
          <SectionLabel>When</SectionLabel>
          <DateRangeField q={q} />
        </div>
        <div className="flex flex-col gap-2">
          <SectionLabel>Simulate</SectionLabel>
          <SimulatePanel q={q} />
        </div>
        <div className="mt-auto pt-2">
          <PurgeControl q={q} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <ResultsView q={q} />
      </div>
    </main>
  );
}
