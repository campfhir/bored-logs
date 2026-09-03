/**
 * Client half of end-to-end shipment encryption: the session state machine
 * the `HttpAdapter` drives when its `encryption` option is set.
 *
 * Lifecycle: `ensureRegistered()` (single-flight — generates or imports the
 * ECDSA signing identity, POSTs it to the registration endpoint, imports the
 * server's ECDH public key) → `seal()` per POST (fresh ephemeral ECDH pair,
 * HKDF-derived AES-256-GCM key, signature over the canonical input) →
 * `reset()` when the server answers `unknown-client` / `decrypt-failed`
 * (restart or key rotation), after which re-registration self-heals.
 */
import {
  E2E_ALGO_V1,
  E2E_HEADERS,
  buildHkdfInfo,
  buildSigInput,
  deriveAesGcmKey,
  exportPublicKeyRaw,
  generateEcdhKeyPair,
  generateEcdsaKeyPair,
  getSubtle,
  importEcdhPublicJwk,
  importEcdsaPrivateJwk,
  randomBytes,
  toBase64Url,
} from "./e2e-wire";

/** A client signing identity as portable JWKs (see {@link generateE2ESigningKeys}). */
export type E2ESigningKeysJwk = { publicJwk: JsonWebKey; privateJwk: JsonWebKey };

/**
 * Generate a persistent ECDSA P-256 signing identity for a shipping client.
 * Persist the JWKs and pass them back via `encryption.signingKeys` so the
 * client keeps the same identity across restarts; without them a fresh
 * identity is generated per session.
 */
export async function generateE2ESigningKeys(): Promise<E2ESigningKeysJwk> {
  const subtle = getSubtle();
  const pair = await generateEcdsaKeyPair();
  return {
    publicJwk: await subtle.exportKey("jwk", pair.publicKey),
    privateJwk: await subtle.exportKey("jwk", pair.privateKey),
  };
}

/** Construction options for {@link E2EClientSession}. */
export type E2EClientSessionOptions = {
  /** The registration endpoint URL. */
  registrationEndpoint: string;
  /** This client's identity string (validated server-side). */
  clientId: string;
  /** Persistent signing identity; omitted → generated for this session. */
  signingKeys?: E2ESigningKeysJwk;
  /** Resolves the user's request headers (auth etc.) — sent on registration too. */
  resolveHeaders?: () => Promise<Record<string, string>>;
  credentials?: RequestCredentials;
};

/** A sealed shipment: the ciphertext body plus its envelope headers. */
export type SealedShipment = { body: Uint8Array; headers: Record<string, string> };

/** The registration + sealing state machine (one per adapter configuration). */
export class E2EClientSession {
  readonly clientId: string;
  private readonly _opts: E2EClientSessionOptions;
  private _signingPrivate: CryptoKey | null = null;
  private _signingPublicJwk: JsonWebKey | null = null;
  private _serverPublic: CryptoKey | null = null;
  private _serverPublicRawB64: string | null = null;
  private _registering: Promise<void> | null = null;

  constructor(opts: E2EClientSessionOptions) {
    this._opts = opts;
    this.clientId = opts.clientId;
  }

  /** True once registered — the unload path checks this and never registers itself. */
  get isReady(): boolean {
    return this._serverPublic !== null;
  }

  /** Forget the registration (server restart / key rotation) — next `ensureRegistered` re-registers. */
  reset(): void {
    this._serverPublic = null;
    this._serverPublicRawB64 = null;
    this._registering = null;
  }

  /** Register with the server if not already; single-flight across callers. */
  ensureRegistered(): Promise<void> {
    if (this.isReady) return Promise.resolve();
    this._registering ??= this._register().catch((err) => {
      // A failed attempt must not poison future ones.
      this._registering = null;
      throw err;
    });
    return this._registering;
  }

  private async _register(): Promise<void> {
    const subtle = getSubtle();
    if (!this._signingPrivate) {
      if (this._opts.signingKeys) {
        this._signingPrivate = await importEcdsaPrivateJwk(this._opts.signingKeys.privateJwk);
        this._signingPublicJwk = this._opts.signingKeys.publicJwk;
      } else {
        const pair = await generateEcdsaKeyPair();
        this._signingPrivate = pair.privateKey;
        this._signingPublicJwk = await subtle.exportKey("jwk", pair.publicKey);
      }
    }

    const extra = (await this._opts.resolveHeaders?.()) ?? {};
    const res = await fetch(this._opts.registrationEndpoint, {
      method: "POST",
      headers: { ...extra, "content-type": "application/json" },
      body: JSON.stringify({
        clientId: this.clientId,
        algo: E2E_ALGO_V1,
        signingKey: this._signingPublicJwk,
      }),
      credentials: this._opts.credentials,
    });
    if (!res.ok) {
      // Surface the server's machine-readable code (e.g. client-key-conflict,
      // unauthorized) so the failure is diagnosable from the error alone.
      const code = res.headers.get("x-bored-logs-error");
      throw new Error(
        `[bored-logs] e2e registration failed: HTTP ${res.status}${code ? ` (${code})` : ""}` +
          (code === "client-key-conflict"
            ? " — this clientId is pinned to a different signing key; use persistent " +
              "signingKeys, or rotate via store.delete(clientId) on the server"
            : ""),
      );
    }
    const body = (await res.json()) as { serverKey?: JsonWebKey };
    if (!body.serverKey) {
      throw new Error("[bored-logs] e2e registration response carried no serverKey");
    }
    const serverPublic = await importEcdhPublicJwk(body.serverKey);
    this._serverPublicRawB64 = toBase64Url(await exportPublicKeyRaw(serverPublic));
    this._serverPublic = serverPublic;
  }

  /**
   * Encrypt + sign one shipment. A fresh ephemeral ECDH keypair per call
   * makes the derived AES key single-use (IV reuse structurally impossible).
   */
  async seal(plaintext: Uint8Array): Promise<SealedShipment> {
    if (!this._serverPublic || !this._serverPublicRawB64 || !this._signingPrivate) {
      throw new Error("[bored-logs] e2e session is not registered — call ensureRegistered() first");
    }
    const subtle = getSubtle();

    const ephemeral = await generateEcdhKeyPair();
    const ephemeralRawB64 = toBase64Url(await exportPublicKeyRaw(ephemeral.publicKey));
    const aes = await deriveAesGcmKey(
      ephemeral.privateKey,
      this._serverPublic,
      buildHkdfInfo(E2E_ALGO_V1, this.clientId, ephemeralRawB64, this._serverPublicRawB64),
    );

    const iv = randomBytes(12);
    const ciphertext = new Uint8Array(
      await subtle.encrypt(
        { name: "AES-GCM", iv: iv as BufferSource },
        aes,
        plaintext as BufferSource,
      ),
    );

    const meta = {
      algo: E2E_ALGO_V1,
      clientId: this.clientId,
      ts: String(Date.now()),
      nonce: toBase64Url(randomBytes(16)),
      key: ephemeralRawB64,
      iv: toBase64Url(iv),
    };
    const signature = await subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      this._signingPrivate,
      buildSigInput(meta, ciphertext) as BufferSource,
    );

    return {
      body: ciphertext,
      headers: {
        [E2E_HEADERS.algo]: meta.algo,
        [E2E_HEADERS.client]: meta.clientId,
        [E2E_HEADERS.ts]: meta.ts,
        [E2E_HEADERS.nonce]: meta.nonce,
        [E2E_HEADERS.key]: meta.key,
        [E2E_HEADERS.iv]: meta.iv,
        [E2E_HEADERS.sig]: toBase64Url(new Uint8Array(signature)),
      },
    };
  }
}
