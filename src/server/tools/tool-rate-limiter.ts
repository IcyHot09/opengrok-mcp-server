/**
 * Per-tool rate limiter using a token bucket algorithm.
 *
 * Prevents any single tool from monopolizing the connection by applying
 * per-tool rate limits on top of the global client rate limit.
 *
 * Uses a single persistent processQueue loop per tool (rather than spawning a
 * fresh setTimeout on every retry), preventing a timer storm when many callers
 * are blocked waiting for a low-RPM tool.
 *
 * Extracted from server.ts for maintainability — its own test file is
 * src/tests/tool-rate-limiter.test.ts.
 */

import { auditLog } from "../transport/audit.js";

export class ToolRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; lastRefill: number }>();
  private readonly limits: Map<string, number>; // tool name → calls per minute
  private readonly defaultLimit: number;
  private readonly queues = new Map<string, Array<{ deadline: number; resolve: () => void; reject: (e: Error) => void }>>();
  private readonly processing = new Map<string, boolean>();

  constructor(limits: Record<string, number>, defaultLimit: number = 60) {
    this.limits = new Map(Object.entries(limits));
    this.defaultLimit = defaultLimit;
  }

  /**
   * Acquire a token for the given tool name.
   * Returns immediately if a token is available, otherwise waits up to
   * `maxWaitMs` (default 30 s). Throws if the limit cannot be satisfied
   * within the timeout to prevent indefinite request queuing.
   */
  async acquire(toolName: string, maxWaitMs = 30_000): Promise<void> {
    const limit = this.limits.get(toolName) ?? this.defaultLimit;
    const now = Date.now();

    // Fast path: token available immediately
    let bucket = this.buckets.get(toolName);
    if (!bucket) {
      bucket = { tokens: limit, lastRefill: now };
      this.buckets.set(toolName, bucket);
    } else {
      const interval = 60000 / limit;
      const elapsed = now - bucket.lastRefill;
      bucket.tokens = Math.min(limit, bucket.tokens + (elapsed / interval));
      bucket.lastRefill = now;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }

    // Slow path: enqueue and wait for a processing loop tick
    return new Promise<void>((resolve, reject) => {
      const deadline = now + maxWaitMs;
      let queue = this.queues.get(toolName);
      if (!queue) {
        queue = [];
        this.queues.set(toolName, queue);
      }
      queue.push({ deadline, resolve, reject });
      if (!this.processing.get(toolName)) {
        this.processing.set(toolName, true);
        void this.processQueue(toolName);
      }
    });
  }

  private async processQueue(toolName: string): Promise<void> {
    const limit = this.limits.get(toolName) ?? this.defaultLimit;
    const interval = 60000 / limit; // ms per token

    while (true) {
      const queue = this.queues.get(toolName);
      if (!queue || queue.length === 0) {
        this.processing.set(toolName, false);
        return;
      }

      const now = Date.now();
      // Expire any callers that have passed their deadline
      while (queue.length > 0 && now > (queue[0]?.deadline ?? 0)) {
        const expired = queue.shift();
        if (!expired) break;
        const err = new Error(`Rate limit exceeded for ${toolName}: no token available within the timeout`);
        auditLog({ type: "rate_limited", tool: toolName, detail: err.message.slice(0, 200) });
        expired.reject(err);
      }
      if (queue.length === 0) {
        this.processing.set(toolName, false);
        return;
      }

      // Refill bucket
      const bucket = this.buckets.get(toolName);
      if (!bucket) { this.processing.set(toolName, false); return; }
      const elapsed = now - bucket.lastRefill;
      bucket.tokens = Math.min(limit, bucket.tokens + (elapsed / interval));
      bucket.lastRefill = now;

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        queue.shift()?.resolve();
      } else {
        // Sleep until next token is available, but no longer than the earliest pending deadline
        const msUntilToken = Math.ceil((1 - bucket.tokens) * interval);
        const nextDeadline = queue[0]?.deadline ?? (now + msUntilToken);
        const msUntilDeadline = Math.max(0, nextDeadline - now) + 5; // +5ms buffer for expiry check
        const waitMs = Math.max(10, Math.min(msUntilToken, msUntilDeadline));
        await new Promise<void>((r) => setTimeout(r, waitMs));
      }
    }
  }
}
