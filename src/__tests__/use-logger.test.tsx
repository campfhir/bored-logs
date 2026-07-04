import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useEffect } from "react";
import { LoggerProvider, useLogger, useLogShipper } from "../client/context";
import type { Logger } from "../logger/logger";
import type { HttpAdapter } from "../adapters/http/adapter";
import { secure, redact } from "../logger/template";
import type { LogShipmentPayload } from "../adapters/http/types";

describe("LoggerProvider + useLogger", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("ships records logged through the provider's logger to the endpoint", async () => {
    let logger!: Logger;
    let ship!: HttpAdapter;
    function Probe() {
      logger = useLogger();
      ship = useLogShipper();
      return null;
    }

    render(
      // console disabled to keep test output clean; shipping is what we assert.
      <LoggerProvider endpoint="/api/logs" application="web" console={false} batchSize={100} flushInterval={0}>
        <Probe />
      </LoggerProvider>,
    );

    act(() => {
      logger.info("Opened {page}", { page: "checkout" });
      logger.error("Payment failed: {reason}", { reason: "declined" });
    });
    expect(ship.pending).toBe(2);

    await act(async () => {
      await ship.flush();
    });

    const body: LogShipmentPayload = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.logs.map((l) => l.level)).toEqual(["info", "error"]);
    expect(body.logs[0].message).toBe("Opened checkout");
    expect(body.logs[0].application).toBe("web");
  });

  it("applies secure/redact rules end-to-end through the logger", async () => {
    let logger!: Logger;
    let ship!: HttpAdapter;
    function Probe() {
      logger = useLogger();
      ship = useLogShipper();
      return null;
    }
    render(
      <LoggerProvider endpoint="/api/logs" console={false} batchSize={100} flushInterval={0} redactMode="omit">
        <Probe />
      </LoggerProvider>,
    );

    act(() => {
      logger.info("pay {pan} tok {tok}", { pan: secure("4111"), tok: redact("t0k3n") });
    });
    await act(async () => {
      await ship.flush();
    });

    const [shipped] = (JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as LogShipmentPayload).logs;
    expect(shipped.message).toBe("pay [secure] tok **REDACTED**");
    expect((shipped.attrs.pan as { _secure?: boolean })._secure).toBe(true);
    expect("tok" in shipped.attrs).toBe(false);
  });

  it("registers a caller-supplied adapter alongside shipping", async () => {
    const custom = { write: vi.fn() };
    function Probe() {
      const logger = useLogger();
      useEffect(() => {
        logger.info("hello");
      }, [logger]);
      return null;
    }
    render(
      <LoggerProvider endpoint="/api/logs" console={false} adapters={[custom]}>
        <Probe />
      </LoggerProvider>,
    );
    expect(custom.write).toHaveBeenCalledTimes(1);
    expect(custom.write.mock.calls[0][0].message).toBe("hello");
  });

  it("flushes any pending records on unmount", async () => {
    function Probe() {
      const logger = useLogger();
      useEffect(() => {
        logger.info("mounted");
      }, [logger]);
      return null;
    }

    const { unmount } = render(
      <LoggerProvider endpoint="/api/logs" console={false} batchSize={100} flushInterval={0}>
        <Probe />
      </LoggerProvider>,
    );

    await act(async () => {
      unmount();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws when used outside a provider", () => {
    function Probe() {
      useLogger();
      return null;
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/LoggerProvider/);
    spy.mockRestore();
  });
});
