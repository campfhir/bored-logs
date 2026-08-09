import { describe, it, expect, vi } from "vitest";
import {
  createE2EServerContext,
  generateE2EServerKeys,
  MemoryRegistrationStore,
} from "../server/e2e-context";
import { createLogRegistrationHandler } from "../server/registration-handler";
import { createLogIngestHandler, MAX_BATCH_HEADER } from "../server/ingest-handler";
import {
  E2E_ALGO_V1,
  E2E_HEADERS,
  E2E_ERROR_HEADER,
  buildSigInput,
  buildHkdfInfo,
  toBase64Url,
  randomBytes,
  generateEcdhKeyPair,
  generateEcdsaKeyPair,
  exportPublicKeyRaw,
  importEcdhPublicJwk,
  deriveAesGcmKey,
  signPayload,
} from "../adapters/http/e2e-wire";
import { createLogger } from "../logger/logger";
import type { LogRecord } from "../logger/adapter";
import type { ClientLogRecord } from "../adapters/http/types";

// ---------------------------------------------------------------------------
// Test-side sealer — built directly on the wire primitives, independent of
// the client session (which gets its own integration tests). Symmetric
// implementations proving the protocol, not one side testing itself.
// ---------------------------------------------------------------------------

type TestClient = {
  clientId: string;
  signing: CryptoKeyPair;
  serverKeyJwk: JsonWebKey;
};

async function registerTestClient(
  ctx: ReturnType<typeof createE2EServerContext>,
  clientId = "test-client",
): Promise<TestClient> {
  const signing = await generateEcdsaKeyPair();
  const handler = createLogRegistrationHandler(ctx);
  const res = await handler(
    new Request("http://x/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId,
        algo: E2E_ALGO_V1,
        signingKey: await crypto.subtle.exportKey("jwk", signing.publicKey),
      }),
    }),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  return { clientId, signing, serverKeyJwk: body.serverKey };
}

/** Re-register an existing client (same signing key), refreshing its server key. */
async function registerTestClient2(
  ctx: ReturnType<typeof createE2EServerContext>,
  client: TestClient,
): Promise<TestClient> {
  const handler = createLogRegistrationHandler(ctx);
  const res = await handler(
    new Request("http://x/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: client.clientId,
        algo: E2E_ALGO_V1,
        signingKey: await crypto.subtle.exportKey("jwk", client.signing.publicKey),
      }),
    }),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  return { ...client, serverKeyJwk: body.serverKey };
}

/** Seal a payload exactly as the wire spec prescribes, with tamper hooks. */
async function seal(
  client: TestClient,
  payload: unknown,
  tamper: {
    meta?: Partial<Record<"algo" | "clientId" | "ts" | "nonce" | "iv" | "key", string>>;
    flipCiphertext?: boolean;
    skipSigOver?: boolean; // sign over the UNtampered meta (headers then lie)
    ts?: number;
    nonce?: Uint8Array;
  } = {},
): Promise<Request> {
  const ephemeral = await generateEcdhKeyPair();
  const serverPub = await importEcdhPublicJwk(client.serverKeyJwk);
  const ephemeralRaw = await exportPublicKeyRaw(ephemeral.publicKey);
  const serverRaw = await exportPublicKeyRaw(serverPub);

  const info = buildHkdfInfo(
    E2E_ALGO_V1,
    client.clientId,
    toBase64Url(ephemeralRaw),
    toBase64Url(serverRaw),
  );
  const aes = await deriveAesGcmKey(ephemeral.privateKey, serverPub, info);
  const iv = randomBytes(12);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      aes,
      new TextEncoder().encode(JSON.stringify(payload)),
    ),
  );
  const meta = {
    algo: E2E_ALGO_V1,
    clientId: client.clientId,
    ts: String(tamper.ts ?? Date.now()),
    nonce: toBase64Url(tamper.nonce ?? randomBytes(16)),
    key: toBase64Url(ephemeralRaw),
    iv: toBase64Url(iv),
  };
  const wireMeta = { ...meta, ...tamper.meta };
  const signedMeta = tamper.skipSigOver ? meta : wireMeta;
  // Sign the PRISTINE ciphertext; tampering happens after, so the wire body
  // no longer matches the signature (that's the attack being simulated).
  const sig = await signPayload(client.signing.privateKey, buildSigInput(signedMeta, ciphertext));
  if (tamper.flipCiphertext) ciphertext[0] ^= 0xff;

  return new Request("http://x/api/logs", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      [E2E_HEADERS.algo]: wireMeta.algo,
      [E2E_HEADERS.client]: wireMeta.clientId,
      [E2E_HEADERS.ts]: wireMeta.ts,
      [E2E_HEADERS.nonce]: wireMeta.nonce,
      [E2E_HEADERS.key]: wireMeta.key,
      [E2E_HEADERS.iv]: wireMeta.iv,
      [E2E_HEADERS.sig]: toBase64Url(sig),
    },
    body: ciphertext as BodyInit,
  });
}

