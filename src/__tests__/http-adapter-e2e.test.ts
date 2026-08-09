import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HttpAdapter } from "../adapters/http/adapter";
import { createE2EServerContext } from "../server/e2e-context";
import { createLogRegistrationHandler } from "../server/registration-handler";
import { createLogIngestHandler } from "../server/ingest-handler";
import { E2E_HEADERS } from "../adapters/http/e2e-wire";
import { createLogger } from "../logger/logger";
import type { LogRecord } from "../logger/adapter";

// ---------------------------------------------------------------------------
// Client ↔ server integration: the fetch stub routes straight into the REAL
// registration + ingest handlers, so every assertion crosses genuine
// WebCrypto seal → verify → decrypt.
// ---------------------------------------------------------------------------

function rec(over: Partial<LogRecord> = {}): LogRecord {
  return {
    level: "info",
    message: "hi",
    template: "hi",
    secureMessage: false,
    attrs: {},
    timestamp: new Date("2026-07-04T00:00:00.000Z"),
    ...over,
  };
}

function makeE2EServer() {
  const ctx = createE2EServerContext();
  const records: LogRecord[] = [];
  const logger = createLogger();
  logger.addAdapter({ write: (r: LogRecord) => void records.push(r) });
  const register = createLogRegistrationHandler(ctx);
  const ingest = createLogIngestHandler({ logger, encryption: { context: ctx } });

  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const request = new Request(u, init);
    if (u.endsWith("/register")) return register(request);
    return ingest(request);
  });
  vi.stubGlobal("fetch", fetchMock);

  const registrations = () => calls.filter((c) => c.url.endsWith("/register"));
  const shipments = () => calls.filter((c) => !c.url.endsWith("/register"));
  return { ctx, records, calls, fetchMock, registrations, shipments };
}

/** No fetch body may ever contain the plaintext payload marker. */
function assertNoPlaintextShipment(calls: Array<{ url: string; init: RequestInit }>): void {
  for (const c of calls) {
    if (typeof c.init.body === "string") {
      expect(c.init.body).not.toContain('"logs"');
    }
  }
}

