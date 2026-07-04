import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import LogSearchBar, { LogSearchSyntaxHelp } from "../../components/log-search-bar";
import type { FilterExpr } from "../../components/log-search-bar";
import type { LogRow } from "../../logger/adapter";

const logs: LogRow[] = [
  {
    id: "1",
    level: "info",
    message: "User logged in",
    meta: { env: "prod", request_id: "req-001", service: "auth" },
    timestamp: "2024-06-01T12:00:00.000Z",
  },
  {
    id: "2",
    level: "error",
    message: "Database connection failed",
    meta: { env: "staging", request_id: "req-002", service: "db" },
    timestamp: "2024-06-01T12:01:00.000Z",
  },
];

function getInput() {
  return screen.getByRole("textbox") as HTMLInputElement;
}

function type(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

// ---------------------------------------------------------------------------
// LogSearchSyntaxHelp
// ---------------------------------------------------------------------------

describe("LogSearchSyntaxHelp", () => {
  it("renders a syntax reference", () => {
    render(<LogSearchSyntaxHelp />);
    expect(screen.getByText("contains")).toBeInTheDocument();
    expect(screen.getByText("equals")).toBeInTheDocument();
    expect(screen.getByText("not contains")).toBeInTheDocument();
    expect(screen.getByText("not equals")).toBeInTheDocument();
    expect(screen.getByText("greater than")).toBeInTheDocument();
    expect(screen.getByText("less than")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// LogSearchBar — base behaviour
// ---------------------------------------------------------------------------

describe("LogSearchBar", () => {
  it("renders nothing when hidden", () => {
    const { container } = render(<LogSearchBar hidden />);
    expect(container).toBeEmptyDOMElement();
  });

  it("commits a token on Enter and clears the input", () => {
    const onSearch = vi.fn();
    render(<LogSearchBar onSearch={onSearch} />);
    const input = getInput();
    type(input, "level:'error'");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSearch).toHaveBeenCalledOnce();
    expect(input.value).toBe("");
  });

  it("removes the last chip on Backspace when input is empty", () => {
    const onSearch = vi.fn();
    render(<LogSearchBar onSearch={onSearch} />);
    const input = getInput();
    type(input, "level:'error'");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSearch).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(onSearch).toHaveBeenCalledTimes(2);
    expect(onSearch.mock.calls[1][0]).toBeNull();
  });

  it("shows a clear button when there is input text", () => {
    render(<LogSearchBar />);
    const input = getInput();
    type(input, "foo");
    expect(screen.getByRole("button", { name: "Clear search" })).toBeInTheDocument();
  });

  it("clears everything when the clear button is clicked", () => {
    const onSearch = vi.fn();
    render(<LogSearchBar onSearch={onSearch} />);
    const input = getInput();
    type(input, "level:'error'");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onSearch).toHaveBeenLastCalledWith(null);
    expect(input.value).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

describe("LogSearchBar autocomplete", () => {
  it("shows no suggestions without a logs prop", () => {
    render(<LogSearchBar />);
    type(getInput(), "lev");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  describe("key stage", () => {
    it("shows matching meta keys as suggestions", () => {
      render(<LogSearchBar logs={logs} />);
      type(getInput(), "env");
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "env" })).toBeInTheDocument();
    });

    it("includes always-suggested keys", () => {
      render(<LogSearchBar logs={logs} />);
      type(getInput(), "lev");
      expect(screen.getByRole("option", { name: "level" })).toBeInTheDocument();
    });

    it("filters suggestions by typed prefix", () => {
      render(<LogSearchBar logs={logs} />);
      type(getInput(), "ser");
      expect(screen.getByRole("option", { name: "service" })).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: "env" })).not.toBeInTheDocument();
    });

    it("tags built-in fields as builtin, distinct from attributes", () => {
      render(<LogSearchBar logs={logs} />);
      type(getInput(), "e"); // matches built-ins (level/message/timestamp) and attrs
      expect(screen.getByRole("option", { name: "level" })).toHaveAttribute("data-kind", "builtin");
      expect(screen.getByRole("option", { name: "env" })).toHaveAttribute("data-kind", "attribute");
    });

    it("lists built-in fields before attributes", () => {
      render(<LogSearchBar logs={logs} />);
      type(getInput(), "e");
      const kinds = screen.getAllByRole("option").map((o) => o.getAttribute("data-kind"));
      // No attribute appears before the last built-in.
      expect(kinds.lastIndexOf("builtin")).toBeLessThan(kinds.indexOf("attribute"));
    });

    it("does not duplicate a built-in when an attribute shares its name", () => {
      const collidingLogs: LogRow[] = [
        { id: "1", level: "info", message: "m", meta: { level: "shadow", env: "prod" }, timestamp: null },
      ];
      render(<LogSearchBar logs={collidingLogs} />);
      type(getInput(), "level");
      const opts = screen.getAllByRole("option", { name: "level" });
      expect(opts).toHaveLength(1);
      expect(opts[0]).toHaveAttribute("data-kind", "builtin");
    });

    it("keeps the accessible name equal to the field name for built-ins", () => {
      render(<LogSearchBar logs={logs} />);
      type(getInput(), "lev");
      // The visible "built-in" tag is aria-hidden, so accepting still inserts level:.
      fireEvent.mouseDown(screen.getByRole("option", { name: "level" }));
      expect(getInput().value).toBe("level:");
    });
  });

  describe("operator stage", () => {
    it("shows operator suggestions after key:", () => {
      render(<LogSearchBar logs={logs} />);
      type(getInput(), "level:");
      const listbox = screen.getByRole("listbox");
      expect(listbox).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "' — contains" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "=' — equals" })).toBeInTheDocument();
    });

    it("narrows operators as the user types an operator prefix", () => {
      render(<LogSearchBar logs={logs} />);
      type(getInput(), "level:!");
      expect(screen.getByRole("option", { name: "!' — not contains" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "!=' — not equals" })).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: "' — contains" })).not.toBeInTheDocument();
    });
  });

  describe("value stage", () => {
    it("shows unique meta values for the key after opening quote", () => {
      render(<LogSearchBar logs={logs} />);
      type(getInput(), "env:'");
      // display is the raw value; the closing quote is part of insert, not display
      expect(screen.getByRole("option", { name: "prod" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "staging" })).toBeInTheDocument();
    });

    it("narrows values as the user types", () => {
      render(<LogSearchBar logs={logs} />);
      type(getInput(), "env:'pro");
      expect(screen.getByRole("option", { name: "prod" })).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: "staging" })).not.toBeInTheDocument();
    });
  });

  describe("Tab / Enter / Escape", () => {
    it("Tab cycles focus through suggestions", () => {
      render(<LogSearchBar logs={logs} />);
      const input = getInput();
      // "e" matches multiple keys (env, level, message, service, timestamp, request_id)
      type(input, "e");
      fireEvent.keyDown(input, { key: "Tab" });
      expect(screen.getAllByRole("option")[0]).toHaveAttribute("data-selected");
      fireEvent.keyDown(input, { key: "Tab" });
      expect(screen.getAllByRole("option")[1]).toHaveAttribute("data-selected");
    });

    it("Enter accepts the highlighted suggestion", () => {
      render(<LogSearchBar logs={logs} />);
      const input = getInput();
      type(input, "env");
      fireEvent.keyDown(input, { key: "Tab" }); // select first suggestion
      fireEvent.keyDown(input, { key: "Enter" });
      // First sorted suggestion among env/message/level/timestamp/request_id/service that includes "env" is "env"
      expect(input.value).toBe("env:");
    });

    it("Escape dismisses suggestions", () => {
      render(<LogSearchBar logs={logs} />);
      const input = getInput();
      type(input, "env");
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("key suggestions stay suppressed while still in key stage", () => {
      render(<LogSearchBar logs={logs} />);
      const input = getInput();
      type(input, "env");
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      // Typing more letters stays in key stage — still suppressed
      type(input, "envi");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("operator suggestions appear after Esc-suppressed key stage once ':' is typed", () => {
      render(<LogSearchBar logs={logs} />);
      const input = getInput();
      type(input, "env");
      fireEvent.keyDown(input, { key: "Escape" });
      // Typing ':' moves to operator stage — never suppressed
      type(input, "env:");
      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });

    it("value suggestions stay suppressed after Esc until token is committed", () => {
      render(<LogSearchBar logs={logs} />);
      const input = getInput();
      type(input, "env:'");
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      // Typing more stays in value stage — still suppressed
      type(input, "env:'p");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      // Committing the token resets suppression
      fireEvent.keyDown(input, { key: "Enter" });
      type(input, "env:'");
      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });
  });

  describe("special characters in meta keys and values", () => {
    const specialLogs: LogRow[] = [
      {
        id: "s1",
        level: "info",
        message: "test",
        meta: {
          "ns:field": "plain",
          "key's": "apostrophe-value",
          'key"s': "dquote-value",
          env: `say "hello"`,
          note: "it's done",
        },
        timestamp: null,
      },
    ];

    it("shows keys containing ':' as suggestions", () => {
      render(<LogSearchBar logs={specialLogs} />);
      type(getInput(), "ns");
      expect(screen.getByRole("option", { name: "ns:field" })).toBeInTheDocument();
    });

    it("shows keys containing \"'\" as suggestions", () => {
      render(<LogSearchBar logs={specialLogs} />);
      type(getInput(), "key");
      expect(screen.getByRole("option", { name: "key's" })).toBeInTheDocument();
    });

    it("shows keys containing '\"' as suggestions", () => {
      render(<LogSearchBar logs={specialLogs} />);
      type(getInput(), "key");
      expect(screen.getByRole("option", { name: 'key"s' })).toBeInTheDocument();
    });

    it("inserts quoted form when accepting a key with ':'", () => {
      render(<LogSearchBar logs={specialLogs} />);
      const input = getInput();
      type(input, "ns");
      fireEvent.mouseDown(screen.getByRole("option", { name: "ns:field" }));
      expect(input.value).toBe("'ns:field':");
    });

    it("inserts quoted+escaped form when accepting a key with \"'\"", () => {
      render(<LogSearchBar logs={specialLogs} />);
      const input = getInput();
      type(input, "key's");
      fireEvent.mouseDown(screen.getByRole("option", { name: "key's" }));
      expect(input.value).toBe("'key\\'s':");
    });

    it("shows values containing '\"' as suggestions", () => {
      render(<LogSearchBar logs={specialLogs} />);
      type(getInput(), "env:'");
      expect(screen.getByRole("option", { name: `say "hello"` })).toBeInTheDocument();
    });

    it("shows values containing \"'\" as suggestions", () => {
      render(<LogSearchBar logs={specialLogs} />);
      type(getInput(), "note:'");
      expect(screen.getByRole("option", { name: "it's done" })).toBeInTheDocument();
    });

    it("inserts escaped closing quote when accepting a value with \"'\"", () => {
      render(<LogSearchBar logs={specialLogs} />);
      const input = getInput();
      type(input, "note:'");
      fireEvent.mouseDown(screen.getByRole("option", { name: "it's done" }));
      expect(input.value).toBe("note:'it\\'s done'");
    });
  });

  it("clicking a suggestion accepts it", () => {
    render(<LogSearchBar logs={logs} />);
    const input = getInput();
    type(input, "env");
    fireEvent.mouseDown(screen.getByRole("option", { name: "env" }));
    expect(input.value).toBe("env:");
  });

  it("autocompletes a key typed inside a group", () => {
    render(<LogSearchBar logs={logs} />);
    const input = getInput();
    type(input, "level:'error' (env");
    fireEvent.mouseDown(screen.getByRole("option", { name: "env" }));
    expect(input.value).toBe("level:'error' (env:");
  });

  it("autocompletes a key typed after an || operator", () => {
    render(<LogSearchBar logs={logs} />);
    const input = getInput();
    type(input, "level:'error' ||env");
    fireEvent.mouseDown(screen.getByRole("option", { name: "env" }));
    expect(input.value).toBe("level:'error' ||env:");
  });
});

// ---------------------------------------------------------------------------
// Boolean expressions — OR / AND / grouping
// ---------------------------------------------------------------------------

describe("LogSearchBar — boolean expressions", () => {
  it("commits a whitespace-AND query as one chip per branch", () => {
    render(<LogSearchBar />);
    const input = getInput();
    type(input, "a:'1' b:'2'");
    fireEvent.keyDown(input, { key: "Enter" });
    const chips = document.querySelectorAll("[data-log-filter-chip]");
    expect(chips).toHaveLength(2);
  });

  it("commits an OR query as a single chip", () => {
    render(<LogSearchBar />);
    const input = getInput();
    type(input, "a:'1' || b:'2'");
    fireEvent.keyDown(input, { key: "Enter" });
    const chips = document.querySelectorAll("[data-log-filter-chip]");
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toContain("a:'1' || b:'2'");
  });

  it("round-trips a grouped query in the chip label", () => {
    render(<LogSearchBar />);
    const input = getInput();
    type(input, "(a:'1' b:'2') || c:'3'");
    fireEvent.keyDown(input, { key: "Enter" });
    const chip = document.querySelector("[data-log-filter-chip]")!;
    expect(chip.textContent).toContain("(a:'1' b:'2') || c:'3'");
  });

  it("emits the full expression tree via onSearch", () => {
    const onSearch = vi.fn<(e: FilterExpr | null) => void>();
    render(<LogSearchBar onSearch={onSearch} />);
    const input = getInput();
    type(input, "a:'1' || b:'2'");
    fireEvent.keyDown(input, { key: "Enter" });
    const expr = onSearch.mock.calls[0][0]!;
    expect(expr.type).toBe("and");
    expect(expr).toEqual({
      type: "and",
      nodes: [
        {
          type: "or",
          nodes: [
            { type: "filter", filter: { key: "a", operator: "contains", value: "1" } },
            { type: "filter", filter: { key: "b", operator: "contains", value: "2" } },
          ],
        },
      ],
    });
  });

  it("emits null via onSearch when cleared", () => {
    const onSearch = vi.fn<(e: FilterExpr | null) => void>();
    render(<LogSearchBar onSearch={onSearch} />);
    const input = getInput();
    type(input, "a:'1'");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onSearch).toHaveBeenLastCalledWith(null);
  });
});

// ---------------------------------------------------------------------------
// Editing chips
// ---------------------------------------------------------------------------

describe("LogSearchBar — editing chips", () => {
  function commit(input: HTMLInputElement, value: string) {
    type(input, value);
    fireEvent.keyDown(input, { key: "Enter" });
  }

  it("clicking a chip moves its expression back into the input and drops the chip", () => {
    render(<LogSearchBar />);
    const input = getInput();
    commit(input, "a:'1'");
    expect(document.querySelectorAll("[data-log-filter-chip]")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Edit filter a:'1'" }));
    expect(input.value).toBe("a:'1'");
    expect(document.querySelectorAll("[data-log-filter-chip]")).toHaveLength(0);
  });

  it("pulls the full expression of a boolean chip back for editing", () => {
    render(<LogSearchBar />);
    const input = getInput();
    commit(input, "a:'1' || b:'2'");
    fireEvent.click(screen.getByRole("button", { name: "Edit filter a:'1' || b:'2'" }));
    expect(input.value).toBe("a:'1' || b:'2'");
  });

  it("emits the reduced tree (without the edited chip) when editing starts", () => {
    const onSearch = vi.fn<(e: FilterExpr | null) => void>();
    render(<LogSearchBar onSearch={onSearch} />);
    const input = getInput();
    commit(input, "a:'1'");
    commit(input, "b:'2'");
    onSearch.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Edit filter a:'1'" }));
    expect(onSearch).toHaveBeenLastCalledWith({
      type: "and",
      nodes: [
        { type: "or", nodes: [{ type: "filter", filter: { key: "b", operator: "contains", value: "2" } }] },
      ],
    });
    expect(input.value).toBe("a:'1'");
  });

  it("re-commits the edited chip with the new value", () => {
    render(<LogSearchBar />);
    const input = getInput();
    commit(input, "a:'1'");
    fireEvent.click(screen.getByRole("button", { name: "Edit filter a:'1'" }));
    // clear and re-type an edited value
    type(input, "a:'2'");
    fireEvent.keyDown(input, { key: "Enter" });

    const chips = document.querySelectorAll("[data-log-filter-chip]");
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toContain("a:'2'");
    expect(chips[0].textContent).not.toContain("a:'1'");
  });

  it("keeps a separate remove (×) button on each chip", () => {
    render(<LogSearchBar />);
    const input = getInput();
    commit(input, "a:'1'");
    expect(screen.getByRole("button", { name: "Edit filter a:'1'" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove filter a:'1'" })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Debounced syntax / contradiction flagging
// ---------------------------------------------------------------------------

describe("LogSearchBar — debounced validation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not flag a syntax error mid-typing (before the debounce)", () => {
    render(<LogSearchBar debounceMs={300} />);
    type(getInput(), "a:'1' ||"); // incomplete OR — invalid, but still typing
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("flags a syntax error after the debounce elapses", () => {
    render(<LogSearchBar debounceMs={300} />);
    type(getInput(), "a:'1' ||");
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(getInput()).toHaveAttribute("aria-invalid", "true");
  });

  it("clears the syntax error as soon as the draft changes again", () => {
    render(<LogSearchBar debounceMs={300} />);
    const input = getInput();
    type(input, "a:'1' ||");
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    type(input, "a:'1' || b:'2'"); // now valid — error clears immediately
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("flags a syntax error immediately on Enter, without waiting", () => {
    render(<LogSearchBar debounceMs={300} />);
    const input = getInput();
    type(input, "a:'1' ||");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    // Nothing committed.
    expect(document.querySelectorAll("[data-log-filter-chip]")).toHaveLength(0);
  });

  it("warns when the query can never match, after the debounce", () => {
    render(<LogSearchBar debounceMs={300} />);
    type(getInput(), "a:='1' a:!='1'"); // contradiction
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("does not warn for a satisfiable query", () => {
    render(<LogSearchBar debounceMs={300} />);
    type(getInput(), "a:'1' b:'2'");
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
