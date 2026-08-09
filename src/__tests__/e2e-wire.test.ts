import { describe, it, expect } from "vitest";
import {
  E2E_ALGO_V1,
  E2E_DOMAIN,
  E2E_HEADERS,
  toBase64Url,
  fromBase64Url,
  isValidClientId,
  assertP256PublicJwk,
  buildSigInput,
  buildHkdfInfo,
  generateEcdhKeyPair,
  generateEcdsaKeyPair,
  exportPublicKeyRaw,
  importEcdhPublicRaw,
  importEcdhPublicJwk,
  importEcdsaPublicJwk,
  deriveAesGcmKey,
  signPayload,
  verifyPayload,
} from "../adapters/http/e2e-wire";

// Real WebCrypto throughout — Node's vitest environment provides crypto.subtle.

describe("base64url", () => {
  it("round-trips arbitrary bytes, including padding-edge lengths", () => {
    for (const len of [0, 1, 2, 3, 4, 31, 32, 33, 64, 65]) {
      const bytes = crypto.getRandomValues(new Uint8Array(len));
      const encoded = toBase64Url(bytes);
      expect(encoded).not.toMatch(/[+/=]/); // url-safe, unpadded
      expect([...fromBase64Url(encoded)]).toEqual([...bytes]);
    }
  });

  it("decodes known vectors", () => {
    expect([...fromBase64Url(toBase64Url(new Uint8Array([0xff, 0xef, 0xbe])))]).toEqual([
      0xff, 0xef, 0xbe,
    ]);
  });
});

describe("clientId validation", () => {
  it("accepts the documented charset", () => {
    for (const id of ["app-a", "web_1", "svc:eu.west", "A.b-C_1:2", "x"]) {
      expect(isValidClientId(id), id).toBe(true);
    }
  });

  it("rejects delimiters, whitespace, and length violations", () => {
    for (const id of ["", "has space", "line\nbreak", "emoji💥", "slash/x", "a".repeat(129)]) {
      expect(isValidClientId(id), JSON.stringify(id)).toBe(false);
    }
  });
});

describe("P-256 public JWK validation", () => {
  it("accepts a freshly exported ECDSA public key", async () => {
    const pair = await generateEcdsaKeyPair();
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    expect(() => assertP256PublicJwk(jwk)).not.toThrow();
  });

  it("rejects wrong curve, wrong kty, missing coordinates, and embedded private material", async () => {
    const pair = await generateEcdsaKeyPair();
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    expect(() => assertP256PublicJwk({ ...jwk, crv: "P-384" })).toThrow();
    expect(() => assertP256PublicJwk({ ...jwk, kty: "RSA" })).toThrow();
    expect(() => assertP256PublicJwk({ ...jwk, x: undefined })).toThrow();
    expect(() => assertP256PublicJwk({ ...jwk, d: "AAAA" })).toThrow(/private/i);
  });
});

describe("canonical signature input", () => {
  const meta = {
    algo: E2E_ALGO_V1,
    clientId: "app-a",
    ts: "1700000000000",
    nonce: "bm9uY2U",
    key: "a2V5",
    iv: "aXY",
  };
  const ct = new Uint8Array([1, 2, 3]);

  it("is deterministic and starts with the domain label", () => {
    const a = buildSigInput(meta, ct);
    const b = buildSigInput(meta, ct);
    expect([...a]).toEqual([...b]);
    const text = new TextDecoder().decode(a);
    expect(text.startsWith(`${E2E_DOMAIN}\n`)).toBe(true);
  });

  it("changes when ANY field changes (no two metas collide)", () => {
    const base = toBase64Url(buildSigInput(meta, ct));
    for (const [k, v] of [
      ["algo", "other"],
      ["clientId", "app-b"],
      ["ts", "1700000000001"],
      ["nonce", "bm9uY2V4"],
      ["key", "a2V5eA"],
      ["iv", "aXZ4"],
    ] as const) {
      expect(toBase64Url(buildSigInput({ ...meta, [k]: v }, ct)), k).not.toBe(base);
    }
    expect(toBase64Url(buildSigInput(meta, new Uint8Array([1, 2, 4])))).not.toBe(base);
  });

  it("cannot be confused by field-boundary shifting", () => {
    // Moving a character across a field boundary must not produce the same
    // bytes — the fields are newline-delimited and none may contain \n.
    const shifted = buildSigInput({ ...meta, clientId: "app-a1", ts: "700000000000" }, ct);
    expect(toBase64Url(shifted)).not.toBe(toBase64Url(buildSigInput(meta, ct)));
  });
});

