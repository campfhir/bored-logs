import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import LogLevelFilter from "../../components/log-level-filter";
import { LOG_LEVELS } from "../../logger/adapter";

function toggles() {
  return screen.getAllByRole("button") as HTMLButtonElement[];
}

describe("LogLevelFilter", () => {
  it("renders one toggle per built-in level by default", () => {
    render(<LogLevelFilter value={[]} onChange={() => {}} />);
    expect(toggles()).toHaveLength(Object.keys(LOG_LEVELS).length);
    expect(screen.getByRole("button", { name: "error" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "info" })).toBeInTheDocument();
  });

  it("renders only the provided levels when `levels` is given, in order", () => {
    render(<LogLevelFilter levels={["info", "warn", "error"]} value={[]} onChange={() => {}} />);
    expect(toggles().map((b) => b.textContent)).toEqual(["info", "warn", "error"]);
  });

  it("marks selected levels via aria-pressed and data-selected", () => {
    render(<LogLevelFilter levels={["info", "error"]} value={["error"]} onChange={() => {}} />);
    const error = screen.getByRole("button", { name: "error" });
    const info = screen.getByRole("button", { name: "info" });
    expect(error).toHaveAttribute("aria-pressed", "true");
    expect(error).toHaveAttribute("data-selected");
    expect(info).toHaveAttribute("aria-pressed", "false");
    expect(info).not.toHaveAttribute("data-selected");
  });

  it("adds a level to the selection on click", () => {
    const onChange = vi.fn();
    render(<LogLevelFilter levels={["info", "error"]} value={["info"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "error" }));
    // emitted in option order, not click order
    expect(onChange).toHaveBeenCalledWith(["info", "error"]);
  });

  it("removes a level from the selection when toggled off", () => {
    const onChange = vi.fn();
    render(<LogLevelFilter levels={["info", "error"]} value={["info", "error"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "info" }));
    expect(onChange).toHaveBeenCalledWith(["error"]);
  });

  it("emits an empty array when the last level is deselected", () => {
    const onChange = vi.fn();
    render(<LogLevelFilter levels={["info"]} value={["info"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "info" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("exposes a labelled group with per-level data hooks", () => {
    render(<LogLevelFilter levels={["error"]} value={[]} onChange={() => {}} />);
    expect(screen.getByRole("group", { name: "Filter by level" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "error" })).toHaveAttribute("data-level", "error");
  });
});
