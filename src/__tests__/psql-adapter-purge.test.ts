import { describe, it, expect, vi, afterEach } from "vitest";
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

// ---------------------------------------------------------------------------
// Async purge — plan, confirm, background batched deletion over the
// persistent log_purge_job / log_purge_ids tables.
//
// A scripted driver answers the planning COUNT queries with configured totals
// and simulates the id-set drain, so the full job lifecycle runs without a
// database. Cross-instance locking, sweep, and restart resumption are
// exercised against a real Postgres in psql-adapter.e2e.test.ts.
// ---------------------------------------------------------------------------

function makePurgeDb(counts: { logs: number; attrs: number; blobs: number }) {
  const compiled: CompiledQuery[] = [];
  const state = {
    remainingIds: 0,
    captured: false,
    batches: 0,
    holdBatch: null as null | Promise<void>,
  };

  const connection: DatabaseConnection = {
    async executeQuery<R>(cq: CompiledQuery): Promise<QueryResult<R>> {
      compiled.push(cq);
      const s = cq.sql;
      // Planning counts
      if (/select count\(\*\)/i.test(s) && /from "logs"/i.test(s)) {
        return { rows: [{ n: counts.logs }] as unknown as R[] };
      }
      if (/select count\(\*\)/i.test(s) && /from "log_attr"(?!_)/i.test(s)) {
        return { rows: [{ n: counts.attrs }] as unknown as R[] };
      }
      if (/select count\(\*\)/i.test(s) && /from "log_attr_blob"/i.test(s)) {
        return { rows: [{ n: counts.blobs }] as unknown as R[] };
      }
      // Job row lifecycle — the unit driver has no row store; purgeStatus
      // falls back to the adapter's memory snapshots.
      if (/select .* from "log_purge_job"/i.test(s)) {
        return { rows: [] as R[] };
      }
      if (/insert into "log_purge_job"/i.test(s)) {
        return { rows: [] as R[], numAffectedRows: 1n };
      }
      if (/update "log_purge_job"/i.test(s)) {
        return { rows: [] as R[], numAffectedRows: 1n };
      }
      if (/delete from "log_purge_job"/i.test(s)) {
        return { rows: [] as R[], numAffectedRows: 1n };
      }
      // Id capture
      if (/INSERT INTO log_purge_ids/i.test(s)) {
        state.captured = true;
        state.remainingIds = counts.logs;
        return { rows: [] as R[], numAffectedRows: BigInt(counts.logs) };
      }
      // Batch drain — a single atomic statement
      if (/WITH batch AS/i.test(s)) {
        if (state.holdBatch) await state.holdBatch;
        state.batches++;
        const limitMatch = /LIMIT (\d+)/i.exec(s);
        const batchSize = limitMatch ? parseInt(limitMatch[1], 10) : 1000;
        const n = Math.min(state.remainingIds, batchSize);
        state.remainingIds -= n;
        return { rows: [{ blobs: 0, attrs: 0, logs: n, ids: n }] as unknown as R[] };
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

  return { db, compiled, state };
}

const batchCount = (compiled: CompiledQuery[]) =>
  compiled.filter((c) => /WITH batch AS/i.test(c.sql)).length;

/** Adapter with the auto-sweep off — unit tests drive the lifecycle directly. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeAdapter = (db: Kysely<any>, opts: Record<string, unknown> = {}) =>
  new PostgresAdapter({ db, purgeSweepIntervalMs: 0, ...opts });

describe("PostgresAdapter.purge — async plan + background deletion", () => {
  let adapter: PostgresAdapter;

  afterEach(async () => {
    await adapter?.close();
  });

  it("returns a job with counts immediately and runs the deletion in the background", async () => {
    const { db, compiled, state } = makePurgeDb({ logs: 100, attrs: 300, blobs: 5 });
    adapter = makeAdapter(db);

    const res = await adapter.purge(new Date("2020-01-01"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const job = res.val;
    expect(job.id).toBeTruthy();
    expect(job.logCount).toBe(100);
    expect(job.attrCount).toBe(305); // attrs + blobs
    expect(job.totalCount).toBe(405);
    expect(job.requiresConfirmation).toBe(false);
    expect(["running", "completed"]).toContain(job.status);
    // The job row was persisted; the caller never sees log ids.
    expect(compiled.some((c) => /insert into "log_purge_job"/i.test(c.sql))).toBe(true);
    expect(Object.keys(job)).not.toContain("logIds");

    await vi.waitFor(async () => {
      const status = await adapter.purgeStatus(job.id);
      expect(status.ok && status.val.status).toBe("completed");
    });
    const done = await adapter.purgeStatus(job.id);
    expect(done.ok && done.val.deletedLogs).toBe(100);
    // Completion deletes the job row (log_purge_ids is empty by then).
    expect(compiled.some((c) => /delete from "log_purge_job"/i.test(c.sql))).toBe(true);
    expect(state.captured).toBe(true);
  });

  it("requires confirmation above the threshold and does not delete until confirmed", async () => {
    const { db, compiled } = makePurgeDb({ logs: 9000, attrs: 2000, blobs: 0 });
    adapter = makeAdapter(db); // default threshold 10_000; total 11_000

    const res = await adapter.purge(new Date("2020-01-01"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.val.requiresConfirmation).toBe(true);
    expect(res.val.status).toBe("awaiting-confirmation");

    // Nothing captured or deleted while awaiting.
    await new Promise((r) => setTimeout(r, 20));
    expect(batchCount(compiled)).toBe(0);
    expect(compiled.some((c) => /INSERT INTO log_purge_ids/i.test(c.sql))).toBe(false);

    const confirmed = await adapter.confirmPurge(res.val.id);
    expect(confirmed.ok).toBe(true);
    await vi.waitFor(async () => {
      const status = await adapter.purgeStatus(res.val.id);
      expect(status.ok && status.val.status).toBe("completed");
    });
    expect(batchCount(compiled)).toBeGreaterThan(0);
  });

  it("honours a per-call confirmationThreshold override", async () => {
    const { db } = makePurgeDb({ logs: 10, attrs: 0, blobs: 0 });
    adapter = makeAdapter(db);

    const res = await adapter.purge(new Date("2020-01-01"), { confirmationThreshold: 5 });
    expect(res.ok && res.val.status).toBe("awaiting-confirmation");
  });

  it("honours the adapter-level purgeConfirmationThreshold option", async () => {
    const { db } = makePurgeDb({ logs: 10, attrs: 0, blobs: 0 });
    adapter = makeAdapter(db, { purgeConfirmationThreshold: 5 });

    const res = await adapter.purge(new Date("2020-01-01"));
    expect(res.ok && res.val.status).toBe("awaiting-confirmation");
  });

  it("drains the id set in batches of batchSize", async () => {
    const { db, state } = makePurgeDb({ logs: 5, attrs: 0, blobs: 0 });
    adapter = makeAdapter(db);

    const res = await adapter.purge(new Date("2020-01-01"), { batchSize: 2 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await vi.waitFor(async () => {
      const status = await adapter.purgeStatus(res.val.id);
      expect(status.ok && status.val.status).toBe("completed");
    });
    // 5 ids / batch of 2 → batches of 2, 2, 1 (the partial batch ends the loop).
    expect(state.batches).toBe(3);
    expect(state.remainingIds).toBe(0);
  });

  it("returns 'unknown purge id' for status and confirm on a bogus id", async () => {
    const { db } = makePurgeDb({ logs: 0, attrs: 0, blobs: 0 });
    adapter = makeAdapter(db);

    const status = await adapter.purgeStatus("nope");
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.err.message).toBe("unknown purge id");

    const confirm = await adapter.confirmPurge("nope");
    expect(confirm.ok).toBe(false);
    if (!confirm.ok) expect(confirm.err.message).toBe("unknown purge id");
  });

  it("confirmPurge on a non-awaiting job returns the current snapshot without error", async () => {
    const { db } = makePurgeDb({ logs: 3, attrs: 0, blobs: 0 });
    adapter = makeAdapter(db);

    const res = await adapter.purge(new Date("2020-01-01"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await vi.waitFor(async () => {
      const s = await adapter.purgeStatus(res.val.id);
      expect(s.ok && s.val.status).toBe("completed");
    });

    const again = await adapter.confirmPurge(res.val.id);
    expect(again.ok && again.val.status).toBe("completed");
  });

  it("a zero-count purge completes immediately without a job row", async () => {
    const { db, compiled } = makePurgeDb({ logs: 0, attrs: 0, blobs: 0 });
    adapter = makeAdapter(db);

    const res = await adapter.purge(new Date("2020-01-01"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.val.totalCount).toBe(0);
    expect(res.val.status).toBe("completed");
    expect(compiled.some((c) => /insert into "log_purge_job"/i.test(c.sql))).toBe(false);
  });

  it("close() stops after the current batch, leaving the job resumable", async () => {
    const { db, compiled, state } = makePurgeDb({ logs: 10, attrs: 0, blobs: 0 });
    adapter = makeAdapter(db);

    // Hold the first batch open until we've called close().
    let release!: () => void;
    state.holdBatch = new Promise<void>((r) => (release = r));

    const res = await adapter.purge(new Date("2020-01-01"), { batchSize: 2 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const closing = adapter.close();
    release();
    await closing;

    // The job's row stays `running` (resumable by a sweep); this instance's
    // snapshot reflects that, with partial progress.
    const status = await adapter.purgeStatus(res.val.id);
    expect(status.ok && status.val.status).toBe("running");
    expect(status.ok && status.val.deletedLogs).toBeLessThan(10);
    // The lock was released so another instance can pick the job up.
    const releases = compiled.filter(
      (c) => /update "log_purge_job"/i.test(c.sql) && c.parameters.includes(null),
    );
    expect(releases.length).toBeGreaterThan(0);
  });
});