function wireRecord(over: Partial<ClientLogRecord> = {}): ClientLogRecord {
  return {
    level: "info",
    message: "Hello Ada",
    template: "Hello {name}",
    secureMessage: false,
    attrs: { name: "Ada" },
    timestamp: "2026-07-04T00:00:00.000Z",
    ...over,
  };
}

function makeCapture() {
  const records: LogRecord[] = [];
  const logger = createLogger();
  logger.addAdapter({ write: (r: LogRecord) => void records.push(r) });
  return { logger, records };
}

// ---------------------------------------------------------------------------
// Registration handler
// ---------------------------------------------------------------------------

describe("createLogRegistrationHandler", () => {
  it("registers a client and returns the server's ECDH public key", async () => {
    const ctx = createE2EServerContext();
    const client = await registerTestClient(ctx, "app-a");
    expect(client.serverKeyJwk.kty).toBe("EC");
    expect(client.serverKeyJwk.crv).toBe("P-256");
    expect((client.serverKeyJwk as { d?: string }).d).toBeUndefined();
  });

  it("rejects non-POST with 405", async () => {
    const handler = createLogRegistrationHandler(createE2EServerContext());
    const res = await handler(new Request("http://x/register", { method: "GET" }));
    expect(res.status).toBe(405);
  });

  it("rejects bad JSON, bad clientId, unsupported algo, and bad JWK with 400 + supportedAlgos", async () => {
    const handler = createLogRegistrationHandler(createE2EServerContext());
    const post = (body: string) =>
      handler(new Request("http://x/register", { method: "POST", body }));

    expect((await post("{nope")).status).toBe(400);

    const signing = await generateEcdsaKeyPair();
    const jwk = await crypto.subtle.exportKey("jwk", signing.publicKey);
    const good = { clientId: "ok", algo: E2E_ALGO_V1, signingKey: jwk };

    const badId = await post(JSON.stringify({ ...good, clientId: "has space" }));
    expect(badId.status).toBe(400);

    const badAlgo = await post(JSON.stringify({ ...good, algo: "rot13" }));
    expect(badAlgo.status).toBe(400);
    expect((await badAlgo.json()).supportedAlgos).toEqual([E2E_ALGO_V1]);

    const badJwk = await post(JSON.stringify({ ...good, signingKey: { ...jwk, d: "secret" } }));
    expect(badJwk.status).toBe(400);
  });


});

// ---------------------------------------------------------------------------
// Encrypted ingest — happy path + the tamper matrix.
// ---------------------------------------------------------------------------

