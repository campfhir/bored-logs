/**
 * Server half of end-to-end shipment encryption: the shared context that
 * holds the server's ECDH keypair, the client-registration store, and the
 * anti-replay nonce cache. One context is shared between
 * `createLogRegistrationHandler` (which fills the store) and
 * `createLogIngestHandler` (whose `encryption` option uses `open()` to
 * verify + decrypt shipments before the normal ingest pipeline runs).
 *
 * Verification order in `open()` is deliberate and security-relevant:
 * header validation → client lookup → SIGNATURE → timestamp skew → nonce
 * check/insert → decrypt. Signature-first means unauthenticated traffic can
 * never poison the nonce cache.
 */
import {
  E2E_ALGO_V1,
  E2E_HEADERS,
  type E2EErrorCode,
  buildHkdfInfo,
  buildSigInput,
  deriveAesGcmKey,
  exportPublicKeyRaw,
  fromBase64Url,
  generateEcdhKeyPair,
  getSubtle,
  importEcdhPrivateJwk,
  importEcdhPublicJwk,
  importEcdhPublicRaw,
  importEcdsaPublicJwk,
  isValidClientId,
  toBase64Url,
  verifyPayload,
} from "../adapters/http/e2e-wire";

// ---------------------------------------------------------------------------
// Registration store
// ---------------------------------------------------------------------------

/** A registered shipping client: its identity and public signing key. */
export type E2ERegistration = {
  clientId: string;
  /** ECDSA P-256 public JWK the client signs shipments with. */
  signingKeyJwk: JsonWebKey;
  algo: string;
  /** Unix ms at (last) registration. */
  registeredAt: number;
};

/**
 * Pluggable persistence for client registrations. The default is in-memory
 * (registrations die with the process — clients transparently re-register);
 * implement this against your database for multi-instance or restart-stable
 * registration.
 */
export interface E2ERegistrationStore {
  get(clientId: string): E2ERegistration | undefined | Promise<E2ERegistration | undefined>;
  set(registration: E2ERegistration): void | Promise<void>;
  delete(clientId: string): void | Promise<void>;
}

