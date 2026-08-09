/**
 * Shared protocol core for opt-in end-to-end log-shipment encryption.
 *
 * Both halves of the pipeline import this module — the client
 * (`HttpAdapter` via `e2e-client.ts`) and the server
 * (`createE2EServerContext` / `createLogRegistrationHandler`) — so the header
 * names, canonical signature input, and key-derivation parameters can never
 * drift apart.
 *
 * Everything here is WebCrypto (`crypto.subtle`) + `Uint8Array` only: no
 * Buffer, no node:crypto — it runs in browsers (secure contexts), Node ≥ 18,
 * Deno, and Edge runtimes, matching the HTTP adapter's universality.
 *
 * Wire shape (v1): the AES-256-GCM ciphertext is the RAW request body
 * (`content-type: application/octet-stream`); all metadata rides in
 * `x-bored-logs-*` headers. A fresh ephemeral ECDH P-256 keypair is generated
 * per POST (single-use AES key ⇒ IV reuse structurally impossible); the
 * client authenticates each shipment with an ECDSA P-256 signature over a
 * fixed, newline-delimited canonical input covering every header field AND
 * the ciphertext — header stripping, reordering, algo downgrade, and clientId
 * substitution all break the signature.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The v1 cipher suite: ECDH P-256 key agreement, AES-256-GCM body, ECDSA P-256 signatures. */
export const E2E_ALGO_V1 = "ecdh-p256+a256gcm+ecdsa-p256";

/** Domain-separation label prefixed to the signature input and HKDF info. */
export const E2E_DOMAIN = "bored-logs-e2e-v1";

/** Ship-time header names — every field of the encrypted envelope. */
export const E2E_HEADERS = {
  /** The cipher-suite id ({@link E2E_ALGO_V1}). Its presence marks a request as encrypted. */
  algo: "x-bored-logs-algo",
  /** The registered clientId whose signing key verifies this shipment. */
  client: "x-bored-logs-client",
  /** Ephemeral ECDH P-256 public key, raw uncompressed point (65 bytes), base64url. */
  key: "x-bored-logs-key",
  /** AES-GCM IV, 12 random bytes, base64url. */
  iv: "x-bored-logs-iv",
  /** Client clock at sealing time, Unix milliseconds, decimal string. */
  ts: "x-bored-logs-ts",
  /** Anti-replay nonce, 16 random bytes, base64url. */
  nonce: "x-bored-logs-nonce",
  /** ECDSA P-256/SHA-256 signature (raw r‖s, 64 bytes) over {@link buildSigInput}. */
  sig: "x-bored-logs-sig",
} as const;

/** Response header carrying a machine-readable E2E error code (e.g. `unknown-client`). */
export const E2E_ERROR_HEADER = "x-bored-logs-error";

/** Machine-readable error codes surfaced via {@link E2E_ERROR_HEADER}. */
export type E2EErrorCode =
  | "unknown-client"
  | "decrypt-failed"
  | "invalid-signature"
  | "replay"
  | "stale-timestamp"
  | "bad-e2e-headers"
  | "encryption-required"
  | "unsupported-algo"
  /** Pinned registration: the clientId is already bound to a DIFFERENT signing key. */
  | "client-key-conflict"
  /** The registration `authorize` hook refused the request. */
  | "unauthorized";

// ---------------------------------------------------------------------------
// Runtime access
// ---------------------------------------------------------------------------

/** WebCrypto handle, or a descriptive throw where it is unavailable (e.g. an insecure browser context). */
export function getSubtle(): SubtleCrypto {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "[bored-logs] WebCrypto (crypto.subtle) is not available in this runtime — " +
        "end-to-end encryption requires a secure context (https/localhost) or Node ≥ 18.",
    );
  }
  return subtle;
}

/** Cryptographically random bytes. */
export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  (globalThis as unknown as { crypto: Crypto }).crypto.getRandomValues(out);
  return out;
}

// ---------------------------------------------------------------------------
// base64url — Uint8Array only, unpadded, universal (no Buffer).
// ---------------------------------------------------------------------------

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64_ALPHABET.length; i++) B64_LOOKUP[B64_ALPHABET[i]] = i;

/** Encode bytes as unpadded base64url. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += B64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/** Decode unpadded base64url into bytes; throws on any character outside the alphabet. */
export function fromBase64Url(encoded: string): Uint8Array {
  const out = new Uint8Array(Math.floor((encoded.length * 3) / 4));
  let outIdx = 0;
  let buffer = 0;
  let bits = 0;
  for (const ch of encoded) {
    const val = B64_LOOKUP[ch];
    if (val === undefined) throw new Error(`invalid base64url character ${JSON.stringify(ch)}`);
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIdx++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, outIdx);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * True when the clientId uses the allowed charset. Enforced at registration
 * AND re-checked at ship time — the charset excludes `\n`, so a valid id can
 * never inject a field boundary into {@link buildSigInput}.
 */
export function isValidClientId(id: string): boolean {
  return CLIENT_ID_RE.test(id);
}

/**
 * Assert a JWK is a plausible P-256 PUBLIC key: correct kty/crv, both
 * coordinates present, and — critically — no embedded private scalar (`d`).
 */
export function assertP256PublicJwk(jwk: JsonWebKey): void {
  if (jwk.kty !== "EC") throw new Error(`expected an EC JWK, got kty=${JSON.stringify(jwk.kty)}`);
  if (jwk.crv !== "P-256") throw new Error(`expected curve P-256, got ${JSON.stringify(jwk.crv)}`);
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("public JWK must carry both x and y coordinates");
  }
  if ("d" in jwk && (jwk as { d?: unknown }).d != null) {
    throw new Error("JWK carries private key material (d) — only public keys may be exchanged");
  }
}

