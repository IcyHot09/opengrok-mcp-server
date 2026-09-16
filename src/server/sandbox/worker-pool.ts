import { Worker } from "worker_threads";
import * as fs from "fs";
import * as path from "path";

// Use __dirname via CommonJS (sandbox.ts uses the same approach)
declare const __dirname: string;

export interface WorkerHandle {
  worker: Worker;
  isAlive: boolean;
  terminate(): Promise<void>;
}

/**
 * Pre-warmed pool of sandbox workers (QuickJS WASM).
 *
 * Maintains up to `maxIdle` idle worker threads so that consecutive
 * `opengrok_execute` calls avoid the ~50ms Worker spawn + WASM load cost.
 * Workers that stay idle beyond `idleTimeoutMs` are terminated automatically.
 */
export class SandboxWorkerPool {
  private idle: WorkerHandle[] = [];
  private readonly maxIdle = 2;
  private readonly idleTimeoutMs = 30_000;
  private idleTimers = new Map<WorkerHandle, ReturnType<typeof setTimeout>>();

  acquire(): WorkerHandle {
    // `idle.pop()` atomically removes the handle from the idle list before any
    // postMessage is sent. Because Node.js is single-threaded (event loop), no
    // concurrent acquire() call can observe and dispatch the same handle between
    // the pop() and the first postMessage — preventing double-dispatch.
    //
    // Workers can die (via an 'error' event) while sitting in the idle pool.
    // Loop until we find a live handle or exhaust the pool.
    let handle: WorkerHandle | undefined;
    while ((handle = this.idle.pop()) !== undefined) {
      const timer = this.idleTimers.get(handle);
      if (timer) clearTimeout(timer);
      this.idleTimers.delete(handle);
      if (handle.isAlive) return handle;
      // Dead worker — discard it and try the next idle slot.
    }
    return this.spawnWorker();
  }

  release(handle: WorkerHandle): void {
    if (!handle.isAlive) return;  // don't pool terminated workers
    // Re-check pool size atomically before pushing; Node.js is single-threaded
    // but idle timer callbacks could have already pushed during a previous await.
    if (this.idle.length < this.maxIdle) {
      // Clear any stale timer for this handle before setting a new one
      const existingTimer = this.idleTimers.get(handle);
      if (existingTimer) clearTimeout(existingTimer);
      this.idle.push(handle);
      const timer = setTimeout(() => {
        const idx = this.idle.indexOf(handle);
        if (idx >= 0) {
          this.idle.splice(idx, 1);
          this.idleTimers.delete(handle);
          void handle.terminate();
        }
      }, this.idleTimeoutMs);
      timer.unref(); // Don't keep process alive just for pool cleanup
      this.idleTimers.set(handle, timer);
    } else {
      void handle.terminate();
    }
  }

  async drain(): Promise<void> {
    // Set draining flag to prevent release() from pooling during await
    const handles = [...this.idleTimers.entries()];
    // Clear timers and idle list BEFORE awaiting to prevent race with release()
    for (const [, timer] of handles) clearTimeout(timer);
    this.idle = [];
    this.idleTimers.clear();
    // Now terminate all workers
    await Promise.all(handles.map(([handle]) => handle.terminate()));
  }

  private spawnWorker(): WorkerHandle {
    // Match the path resolution used by sandbox.ts
    const localWorkerPath = path.join(__dirname, "sandbox-worker.js");
    const devWorkerPath = path.join(__dirname, "..", "..", "..", "out", "server", "sandbox-worker.js");
    const workerPath = fs.existsSync(localWorkerPath) ? localWorkerPath : devWorkerPath;
    const worker = new Worker(workerPath);
    let alive = true;
    const handle: WorkerHandle = {
      worker,
      get isAlive() { return alive; },
      terminate: async () => {
        alive = false;
        await worker.terminate();
      },
    };
    // Prevent unhandled 'error' events (e.g. WASM init failures in test
    // environments) from crashing the process. The worker is marked dead so
    // the next acquire() call spawns a fresh one.
    worker.on("error", () => { alive = false; });
    return handle;
  }
}
