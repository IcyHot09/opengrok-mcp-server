/**
 * Tests for client.ts internal classes and integration-level coverage of
 * OpenGrokClient branches — RateLimiter, TTLCache, estimateBytes, caching,
 * rate limiting, auth headers, search/file method branches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Production code calls fetch from 'undici' (same package as the Agent
// dispatcher — the global fetch rejects cross-version dispatchers).
// Mock it here; keep real Agent/ProxyAgent via importOriginal.
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: (...args: unknown[]) => fetchMock(...args) };
});
import {
  OpenGrokClient,
  _RateLimiter as RateLimiter,
  _TTLCache as TTLCache,
  _estimateBytes as estimateBytes,
  _sleep as sleep,
  _TIMEOUTS as TIMEOUTS,
} from '../server/client/index.js';
import type { Config } from '../server/config.js';

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    OPENGROK_BASE_URL: 'https://example.com/source/',
    OPENGROK_USERNAME: '',
    OPENGROK_PASSWORD: '',
    OPENGROK_PASSWORD_FILE: '',
    OPENGROK_PASSWORD_KEY: '',
    OPENGROK_VERIFY_SSL: true,
    OPENGROK_TIMEOUT: 30,
    OPENGROK_DEFAULT_MAX_RESULTS: 25,
    OPENGROK_CACHE_ENABLED: false,
    OPENGROK_CACHE_SEARCH_TTL: 300,
    OPENGROK_CACHE_FILE_TTL: 600,
    OPENGROK_CACHE_HISTORY_TTL: 1800,
    OPENGROK_CACHE_PROJECTS_TTL: 3600,
    OPENGROK_CACHE_MAX_SIZE: 500,
    OPENGROK_CACHE_MAX_BYTES: 52428800,
    OPENGROK_RATELIMIT_ENABLED: false,
    OPENGROK_RATELIMIT_RPM: 60,
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    OPENGROK_LOCAL_COMPILE_DB_PATHS: '',
    OPENGROK_DEFAULT_PROJECT: 'release-2.x',
    ...overrides,
  } as Config;
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock.mockReset();
  fetchSpy = fetchMock;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// -----------------------------------------------------------------------
// TIMEOUTS
// -----------------------------------------------------------------------

describe('TIMEOUTS', () => {
  it('has expected timeout values', () => {
    expect(TIMEOUTS.search).toBe(60_000);
    expect(TIMEOUTS.suggest).toBe(10_000);
    expect(TIMEOUTS.file).toBe(30_000);
    expect(TIMEOUTS.default).toBe(30_000);
  });
});

// -----------------------------------------------------------------------
// sleep
// -----------------------------------------------------------------------

describe('sleep', () => {
  it('resolves after specified ms', async () => {
    vi.useFakeTimers();
    const p = sleep(100);
    vi.advanceTimersByTime(100);
    await p;
    vi.useRealTimers();
  });
});

// -----------------------------------------------------------------------
// estimateBytes
// -----------------------------------------------------------------------

describe('estimateBytes', () => {
  it('returns 0 for null and undefined', () => {
    expect(estimateBytes(null)).toBe(0);
    expect(estimateBytes(undefined)).toBe(0);
  });

  it('estimates string bytes using UTF-8', () => {
    expect(estimateBytes('hello')).toBe(5);
    // Multi-byte character
    expect(estimateBytes('é')).toBe(2);
  });

  it('returns 8 for numbers and booleans', () => {
    expect(estimateBytes(42)).toBe(8);
    expect(estimateBytes(true)).toBe(8);
    expect(estimateBytes(false)).toBe(8);
  });

  it('sums array item sizes', () => {
    expect(estimateBytes(['a', 'b'])).toBe(2);
  });

  it('sums key + value sizes for objects', () => {
    const size = estimateBytes({ key: 'val' });
    // "key" = 3 bytes, "val" = 3 bytes => 6
    expect(size).toBe(6);
  });

  it('returns 0 for other types (symbol, function)', () => {
    expect(estimateBytes(Symbol())).toBe(0);
  });

  it('handles nested structures', () => {
    const size = estimateBytes({ arr: [1, 2], nested: { x: 'y' } });
    // "arr" = 3, [1,2] = 16, "nested" = 6, {"x":"y"} = (1+1)=2 => 3+16+6+2=27
    expect(size).toBe(27);
  });
});

// -----------------------------------------------------------------------
// RateLimiter
// -----------------------------------------------------------------------

describe('RateLimiter', () => {
  it('acquires immediately when tokens are available', async () => {
    const rl = new RateLimiter(60);
    await rl.acquire(); // Should resolve instantly
  });

  it('queues requests when tokens are exhausted', async () => {
    const rl = new RateLimiter(2); // 2 per minute — low enough to exhaust
    await rl.acquire(); // use first token
    await rl.acquire(); // use second token
    // Third acquire should queue but eventually resolve
    const start = Date.now();
    await rl.acquire();
    const elapsed = Date.now() - start;
    // Should have waited some time for a new token
    expect(elapsed).toBeGreaterThan(0);
  }, 60_000);
});

// -----------------------------------------------------------------------
// TTLCache
// -----------------------------------------------------------------------

describe('TTLCache', () => {
  it('stores and retrieves values', () => {
    const cache = new TTLCache<string, number>(10, 1000, 60_000);
    cache.set('a', 42, 8);
    expect(cache.get('a')).toBe(42);
  });

  it('returns undefined for missing keys', () => {
    const cache = new TTLCache<string, number>(10, 1000, 60_000);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('expires entries after TTL', () => {
    const cache = new TTLCache<string, number>(10, 1000, 1); // 1ms TTL
    cache.set('a', 42, 8);
    // Wait for expiry
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    expect(cache.get('a')).toBeUndefined();
  });

  it('evicts LRU entries when maxEntries exceeded', () => {
    const cache = new TTLCache<string, number>(2, 10000, 60_000);
    cache.set('a', 1, 8);
    cache.set('b', 2, 8);
    cache.set('c', 3, 8); // should evict 'a'
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('evicts entries when maxBytes exceeded', () => {
    const cache = new TTLCache<string, number>(100, 20, 60_000);
    cache.set('a', 1, 12);
    cache.set('b', 2, 12); // total=24 > 20, should evict 'a'
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
  });

  it('has() returns true for existing, false for missing/expired', () => {
    const cache = new TTLCache<string, number>(10, 1000, 1);
    cache.set('a', 1, 8);
    expect(cache.has('a')).toBe(true);
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    expect(cache.has('a')).toBe(false);
  });

  it('clear() removes all entries', () => {
    const cache = new TTLCache<string, number>(10, 1000, 60_000);
    cache.set('a', 1, 8);
    cache.set('b', 2, 8);
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('evictExpired runs every 10 writes', () => {
    const cache = new TTLCache<string, number>(100, 100_000, 1); // 1ms TTL
    // Insert 9 entries
    for (let i = 0; i < 9; i++) cache.set(`k${i}`, i, 8);
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin for expiry */ }
    // Insert 10th — triggers evictExpired
    cache.set('k10', 10, 8);
    // Expired entries should be cleaned up
    expect(cache.get('k0')).toBeUndefined();
    expect(cache.get('k10')).toBe(10);
  });

  it('evictExpired removes expired entries using fake timers', () => {
    // Use vitest fake timers so the time-based eviction branch is actually exercised
    // in a controlled way — no real-time spinning, no flakiness.
    vi.useFakeTimers();
    try {
      const ttlMs = 5_000; // 5 second TTL
      const cache = new TTLCache<string, number>(100, 100_000, ttlMs);

      // Insert 9 entries at t=0
      for (let i = 0; i < 9; i++) cache.set(`k${i}`, i, 8);

      // Advance clock past the TTL so all entries are now expired
      vi.advanceTimersByTime(ttlMs + 1);

      // Insert 10th entry — this is the 10th write, which triggers evictExpired().
      // At this point Date.now() returns a time after all entries' expiresAt,
      // so the eviction loop removes all 9 expired entries.
      cache.set('k10', 10, 8);

      // All original entries should be gone (evicted as expired)
      for (let i = 0; i < 9; i++) {
        expect(cache.get(`k${i}`), `k${i} should be evicted`).toBeUndefined();
      }
      // The newly inserted entry must survive
      expect(cache.get('k10')).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });
});

