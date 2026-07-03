import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Kysely,
  PostgresAdapter as KyselyPostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from "kysely";
import { PostgresAdapter } from "../adapters/psql/adapter";
import type { LogRecord, AdapterWarning } from "../logger/adapter";

// ---------------------------------------------------------------------------
// Attribute-value size routing.
//
// log_attr.val carries a btree index (attr_val_name_idx) whose rows max out at
// ~2704 bytes. Values at/above MAX_ATTR_VAL_LENGTH (2000) UTF-8 bytes must be
// routed to the un-indexed bytea blob table instead — measured by encoded byte
// length so multibyte text and base64 ciphertext can't slip past the limit.
//
// We drive the real write path through a capturing driver (which hands back a
// log_id for the `logs` insert) and inspect the compiled INSERT statements.
// ---------------------------------------------------------------------------

function makeCapturingDb() {
  const compiled: CompiledQuery[] = [];

  const connection: DatabaseConnection = {
    async executeQuery<R>(cq: CompiledQuery): Promise<QueryResult<R>> {
      compiled.push(cq);
      // The batch writer needs a log_id back from the `logs` insert.
      if (/insert into "logs"/.test(cq.sql)) {
        return { rows: [{ log_id: "1" }] as unknown as R[] };
      }
      return { rows: [] as R[] };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      return;
    },
  };

  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return connection;
    },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    async releaseConnection() {},
    async destroy() {},
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = new Kysely<any>({
    dialect: {
      createAdapter: () => new KyselyPostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });

  return { db, compiled };
}

function baseRecord(attrs: Record<string, unknown>): LogRecord {
  return {
    level: "info",
    message: "m",
    template: "m",
    secureMessage: false,
    attrs,
    timestamp: new Date(0),
  };
}

const attrInsert = (compiled: CompiledQuery[]) =>
  compiled.find((c) => /insert into "log_attr" /.test(c.sql));
const blobInsert = (compiled: CompiledQuery[]) =>
  compiled.find((c) => /insert into "log_attr_blob"/.test(c.sql));

describe("PostgresAdapter — attribute value size routing (btree safety)", () => {
  let compiled: CompiledQuery[];
  let adapter: PostgresAdapter;

  beforeEach(() => {
    const cap = makeCapturingDb();
    compiled = cap.compiled;
    adapter = new PostgresAdapter({ db: cap.db });
  });

  afterEach(async () => {
    await adapter.close();
  });

  it("routes a multibyte value under the char limit but over the byte limit to the blob table", async () => {
    // 1000 × "あ" = 1000 chars but 3000 UTF-8 bytes — the exact shape that used
    // to slip into log_attr.val and blow the btree limit.
    const big = "あ".repeat(1000);
    expect(big.length).toBeLessThan(2000); // char count under threshold
    expect(Buffer.byteLength(big, "utf-8")).toBeGreaterThanOrEqual(2000);

    adapter.write(baseRecord({ big, small: "hi" }));
    await adapter.flush();

    const attr = attrInsert(compiled);
    const blob = blobInsert(compiled);
    expect(attr).toBeDefined();
    expect(blob).toBeDefined();

    // The oversized value is NOT stored inline (would break the btree index);
    // log_attr carries a null val + "binary" type for it.
    expect(attr!.parameters).not.toContain(big);
    expect(attr!.parameters).toContain(null);
    expect(attr!.parameters).toContain("binary");

    // The small value stays inline as a normal string.
    expect(attr!.parameters).toContain("hi");
    expect(attr!.parameters).toContain("string");

    // The oversized value lands in the blob table as bytea.
    const buf = blob!.parameters.find((p): p is Buffer => Buffer.isBuffer(p));
    expect(buf).toBeDefined();
    expect(buf!.toString("utf-8")).toBe(big);
  });

  it("keeps a small multibyte value inline", async () => {
    const small = "あ".repeat(10); // 30 bytes — well under the limit
    adapter.write(baseRecord({ small }));
    await adapter.flush();

    const attr = attrInsert(compiled);
    expect(attr!.parameters).toContain(small);
    expect(attr!.parameters).toContain("string");
    expect(blobInsert(compiled)).toBeUndefined();
  });

  it("routes to the blob table when encryption expansion pushes a value over the byte limit", async () => {
    // Identity-ish encrypt: base64url of the UTF-8 bytes (~33% larger). A 1600
    // byte plaintext is under the limit, but its ciphertext is over it.
    const cap = makeCapturingDb();
    compiled = cap.compiled;
    const enc = new PostgresAdapter({
      db: cap.db,
      encrypt: (s: string) => Buffer.from(s, "utf-8"),
      decrypt: (s: string) => s,
    });

    const { secure } = await import("../logger/template");
    const plain = "a".repeat(1600);
    expect(Buffer.byteLength(plain, "utf-8")).toBeLessThan(2000); // plaintext fits

    enc.write(baseRecord({ token: secure(plain) }));
    await enc.flush();

    const attr = attrInsert(compiled);
    expect(attr!.parameters).toContain("binary");
    expect(attr!.parameters).not.toContain(plain);
    expect(blobInsert(compiled)).toBeDefined();

    await enc.close();
  });

  it("caps the stored blob value by UTF-8 byte length without splitting a character", async () => {
    const cap = makeCapturingDb();
    const warnings: AdapterWarning[] = [];
    const a = new PostgresAdapter({
      db: cap.db,
      onWarning: (w) => warnings.push(w),
    });

    // 30000 × "あ" = 90000 UTF-8 bytes — well over the 64 KB blob cap.
    const huge = "あ".repeat(30000);
    a.write(baseRecord({ big: huge }));
    await a.flush();

    const blob = blobInsert(cap.compiled);
    const buf = blob!.parameters.find((p): p is Buffer => Buffer.isBuffer(p));
    expect(buf).toBeDefined();
    // Stored bytea is bounded to the byte cap (65536) and decodes cleanly to a
    // whole-character prefix of the original.
    expect(buf!.length).toBeLessThanOrEqual(65_536);
    expect(buf!.toString("utf-8")).toBe("あ".repeat(21845)); // floor(65536 / 3)
    expect(huge.startsWith(buf!.toString("utf-8"))).toBe(true);

    const warn = warnings.find((w) => w.type === "attr_value_truncated");
    expect(warn).toBeDefined();
    if (warn?.type === "attr_value_truncated") {
      expect(warn.limit).toBe(65_536);
      expect(warn.length).toBe(90_000); // byte length, not char count
    }

    await a.close();
  });
});

