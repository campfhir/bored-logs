"use client";

import { useState, type ReactNode, type ReactElement } from "react";
import type { LogRow } from "../logger/adapter";
import { formatTimestamp, type ExtraColumn } from "./log-table";

// ---------------------------------------------------------------------------
// LogCard — a single log rendered as a card, for narrow / mobile layouts where
// a table doesn't fit. Style-less like the other components: it only provides
// semantic elements and `data-*` hooks. Fields reuse the same {@link ExtraColumn}
// shape as LogTable's `extraColumns`, so the same config drives both views.
//
// Expand/collapse state is built in (click or keyboard on the header), mirroring
// LogTableRowGroup; the expanded panel defaults to a JSON dump of `log.meta`.
// ---------------------------------------------------------------------------

/** A meta field shown on the card — identical shape to LogTable's ExtraColumn. */
export type LogCardField = ExtraColumn;

/** Props for {@link LogCard}. */
export type LogCardProps = {
  log: LogRow;
  /** Meta fields to surface as labelled rows. Defaults to none. */
  fields?: LogCardField[];
  /** Expanded detail content. Defaults to a JSON dump of `log.meta`. */
  children?: ReactNode;
  /** Render the card expanded initially. */
  defaultOpen?: boolean;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
  expandedClassName?: string;
};

/**
 * Renders a single log entry as a style-less `<article>` card for narrow or
 * mobile layouts where a table doesn't fit. Shows the level, timestamp, and
 * message, optionally surfaces meta `fields` as a labelled list, and has a
 * built-in expand/collapse detail panel (defaulting to a JSON dump of
 * `log.meta`).
 */
export function LogCard({
  log,
  fields = [],
  children,
  defaultOpen = false,
  className,
  headerClassName,
  bodyClassName,
  expandedClassName,
}: LogCardProps): ReactElement {
  const [open, setOpen] = useState(defaultOpen);

  function toggle() {
    setOpen((o) => !o);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  }

  return (
    <article data-log-card data-level={log.level} className={className}>
      <header
        data-log-card-header
        className={headerClassName}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={onKeyDown}
      >
        <span data-level={log.level}>{log.level}</span>
        <time data-log-card-time dateTime={log.timestamp ?? undefined}>
          {formatTimestamp(log.timestamp)}
        </time>
      </header>

      <p data-log-card-message className={bodyClassName}>
        {log.message}
      </p>

      {fields.length > 0 && (
        <dl data-log-card-fields>
          {fields.map((f) => {
            const value = f.value ? f.value(log) : log.meta[f.key];
            return (
              <div data-log-card-field key={f.key}>
                <dt>{f.label ?? f.key}</dt>
                <dd data-column={f.key}>
                  {f.render ? f.render(value, log) : value != null ? String(value) : "—"}
                </dd>
              </div>
            );
          })}
        </dl>
      )}

      {open && (
        <div data-log-card-detail className={expandedClassName}>
          {children ?? <pre>{JSON.stringify(log.meta, null, 2)}</pre>}
        </div>
      )}
    </article>
  );
}