describe("key agreement + AES-GCM", () => {
  it("both sides derive the same key and can round-trip a payload", async () => {
    const server = await generateEcdhKeyPair();
    const client = await generateEcdhKeyPair(); // ephemeral
    const serverPubRaw = await exportPublicKeyRaw(server.publicKey);
    const clientPubRaw = await exportPublicKeyRaw(client.publicKey);
    const info = buildHkdfInfo(E2E_ALGO_V1, "app-a", toBase64Url(clientPubRaw), toBase64Url(serverPubRaw));

    // Client side: own private + server public.
    const clientKey = await deriveAesGcmKey(client.privateKey, server.publicKey, info);
    // Server side: own private + client's transmitted raw public.
    const clientPubImported = await importEcdhPublicRaw(clientPubRaw);
    const serverKey = await deriveAesGcmKey(server.privateKey, clientPubImported, info);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify({ logs: [{ hello: "world" }] }));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, clientKey, plaintext);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, serverKey, ciphertext);
    expect(new TextDecoder().decode(decrypted)).toContain("hello");
  });

  it("a different HKDF info yields a key that cannot decrypt", async () => {
    const server = await generateEcdhKeyPair();
    const client = await generateEcdhKeyPair();
    const serverPubRaw = await exportPublicKeyRaw(server.publicKey);
    const clientPubRaw = await exportPublicKeyRaw(client.publicKey);

    const infoA = buildHkdfInfo(E2E_ALGO_V1, "app-a", toBase64Url(clientPubRaw), toBase64Url(serverPubRaw));
    const infoB = buildHkdfInfo(E2E_ALGO_V1, "app-B", toBase64Url(clientPubRaw), toBase64Url(serverPubRaw));

    const kA = await deriveAesGcmKey(client.privateKey, server.publicKey, infoA);
    const kB = await deriveAesGcmKey(server.privateKey, await importEcdhPublicRaw(clientPubRaw), infoB);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kA, new Uint8Array([1]));
    await expect(crypto.subtle.decrypt({ name: "AES-GCM", iv }, kB, ct)).rejects.toThrow();
  });
});

describe("signatures", () => {
  it("sign/verify round-trips and rejects tampered input", async () => {
    const pair = await generateEcdsaKeyPair();
    const input = buildSigInput(
      { algo: E2E_ALGO_V1, clientId: "a", ts: "1", nonce: "bg", key: "aw", iv: "aXY" },
      new Uint8Array([9, 9]),
    );
    const sig = await signPayload(pair.privateKey, input);
    expect(sig.byteLength).toBe(64); // raw r‖s

    const pubJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const pub = await importEcdsaPublicJwk(pubJwk);
    expect(await verifyPayload(pub, sig, input)).toBe(true);

    const tampered = new Uint8Array(input);
    tampered[tampered.length - 1] ^= 0xff;
    expect(await verifyPayload(pub, sig, tampered)).toBe(false);

    const other = await generateEcdsaKeyPair();
    const otherPub = await importEcdsaPublicJwk(
      await crypto.subtle.exportKey("jwk", other.publicKey),
    );
    expect(await verifyPayload(otherPub, sig, input)).toBe(false);
  });
});

describe("constants", () => {
  it("exposes the v1 suite id and the six ship-time header names", () => {
    expect(E2E_ALGO_V1).toBe("ecdh-p256+a256gcm+ecdsa-p256");
    expect(Object.values(E2E_HEADERS).sort()).toEqual(
      [
        "x-bored-logs-algo",
        "x-bored-logs-client",
        "x-bored-logs-iv",
        "x-bored-logs-key",
        "x-bored-logs-nonce",
        "x-bored-logs-sig",
        "x-bored-logs-ts",
      ].sort(),
    );
  });
});
