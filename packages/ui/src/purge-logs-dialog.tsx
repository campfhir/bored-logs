"use client";

import type { ReactElement } from "react";

/** Props for {@link PurgeLogsDialog}. */
type Props = {
  className?: string;
  show: boolean;
  purging: boolean;
  untilDate: string;
  onUntilDateChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * A confirmation dialog for deleting all log entries before a chosen date.
 * Renders a modal `role="dialog"` with a date input and Cancel/Purge buttons
 * (disabled while `purging`) when `show` is true, and nothing otherwise. It is
 * controlled — the consumer owns the date value and confirm/cancel handlers.
 */
export default function PurgeLogsDialog({
  className,
  show,
  purging,
  untilDate,
  onUntilDateChange,
  onConfirm,
  onCancel,
}: Props): ReactElement | null {
  if (!show) return null;

  return (
    <div className={className} role="dialog" aria-modal="true" aria-labelledby="purge-dialog-title">
      <h3 id="purge-dialog-title">Purge Logs</h3>

      <p>
        Delete all log entries before the selected date. This action cannot be
        undone.
      </p>

      <label htmlFor="purge-until-date">Purge logs before</label>
      <input
        id="purge-until-date"
        type="date"
        value={untilDate}
        onChange={(e) => onUntilDateChange(e.target.value)}
        disabled={purging}
      />

      <button onClick={onCancel} disabled={purging}>
        Cancel
      </button>
      <button onClick={onConfirm} disabled={purging || !untilDate}>
        {purging ? "Purging..." : "Purge"}
      </button>
    </div>
  );
}
