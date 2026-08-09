import { describe, it, expect } from "vitest";
import {
  parseLogQuery,
  parseLogQueryExpr,
  parseAttrPath,
  formatToken,
  formatExpr,
  findContradictions,
  isUnsatisfiable,
  type FilterExpr,
} from "../logger/parseLogQuery";
import { interpolate, secure, redact } from "../logger/template";
import { where, literal } from "../logger/query-builder";
import {
  toBase64Url,
  fromBase64Url,
  buildSigInput,
  isValidClientId,
  type E2ESigMeta,
} from "../adapters/http/e2e-wire";
import { createE2EServerContext } from "../server/e2e-context";
import { createLogRegistrationHandler } from "../server/registration-handler";
import { createLogIngestHandler } from "../server/ingest-handler";
import {
  E2E_ALGO_V1,
  E2E_HEADERS,
  E2E_ERROR_HEADER,
  buildHkdfInfo,
  deriveAesGcmKey,
  exportPublicKeyRaw,
  generateEcdhKeyPair,
  generateEcdsaKeyPair,
  importEcdhPublicJwk,
  randomBytes,
  signPayload,
} from "../adapters/http/e2e-wire";
import { createLogger } from "../logger/logger";
import type { LogRecord } from "../logger/adapter";

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) so any fuzz failure is reproducible. Seed
// from FUZZ_SEED to reproduce a specific run; each `describe` derives its own
// stream so tests stay independent.
// ---------------------------------------------------------------------------

const BASE_SEED = Number(process.env.FUZZ_SEED ?? 0x1234_5678) >>> 0;
const ITERATIONS = Number(process.env.FUZZ_ITER ?? 2000);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Report the seed on failure so it can be replayed via FUZZ_SEED. */
function withSeed<T>(label: string, seed: number, fn: (rand: () => number) => T): T {
  try {
    return fn(mulberry32(seed));
  } catch (err) {
    throw new Error(`[fuzz:${label}] failed — replay with FUZZ_SEED=${seed}\n${String(err)}`);
  }
}

