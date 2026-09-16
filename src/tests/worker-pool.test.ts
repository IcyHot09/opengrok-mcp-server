/**
 * Unit tests for SandboxWorkerPool.
 * worker_threads is fully mocked — no real Workers are spawned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("worker_threads", () => ({
  Worker: vi.fn().mockImplementation(() => ({
    terminate: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    postMessage: vi.fn(),
  })),
}));

// Import AFTER mock is registered
import { SandboxWorkerPool } from "../server/sandbox/worker-pool.js";
import { Worker } from "worker_threads";

const MockWorker = Worker as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  MockWorker.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SandboxWorkerPool", () => {
  it("1. acquire() spawns a new worker when the pool is empty", async () => {
    const pool = new SandboxWorkerPool();
    const handle = await pool.acquire();

    expect(MockWorker).toHaveBeenCalledTimes(1);
    expect(handle.worker).toBeDefined();
    expect(typeof handle.terminate).toBe("function");

    await pool.drain();
  });

  it("2. release() keeps a worker in the pool when below maxIdle", async () => {
    const pool = new SandboxWorkerPool();
    const handle = await pool.acquire();
    pool.release(handle);

    // Acquiring again should NOT spawn a new worker
    const handle2 = await pool.acquire();
    expect(MockWorker).toHaveBeenCalledTimes(1); // only the first spawn
    expect(handle2).toBe(handle);

    await pool.drain();
  });

  it("3. release() terminates worker when pool is at maxIdle", async () => {
    const pool = new SandboxWorkerPool();

    // Fill pool to maxIdle=2
    const h1 = await pool.acquire();
    const h2 = await pool.acquire();
    pool.release(h1); // pool.idle.length = 1 → kept
    pool.release(h2); // pool.idle.length = 2 → kept (at capacity)

    // Third worker returned while pool is already full → must be terminated
    const h3 = await pool.acquire(); // returns h2 (LIFO pop)
    const terminateSpy = vi.spyOn(h3, "terminate");
    pool.release(h3); // pool.idle.length is already 1 (h1 remains), this is 2 → kept
    // Actually need to verify overflow: acquire h1 back, then release h3 when full
    // Drain what's in the pool first, then test the overflow
    await pool.drain(); // clears idle

    const ha = await pool.acquire();
    const hb = await pool.acquire();
    pool.release(ha);
    pool.release(hb); // pool now at capacity (2)

    const hc = await pool.acquire(); // spawns fresh (pool had ha/hb, returns hb)
    const hd = await pool.acquire(); // returns ha
    const overflow = await pool.acquire(); // pool is empty → spawns fresh

    pool.release(hc); // pool.idle.length=0 → 1, kept
    pool.release(hd); // pool.idle.length=1 → 2, kept (at maxIdle)

    const overflowTerminate = vi.spyOn(overflow, "terminate");
    pool.release(overflow); // pool.idle.length == maxIdle → terminate

    expect(overflowTerminate).toHaveBeenCalled();

    await pool.drain();
  });

  it("4. acquire() returns the pooled worker on second call (no new spawn)", async () => {
    const pool = new SandboxWorkerPool();

    const first = await pool.acquire();
    pool.release(first);

    const second = await pool.acquire();
    expect(second).toBe(first);
    expect(MockWorker).toHaveBeenCalledTimes(1);

    await pool.drain();
  });

  it("5. idle worker is terminated after 30s idle timeout", async () => {
    const pool = new SandboxWorkerPool();
    const handle = await pool.acquire();
    const terminateSpy = vi.spyOn(handle, "terminate");

    pool.release(handle);
    expect(terminateSpy).not.toHaveBeenCalled();

    // Fast-forward past idle timeout
    vi.advanceTimersByTime(30_001);

    expect(terminateSpy).toHaveBeenCalled();

    await pool.drain();
  });

  it("6. drain() terminates all idle workers and clears the pool", async () => {
    const pool = new SandboxWorkerPool();

    const h1 = await pool.acquire();
    const h2 = await pool.acquire();
    const t1 = vi.spyOn(h1, "terminate");
    const t2 = vi.spyOn(h2, "terminate");
    pool.release(h1);
    pool.release(h2);

    await pool.drain();

    expect(t1).toHaveBeenCalled();
    expect(t2).toHaveBeenCalled();

    // Pool should be empty — next acquire spawns fresh
    MockWorker.mockClear();
    const h3 = await pool.acquire();
    expect(MockWorker).toHaveBeenCalledTimes(1);
    await h3.terminate();
  });

  it("7. drain() is a no-op when the pool is already empty", async () => {
    const pool = new SandboxWorkerPool();
    // Acquire and DO NOT release — pool is empty of idle workers
    const handle = await pool.acquire();
    MockWorker.mockClear();

    // drain with no idle workers should complete without error
    await pool.drain();

    // Manually terminate acquired handle
    await handle.terminate();
  });

  it("8. pool limits idle capacity to maxIdle=2 and terminates overflow", async () => {
    const pool = new SandboxWorkerPool();

    const handles = await Promise.all([
      pool.acquire(),
      pool.acquire(),
      pool.acquire(),
    ]);
    expect(MockWorker).toHaveBeenCalledTimes(3);

    const spies = handles.map((h) => vi.spyOn(h, "terminate"));

    // Release all three: first two go to idle pool, third is terminated
    pool.release(handles[0]);
    pool.release(handles[1]);
    pool.release(handles[2]); // pool already at maxIdle=2 → terminate

    expect(spies[2]).toHaveBeenCalled();
    expect(spies[0]).not.toHaveBeenCalled();
    expect(spies[1]).not.toHaveBeenCalled();

    await pool.drain();
  });
});

  it("9. release() is a no-op when handle is no longer alive (terminated worker)", async () => {
    const pool = new SandboxWorkerPool();
    const handle = await pool.acquire();
    // Terminate the worker — isAlive becomes false
    await handle.terminate();
    // Releasing a dead handle should be a no-op (line 39 branch)
    expect(() => pool.release(handle)).not.toThrow();
    // Pool should remain empty
    const second = await pool.acquire();
    expect(second).not.toBe(handle); // spawned fresh
    await pool.drain();
  });