describe("HttpAdapter — end-to-end encryption", () => {
  let server: ReturnType<typeof makeE2EServer>;

  beforeEach(() => {
    server = makeE2EServer();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const makeAdapter = (extra: Record<string, unknown> = {}) =>
    new HttpAdapter({
      endpoint: "https://logs.example/api/logs",
      flushInterval: 0,
      encryption: {},
      ...extra,
    });

  it("registers on first flush, then ships an encrypted body with the full envelope", async () => {
    const adapter = makeAdapter();
    adapter.write(rec({ message: "m1", template: "m1" }));
    adapter.write(rec({ message: "m2", template: "m2" }));
    await adapter.flush();

    expect(server.registrations()).toHaveLength(1);
    expect(server.registrations()[0].url).toBe("https://logs.example/api/logs/register");
    expect(server.shipments()).toHaveLength(1);

    const ship = server.shipments()[0];
    const headers = new Headers(ship.init.headers as HeadersInit);
    expect(headers.get("content-type")).toBe("application/octet-stream");
    for (const name of Object.values(E2E_HEADERS)) {
      expect(headers.get(name), name).toBeTruthy();
    }
    expect(typeof ship.init.body).not.toBe("string"); // ciphertext, not JSON

    // The server actually decrypted and ingested the records, in order.
    expect(server.records.map((r) => r.message)).toEqual(["m1", "m2"]);
    assertNoPlaintextShipment(server.calls);
  });

  it("sends the user's auth headers on registration AND shipment", async () => {
    const adapter = makeAdapter({ headers: { authorization: "Bearer tok" } });
    adapter.write(rec());
    await adapter.flush();

    for (const call of server.calls) {
      expect(new Headers(call.init.headers as HeadersInit).get("authorization")).toBe("Bearer tok");
    }
  });

  it("recovers from a server restart: unknown-client → re-register → retry, order preserved", async () => {
    const adapter = makeAdapter({ encryption: { clientId: "stable-client" } });
    adapter.write(rec({ message: "a", template: "a" }));
    await adapter.flush();
    expect(server.records.map((r) => r.message)).toEqual(["a"]);

    // Simulate a restart: the registration store forgets the client.
    await server.ctx.store.delete("stable-client");

    adapter.write(rec({ message: "b", template: "b" }));
    adapter.write(rec({ message: "c", template: "c" }));
    await adapter.flush();

    expect(server.records.map((r) => r.message)).toEqual(["a", "b", "c"]);
    expect(server.registrations()).toHaveLength(2); // initial + exactly one recovery
    assertNoPlaintextShipment(server.calls);
  });

  it("throws when transport and encryption are combined", () => {
    expect(() =>
      makeAdapter({ transport: async () => {} }),
    ).toThrowError(TypeError);

    const adapter = makeAdapter();
    expect(() =>
      adapter.setOptions({
        endpoint: "https://logs.example/api/logs",
        encryption: {},
        transport: async () => {},
      }),
    ).toThrowError(TypeError);
  });

  it("keeps the session (no re-registration) across equal setOptions calls", async () => {
    const opts = {
      endpoint: "https://logs.example/api/logs",
      flushInterval: 0,
      encryption: { clientId: "provider-client" },
    };
    const adapter = new HttpAdapter(opts);
    adapter.write(rec());
    await adapter.flush();

    adapter.setOptions({ ...opts }); // LoggerProvider re-commit
    adapter.write(rec());
    await adapter.flush();

    expect(server.registrations()).toHaveLength(1);
    expect(server.records).toHaveLength(2);
  });

  it("re-queues and reports when registration itself fails", async () => {
    const onError = vi.fn();
    server.fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    const adapter = makeAdapter({ onError });
    adapter.write(rec());
    await adapter.flush();

    expect(onError).toHaveBeenCalled();
    expect(adapter.pending).toBe(1); // nothing lost, retried next flush
    assertNoPlaintextShipment(server.calls);
  });

  describe("unload path", () => {
    it("never uses sendBeacon and ships encrypted via keepalive fetch when registered", async () => {
      const sendBeacon = vi.fn(() => true);
      vi.stubGlobal("navigator", { sendBeacon });

      const adapter = makeAdapter();
      adapter.write(rec({ message: "pre", template: "pre" }));
      await adapter.flush(); // registers the session

      adapter.write(rec({ message: "tail", template: "tail" }));
      adapter.flushBeacon();

      await vi.waitFor(() => {
        expect(server.records.map((r) => r.message)).toEqual(["pre", "tail"]);
      });
      expect(sendBeacon).not.toHaveBeenCalled();
      const last = server.shipments().at(-1)!;
      expect((last.init as RequestInit & { keepalive?: boolean }).keepalive).toBe(true);
      assertNoPlaintextShipment(server.calls);
    });

    it("drops (never downgrades) when the session is not yet registered", async () => {
      const sendBeacon = vi.fn(() => true);
      vi.stubGlobal("navigator", { sendBeacon });
      const onError = vi.fn();

      const adapter = makeAdapter({ onError });
      adapter.write(rec({ message: "doomed", template: "doomed" }));
      adapter.flushBeacon(); // no prior flush — session unready

      await new Promise((r) => setTimeout(r, 30));
      expect(sendBeacon).not.toHaveBeenCalled();
      expect(server.calls).toHaveLength(0); // nothing sent AT ALL
      expect(onError).toHaveBeenCalled(); // the drop is reported
      expect(adapter.pending).toBe(0); // dropped, not queued (page is going away)
    });
  });
});

// ---------------------------------------------------------------------------
// Risk mitigations: eager warm-up, fail-fast without WebCrypto, key-conflict
// surfacing.
// ---------------------------------------------------------------------------

describe("HttpAdapter — E2E risk mitigations", () => {
  let server: ReturnType<typeof makeE2EServer>;

  beforeEach(() => {
    server = makeE2EServer();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("start() eagerly registers the session before any write or flush", async () => {
    const adapter = new HttpAdapter({
      endpoint: "https://logs.example/api/logs",
      flushInterval: 0,
      encryption: {},
    });
    const stop = adapter.start();
    await vi.waitFor(() => {
      expect(server.registrations()).toHaveLength(1);
    });
    expect(server.shipments()).toHaveLength(0); // nothing shipped — just warm

    // The warmed session means an immediate unload flush can seal.
    adapter.write(rec({ message: "tail", template: "tail" }));
    adapter.flushBeacon();
    await vi.waitFor(() => {
      expect(server.records.map((r) => r.message)).toEqual(["tail"]);
    });
    stop();
  });

  it("throws at construction when encryption is configured without crypto.subtle", () => {
    const realCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) });
    try {
      expect(
        () => new HttpAdapter({ endpoint: "/logs", encryption: {} }),
      ).toThrowError(/crypto\.subtle/);
      // Plaintext construction stays fine without subtle.
      expect(() => new HttpAdapter({ endpoint: "/logs" })).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("surfaces a 409 client-key-conflict via onError without retry loops or plaintext", async () => {
    // Pre-register the clientId with a DIFFERENT key (the takeover victim).
    const { generateEcdsaKeyPair } = await import("../adapters/http/e2e-wire");
    const other = await generateEcdsaKeyPair();
    await server.ctx.store.set({
      clientId: "contested",
      signingKeyJwk: await crypto.subtle.exportKey("jwk", other.publicKey),
      algo: "ecdh-p256+a256gcm+ecdsa-p256",
      registeredAt: Date.now(),
    });

    const onError = vi.fn();
    const adapter = new HttpAdapter({
      endpoint: "https://logs.example/api/logs",
      flushInterval: 0,
      encryption: { clientId: "contested" }, // ephemeral keys → conflict
      onError,
    });
    adapter.write(rec());
    await adapter.flush();

    expect(onError).toHaveBeenCalled();
    const err = onError.mock.calls[0][0] as Error;
    expect(String(err)).toMatch(/409|client-key-conflict|registration/i);
    expect(adapter.pending).toBe(1); // re-queued, no loss
    expect(server.shipments()).toHaveLength(0); // never shipped anything
    assertNoPlaintextShipment(server.calls);
    // One registration attempt for this flush — no hot loop.
    expect(server.registrations()).toHaveLength(1);
  });
});