const pick = <T>(rand: () => number, arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
const int = (rand: () => number, n: number): number => Math.floor(rand() * n);

// A charset skewed toward the grammar's structural characters, so the parser
// is exercised on realistic-looking-but-hostile input, not just noise.
const QUERY_CHARS = [
  ..."abcABC0123 ",
  ...":='<>!|&()[]*.-_,",
  ...`"'\\`,
  "null",
  "NULL",
  "::string",
  "$level",
  "$timestamp",
  "$message",
  "\n",
  "\t",
];

function randomQuery(rand: () => number, maxLen = 40): string {
  const n = int(rand, maxLen);
  let out = "";
  for (let i = 0; i < n; i++) out += pick(rand, QUERY_CHARS);
  return out;
}

// ---------------------------------------------------------------------------
// Query parsers — must NEVER throw and NEVER hang on any input.
// ---------------------------------------------------------------------------

describe("fuzz: query parsers never throw or hang", () => {
  it(`parseLogQueryExpr / parseLogQuery over ${ITERATIONS} random strings`, () => {
    withSeed("parse", BASE_SEED, (rand) => {
      for (let i = 0; i < ITERATIONS; i++) {
        const q = randomQuery(rand);
        // parseLogQueryExpr must return a Result (never throw).
        const start = Date.now();
        const r = parseLogQueryExpr(q);
        expect(Date.now() - start, `hang on ${JSON.stringify(q)}`).toBeLessThan(1000);
        expect(typeof r.ok).toBe("boolean");
        if (r.ok && r.val) {
          // A successfully parsed tree must be one of the three node shapes,
          // recursively, with the value always a string.
          assertWellFormed(r.val);
        }
        // parseLogQuery (flat) must never throw either.
        expect(Array.isArray(parseLogQuery(q))).toBe(true);
      }
    });
  });

  // Round-trip is fuzzed over tokens with REALISTIC keys (attribute names /
  // field names — identifiers and valid paths) but HOSTILE values (user data
  // is arbitrary: quotes, backslashes, newlines, grammar operators). Keys
  // carrying grammar-operator characters are excluded by design: a bare key
  // that is also a valid path but needs quoting cannot round-trip its
  // path-vs-literal classification (quoting *means* literal), and real
  // attribute names never contain `= < > | & ! : ' " \` or whitespace.
  it(`format → parse round-trip holds for ${ITERATIONS} generated tokens`, () => {
    withSeed("roundtrip", BASE_SEED ^ 0xa5a5, (rand) => {
      const OPS = ["contains", "=", ">", ">=", "<", "<="] as const;
      const REALISTIC_KEYS = [
        "level",
        "userId",
        "session.id",
        "cart.items[*].sku",
        "users[0]",
        "a.b.c",
        "$level",
        "$timestamp",
        "$message",
        "commit_hash",
        "region-name",
      ];
      const VALUE_CHARS = [..."abc012 -_.", ...`'"\\:=<>!|&()[]`, "\n", "\t"];

      const genValue = (): string => {
        let v = "";
        for (let j = 0; j < int(rand, 14); j++) v += pick(rand, VALUE_CHARS);
        return v;
      };
      const genToken = (): FilterExpr => {
        const key = pick(rand, REALISTIC_KEYS);
        const isBuiltin = key.startsWith("$");
        const operator = pick(rand, OPS);
        const filter: Record<string, unknown> = { key, operator, value: genValue() };
        if (rand() < 0.3) filter.negated = true;
        // $timestamp requires a parseable date value; give it one so the tree
        // survives the parser's semantic validation.
        if (key === "$timestamp") {
          filter.operator = pick(rand, [">", ">=", "<", "<="] as const);
          filter.value = "2003-01-02T09:30:00Z";
          delete filter.negated;
        }
        // ::string cast only applies to attribute comparisons.
        if (!isBuiltin && !filter.negated && rand() < 0.2 && filter.operator !== "contains") {
          filter.cast = "string";
        }
        return { type: "filter", filter } as unknown as FilterExpr;
      };
      const genTree = (depth: number): FilterExpr => {
        if (depth <= 0 || rand() < 0.4) return genToken();
        const kind = rand() < 0.5 ? "and" : "or";
        const n = 2 + int(rand, 2);
        return { type: kind, nodes: Array.from({ length: n }, () => genTree(depth - 1)) };
      };

      let checked = 0;
      for (let i = 0; i < ITERATIONS; i++) {
        // Normalize through one parse so the tree is in canonical form (the
        // form formatExpr targets) before asserting the fixed point.
        const seed = genTree(3);
        const canon = parseLogQueryExpr(formatExpr(seed));
        if (!canon.ok || canon.val === null) continue;
        const reparsed = parseLogQueryExpr(formatExpr(canon.val));
        expect(reparsed.ok, `reformat of ${formatExpr(canon.val)}`).toBe(true);
        if (reparsed.ok && reparsed.val) {
          expect(reparsed.val, `not idempotent: ${formatExpr(canon.val)}`).toEqual(canon.val);
          checked++;
        }
      }
      expect(checked, "no trees exercised the round-trip").toBeGreaterThan(ITERATIONS / 2);
    });
  });

  it(`findContradictions / isUnsatisfiable never throw over ${ITERATIONS} trees`, () => {
    withSeed("contradictions", BASE_SEED ^ 0x1111, (rand) => {
      for (let i = 0; i < ITERATIONS; i++) {
        const r = parseLogQueryExpr(randomQuery(rand));
        if (!r.ok) continue;
        expect(Array.isArray(findContradictions(r.val))).toBe(true);
        expect(typeof isUnsatisfiable(r.val)).toBe("boolean");
      }
    });
  });

  it(`parseAttrPath never throws and reconstructs consistently`, () => {
    withSeed("attrpath", BASE_SEED ^ 0x2222, (rand) => {
      const PATH_CHARS = [..."abc012.[]*", ..."-_"];
      for (let i = 0; i < ITERATIONS; i++) {
        const n = int(rand, 20);
        let key = "";
        for (let j = 0; j < n; j++) key += pick(rand, PATH_CHARS);
        const path = parseAttrPath(key);
        if (path === null) continue;
        // base must be non-empty and contain no path punctuation.
        expect(path.base.length).toBeGreaterThan(0);
        expect(/[.[\]]/.test(path.base)).toBe(false);
        for (const seg of path.segments) {
          if (seg.type === "index") expect(Number.isInteger(seg.index) && seg.index >= 0).toBe(true);
          if (seg.type === "member") expect(seg.name.length).toBeGreaterThan(0);
        }
      }
    });
  });
});

/** Structural invariant for a parsed FilterExpr. */
function assertWellFormed(node: FilterExpr): void {
  if (node.type === "filter") {
    expect(typeof node.filter.key).toBe("string");
    expect(typeof node.filter.value).toBe("string");
    expect(["contains", "=", ">", ">=", "<", "<="]).toContain(node.filter.operator);
    return;
  }
  expect(node.type === "and" || node.type === "or").toBe(true);
  expect(Array.isArray(node.nodes)).toBe(true);
  expect(node.nodes.length).toBeGreaterThan(0);
  for (const child of node.nodes) assertWellFormed(child);
}

// ---------------------------------------------------------------------------
// formatToken — arbitrary tokens must round-trip through the flat parser.
// ---------------------------------------------------------------------------

describe("fuzz: formatToken round-trips arbitrary values", () => {
  it(`format → parse preserves key/operator/value/flags`, () => {
    withSeed("token", BASE_SEED ^ 0x3333, (rand) => {
      const OPS = ["contains", "=", ">", ">=", "<", "<="] as const;
      const VALUE_CHARS = [..."abc012 ", ...`'"\\:=<>!|&()`, "\n"];
      for (let i = 0; i < ITERATIONS; i++) {
        let value = "";
        for (let j = 0; j < int(rand, 12); j++) value += pick(rand, VALUE_CHARS);
        // A key from ordinary characters (formatToken quotes special ones).
        let key = "";
        for (let j = 0; j < 1 + int(rand, 8); j++) key += pick(rand, [..."abcKEY._-"]);
        const token = {
          key,
          operator: pick(rand, OPS),
          value,
          ...(rand() < 0.3 ? { negated: true } : {}),
        };
        const round = parseLogQuery(formatToken(token));
        expect(round.length, `dropped: ${formatToken(token)}`).toBe(1);
        expect(round[0].key).toBe(token.key);
        expect(round[0].operator).toBe(token.operator);
        expect(round[0].value).toBe(token.value);
        expect(!!round[0].negated).toBe(!!token.negated);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// interpolate — never throws for any template + attrs shape.
// ---------------------------------------------------------------------------

describe("fuzz: interpolate never throws", () => {
  it(`over ${ITERATIONS} random templates and attribute maps`, () => {
    withSeed("interpolate", BASE_SEED ^ 0x4444, (rand) => {
      const TPL_CHARS = [..."abc {}", ..."{key}{a}{0}{__}{$x}", "{", "}", "\\"];
      for (let i = 0; i < ITERATIONS; i++) {
        let tpl = "";
        for (let j = 0; j < int(rand, 30); j++) tpl += pick(rand, TPL_CHARS);
        const attrs: Record<string, unknown> = {};
        const keys = ["key", "a", "0", "__", "$x", "nested"];
        for (const k of keys) {
          if (rand() < 0.5) continue;
          const roll = rand();
          attrs[k] =
            roll < 0.2
              ? { deep: [1, 2, { x: rand() }] }
              : roll < 0.4
                ? secure(String(rand()))
                : roll < 0.6
                  ? redact(String(rand()))
                  : roll < 0.8
                    ? rand() * 1e6
                    : String(rand());
        }
        const out = interpolate(tpl, attrs);
        expect(typeof out).toBe("string");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Query builder — random chains must build a well-formed, round-tripping tree.
// ---------------------------------------------------------------------------

describe("fuzz: query builder produces round-tripping trees", () => {
  it(`random where()/and()/or() chains`, () => {
    withSeed("builder", BASE_SEED ^ 0x5555, (rand) => {
      const KEYS = ["a", "b", "session.id", "users[*]", "$level", "commit"];
      const VALS = ["1", "x", "error", "info", "123"];
      type QB = ReturnType<ReturnType<typeof where>["eq"]>;
      const leaf = (): QB => {
        try {
          const key = pick(rand, KEYS);
          const w = rand() < 0.5 ? where(key) : literal(key);
          const op = pick(rand, ["eq", "notEq", "contains", "gt", "lt"] as const);
          return w[op](pick(rand, VALS));
        } catch {
          // where()/an operator can throw (malformed path, bad $timestamp) —
          // fall back to a guaranteed-valid leaf.
          return where("safe").eq("1");
        }
      };
      const build = (depth: number): QB => {
        let b = leaf();
        if (depth > 0 && rand() < 0.6) {
          const other = build(depth - 1);
          b = rand() < 0.5 ? b.and(other) : b.or(other);
        }
        return b;
      };

      for (let i = 0; i < 400; i++) {
        const built = build(3 + int(rand, 3)).build();
        assertWellFormed(built);
        const reparsed = parseLogQueryExpr(formatExpr(built));
        expect(reparsed.ok).toBe(true);
        if (reparsed.ok) expect(reparsed.val).toEqual(built);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// base64url — round-trips arbitrary bytes; rejects out-of-alphabet input.
// ---------------------------------------------------------------------------

describe("fuzz: base64url", () => {
  it(`round-trips arbitrary byte arrays over ${ITERATIONS} cases`, () => {
    withSeed("b64", BASE_SEED ^ 0x6666, (rand) => {
      for (let i = 0; i < ITERATIONS; i++) {
        const len = int(rand, 300);
        const bytes = new Uint8Array(len);
        for (let j = 0; j < len; j++) bytes[j] = int(rand, 256);
        const encoded = toBase64Url(bytes);
        expect(/^[A-Za-z0-9_-]*$/.test(encoded), `non-url-safe: ${encoded}`).toBe(true);
        expect([...fromBase64Url(encoded)]).toEqual([...bytes]);
      }
    });
  });

  it(`buildSigInput is injective on its fields`, () => {
    withSeed("siginput", BASE_SEED ^ 0x7777, (rand) => {
      const field = () => toBase64Url(randomBytes(1 + int(rand, 8)));
      const seen = new Map<string, string>();
      for (let i = 0; i < 500; i++) {
        const meta: E2ESigMeta = {
          algo: E2E_ALGO_V1,
          clientId: `c${int(rand, 5)}`,
          ts: String(int(rand, 1e9)),
          nonce: field(),
          key: field(),
          iv: field(),
        };
        const ct = randomBytes(int(rand, 16));
        const out = toBase64Url(buildSigInput(meta, ct));
        const id = JSON.stringify([meta, [...ct]]);
        const prior = seen.get(out);
        // Two DIFFERENT (meta, ciphertext) pairs must not yield identical bytes.
        if (prior !== undefined) expect(prior).toBe(id);
        seen.set(out, id);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// E2E — seal/open round-trips arbitrary payloads; any tamper is rejected.
// ---------------------------------------------------------------------------

describe("fuzz: E2E seal/open", () => {
  it("round-trips arbitrary JSON payloads and rejects any single-byte tamper", async () => {
    const seedRand = mulberry32(BASE_SEED ^ 0x8888);
    const ctx = createE2EServerContext();
    const signing = await generateEcdsaKeyPair();
    const records: LogRecord[] = [];
    const logger = createLogger();
    logger.addAdapter({ write: (r: LogRecord) => void records.push(r) });
    const ingest = createLogIngestHandler({ logger, encryption: { context: ctx } });

    // Register once (pinned), then reuse.
    await createLogRegistrationHandler(ctx)(
      new Request("http://x/register", {
        method: "POST",
        body: JSON.stringify({
          clientId: "fuzz",
          algo: E2E_ALGO_V1,
          signingKey: await crypto.subtle.exportKey("jwk", signing.publicKey),
        }),
      }),
    );

    const ROUNDS = 40; // crypto is slow — a smaller but meaningful sweep
    for (let i = 0; i < ROUNDS; i++) {
      // A random-shaped but valid payload.
      const n = int(seedRand, 4);
      const logs = Array.from({ length: n }, (_, j) => ({
        level: "info",
        message: `m${i}-${j}-${"x".repeat(int(seedRand, 50))}`,
        template: "m",
        secureMessage: false,
        attrs: { r: seedRand(), nested: { a: [1, 2, int(seedRand, 9)] } },
        timestamp: new Date(int(seedRand, 1e12)).toISOString(),
      }));
      const payload = new TextEncoder().encode(JSON.stringify({ logs }));

      const sealedFresh = await sealFor(ctx, signing, "fuzz", payload);
      const ok = await ingest(
        new Request("http://x/api/logs", { method: "POST", headers: sealedFresh.headers, body: sealedFresh.body as BodyInit }),
      );
      expect(ok.status, `round ${i}`).toBe(200);

      // Tamper one random byte of the ciphertext → must be rejected.
      const sealedTamper = await sealFor(ctx, signing, "fuzz", payload);
      if (sealedTamper.body.length > 0) {
        const idx = int(seedRand, sealedTamper.body.length);
        sealedTamper.body[idx] ^= 1 << int(seedRand, 8);
        const bad = await ingest(
          new Request("http://x/api/logs", {
            method: "POST",
            headers: sealedTamper.headers,
            body: sealedTamper.body as BodyInit,
          }),
        );
        expect(bad.status, `tamper round ${i}`).not.toBe(200);
        expect(bad.headers.get(E2E_ERROR_HEADER)).toBe("invalid-signature");
      }
    }
    expect(records.length).toBeGreaterThan(0);
  });

  // Helper reused above (declared after for clarity of the main test body).
  async function sealFor(
    ctx: ReturnType<typeof createE2EServerContext>,
    signing: CryptoKeyPair,
    clientId: string,
    payload: Uint8Array,
  ) {
    const reg = await ctx.registerClient({
      clientId,
      algo: E2E_ALGO_V1,
      signingKey: await crypto.subtle.exportKey("jwk", signing.publicKey),
    });
    if (!reg.ok) throw new Error("register failed");
    const serverPub = await importEcdhPublicJwk(reg.serverKeyJwk);
    const ephemeral = await generateEcdhKeyPair();
    const ephRaw = await exportPublicKeyRaw(ephemeral.publicKey);
    const srvRaw = await exportPublicKeyRaw(serverPub);
    const aes = await deriveAesGcmKey(
      ephemeral.privateKey,
      serverPub,
      buildHkdfInfo(E2E_ALGO_V1, clientId, toBase64Url(ephRaw), toBase64Url(srvRaw)),
    );
    const iv = randomBytes(12);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, aes, payload as BufferSource),
    );
    const meta = {
      algo: E2E_ALGO_V1,
      clientId,
      ts: String(Date.now()),
      nonce: toBase64Url(randomBytes(16)),
      key: toBase64Url(ephRaw),
      iv: toBase64Url(iv),
    };
    const sig = await signPayload(signing.privateKey, buildSigInput(meta, ct));
    return {
      body: ct,
      headers: {
        "content-type": "application/octet-stream",
        [E2E_HEADERS.algo]: meta.algo,
        [E2E_HEADERS.client]: meta.clientId,
        [E2E_HEADERS.ts]: meta.ts,
        [E2E_HEADERS.nonce]: meta.nonce,
        [E2E_HEADERS.key]: meta.key,
        [E2E_HEADERS.iv]: meta.iv,
        [E2E_HEADERS.sig]: toBase64Url(sig),
      },
    };
  }
});

// ---------------------------------------------------------------------------
// isValidClientId — the invariant the signature canonicalization relies on.
// ---------------------------------------------------------------------------

describe("fuzz: isValidClientId excludes newline (sig-input safety)", () => {
  it("no accepted clientId can contain a field-delimiter character", () => {
    withSeed("clientid", BASE_SEED ^ 0x9999, (rand) => {
      const CHARS = [..."abcABC012._:-", "\n", "\t", " ", "/", "💥", "|"];
      for (let i = 0; i < ITERATIONS; i++) {
        let id = "";
        for (let j = 0; j < int(rand, 20); j++) id += pick(rand, CHARS);
        if (isValidClientId(id)) {
          // The whole point: an accepted id can never break buildSigInput.
          expect(id).not.toContain("\n");
          expect(id.length).toBeGreaterThan(0);
          expect(id.length).toBeLessThanOrEqual(128);
        }
      }
    });
  });
});
