"use client";

import { useState, useEffect, type ReactElement } from "react";

// ---------------------------------------------------------------------------
// LogDateRangePicker
//
// A controlled, style-less date-range control that pairs an explicit
// start/end range (validated so start <= end) with a set of quick "last X"
// presets. Emits ISO-8601 strings, matching `query({ start, end })`.
//
// Each bound is a separate date + time input rather than a single
// `datetime-local`: a `datetime-local` reports an empty value until BOTH its
// date and time sub-fields are filled, so picking only a date (the common
// case) silently sets nothing. Splitting them lets the date apply on its own,
// with the time defaulting to the start/end of that day until the user sets it.
//
// Style-less like the other components: it carries `data-log-date-range*`
// hooks and standard roles, and owns no styling. You control the `value`.
// ---------------------------------------------------------------------------

/** A start/end range as ISO-8601 strings (or null for an open bound). */
export type LogDateRange = {
  /** Inclusive lower bound, ISO-8601, or null for no lower bound. */
  start: string | null;
  /** Inclusive upper bound, ISO-8601, or null for no upper bound. */
  end: string | null;
};

/**
 * A quick "last X" preset. `resolve` is given the current time and returns the
 * concrete range to apply — return `end` as null (or omit it) for an open
 * upper bound.
 */
export type QuickRange = {
  /** Button label, e.g. `"Last 24 hours"`. */
  label: string;
  /** Resolve the preset to a concrete range, relative to `now`. */
  resolve: (now: Date) => { start: Date; end?: Date | null };
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

// When only a date is picked, the time defaults to the start of that day for
// the lower bound and the end of that day for the upper bound.
const START_DEFAULT_TIME = "00:00";
const END_DEFAULT_TIME = "23:59";

/** Sensible default presets: last 15 min, hour, 24 hours, 7 days, and 30 days. */
export const DEFAULT_QUICK_RANGES: QuickRange[] = [
  { label: "Last 15 min", resolve: (now) => ({ start: new Date(now.getTime() - 15 * MINUTE), end: now }) },
  { label: "Last hour", resolve: (now) => ({ start: new Date(now.getTime() - HOUR), end: now }) },
  { label: "Last 24 hours", resolve: (now) => ({ start: new Date(now.getTime() - DAY), end: now }) },
  { label: "Last 7 days", resolve: (now) => ({ start: new Date(now.getTime() - WEEK), end: now }) },
  { label: "Last 30 days", resolve: (now) => ({ start: new Date(now.getTime() - 30 * DAY), end: now }) },
];

const pad = (n: number) => String(n).padStart(2, "0");

/** Local `YYYY-MM-DD` for an ISO string, or "" when empty/invalid. */
function isoToLocalDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local `HH:mm` for an ISO string, or "" when empty/invalid. */
function isoToLocalTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Combine a local `YYYY-MM-DD` date and `HH:mm` time into an ISO string (null if no date). */
function partsToIso(date: string, time: string): string | null {
  if (!date) return null;
  const d = new Date(`${date}T${time}`); // interpreted in the local time zone
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Props for {@link LogDateRangePicker}. */
export type LogDateRangePickerProps = {
  /** The current range (controlled). */
  value: LogDateRange;
  /** Called with the next range whenever a valid change is made. Invalid ranges (start > end) are not emitted. */
  onChange: (range: LogDateRange) => void;
  /** Quick "last X" presets. Defaults to {@link DEFAULT_QUICK_RANGES}. */
  quickRanges?: QuickRange[];
  /** Hide the explicit start/end inputs, leaving only the quick presets. */
  hideCustomRange?: boolean;
  /** Hide the quick presets, leaving only the start/end inputs. */
  hideQuickRanges?: boolean;
  className?: string;
};

/**
 * A controlled, style-less date-range picker: separate start/end date and time
 * inputs (validated so start is on or before end) plus configurable quick
 * "last X" presets. Picking a date defaults its time to the start/end of that
 * day, so a date applies without also having to set a time. Emits ISO-8601
 * strings via `onChange`, ready to pass to `query({ start, end })`. An invalid
 * range (start after end) surfaces an alert and is not emitted.
 */
export default function LogDateRangePicker({
  value,
  onChange,
  quickRanges = DEFAULT_QUICK_RANGES,
  hideCustomRange,
  hideQuickRanges,
  className,
}: LogDateRangePickerProps): ReactElement {
  // The inputs keep their own draft state so an invalid (un-emitted) edit is
  // still reflected; they re-sync when the controlled value changes externally.
  const [startDate, setStartDate] = useState(() => isoToLocalDate(value.start));
  const [startTime, setStartTime] = useState(() => isoToLocalTime(value.start));
  const [endDate, setEndDate] = useState(() => isoToLocalDate(value.end));
  const [endTime, setEndTime] = useState(() => isoToLocalTime(value.end));

  useEffect(() => {
    setStartDate(isoToLocalDate(value.start));
    setStartTime(isoToLocalTime(value.start));
  }, [value.start]);
  useEffect(() => {
    setEndDate(isoToLocalDate(value.end));
    setEndTime(isoToLocalTime(value.end));
  }, [value.end]);

  const startIso = partsToIso(startDate, startTime || START_DEFAULT_TIME);
  const endIso = partsToIso(endDate, endTime || END_DEFAULT_TIME);
  const invalid = startIso != null && endIso != null && new Date(startIso) > new Date(endIso);

  function commit(sDate: string, sTime: string, eDate: string, eTime: string) {
    const start = partsToIso(sDate, sTime || START_DEFAULT_TIME);
    const end = partsToIso(eDate, eTime || END_DEFAULT_TIME);
    // Don't propagate an invalid range — the alert explains why.
    if (start != null && end != null && new Date(start) > new Date(end)) return;
    onChange({ start, end });
  }

  function changeStartDate(next: string) {
    // Default the time when a date is first set, so the bound applies at once.
    const time = next && !startTime ? START_DEFAULT_TIME : startTime;
    setStartDate(next);
    setStartTime(time);
    commit(next, time, endDate, endTime);
  }
  function changeStartTime(next: string) {
    setStartTime(next);
    commit(startDate, next, endDate, endTime);
  }
  function changeEndDate(next: string) {
    const time = next && !endTime ? END_DEFAULT_TIME : endTime;
    setEndDate(next);
    setEndTime(time);
    commit(startDate, startTime, next, time);
  }
  function changeEndTime(next: string) {
    setEndTime(next);
    commit(startDate, startTime, endDate, next);
  }

  function applyQuick(quick: QuickRange) {
    const { start, end } = quick.resolve(new Date());
    const range: LogDateRange = {
      start: start.toISOString(),
      end: end == null ? null : end.toISOString(),
    };
    setStartDate(isoToLocalDate(range.start));
    setStartTime(isoToLocalTime(range.start));
    setEndDate(isoToLocalDate(range.end));
    setEndTime(isoToLocalTime(range.end));
    onChange(range);
  }

  return (
    <div className={className} data-log-date-range>
      {!hideQuickRanges && (
        <div role="group" aria-label="Quick date ranges" data-log-date-range-quick>
          {quickRanges.map((quick) => (
            <button
              key={quick.label}
              type="button"
              data-log-date-range-quick-option
              onClick={() => applyQuick(quick)}
            >
              {quick.label}
            </button>
          ))}
        </div>
      )}

      {!hideCustomRange && (
        <div data-log-date-range-custom>
          <div data-log-date-range-start>
            <span>Start</span>
            <input
              type="date"
              value={startDate}
              aria-label="Start date"
              aria-invalid={invalid || undefined}
              onChange={(e) => changeStartDate(e.target.value)}
            />
            <input
              type="time"
              value={startTime}
              aria-label="Start time"
              aria-invalid={invalid || undefined}
              onChange={(e) => changeStartTime(e.target.value)}
            />
          </div>
          <div data-log-date-range-end>
            <span>End</span>
            <input
              type="date"
              value={endDate}
              aria-label="End date"
              aria-invalid={invalid || undefined}
              onChange={(e) => changeEndDate(e.target.value)}
            />
            <input
              type="time"
              value={endTime}
              aria-label="End time"
              aria-invalid={invalid || undefined}
              onChange={(e) => changeEndTime(e.target.value)}
            />
          </div>
          {invalid && (
            <span role="alert" data-log-date-range-error>
              Start must be on or before end.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