// ---------------------------------------------------------------------------
// Canonical signature input + HKDF info
// ---------------------------------------------------------------------------

/** The signed/derived-over metadata fields, as their ENCODED wire strings. */
export type E2ESigMeta = {
  algo: string;
  clientId: string;
  /** Unix ms, decimal string — exactly as sent in the header. */
  ts: string;
  /** base64url — exactly as sent in the header. */
  nonce: string;
  /** base64url ephemeral public key — exactly as sent in the header. */
  key: string;
  /** base64url IV — exactly as sent in the header. */
  iv: string;
};

const encoder = new TextEncoder();

/**
 * The exact byte sequence the client signs and the server verifies:
 *
 * ```
 * UTF8(domain) \n algo \n clientId \n ts \n nonce \n key \n iv \n ciphertext
 * ```
 *
 * Fixed field count and order, newline-delimited, and no field can contain a
 * newline (base64url / decimal / validated clientId / fixed algo) — so what
 * is verified is byte-identical to what is on the wire, and stripping,
 * reordering, downgrading, or substituting any header breaks the signature.
 */
export function buildSigInput(meta: E2ESigMeta, ciphertext: Uint8Array): Uint8Array {
  const head = encoder.encode(
    `${E2E_DOMAIN}\n${meta.algo}\n${meta.clientId}\n${meta.ts}\n${meta.nonce}\n${meta.key}\n${meta.iv}\n`,
  );
  const out = new Uint8Array(head.length + ciphertext.length);
  out.set(head, 0);
  out.set(ciphertext, head.length);
  return out;
}

/**
 * HKDF `info` binding the derived AES key to the suite, the client identity,
 * and BOTH public keys (ephemeral and server-static) — RFC 9180-style
 * hygiene, so a key derived for one context can never be confused with
 * another.
 */
export function buildHkdfInfo(
  algo: string,
  clientId: string,
  ephemeralPubB64: string,
  serverPubB64: string,
): Uint8Array {
  return encoder.encode(`${E2E_DOMAIN}|${algo}|${clientId}|${ephemeralPubB64}|${serverPubB64}`);
}

// ---------------------------------------------------------------------------
// crypto.subtle wrappers — every key/algorithm parameter in one place.
// ---------------------------------------------------------------------------

const ECDH_PARAMS: EcKeyGenParams = { name: "ECDH", namedCurve: "P-256" };
const ECDSA_PARAMS: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
const ECDSA_SIGN: EcdsaParams = { name: "ECDSA", hash: "SHA-256" };

/** Generate an ECDH P-256 keypair (server-static, or client-ephemeral per POST). */
export function generateEcdhKeyPair(): Promise<CryptoKeyPair> {
  return getSubtle().generateKey(ECDH_PARAMS, true, ["deriveBits"]) as Promise<CryptoKeyPair>;
}

/** Generate an ECDSA P-256 signing keypair (the client's identity). */
export function generateEcdsaKeyPair(): Promise<CryptoKeyPair> {
  return getSubtle().generateKey(ECDSA_PARAMS, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
}

/** Export a public key as its raw uncompressed point (65 bytes for P-256). */
export async function exportPublicKeyRaw(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await getSubtle().exportKey("raw", key));
}

/** Import an ECDH public key from its raw point bytes. */
export function importEcdhPublicRaw(raw: Uint8Array): Promise<CryptoKey> {
  return getSubtle().importKey("raw", raw as BufferSource, ECDH_PARAMS, true, []);
}

/** Import an ECDH public key from a validated JWK. */
export function importEcdhPublicJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  assertP256PublicJwk(jwk);
  return getSubtle().importKey("jwk", jwk, ECDH_PARAMS, true, []);
}

/** Import an ECDSA public (verification) key from a validated JWK. */
export function importEcdsaPublicJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  assertP256PublicJwk(jwk);
  return getSubtle().importKey("jwk", jwk, ECDSA_PARAMS, true, ["verify"]);
}

/** Import an ECDSA private (signing) key from a JWK. */
export function importEcdsaPrivateJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return getSubtle().importKey("jwk", jwk, ECDSA_PARAMS, true, ["sign"]);
}

/** Import an ECDH private key from a JWK (server-side key persistence). */
export function importEcdhPrivateJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return getSubtle().importKey("jwk", jwk, ECDH_PARAMS, true, ["deriveBits"]);
}

/**
 * ECDH(privateKey, publicKey) → HKDF-SHA-256(salt=∅, info) → AES-256-GCM key.
 * Both sides call this with their own private key and the peer's public key;
 * the same `info` (see {@link buildHkdfInfo}) yields the same AES key.
 */
export async function deriveAesGcmKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  info: Uint8Array,
): Promise<CryptoKey> {
  const subtle = getSubtle();
  const shared = await subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const hkdfKey = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: info as BufferSource },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Sign the canonical input; returns WebCrypto's raw r‖s (64 bytes). */
export async function signPayload(privateKey: CryptoKey, input: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await getSubtle().sign(ECDSA_SIGN, privateKey, input as BufferSource));
}

/** Verify a raw r‖s signature over the canonical input. */
export function verifyPayload(
  publicKey: CryptoKey,
  signature: Uint8Array,
  input: Uint8Array,
): Promise<boolean> {
  return getSubtle().verify(
    ECDSA_SIGN,
    publicKey,
    signature as BufferSource,
    input as BufferSource,
  );
}