// ---------------------------------------------------------------------------
// Attribute KEY (val_name) size routing. val_name is VARCHAR(1024) *characters*
// and is now indexed (log_attr_val_name_idx), so keys are bounded by UTF-8
// byte length — a multibyte key under 1024 chars can still exceed 1024 bytes.
// ---------------------------------------------------------------------------

/** The stored val_name for a key made only of "あ" — found among insert params. */
const storedAaKey = (compiled: CompiledQuery[]): string | undefined => {
  const attr = attrInsert(compiled);
  return attr?.parameters.find(
    (p): p is string => typeof p === "string" && /^あ+$/.test(p),
  );
};

describe("PostgresAdapter — attribute key size (byte-bounded)", () => {
  let compiled: CompiledQuery[];
  let warnings: AdapterWarning[];
  let adapter: PostgresAdapter;

  beforeEach(() => {
    const cap = makeCapturingDb();
    compiled = cap.compiled;
    warnings = [];
    adapter = new PostgresAdapter({
      db: cap.db,
      onWarning: (w) => warnings.push(w),
    });
  });

  afterEach(async () => {
    await adapter.close();
  });

  it("truncates a multibyte key under 1024 chars but over 1024 bytes to a byte-safe length", async () => {
    const key = "あ".repeat(400); // 400 chars, 1200 UTF-8 bytes
    expect(key.length).toBeLessThan(1024); // char count under column limit
    expect(Buffer.byteLength(key, "utf-8")).toBeGreaterThan(1024);

    adapter.write(baseRecord({ [key]: "v" }));
    await adapter.flush();

    const stored = storedAaKey(compiled);
    expect(stored).toBeDefined();
    // Stored key fits the byte budget and never splits a character.
    expect(Buffer.byteLength(stored!, "utf-8")).toBeLessThanOrEqual(1024);
    expect(stored).toBe("あ".repeat(341)); // floor(1024 / 3) = 341
    expect(key.startsWith(stored!)).toBe(true);
  });

  it("warns with the byte length when a key is truncated", async () => {
    const key = "あ".repeat(400);
    adapter.write(baseRecord({ [key]: "v" }));
    await adapter.flush();

    const warn = warnings.find((w) => w.type === "attr_keys_truncated");
    expect(warn).toBeDefined();
    if (warn?.type === "attr_keys_truncated") {
      expect(warn.limit).toBe(1024);
      expect(warn.keys[0].length).toBe(1200); // byte length, not char count
    }
  });

  it("leaves a short multibyte key untouched and does not warn", async () => {
    const key = "あ".repeat(10); // 30 bytes
    adapter.write(baseRecord({ [key]: "v" }));
    await adapter.flush();

    expect(storedAaKey(compiled)).toBe(key);
    expect(warnings).toHaveLength(0);
  });
});
