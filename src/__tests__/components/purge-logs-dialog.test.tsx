import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import PurgeLogsDialog from "../../components/purge-logs-dialog";

const defaultProps = {
  show: true,
  purging: false,
  untilDate: "2024-01-14",
  onUntilDateChange: vi.fn(),
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
};

describe("PurgeLogsDialog", () => {
  it("renders nothing when show is false", () => {
    const { container } = render(<PurgeLogsDialog {...defaultProps} show={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the dialog when show is true", () => {
    render(<PurgeLogsDialog {...defaultProps} />);
    expect(screen.getByRole("heading", { name: "Purge Logs" })).toBeInTheDocument();
  });

  it("shows the date input with the provided untilDate", () => {
    render(<PurgeLogsDialog {...defaultProps} />);
    expect(screen.getByDisplayValue("2024-01-14")).toBeInTheDocument();
  });

  it("calls onCancel when the Cancel button is clicked", () => {
    const onCancel = vi.fn();
    render(<PurgeLogsDialog {...defaultProps} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("calls onConfirm when the Purge button is clicked", () => {
    const onConfirm = vi.fn();
    render(<PurgeLogsDialog {...defaultProps} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Purge" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("disables both buttons while purging", () => {
    render(<PurgeLogsDialog {...defaultProps} purging={true} />);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Purging/ })).toBeDisabled();
  });

  it("shows 'Purging...' text on the confirm button while purging", () => {
    render(<PurgeLogsDialog {...defaultProps} purging={true} />);
    expect(screen.getByRole("button", { name: /Purging/ })).toBeInTheDocument();
  });

  it("calls onUntilDateChange when the date input changes", () => {
    const onUntilDateChange = vi.fn();
    render(<PurgeLogsDialog {...defaultProps} onUntilDateChange={onUntilDateChange} />);
    fireEvent.change(screen.getByDisplayValue("2024-01-14"), {
      target: { value: "2024-01-01" },
    });
    expect(onUntilDateChange).toHaveBeenCalledWith("2024-01-01");
  });

  it("disables the Purge button when untilDate is empty", () => {
    render(<PurgeLogsDialog {...defaultProps} untilDate="" />);
    expect(screen.getByRole("button", { name: "Purge" })).toBeDisabled();
  });
});
