"use server";

import type { FilterExpr, LogRow, LogLevel } from "@campfhir/bored-logs";
import { ensureBoredLogs } from "@/lib/logger";
import { SCENARIO_BY_ID } from "@/lib/scenarios";
import { splitLevelTerms } from "@/lib/split-levels";

/** Write one scenario's worth of fake logs and flush them to Postgres. */
export async function simulate(scenarioId: string): Promise<{ count: number }> {
  const { logger, adapter } = await ensureBoredLogs();

  const scenario = SCENARIO_BY_ID[scenarioId];
  if (!scenario) return { count: 0 };

  const records = scenario.generate();
  for (const r of records) logger.log(r.level, r.template, r.attrs);
  await adapter.flush();

  return { count: records.length };
}

/**
 * Query logs.
 *
 * `levels` comes from the dedicated <LogLevelFilter> — level is a first-class
 * column with its own query option, not a stored attribute. The `expr` boolean
 * tree from <LogSearchBar> drives message/attribute matching via
 * `attributeFilter`; as a convenience any `level:` term typed into the bar is
 * also lifted out and merged into `levels`.
 */
export async function search(
  expr: FilterExpr | null,
  levels: string[],
  sort: "asc" | "desc",
  range?: { start?: string | null; end?: string | null },
): Promise<LogRow[]> {
  const { adapter } = await ensureBoredLogs();

  const { levels: typed, filter } = splitLevelTerms(expr);
  const allLevels = Array.from(new Set([...levels, ...typed]));
  const res = await adapter.query({
    // Values are validated against LOG_LEVELS in splitLevelTerms / the filter UI.
    levels: allLevels.length ? (allLevels as LogLevel[]) : undefined,
    attributeFilter: filter ?? undefined,
    // From <LogDateRangePicker>. Omitting both falls back to the adapter's
    // default window (the last 24 hours).
    start: range?.start ?? undefined,
    end: range?.end ?? undefined,
    sort,
    limit: 200,
  });
  return res.ok ? res.val : [];
}

/** Delete every log strictly older than the given ISO date. */
export async function purge(untilISO: string): Promise<{ deleted: number }> {
  const { adapter } = await ensureBoredLogs();

  const res = await adapter.purge(new Date(untilISO));
  return { deleted: res.ok ? res.val : 0 };
}
