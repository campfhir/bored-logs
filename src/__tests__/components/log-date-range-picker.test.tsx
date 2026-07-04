import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import LogDateRangePicker, {
  DEFAULT_QUICK_RANGES,
  type LogDateRange,
  type QuickRange,
} from "../../components/log-date-range-picker";

const EMPTY: LogDateRange = { start: null, end: null };

const startDate = () => screen.getByLabelText("Start date") as HTMLInputElement;
const startTime = () => screen.getByLabelText("Start time") as HTMLInputElement;
const endDate = () => screen.getByLabelText("End date") as HTMLInputElement;
const endTime = () => screen.getByLabelText("End time") as HTMLInputElement;

describe("LogDateRangePicker — quick ranges", () => {
  it("renders the default presets", () => {
    render(<LogDateRangePicker value={EMPTY} onChange={vi.fn()} />);
    for (const { label } of DEFAULT_QUICK_RANGES) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("emits the resolved range for a clicked preset", () => {
    const onChange = vi.fn();
    const quickRanges: QuickRange[] = [
      {
        label: "Fixed window",
        resolve: () => ({
          start: new Date("2024-01-01T00:00:00.000Z"),
          end: new Date("2024-01-02T00:00:00.000Z"),
        }),
      },
    ];
    render(<LogDateRangePicker value={EMPTY} onChange={onChange} quickRanges={quickRanges} />);
    fireEvent.click(screen.getByRole("button", { name: "Fixed window" }));
    expect(onChange).toHaveBeenCalledWith({
      start: "2024-01-01T00:00:00.000Z",
      end: "2024-01-02T00:00:00.000Z",
    });
  });

  it("treats an omitted preset end as an open upper bound", () => {
    const onChange = vi.fn();
    const quickRanges: QuickRange[] = [
      { label: "Since epoch", resolve: () => ({ start: new Date("1970-01-01T00:00:00.000Z") }) },
    ];
    render(<LogDateRangePicker value={EMPTY} onChange={onChange} quickRanges={quickRanges} />);
    fireEvent.click(screen.getByRole("button", { name: "Since epoch" }));
    expect(onChange).toHaveBeenCalledWith({ start: "1970-01-01T00:00:00.000Z", end: null });
  });

  it("default presets always yield start on or before end", () => {
    const onChange = vi.fn();
    render(<LogDateRangePicker value={EMPTY} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Last 24 hours" }));
    const { start, end } = onChange.mock.calls[0][0] as LogDateRange;
    expect(start).not.toBeNull();
    expect(end).not.toBeNull();
    expect(new Date(start!).getTime()).toBeLessThanOrEqual(new Date(end!).getTime());
  });
});

describe("LogDateRangePicker — custom range", () => {
  it("emits ISO strings for a valid start/end edit", () => {
    const onChange = vi.fn();
    render(<LogDateRangePicker value={EMPTY} onChange={onChange} />);
    fireEvent.change(startDate(), { target: { value: "2024-06-01" } });
    fireEvent.change(startTime(), { target: { value: "08:00" } });
    fireEvent.change(endDate(), { target: { value: "2024-06-01" } });
    fireEvent.change(endTime(), { target: { value: "10:00" } });
    const last = onChange.mock.calls.at(-1)![0] as LogDateRange;
    expect(last.start).not.toBeNull();
    expect(last.end).not.toBeNull();
    expect(new Date(last.start!).getTime()).toBeLessThanOrEqual(new Date(last.end!).getTime());
  });

  it("defaults the start time to start-of-day when only a date is picked", () => {
    const onChange = vi.fn();
    render(<LogDateRangePicker value={EMPTY} onChange={onChange} />);
    fireEvent.change(startDate(), { target: { value: "2024-06-01" } });
    // Time auto-fills so the bound applies immediately (the core Firefox fix).
    expect(startTime().value).toBe("00:00");
    const last = onChange.mock.calls.at(-1)![0] as LogDateRange;
    expect(last.start).toBe(new Date("2024-06-01T00:00").toISOString());
  });

  it("defaults the end time to end-of-day when only a date is picked", () => {
    const onChange = vi.fn();
    render(<LogDateRangePicker value={EMPTY} onChange={onChange} />);
    fireEvent.change(endDate(), { target: { value: "2024-06-01" } });
    expect(endTime().value).toBe("23:59");
    const last = onChange.mock.calls.at(-1)![0] as LogDateRange;
    expect(last.end).toBe(new Date("2024-06-01T23:59").toISOString());
  });

  it("flags and does not emit an invalid range (start after end)", () => {
    const onChange = vi.fn();
    render(<LogDateRangePicker value={EMPTY} onChange={onChange} />);
    fireEvent.change(endDate(), { target: { value: "2024-06-01" } });
    fireEvent.change(endTime(), { target: { value: "08:00" } });
    fireEvent.change(startDate(), { target: { value: "2024-06-01" } }); // start 00:00 <= 08:00, valid
    onChange.mockClear();
    fireEvent.change(startTime(), { target: { value: "12:00" } }); // 12:00 > 08:00, invalid
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(startTime()).toHaveAttribute("aria-invalid", "true");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("seeds the inputs from the controlled value", () => {
    render(
      <LogDateRangePicker
        value={{ start: "2024-06-01T08:30:00.000Z", end: null }}
        onChange={vi.fn()}
      />,
    );
    // Exact local strings are timezone-dependent; assert they recombine to the same instant.
    expect(new Date(`${startDate().value}T${startTime().value}`).toISOString()).toBe(
      "2024-06-01T08:30:00.000Z",
    );
    expect(endDate().value).toBe("");
    expect(endTime().value).toBe("");
  });
});

describe("LogDateRangePicker — visibility toggles", () => {
  it("hides quick ranges when hideQuickRanges is set", () => {
    render(<LogDateRangePicker value={EMPTY} onChange={vi.fn()} hideQuickRanges />);
    expect(screen.queryByRole("group", { name: "Quick date ranges" })).not.toBeInTheDocument();
    expect(startDate()).toBeInTheDocument();
  });

  it("hides the custom inputs when hideCustomRange is set", () => {
    render(<LogDateRangePicker value={EMPTY} onChange={vi.fn()} hideCustomRange />);
    expect(screen.queryByLabelText("Start date")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Quick date ranges" })).toBeInTheDocument();
  });
});
