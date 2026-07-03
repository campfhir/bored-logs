import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LogTable, LogTableRow, LogTableRowGroup, LogTableRowExpanded } from "../../components/log-table";
import type { LogRow } from "../../logger/adapter";

const sampleLogs: LogRow[] = [
  {
    id: "1",
    level: "info",
    message: "User logged in",
    meta: { userId: "abc", env: "prod", request_id: "req-001" },
    timestamp: "2024-06-01T12:00:00.000Z",
  },
  {
    id: "2",
    level: "error",
    message: "Database connection failed",
    meta: { env: "prod" },
    timestamp: "2024-06-01T12:01:00.000Z",
  },
];

describe("LogTable", () => {
  describe("empty state", () => {
    it("renders a table with empty tbody when no children are provided", () => {
      const { container } = render(<LogTable />);
      expect(container.querySelector("table")).toBeInTheDocument();
      expect(container.querySelector("tbody")!.children).toHaveLength(0);
    });

    it("renders footer when provided with no rows", () => {
      render(<LogTable footer={<span>Page 1</span>} />);
      expect(screen.getByRole("table")).toBeInTheDocument();
      expect(screen.getByText("Page 1")).toBeInTheDocument();
    });
  });

  describe("built-in columns", () => {
    it("renders column headers", () => {
      render(<LogTable>{sampleLogs.map((l) => <LogTableRow key={l.id} log={l} />)}</LogTable>);
      expect(screen.getByText("Timestamp")).toBeInTheDocument();
      expect(screen.getByText("Level")).toBeInTheDocument();
      expect(screen.getByText("Message")).toBeInTheDocument();
    });

    it("does not render a Request ID column by default", () => {
      render(<LogTable>{sampleLogs.map((l) => <LogTableRow key={l.id} log={l} />)}</LogTable>);
      expect(screen.queryByText("Request ID")).not.toBeInTheDocument();
    });

    it("renders a row for each log entry", () => {
      render(<LogTable>{sampleLogs.map((l) => <LogTableRow key={l.id} log={l} />)}</LogTable>);
      expect(screen.getByText("User logged in")).toBeInTheDocument();
      expect(screen.getByText("Database connection failed")).toBeInTheDocument();
    });

    it("displays the log level", () => {
      render(<LogTable>{sampleLogs.map((l) => <LogTableRow key={l.id} log={l} />)}</LogTable>);
      expect(screen.getByText("info")).toBeInTheDocument();
      expect(screen.getByText("error")).toBeInTheDocument();
    });
  });

  describe("sortable headers", () => {
    it("does not make headers clickable without onSortChange", () => {
      render(<LogTable>{sampleLogs.map((l) => <LogTableRow key={l.id} log={l} />)}</LogTable>);
      const th = screen.getByText("Timestamp").closest("th")!;
      expect(th.onclick).toBeNull();
    });

    it("calls onSortChange with asc when an unsorted header is clicked", () => {
      const onSortChange = vi.fn();
      render(
        <LogTable onSortChange={onSortChange}>
          {sampleLogs.map((l) => <LogTableRow key={l.id} log={l} />)}
        </LogTable>,
      );
      fireEvent.click(screen.getByText("Timestamp"));
      expect(onSortChange).toHaveBeenCalledWith({ column: "timestamp", direction: "asc" });
    });

    it("toggles to desc when the active asc column is clicked", () => {
      const onSortChange = vi.fn();
      render(
        <LogTable sort={{ column: "timestamp", direction: "asc" }} onSortChange={onSortChange}>
          {sampleLogs.map((l) => <LogTableRow key={l.id} log={l} />)}
        </LogTable>,
      );
      fireEvent.click(screen.getByText("Timestamp"));
      expect(onSortChange).toHaveBeenCalledWith({ column: "timestamp", direction: "desc" });
    });

    it("sets data-sort attribute on the active column header", () => {
      render(
        <LogTable sort={{ column: "level", direction: "desc" }} onSortChange={vi.fn()}>
          {sampleLogs.map((l) => <LogTableRow key={l.id} log={l} />)}
        </LogTable>,
      );
      const th = screen.getByText("Level").closest("th")!;
      expect(th).toHaveAttribute("data-sort", "desc");
    });

    it("does not set data-sort on inactive column headers", () => {
      render(
        <LogTable sort={{ column: "level", direction: "asc" }} onSortChange={vi.fn()}>
          {sampleLogs.map((l) => <LogTableRow key={l.id} log={l} />)}
        </LogTable>,
      );
      const th = screen.getByText("Timestamp").closest("th")!;
      expect(th).not.toHaveAttribute("data-sort");
    });
  });

  describe("extra columns", () => {
    it("renders extra column headers", () => {
      render(
        <LogTable extraColumns={[{ key: "env" }]}>
          {sampleLogs.map((l) => <LogTableRow key={l.id} log={l} />)}
        </LogTable>,
      );
      expect(screen.getByText("env")).toBeInTheDocument();
    });

    it("uses a custom label when provided", () => {
      render(
        <LogTable extraColumns={[{ key: "env", label: "Environment" }]}>
          {sampleLogs.map((l) => <LogTableRow key={l.id} log={l} />)}
        </LogTable>,
      );
      expect(screen.getByText("Environment")).toBeInTheDocument();
    });

    it("renders meta values in extra column cells", () => {
      render(
        <LogTable extraColumns={[{ key: "env" }]}>
          {sampleLogs.map((l) => <LogTableRow key={l.id} log={l} />)}
        </LogTable>,
      );
      expect(screen.getAllByText("prod")).toHaveLength(2);
    });

    it("shows a dash when the meta key is absent on a row", () => {
      const { container } = render(
        <LogTable extraColumns={[{ key: "userId" }]}>
          {sampleLogs.map((l) => <LogTableRow key={l.id} log={l} />)}
        </LogTable>,
      );
      const cells = container.querySelectorAll("td[data-column='userId']");
      expect(cells[0]).toHaveTextContent("abc");
      expect(cells[1]).toHaveTextContent("—");
    });

    it("uses a custom render function when provided", () => {
      render(
        <LogTable extraColumns={[{ key: "env", render: (v) => <strong>{String(v)}</strong> }]}>
          {sampleLogs.map((l) => <LogTableRow key={l.id} log={l} />)}
        </LogTable>,
      );
      expect(screen.getAllByRole("strong")).toHaveLength(2);
    });

    it("renders request_id from meta", () => {
      const { container } = render(
        <LogTable extraColumns={[{ key: "request_id", label: "Request ID" }]}>
          {sampleLogs.map((l) => <LogTableRow key={l.id} log={l} />)}
        </LogTable>,
      );
      expect(screen.getByText("Request ID")).toBeInTheDocument();
      const cells = container.querySelectorAll("td[data-column='request_id']");
      expect(cells[0]).toHaveTextContent("req-001");
      expect(cells[1]).toHaveTextContent("—");
    });

    it("uses a value accessor to resolve cell content", () => {
      render(
        <LogTable extraColumns={[{ key: "id", label: "ID", value: (log) => log.id }]}>
          {sampleLogs.map((l) => <LogTableRow key={l.id} log={l} />)}
        </LogTable>,
      );
      expect(screen.getByText("1")).toBeInTheDocument();
      expect(screen.getByText("2")).toBeInTheDocument();
    });

    it("extra columns are sortable when onSortChange is provided", () => {
      const onSortChange = vi.fn();
      render(
        <LogTable extraColumns={[{ key: "env", label: "Environment" }]} onSortChange={onSortChange}>
          {sampleLogs.map((l) => <LogTableRow key={l.id} log={l} />)}
        </LogTable>,
      );
      fireEvent.click(screen.getByText("Environment"));
      expect(onSortChange).toHaveBeenCalledWith({ column: "env", direction: "asc" });
    });
  });

  describe("footer", () => {
    it("renders footer content inside tfoot", () => {
      render(
        <LogTable footer={<span>Page 1 of 3</span>}>
          {sampleLogs.map((l) => <LogTableRow key={l.id} log={l} />)}
        </LogTable>,
      );
      expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    });

    it("does not render tfoot when footer is not provided", () => {
      const { container } = render(
        <LogTable>{sampleLogs.map((l) => <LogTableRow key={l.id} log={l} />)}</LogTable>,
      );
      expect(container.querySelector("tfoot")).toBeNull();
    });
  });

  describe("LogTableRow", () => {
    it("calls onClick with the log when the row is clicked", () => {
      const onClick = vi.fn();
      render(
        <LogTable>
          <LogTableRow log={sampleLogs[0]} onClick={onClick} />
        </LogTable>,
      );
      fireEvent.click(screen.getByText("User logged in"));
      expect(onClick).toHaveBeenCalledWith(sampleLogs[0]);
    });

    it("sets data-clickable when onClick is provided", () => {
      const { container } = render(
        <LogTable>
          <LogTableRow log={sampleLogs[0]} onClick={vi.fn()} />
        </LogTable>,
      );
      expect(container.querySelector("tr[data-clickable]")).toBeInTheDocument();
    });

    it("does not set data-clickable without onClick", () => {
      const { container } = render(
        <LogTable>
          <LogTableRow log={sampleLogs[0]} />
        </LogTable>,
      );
      expect(container.querySelector("tr[data-clickable]")).toBeNull();
    });
  });

  describe("LogTableRowExpanded", () => {
    it("renders children when open", () => {
      render(
        <LogTable>
          <LogTableRowExpanded open><span>Detail content</span></LogTableRowExpanded>
        </LogTable>,
      );
      expect(screen.getByText("Detail content")).toBeInTheDocument();
    });

    it("renders nothing when open is false", () => {
      render(
        <LogTable>
          <LogTableRowExpanded open={false}><span>Detail content</span></LogTableRowExpanded>
        </LogTable>,
      );
      expect(screen.queryByText("Detail content")).not.toBeInTheDocument();
    });

    it("sets data-expanded on the row", () => {
      const { container } = render(
        <LogTable>
          <LogTableRowExpanded open>content</LogTableRowExpanded>
        </LogTable>,
      );
      expect(container.querySelector("tr[data-expanded]")).toBeInTheDocument();
    });

    it("spans all columns including extra columns", () => {
      const { container } = render(
        <LogTable extraColumns={[{ key: "env" }, { key: "level" }]}>
          <LogTableRowExpanded open>content</LogTableRowExpanded>
        </LogTable>,
      );
      const td = container.querySelector("tr[data-expanded] td")!;
      expect(td).toHaveAttribute("colspan", "5");
    });
  });

  describe("LogTableRowGroup", () => {
    it("toggles expanded row on click", () => {
      render(
        <LogTable>
          <LogTableRowGroup log={sampleLogs[0]}>
            <span>Meta details</span>
          </LogTableRowGroup>
        </LogTable>,
      );
      expect(screen.queryByText("Meta details")).not.toBeInTheDocument();
      fireEvent.click(screen.getByText("User logged in"));
      expect(screen.getByText("Meta details")).toBeInTheDocument();
      fireEvent.click(screen.getByText("User logged in"));
      expect(screen.queryByText("Meta details")).not.toBeInTheDocument();
    });

    it("renders default JSON meta dump when no children provided", () => {
      render(
        <LogTable>
          <LogTableRowGroup log={sampleLogs[0]} />
        </LogTable>,
      );
      fireEvent.click(screen.getByText("User logged in"));
      expect(screen.getByText(/userId/)).toBeInTheDocument();
    });
  });
});
