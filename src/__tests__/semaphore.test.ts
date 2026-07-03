import { describe, it, expect, vi } from "vitest";

// Semaphore is not exported — test it indirectly via the transport's
// concurrency behaviour by inspecting call timing.

// Inline a copy of the semaphore logic to unit-test it directly.
class Semaphore {
  private running = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  acquire(): Promise<void> {
    if (this.running < this.max) { this.running++; return Promise.resolve(); }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) { next(); } else { this.running--; }
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try { return await fn(); } finally { this.release(); }
  }
}

describe("Semaphore", () => {
  it("allows up to max concurrent tasks", async () => {
    const sem = new Semaphore(2);
    let running = 0;
    let maxObserved = 0;

    const task = () =>
      sem.run(async () => {
        running++;
        maxObserved = Math.max(maxObserved, running);
        await new Promise((r) => setTimeout(r, 10));
        running--;
      });

    await Promise.all([task(), task(), task(), task()]);
    expect(maxObserved).toBeLessThanOrEqual(2);
  });

  it("queues tasks beyond the limit and runs them after release", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];

    const task = (id: number) =>
      sem.run(async () => {
        order.push(id);
        await new Promise((r) => setTimeout(r, 5));
      });

    await Promise.all([task(1), task(2), task(3)]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("resolves all tasks even when max is 1", async () => {
    const sem = new Semaphore(1);
    const results: number[] = [];
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) => sem.run(async () => { results.push(n); })),
    );
    expect(results).toHaveLength(5);
  });

  it("propagates errors from tasks without deadlocking", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    // Should still accept new tasks after an error
    const result = await sem.run(async () => 42);
    expect(result).toBe(42);
  });
});
