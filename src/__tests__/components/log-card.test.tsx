import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { LogCard } from "../../components/log-card";
import type { LogRow } from "../../logger/adapter";

const log: LogRow = {
  id: "1",
  level: "error",
  message: "db connection failed",
  meta: { service: "db", statusCode: 500, requestId: "req-1" },
  timestamp: "2024-06-01T12:00:00.000Z",
};

describe("LogCard", () => {
  it("renders the level, message and timestamp", () => {
    render(<LogCard log={log} />);
    expect(screen.getByText("error")).toBeInTheDocument();
    expect(screen.getByText("db connection failed")).toBeInTheDocument();
    // formatted, not the raw ISO string
    expect(screen.queryByText("2024-06-01T12:00:00.000Z")).not.toBeInTheDocument();
    expect(document.querySelector("[data-log-card-time]")).toBeInTheDocument();
  });

  it("marks the card and level badge with the level", () => {
    render(<LogCard log={log} />);
    expect(document.querySelector("[data-log-card]")).toHaveAttribute("data-level", "error");
    expect(document.querySelector("[data-log-card-header] [data-level]")).toHaveAttribute(
      "data-level",
      "error",
    );
  });

  it("renders requested fields with labels, values and data-column", () => {
    render(
      <LogCard
        log={log}
        fields={[
          { key: "service", label: "Service" },
          { key: "statusCode", label: "Status", render: (v) => <b>{`HTTP ${v}`}</b> },
        ]}
      />,
    );
    const fields = document.querySelector("[data-log-card-fields]")!;
    expect(within(fields as HTMLElement).getByText("Service")).toBeInTheDocument();
    expect(within(fields as HTMLElement).getByText("db")).toBeInTheDocument();
    expect(within(fields as HTMLElement).getByText("HTTP 500")).toBeInTheDocument();
    expect(fields.querySelector('[data-column="statusCode"]')).toBeInTheDocument();
  });

  it("renders no field list when no fields are given", () => {
    render(<LogCard log={log} />);
    expect(document.querySelector("[data-log-card-fields]")).not.toBeInTheDocument();
  });

  it("is collapsed by default and toggles detail on header click", () => {
    render(<LogCard log={log} />);
    const header = screen.getByRole("button");
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector("[data-log-card-detail]")).not.toBeInTheDocument();

    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    const detail = document.querySelector("[data-log-card-detail]")!;
    expect(detail.textContent).toContain('"requestId": "req-1"');

    fireEvent.click(header);
    expect(document.querySelector("[data-log-card-detail]")).not.toBeInTheDocument();
  });

  it("toggles with keyboard (Enter / Space)", () => {
    render(<LogCard log={log} />);
    const header = screen.getByRole("button");
    fireEvent.keyDown(header, { key: "Enter" });
    expect(header).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(header, { key: " " });
    expect(header).toHaveAttribute("aria-expanded", "false");
  });

  it("honours defaultOpen and custom detail children", () => {
    render(
      <LogCard log={log} defaultOpen>
        <span>custom detail</span>
      </LogCard>,
    );
    const detail = document.querySelector("[data-log-card-detail]")!;
    expect(detail.textContent).toBe("custom detail");
  });
});