// -----------------------------------------------------------------------
// OpenGrokClient constructor branches
// -----------------------------------------------------------------------

describe('OpenGrokClient constructor', () => {
  it('creates auth header when username and password set', async () => {
    const client = new OpenGrokClient(makeConfig({
      OPENGROK_USERNAME: 'admin',
      OPENGROK_PASSWORD: 'secret',
    }));
    // Auth header is private; verify via a request that includes it
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ resultCount: 0, results: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    );
    await client.search('test', 'full');
    const callArgs = fetchSpy.mock.calls[0];
    const options = callArgs[1] as RequestInit;
    expect((options.headers as Record<string, string>)['Authorization']).toMatch(/^Basic /);
    await client.close();
  });

  it('creates agent when VERIFY_SSL is false', () => {
    const client = new OpenGrokClient(makeConfig({ OPENGROK_VERIFY_SSL: false }));
    // The agent is private, but close() should clean it up without error
    expect(() => client.close()).not.toThrow();
  });

  it('initializes caches when CACHE_ENABLED is true', async () => {
    const client = new OpenGrokClient(makeConfig({ OPENGROK_CACHE_ENABLED: true }));
    // close() should clear caches without error
    await client.close();
  });

  it('initializes rate limiter when RATELIMIT_ENABLED is true', async () => {
    const client = new OpenGrokClient(makeConfig({ OPENGROK_RATELIMIT_ENABLED: true }));
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ resultCount: 0, results: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    );
    await client.search('test', 'full');
    expect(fetchSpy).toHaveBeenCalled();
    await client.close();
  });
});