/** The default {@link E2ERegistrationStore}: a process-local Map. */
export class MemoryRegistrationStore implements E2ERegistrationStore {
  private readonly _map = new Map<string, E2ERegistration>();
  get(clientId: string): E2ERegistration | undefined {
    return this._map.get(clientId);
  }
  set(registration: E2ERegistration): void {
    this._map.set(registration.clientId, registration);
  }
  delete(clientId: string): void {
    this._map.delete(clientId);
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** A P-256 keypair as portable JWKs (e.g. from {@link generateE2EServerKeys} / `exportKeys`). */
export type E2EKeyPairJwk = { publicJwk: JsonWebKey; privateJwk: JsonWebKey };

/** Options for {@link createE2EServerContext}. */
export type E2EServerContextOptions = {
  /**
   * The server's static ECDH P-256 keypair (JWK). Omit to generate a fresh
   * pair at first use — clients sealed against a previous pair then get
   * `decrypt-failed` and transparently re-register. Persist via `exportKeys()`
   * to keep shipments valid across restarts.
   */
  keys?: E2EKeyPairJwk;
  /** Client-registration persistence. Defaults to {@link MemoryRegistrationStore}. */
  store?: E2ERegistrationStore;
  /** Max allowed |now − shipment ts|, ms, both directions. Default 300 000 (5 min). */
  clockSkewMs?: number;
  /** Anti-replay nonce cache capacity (oldest evicted past it). Default 10 000. */
  nonceCacheSize?: number;
  /**
   * Key-continuity policy. `"pinned"` (default): once a clientId is
   * registered, re-registration with the SAME signing key is idempotent
   * (restart recovery), but a DIFFERENT key is refused with
   * `client-key-conflict` — an attacker who can reach the endpoint cannot
   * take over an existing identity. Deliberate client-key rotation =
   * `store.delete(clientId)` first. `"open"` restores last-write-wins.
   */
  registration?: "pinned" | "open";
};

/** The result of {@link E2EServerContext.open}. */
export type E2EOpenResult =
  | { ok: true; text: string }
  | { ok: false; status: number; code: E2EErrorCode };

/** Shared server-side E2E state — see {@link createE2EServerContext}. */
export type E2EServerContext = {
  /** The client-registration store (exposed for custom flows and tests). */
  store: E2ERegistrationStore;
  /** Supported cipher suites, most preferred first. */
  algos: readonly string[];
  /** Register/upsert a client (used by `createLogRegistrationHandler`). */
  registerClient(registration: {
    clientId: string;
    algo: string;
    signingKey: JsonWebKey;
  }): Promise<{ ok: true; serverKeyJwk: JsonWebKey } | { ok: false; code: E2EErrorCode; error: string }>;
  /** Verify + decrypt an encrypted shipment request; returns the plaintext UTF-8 body. */
  open(request: Request): Promise<E2EOpenResult>;
  /** Export the server keypair (JWK) for persistence across restarts. */
  exportKeys(): Promise<E2EKeyPairJwk>;
  /**
   * Rotate the server's ECDH keypair, returning the NEW pair for
   * persistence. In-flight shipments sealed against the old key answer
   * `decrypt-failed`, which makes clients transparently re-register and
   * fetch the new key — rotating on a schedule shrinks the
   * capture-then-decrypt window to one rotation period.
   */
  rotateKeys(): Promise<E2EKeyPairJwk>;
};

/** Generate a fresh server ECDH P-256 keypair as portable JWKs. */
export async function generateE2EServerKeys(): Promise<E2EKeyPairJwk> {
  const subtle = getSubtle();
  const pair = await generateEcdhKeyPair();
  return {
    publicJwk: await subtle.exportKey("jwk", pair.publicKey),
    privateJwk: await subtle.exportKey("jwk", pair.privateKey),
  };
}

/** Create the shared server-side E2E context. Sync — keys import/generate lazily. */
export function createE2EServerContext(options: E2EServerContextOptions = {}): E2EServerContext {
  const store = options.store ?? new MemoryRegistrationStore();
  const clockSkewMs = options.clockSkewMs ?? 300_000;
  const nonceCacheSize = options.nonceCacheSize ?? 10_000;
  const registrationMode = options.registration ?? "pinned";

  // Nonce LRU: insertion-ordered Map, key `${clientId}:${nonce}` → seen-at ms.
  const nonces = new Map<string, number>();
  const rememberNonce = (key: string, now: number): void => {
    // Lazy purge: drop entries old enough that the skew window already
    // rejects their timestamps.
    for (const [k, at] of nonces) {
      if (now - at > 2 * clockSkewMs) nonces.delete(k);
      else break; // insertion-ordered — the rest are newer
    }
    nonces.set(key, now);
    while (nonces.size > nonceCacheSize) {
      const oldest = nonces.keys().next().value as string;
      nonces.delete(oldest);
    }
  };

  // Lazy, ROTATABLE server keypair (WebCrypto is async; the factory is sync).
  type ServerKeys = {
    privateKey: CryptoKey;
    publicJwk: JsonWebKey;
    privateJwk: JsonWebKey;
    publicRawB64: string;
  };
  let keysPromise: Promise<ServerKeys> | null = null;
  const materialize = async (pair: CryptoKeyPair): Promise<ServerKeys> => {
    const subtle = getSubtle();
    return {
      privateKey: pair.privateKey,
      publicJwk: await subtle.exportKey("jwk", pair.publicKey),
      privateJwk: await subtle.exportKey("jwk", pair.privateKey),
      publicRawB64: toBase64Url(await exportPublicKeyRaw(pair.publicKey)),
    };
  };
  const keys = () => {
    keysPromise ??= (async () => {
      if (options.keys) {
        const privateKey = await importEcdhPrivateJwk(options.keys.privateJwk);
        const publicKey = await importEcdhPublicJwk(options.keys.publicJwk);
        return {
          privateKey,
          publicJwk: options.keys.publicJwk,
          privateJwk: options.keys.privateJwk,
          publicRawB64: toBase64Url(await exportPublicKeyRaw(publicKey)),
        };
      }
      return materialize(await generateEcdhKeyPair());
    })();
    return keysPromise;
  };

  return {
    store,
    algos: [E2E_ALGO_V1],

    async registerClient({ clientId, algo, signingKey }) {
      if (typeof clientId !== "string" || !isValidClientId(clientId)) {
        return { ok: false, code: "bad-e2e-headers", error: "invalid clientId" };
      }
      if (algo !== E2E_ALGO_V1) {
        return { ok: false, code: "unsupported-algo", error: `unsupported algo ${JSON.stringify(algo)}` };
      }
      try {
        await importEcdsaPublicJwk(signingKey); // validates shape + curve, rejects private material
      } catch (err) {
        return { ok: false, code: "bad-e2e-headers", error: `invalid signingKey: ${String(err)}` };
      }
      if (registrationMode === "pinned") {
        const existing = await store.get(clientId);
        if (
          existing &&
          (existing.signingKeyJwk.x !== signingKey.x || existing.signingKeyJwk.y !== signingKey.y)
        ) {
          return {
            ok: false,
            code: "client-key-conflict",
            error:
              `clientId ${JSON.stringify(clientId)} is already registered with a different ` +
              `signing key. Give the client a persistent identity (generateE2ESigningKeys), ` +
              `or rotate deliberately via store.delete(clientId), or opt into ` +
              `registration: "open".`,
          };
        }
      }
      await store.set({ clientId, signingKeyJwk: signingKey, algo, registeredAt: Date.now() });
      return { ok: true, serverKeyJwk: (await keys()).publicJwk };
    },

    async open(request) {
      // 1. Envelope shape — every header present, decodable, right-sized.
      const h = (name: string) => request.headers.get(name);
      const algo = h(E2E_HEADERS.algo);
      const clientId = h(E2E_HEADERS.client);
      const ts = h(E2E_HEADERS.ts);
      const nonce = h(E2E_HEADERS.nonce);
      const keyB64 = h(E2E_HEADERS.key);
      const ivB64 = h(E2E_HEADERS.iv);
      const sigB64 = h(E2E_HEADERS.sig);
      if (!algo || !clientId || !ts || !nonce || !keyB64 || !ivB64 || !sigB64) {
        return { ok: false, status: 400, code: "bad-e2e-headers" };
      }
      if (algo !== E2E_ALGO_V1 || !isValidClientId(clientId) || !/^\d{1,16}$/.test(ts)) {
        return { ok: false, status: 400, code: "bad-e2e-headers" };
      }
      let ephemeralRaw: Uint8Array, iv: Uint8Array, sig: Uint8Array;
      try {
        ephemeralRaw = fromBase64Url(keyB64);
        iv = fromBase64Url(ivB64);
        sig = fromBase64Url(sigB64);
      } catch {
        return { ok: false, status: 400, code: "bad-e2e-headers" };
      }
      if (ephemeralRaw.length !== 65 || iv.length !== 12 || sig.length !== 64) {
        return { ok: false, status: 400, code: "bad-e2e-headers" };
      }

      // 2. Client lookup.
      const registration = await store.get(clientId);
      if (!registration) return { ok: false, status: 401, code: "unknown-client" };

      // 3. SIGNATURE — before any state is touched (nonce cache stays clean
      //    of unauthenticated traffic).
      const ciphertext = new Uint8Array(await request.arrayBuffer());
      let verified = false;
      try {
        const signingKey = await importEcdsaPublicJwk(registration.signingKeyJwk);
        verified = await verifyPayload(
          signingKey,
          sig,
          buildSigInput({ algo, clientId, ts, nonce, key: keyB64, iv: ivB64 }, ciphertext),
        );
      } catch {
        verified = false;
      }
      if (!verified) return { ok: false, status: 401, code: "invalid-signature" };

      // 4. Freshness.
      const now = Date.now();
      const tsMs = parseInt(ts, 10);
      if (Math.abs(now - tsMs) > clockSkewMs) {
        return { ok: false, status: 400, code: "stale-timestamp" };
      }

      // 5. Replay.
      const nonceKey = `${clientId}:${nonce}`;
      if (nonces.has(nonceKey)) return { ok: false, status: 400, code: "replay" };
      rememberNonce(nonceKey, now);

      // 6. Derive + decrypt.
      try {
        const { privateKey, publicRawB64 } = await keys();
        const ephemeralKey = await importEcdhPublicRaw(ephemeralRaw);
        const aes = await deriveAesGcmKey(
          privateKey,
          ephemeralKey,
          buildHkdfInfo(algo, clientId, keyB64, publicRawB64),
        );
        const plaintext = await getSubtle().decrypt(
          { name: "AES-GCM", iv: iv as BufferSource },
          aes,
          ciphertext as BufferSource,
        );
        return { ok: true, text: new TextDecoder().decode(plaintext) };
      } catch {
        // Signature was valid, so this is OUR side mismatching — most likely
        // a rotated server key. The coded response tells the client to
        // re-register (fetching the new key) and retry.
        return { ok: false, status: 400, code: "decrypt-failed" };
      }
    },

    async exportKeys() {
      const k = await keys();
      return { publicJwk: k.publicJwk, privateJwk: k.privateJwk };
    },

    async rotateKeys() {
      const next = await materialize(await generateEcdhKeyPair());
      keysPromise = Promise.resolve(next);
      return { publicJwk: next.publicJwk, privateJwk: next.privateJwk };
    },
  };
}