describe("createLogIngestHandler with encryption", () => {
  async function setup(opts: { required?: boolean; ctxOpts?: Parameters<typeof createE2EServerContext>[0] } = {}) {
    const ctx = createE2EServerContext(opts.ctxOpts);
    const client = await registerTestClient(ctx);
    const { logger, records } = makeCapture();
    const ingest = createLogIngestHandler({
      logger,
      encryption: { context: ctx, required: opts.required },
    });
    return { ctx, client, ingest, records };
  }

  it("decrypts, verifies, and ingests an encrypted batch", async () => {
    const { client, ingest, records } = await setup();
    const res = await ingest(
      await seal(client, { logs: [wireRecord(), wireRecord({ message: "second" })] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 2 });
    expect(res.headers.get(MAX_BATCH_HEADER)).toBe("100");
    expect(records.map((r) => r.message)).toEqual(["Hello Ada", "second"]);
  });

  it("keeps the plaintext path byte-identical when the request has no algo header", async () => {
    const { ingest, records } = await setup();
    const res = await ingest(
      new Request("http://x/api/logs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ logs: [wireRecord()] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(records).toHaveLength(1);
  });

  it("rejects plaintext with 400 encryption-required when required", async () => {
    const { ingest } = await setup({ required: true });
    const res = await ingest(
      new Request("http://x/api/logs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ logs: [wireRecord()] }),
      }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get(E2E_ERROR_HEADER)).toBe("encryption-required");
  });

  it("answers 401 unknown-client for an unregistered clientId", async () => {
    const { ctx, client, ingest } = await setup();
    await ctx.store.delete(client.clientId); // simulate a server restart
    const res = await ingest(await seal(client, { logs: [wireRecord()] }));
    expect(res.status).toBe(401);
    expect(res.headers.get(E2E_ERROR_HEADER)).toBe("unknown-client");
  });

  it("rejects tampering with any signed field as invalid-signature", async () => {
    const { client, ingest } = await setup();
    const cases: Array<Parameters<typeof seal>[2]> = [
      { flipCiphertext: true },
      // +60s: clearly different from the sealed ts, still inside the skew window.
      { meta: { ts: String(Date.now() + 60_000) }, skipSigOver: true },
      { meta: { nonce: toBase64Url(randomBytes(16)) }, skipSigOver: true },
      { meta: { iv: toBase64Url(randomBytes(12)) }, skipSigOver: true },
    ];
    for (const tamper of cases) {
      const res = await ingest(await seal(client, { logs: [wireRecord()] }, tamper));
      expect(res.status, JSON.stringify(tamper)).toBe(401);
      expect(res.headers.get(E2E_ERROR_HEADER)).toBe("invalid-signature");
    }
  });

  it("rejects a stale or future timestamp", async () => {
    const { client, ingest } = await setup({ ctxOpts: { clockSkewMs: 1000 } });
    for (const ts of [Date.now() - 10_000, Date.now() + 10_000]) {
      const res = await ingest(await seal(client, { logs: [wireRecord()] }, { ts }));
      expect(res.status).toBe(400);
      expect(res.headers.get(E2E_ERROR_HEADER)).toBe("stale-timestamp");
    }
  });

  it("rejects a replayed nonce", async () => {
    const { client, ingest } = await setup();
    const nonce = randomBytes(16);
    const first = await ingest(await seal(client, { logs: [wireRecord()] }, { nonce }));
    expect(first.status).toBe(200);
    const replayed = await ingest(await seal(client, { logs: [wireRecord()] }, { nonce }));
    expect(replayed.status).toBe(400);
    expect(replayed.headers.get(E2E_ERROR_HEADER)).toBe("replay");
  });

  it("does NOT cache the nonce of a request that failed signature verification", async () => {
    const { client, ingest } = await setup();
    const nonce = randomBytes(16);
    const bad = await ingest(
      await seal(client, { logs: [wireRecord()] }, { nonce, flipCiphertext: true }),
    );
    expect(bad.headers.get(E2E_ERROR_HEADER)).toBe("invalid-signature");
    // The same nonce must still be usable by a VALID request.
    const good = await ingest(await seal(client, { logs: [wireRecord()] }, { nonce }));
    expect(good.status).toBe(200);
  });

  it("answers decrypt-failed after server key rotation (valid signature, wrong server key)", async () => {
    const ctx = createE2EServerContext();
    const client = await registerTestClient(ctx);
    // Rotate: a NEW context (new ECDH keys) with the SAME registration store.
    const rotated = createE2EServerContext({ store: ctx.store });
    const { logger } = makeCapture();
    const ingest = createLogIngestHandler({ logger, encryption: { context: rotated } });
    // Sealed against the OLD server key — signature verifies, decryption fails.
    const res = await ingest(await seal(client, { logs: [wireRecord()] }));
    expect(res.status).toBe(400);
    expect(res.headers.get(E2E_ERROR_HEADER)).toBe("decrypt-failed");
  });

  it("rejects malformed envelope headers as bad-e2e-headers", async () => {
    const { client, ingest } = await setup();
    const good = await seal(client, { logs: [wireRecord()] });
    for (const [header, value] of [
      [E2E_HEADERS.client, "bad id!"],
      [E2E_HEADERS.iv, toBase64Url(randomBytes(5))], // wrong IV length
      [E2E_HEADERS.sig, "***"],
      [E2E_HEADERS.algo, "rot13"],
    ] as const) {
      const req = new Request(good.url, {
        method: "POST",
        headers: new Headers(good.headers),
        body: await good.clone().arrayBuffer(),
      });
      req.headers.set(header, value);
      const res = await ingest(req);
      expect(res.status, header).toBe(400);
      expect(res.headers.get(E2E_ERROR_HEADER)).toBe("bad-e2e-headers");
    }
  });

  it("enforces maxBatch AFTER decryption, with the negotiation header intact", async () => {
    const ctx = createE2EServerContext();
    const client = await registerTestClient(ctx);
    const { logger } = makeCapture();
    const ingest = createLogIngestHandler({
      logger,
      maxBatch: 2,
      encryption: { context: ctx },
    });
    const res = await ingest(
      await seal(client, { logs: [wireRecord(), wireRecord(), wireRecord()] }),
    );
    expect(res.status).toBe(413);
    expect(res.headers.get(MAX_BATCH_HEADER)).toBe("2");
  });

  it("evicts the oldest nonce past the cache cap", async () => {
    const { client, ingest } = await setup({ ctxOpts: { nonceCacheSize: 2 } });
    const n1 = randomBytes(16);
    expect((await ingest(await seal(client, { logs: [wireRecord()] }, { nonce: n1 }))).status).toBe(200);
    expect((await ingest(await seal(client, { logs: [wireRecord()] }))).status).toBe(200);
    expect((await ingest(await seal(client, { logs: [wireRecord()] }))).status).toBe(200);
    // n1 has been evicted — replaying it is (by design) no longer detected.
    expect((await ingest(await seal(client, { logs: [wireRecord()] }, { nonce: n1 }))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Context surface
// ---------------------------------------------------------------------------

describe("createE2EServerContext", () => {
  it("exportKeys round-trips into a new context (persistence across restarts)", async () => {
    const a = createE2EServerContext();
    const clientOnA = await registerTestClient(a);
    const keys = await a.exportKeys();
    expect((keys.privateJwk as { d?: string }).d).toBeTruthy();

    // Same keys + same store → shipments sealed for A open on B.
    const b = createE2EServerContext({ keys, store: a.store });
    const { logger, records } = makeCapture();
    const ingest = createLogIngestHandler({ logger, encryption: { context: b } });
    const res = await ingest(await seal(clientOnA, { logs: [wireRecord()] }));
    expect(res.status).toBe(200);
    expect(records).toHaveLength(1);
  });

  it("generateE2EServerKeys produces an importable pair", async () => {
    const keys = await generateE2EServerKeys();
    const ctx = createE2EServerContext({ keys });
    const client = await registerTestClient(ctx);
    expect(client.serverKeyJwk.x).toBe(keys.publicJwk.x);
  });

  it("MemoryRegistrationStore get/set/delete work", async () => {
    const store = new MemoryRegistrationStore();
    expect(await store.get("x")).toBeUndefined();
    await store.set({ clientId: "x", signingKeyJwk: {}, algo: E2E_ALGO_V1, registeredAt: 1 });
    expect((await store.get("x"))?.clientId).toBe("x");
    await store.delete("x");
    expect(await store.get("x")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Risk mitigations: key-continuity pinning, authorize hook, key rotation.
// ---------------------------------------------------------------------------

describe("registration key-continuity (pinned by default)", () => {
  it("same-key re-registration stays idempotent (restart recovery unharmed)", async () => {
    const ctx = createE2EServerContext();
    const signing = await generateEcdsaKeyPair();
    const jwk = await crypto.subtle.exportKey("jwk", signing.publicKey);
    const handler = createLogRegistrationHandler(ctx);
    const register = () =>
      handler(
        new Request("http://x/register", {
          method: "POST",
          body: JSON.stringify({ clientId: "stable", algo: E2E_ALGO_V1, signingKey: jwk }),
        }),
      );
    expect((await register()).status).toBe(200);
    expect((await register()).status).toBe(200); // same key → fine
  });

  it("rejects a DIFFERENT key for a registered clientId with 409 client-key-conflict", async () => {
    const ctx = createE2EServerContext();
    await registerTestClient(ctx, "pinned-id");
    const otherKey = await crypto.subtle.exportKey(
      "jwk",
      (await generateEcdsaKeyPair()).publicKey,
    );
    const handler = createLogRegistrationHandler(ctx);
    const res = await handler(
      new Request("http://x/register", {
        method: "POST",
        body: JSON.stringify({ clientId: "pinned-id", algo: E2E_ALGO_V1, signingKey: otherKey }),
      }),
    );
    expect(res.status).toBe(409);
    expect(res.headers.get(E2E_ERROR_HEADER)).toBe("client-key-conflict");
  });

  it("registration: 'open' restores last-write-wins for operators who opt out", async () => {
    const ctx = createE2EServerContext({ registration: "open" });
    const first = await registerTestClient(ctx, "same-id");
    const second = await registerTestClient(ctx, "same-id"); // overwrites, no conflict

    const { logger } = makeCapture();
    const ingest = createLogIngestHandler({ logger, encryption: { context: ctx } });
    expect((await ingest(await seal(second, { logs: [wireRecord()] }))).status).toBe(200);
    expect((await ingest(await seal(first, { logs: [wireRecord()] }))).status).toBe(401);
  });

  it("store.delete unblocks a deliberate client-key rotation under pinning", async () => {
    const ctx = createE2EServerContext();
    await registerTestClient(ctx, "rotate-me");
    await ctx.store.delete("rotate-me");
    const fresh = await registerTestClient(ctx, "rotate-me"); // new key accepted
    const { logger } = makeCapture();
    const ingest = createLogIngestHandler({ logger, encryption: { context: ctx } });
    expect((await ingest(await seal(fresh, { logs: [wireRecord()] }))).status).toBe(200);
  });
});

describe("registration authorize hook", () => {
  it("rejects with 401 when authorize returns false, before any store write", async () => {
    const ctx = createE2EServerContext();
    const handler = createLogRegistrationHandler(ctx, {
      authorize: (request) => request.headers.get("authorization") === "Bearer ok",
    });
    const signing = await generateEcdsaKeyPair();
    const body = JSON.stringify({
      clientId: "authed",
      algo: E2E_ALGO_V1,
      signingKey: await crypto.subtle.exportKey("jwk", signing.publicKey),
    });

    const denied = await handler(new Request("http://x/register", { method: "POST", body }));
    expect(denied.status).toBe(401);
    expect(await ctx.store.get("authed")).toBeUndefined();

    const allowed = await handler(
      new Request("http://x/register", {
        method: "POST",
        headers: { authorization: "Bearer ok" },
        body,
      }),
    );
    expect(allowed.status).toBe(200);
    expect(await ctx.store.get("authed")).toBeTruthy();
  });
});

describe("server key rotation", () => {
  it("rotateKeys swaps the keypair; old shipments fail decrypt-failed, re-registration heals", async () => {
    const ctx = createE2EServerContext();
    const client = await registerTestClient(ctx);
    const { logger, records } = makeCapture();
    const ingest = createLogIngestHandler({ logger, encryption: { context: ctx } });
    expect((await ingest(await seal(client, { logs: [wireRecord()] }))).status).toBe(200);

    const before = await ctx.exportKeys();
    const rotated = await ctx.rotateKeys();
    expect(rotated.publicJwk.x).not.toBe(before.publicJwk.x);
    expect((await ctx.exportKeys()).publicJwk.x).toBe(rotated.publicJwk.x);

    // A shipment sealed against the OLD server key: signature still valid,
    // decryption fails → the client's re-register trigger.
    const stale = await ingest(await seal(client, { logs: [wireRecord()] }));
    expect(stale.status).toBe(400);
    expect(stale.headers.get(E2E_ERROR_HEADER)).toBe("decrypt-failed");

    // Re-register (same signing key — pinning allows it) → fetch the new
    // server key → shipments work again.
    const refreshed = await registerTestClient2(ctx, client);
    expect((await ingest(await seal(refreshed, { logs: [wireRecord()] }))).status).toBe(200);
    expect(records.length).toBe(2);
  });
});

describe("registration authorize hook — throw semantics", () => {
  it("a THROWING authorize fails closed with 500 and touches nothing", async () => {
    const ctx = createE2EServerContext();
    const onError = vi.fn();
    const handler = createLogRegistrationHandler(ctx, {
      authorize: () => {
        throw new Error("auth backend down");
      },
      onError,
    });
    const signing = await generateEcdsaKeyPair();
    const res = await handler(
      new Request("http://x/register", {
        method: "POST",
        body: JSON.stringify({
          clientId: "x",
          algo: E2E_ALGO_V1,
          signingKey: await crypto.subtle.exportKey("jwk", signing.publicKey),
        }),
      }),
    ); // must NOT reject
    expect(res.status).toBe(500);
    expect(await ctx.store.get("x")).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });
});