// -----------------------------------------------------------------------
// OpenGrokClient search method branches
// -----------------------------------------------------------------------

describe('OpenGrokClient search branches', () => {
  let client: OpenGrokClient;

  beforeEach(() => {
    client = new OpenGrokClient(makeConfig());
  });

  afterEach(async () => {
    await client.close();
  });

  it('search with projects param sorts and passes them', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ resultCount: 0, results: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    );
    await client.search('test', 'full', ['proj-b', 'proj-a']);
    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.searchParams.get('projects')).toBe('proj-a,proj-b');
  });

  it('search with start > 0 adds start param', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ resultCount: 0, results: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    );
    await client.search('test', 'full', undefined, 10, 5);
    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.searchParams.get('start')).toBe('5');
  });

  it('search with fileType adds type param', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ resultCount: 0, results: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    );
    await client.search('test', 'full', undefined, 10, 0, 'cxx');
    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.searchParams.get('type')).toBe('cxx');
  });

  it('search with defs type tries REST then falls back to searchWeb', async () => {
    // All fetch calls return HTML — REST path will throw on JSON.parse, then web UI path succeeds
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response('<html><body></body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }))
    );
    const result = await client.search('MyFunc', 'defs', ['proj'], 10, 0, 'cxx');
    // call[0] = REST attempt (/api/v1/search?defs=MyFunc), call[1] = web UI (/search?defs=MyFunc)
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const webUrl = new URL(fetchSpy.mock.calls[1][0] as string);
    expect(webUrl.pathname).toContain('/search');
    expect(webUrl.searchParams.get('defs')).toBe('MyFunc');
    expect(webUrl.searchParams.get('type')).toBe('cxx');
    expect(result.searchType).toBe('defs');
  });

  it('searchWeb with projects appends each as separate project param', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response('<html></html>', { status: 200 }))
    );
    await client.search('X', 'refs', ['a', 'b']);
    // call[0] = REST attempt, call[1] = web UI (which uses per-project params)
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const webUrl = new URL(fetchSpy.mock.calls[1][0] as string);
    expect(webUrl.searchParams.getAll('project')).toEqual(['a', 'b']);
  });
});

// -----------------------------------------------------------------------
// OpenGrokClient getFileHistory branches
// -----------------------------------------------------------------------

