"use client";

import type { ReactElement } from "react";
import { LOG_LEVELS } from "../logger/adapter";

// ---------------------------------------------------------------------------
// LogLevelFilter
//
// A dedicated control for the log *level*, which is a first-class column with
// its own query option — NOT an attribute. Selecting levels here produces the
// array you pass to `query({ levels })`; it deliberately does not go through
// the free-text search bar / `attributeFilter`, where `level:'…'` would search
// a (non-existent) `level` attribute instead of the level column.
//
// Style-less like the other components: a `role="group"` of toggle buttons,
// each carrying `data-level` and `data-selected` hooks. Controlled — you own
// the selected `value`.
// ---------------------------------------------------------------------------

/** Built-in level names, most-verbose-last, as the default option set. */
const DEFAULT_LEVELS = Object.keys(LOG_LEVELS);

/** Props for {@link LogLevelFilter}. */
export type LogLevelFilterProps = {
  /** Selectable level names, in display order. Defaults to the built-in levels. */
  levels?: string[];
  /** Selected levels (controlled). Empty = no level filter (pass nothing to query). */
  value: string[];
  /** Called with the next selection whenever a level is toggled. */
  onChange: (levels: string[]) => void;
  className?: string;
};

/**
 * A controlled, style-less filter control for the log level. Renders a
 * `role="group"` of toggle buttons (one per level, each carrying `data-level`
 * and `data-selected` hooks) and calls `onChange` with the next selection —
 * the array you pass to `query({ levels })`.
 */
export default function LogLevelFilter({
  levels = DEFAULT_LEVELS,
  value,
  onChange,
  className,
}: LogLevelFilterProps): ReactElement {
  const selected = new Set(value);

  function toggle(level: string) {
    const next = new Set(selected);
    if (next.has(level)) next.delete(level);
    else next.add(level);
    // Emit in the option order, keeping only known levels.
    onChange(levels.filter((l) => next.has(l)));
  }

  return (
    <div className={className} role="group" aria-label="Filter by level" data-log-level-filter>
      {levels.map((level) => {
        const on = selected.has(level);
        return (
          <button
            key={level}
            type="button"
            aria-pressed={on}
            data-level={level}
            data-selected={on || undefined}
            onClick={() => toggle(level)}
          >
            {level}
          </button>
        );
      })}
    </div>
  );
}
