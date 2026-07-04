"use client";

import { useState, useEffect, type ReactElement } from "react";

// ---------------------------------------------------------------------------
// LogDateRangePicker
//
// A controlled, style-less date-range control that pairs an explicit
// start/end date-time range (validated so start <= end) with a set of quick
// "last X" presets. Emits ISO-8601 strings, matching `query({ start, end })`.
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

/** Sensible default presets: last 15 min, hour, 24 hours, 7 days, and 30 days. */
export const DEFAULT_QUICK_RANGES: QuickRange[] = [
  { label: "Last 15 min", resolve: (now) => ({ start: new Date(now.getTime() - 15 * MINUTE), end: now }) },
  { label: "Last hour", resolve: (now) => ({ start: new Date(now.getTime() - HOUR), end: now }) },
  { label: "Last 24 hours", resolve: (now) => ({ start: new Date(now.getTime() - DAY), end: now }) },
  { label: "Last 7 days", resolve: (now) => ({ start: new Date(now.getTime() - WEEK), end: now }) },
  { label: "Last 30 days", resolve: (now) => ({ start: new Date(now.getTime() - 30 * DAY), end: now }) },
];

/** Format an ISO string as a local `datetime-local` input value (`YYYY-MM-DDTHH:mm`). */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parse a local `datetime-local` value into an ISO string, or null when empty/invalid. */
function localInputToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local); // interpreted in the local time zone
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
 * A controlled, style-less date-range picker: explicit start/end `datetime-local`
 * inputs (validated so start is on or before end) plus configurable quick
 * "last X" presets. Emits ISO-8601 strings via `onChange`, ready to pass to
 * `query({ start, end })`. An invalid range (start after end) surfaces an alert
 * and is not emitted.
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
  const [startInput, setStartInput] = useState(() => isoToLocalInput(value.start));
  const [endInput, setEndInput] = useState(() => isoToLocalInput(value.end));

  useEffect(() => {
    setStartInput(isoToLocalInput(value.start));
  }, [value.start]);
  useEffect(() => {
    setEndInput(isoToLocalInput(value.end));
  }, [value.end]);

  const startIso = localInputToIso(startInput);
  const endIso = localInputToIso(endInput);
  const invalid = startIso != null && endIso != null && new Date(startIso) > new Date(endIso);

  function commitCustom(nextStart: string, nextEnd: string) {
    const start = localInputToIso(nextStart);
    const end = localInputToIso(nextEnd);
    // Don't propagate an invalid range — the alert explains why.
    if (start != null && end != null && new Date(start) > new Date(end)) return;
    onChange({ start, end });
  }

  function applyQuick(quick: QuickRange) {
    const { start, end } = quick.resolve(new Date());
    const range: LogDateRange = {
      start: start.toISOString(),
      end: end == null ? null : end.toISOString(),
    };
    setStartInput(isoToLocalInput(range.start));
    setEndInput(isoToLocalInput(range.end));
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
          <label data-log-date-range-start>
            <span>Start</span>
            <input
              type="datetime-local"
              value={startInput}
              aria-label="Start date and time"
              aria-invalid={invalid || undefined}
              onChange={(e) => {
                setStartInput(e.target.value);
                commitCustom(e.target.value, endInput);
              }}
            />
          </label>
          <label data-log-date-range-end>
            <span>End</span>
            <input
              type="datetime-local"
              value={endInput}
              aria-label="End date and time"
              aria-invalid={invalid || undefined}
              onChange={(e) => {
                setEndInput(e.target.value);
                commitCustom(startInput, e.target.value);
              }}
            />
          </label>
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