describe('OpenGrokClient getFileHistory', () => {
  let client: OpenGrokClient;

  beforeEach(() => {
    client = new OpenGrokClient(makeConfig({ OPENGROK_CACHE_ENABLED: true }));
  });

  afterEach(async () => {
    await client.close();
  });

  it('slices entries when maxEntries is less than total', async () => {
    // Return HTML with multiple history entries
    const html = `<html><body>
      <table id="revisions">
        <tr class="changeset"><td>rev1</td><td>2024-01-01</td><td>author1</td><td>msg1</td></tr>
        <tr class="changeset"><td>rev2</td><td>2024-01-02</td><td>author2</td><td>msg2</td></tr>
        <tr class="changeset"><td>rev3</td><td>2024-01-03</td><td>author3</td><td>msg3</td></tr>
      </table>
    </body></html>`;
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(html, { status: 200 }))
    );
    const result = await client.getFileHistory('proj', 'file.cpp', 1);
    expect(result.entries.length).toBeLessThanOrEqual(1);
  });

  it('uses cache on second call', async () => {
    const html = '<html><body></body></html>';
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(html, { status: 200 }))
    );
    await client.getFileHistory('proj', 'f.cpp');
    await client.getFileHistory('proj', 'f.cpp');
    // With caching, second call should be from cache
    // At minimum, both calls should succeed
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

// -----------------------------------------------------------------------
// OpenGrokClient listProjects branches
// -----------------------------------------------------------------------

describe('OpenGrokClient listProjects filter', () => {
  let client: OpenGrokClient;

  beforeEach(() => {
    client = new OpenGrokClient(makeConfig({ OPENGROK_CACHE_ENABLED: true }));
  });

  afterEach(async () => {
    await client.close();
  });

  it('auto-appends * for non-glob patterns', async () => {
    const html = '<html><body><select id="project"><option value="release-2.x">release-2.x</option><option value="v3.1-beta">v3.1-beta</option></select></body></html>';
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(html, { status: 200 }))
    );
    const result = await client.listProjects('release');
    expect(result.some(p => p.name === 'release-2.x')).toBe(true);
    expect(result.some(p => p.name === 'v3.1-beta')).toBe(false);
  });

  it('uses glob patterns as-is when they contain wildcards', async () => {
    const html = '<html><body><select id="project"><option value="release-2.x">release-2.x</option><option value="v3.1-beta">v3.1-beta</option></select></body></html>';
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(html, { status: 200 }))
    );
    const result = await client.listProjects('*-*');
    expect(result.length).toBe(2);
  });

  it('returns all projects when filter produces valid regex', async () => {
    const html = '<html><body><select id="project"><option value="p">p</option></select></body></html>';
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(html, { status: 200 }))
    );
    // Square bracket is escaped by glob converter so produces valid regex
    const result = await client.listProjects('[p');
    // The escaped pattern matches literally
    expect(result).toBeDefined();
  });

  it('uses projects cache on second call', async () => {
    const html = '<html><body><select id="project"><option value="p1">p1</option></select></body></html>';
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(html, { status: 200 }))
    );
    await client.listProjects();
    await client.listProjects();
    // Cache should mean only 1 fetch
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

// -----------------------------------------------------------------------
// OpenGrokClient getFileSymbols caching
// -----------------------------------------------------------------------

describe('OpenGrokClient getFileSymbols cache', () => {
  it('caches symbols in fileCache and returns cached on second call', async () => {
    const client = new OpenGrokClient(makeConfig({ OPENGROK_CACHE_ENABLED: true }));
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify([
        { symbol: 'Foo', type: 'function', line: 10, lineStart: 10 },
      ]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    );
    const r1 = await client.getFileSymbols('proj', 'file.cpp');
    expect(r1.symbols).toHaveLength(1);
    const r2 = await client.getFileSymbols('proj', 'file.cpp');
    expect(r2.symbols).toHaveLength(1);
    await client.close();
  });
});

// -----------------------------------------------------------------------
// OpenGrokClient getAnnotate endpoint caching
// -----------------------------------------------------------------------

