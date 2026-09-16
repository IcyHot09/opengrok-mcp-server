/**
 * OpenGrok HTTP client subsystem - split from client.ts (pure move, no logic changes).
 */

// ---------------------------------------------------------------------------
// TTL Cache (entry count + total byte budget)
// ---------------------------------------------------------------------------

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
  sizeBytes: number;
}

export class TTLCache<K, V> {
  private map = new Map<K, CacheEntry<V>>();
  private totalBytes = 0;
  private writeCount = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
    private readonly ttlMs: number
  ) { }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.totalBytes -= entry.sizeBytes;
      this.map.delete(key);
      return undefined;
    }
    // Promote to end for LRU ordering
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, sizeBytes: number, ttlMs?: number): void {
    // Reject entries that individually exceed the byte budget
    if (sizeBytes > this.maxBytes) return;

    // Evict expired entries periodically (every 10 writes) instead of every set()
    if (++this.writeCount % 10 === 0) this.evictExpired();

    // Remove existing entry AFTER the eviction loop so the loop sees the current map size.
    // (B5 fix previously deleted before the loop, causing the size check to under-count by one
    // and potentially leaving one stale entry more than maxEntries when updating an existing key.)
    const existing = this.map.get(key);
    if (existing) {
      this.totalBytes -= existing.sizeBytes;
    }

    // Proactively evict expired entries before LRU eviction to free space
    // that stale entries are occupying, allowing fresh entries in.
    if (
      this.map.size - (existing ? 1 : 0) >= this.maxEntries ||
      this.totalBytes + sizeBytes > this.maxBytes
    ) {
      this.evictExpired();
    }

    // Evict LRU-style if over limits. Re-evaluate map.size on each iteration so
    // successive evictions correctly reduce the apparent size.
    while (
      this.map.size - (existing ? 1 : 0) >= this.maxEntries ||
      this.totalBytes + sizeBytes > this.maxBytes
    ) {
      // Find and remove the oldest (first) non-target entry
      let evicted = false;
      for (const [k, entry] of this.map) {
        if (k === key) continue; // don't evict the key we're inserting
        this.totalBytes -= entry.sizeBytes;
        this.map.delete(k);
        evicted = true;
        break;
      }
      if (!evicted) break;
    }

    if (existing) {
      this.map.delete(key);
    }

    this.map.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.ttlMs),
      sizeBytes,
    });
    this.totalBytes += sizeBytes;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    this.totalBytes -= entry.sizeBytes;
    this.map.delete(key);
    return true;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [k, entry] of this.map) {
      if (now > entry.expiresAt) {
        this.totalBytes -= entry.sizeBytes;
        this.map.delete(k);
      }
    }
  }

  clear(): void {
    this.map.clear();
    this.totalBytes = 0;
  }
}

// ---------------------------------------------------------------------------
// estimateBytes (moved verbatim from client.ts, exported for cross-module use)
// ---------------------------------------------------------------------------

/** Estimate the byte size of a serializable value without blocking the event loop natively. */
export function estimateBytes(value: unknown, depth = 0): number {
  if (depth > 20) return 8192; // conservative overestimate for pathologically deep structures
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (typeof value === "number" || typeof value === "boolean") return 8;
  if (typeof value === "object") {
    let size = 0;
    if (Array.isArray(value)) {
      for (const item of value) size += estimateBytes(item, depth + 1);
    } else {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        size += Buffer.byteLength(k, "utf8") + estimateBytes(v, depth + 1);
      }
    }
    return size;
  }
  return 0;
}