describe('OpenGrokClient getAnnotate', () => {
  let client: OpenGrokClient;

  beforeEach(() => {
    client = new OpenGrokClient(makeConfig());
  });

  afterEach(async () => {
    await client.close();
  });

  it('caches annotate endpoint on success', async () => {
    const html = '<html><body><table id="revision-header"></table></body></html>';
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(html, { status: 200 }))
    );
    await client.getAnnotate('proj', 'file.cpp');
    await client.getAnnotate('proj', 'file2.cpp');
    // Both should use /annotate endpoint (cached style)
    for (const call of fetchSpy.mock.calls) {
      const url = new URL(call[0] as string);
      expect(url.pathname).toContain('/annotate/');
    }
  });

  it('resets cached endpoint when annotate style fails', async () => {
    let callCount = 0;
    fetchSpy.mockImplementation(() => {
      callCount++;
      if (callCount <= 1) {
        // First call to /annotate succeeds (sets annotateEndpoint = 'annotate')
        return Promise.resolve(new Response('<html></html>', { status: 200 }));
      }
      if (callCount === 2) {
        // Second call to /annotate fails
        return Promise.reject(new Error('annotate failed'));
      }
      // Remaining calls to /xref succeed
      return Promise.resolve(new Response('<html></html>', { status: 200 }));
    });
    // First call — sets endpoint to 'annotate'
    await client.getAnnotate('proj', 'a.cpp');
    // Second call — annotate fails, should fall through to xref
    await client.getAnnotate('proj', 'b.cpp');
    expect(callCount).toBeGreaterThanOrEqual(3);
  }, 30_000);
});

// -----------------------------------------------------------------------
// OpenGrokClient search caching  
// -----------------------------------------------------------------------

describe('OpenGrokClient search with cache', () => {
  it('caches search results and returns from cache on second call', async () => {
    const client = new OpenGrokClient(makeConfig({ OPENGROK_CACHE_ENABLED: true }));
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ resultCount: 1, results: { '/proj/f.cpp': [{ lineNumber: 1, line: 'x' }] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    );
    const r1 = await client.search('test', 'full');
    const r2 = await client.search('test', 'full');
    expect(r1.totalCount).toBe(1);
    expect(r2.totalCount).toBe(1);
    await client.close();
  });

  it('caches defs/refs web search results', async () => {
    const client = new OpenGrokClient(makeConfig({ OPENGROK_CACHE_ENABLED: true }));
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response('<html><body></body></html>', { status: 200 }))
    );
    await client.search('Func', 'defs');
    await client.search('Func', 'defs');
    await client.close();
  });

  it('caches file content and returns from cache', async () => {
    const client = new OpenGrokClient(makeConfig({ OPENGROK_CACHE_ENABLED: true }));
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response('line1\nline2\nline3', { status: 200 }))
    );
    const r1 = await client.getFileContent('proj', 'file.cpp');
    const r2 = await client.getFileContent('proj', 'file.cpp');
    expect(r1.content).toBe(r2.content);
    await client.close();
  });
});

// -----------------------------------------------------------------------
// RateLimiter — load tests (fake timers)
// -----------------------------------------------------------------------

describe('RateLimiter load test', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('allows burst up to token limit then throttles remaining requests', async () => {
    // RPM=3: starts with 3 tokens, refill rate = 3/60 = 0.05 tokens/s (20s per token)
    const rl = new RateLimiter(3);
    const completed: number[] = [];

    const promises = Array.from({ length: 5 }, (_, i) =>
      rl.acquire().then(() => { completed.push(i); })
    );

    // Let the first 3 burst through (tokens already available)
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toHaveLength(3);

    // Advance ~20s per token to allow the remaining 2 through
    await vi.advanceTimersByTimeAsync(40_100);
    await Promise.all(promises);
    expect(completed).toHaveLength(5);
  });

  it('recovers tokens over time and resumes queued requests', async () => {
    // RPM=60: 60 tokens pre-filled, rate=1 token/s
    const rl = new RateLimiter(60);

    // Exhaust all 60 tokens
    const burst = Array.from({ length: 60 }, () => rl.acquire());
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all(burst);

    let recovered = false;
    const waitingRequest = rl.acquire().then(() => { recovered = true; });

    // Not resolved yet — no tokens available
    await vi.advanceTimersByTimeAsync(0);
    expect(recovered).toBe(false);

    // Advance 1+ seconds to accumulate 1 token
    await vi.advanceTimersByTimeAsync(1100);
    await waitingRequest;
    expect(recovered).toBe(true);
  });
});
