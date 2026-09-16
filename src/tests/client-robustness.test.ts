/**
 * Tests for HTTP error codes (Phase 7.1), network failures/timeouts (Phase 7.2),
 * and concurrent cache operations (Phase 7.4).
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
  _TTLCache as TTLCache,
} from '../server/client/index.js';
import type { Config } from '../server/config.js';

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    OPENGROK_BASE_URL: 'https://example.com/source/',
    OPENGROK_USERNAME: 'user',
    OPENGROK_PASSWORD: 'pass',
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

function mockResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `Status ${status}`,
    headers: new Headers(headers),
    text: vi.fn().mockResolvedValue(body),
    json: vi.fn().mockResolvedValue(JSON.parse(body || '{}')),
    clone: vi.fn(),
  } as unknown as Response;
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
// Phase 7.1: HTTP error code tests
// -----------------------------------------------------------------------

describe('HTTP error codes', () => {
  it('403 Forbidden — server is reachable (access denied)', async () => {
    fetchSpy.mockResolvedValue(mockResponse(403, '{}'));
    const client = new OpenGrokClient(makeConfig());
    // 403 means the server is up and responding — connected=true
    await expect(client.testConnection()).resolves.toBe(true);
  });

  it('404 Not Found — server is reachable (wrong path)', async () => {
    fetchSpy.mockResolvedValue(mockResponse(404, '{}'));
    const client = new OpenGrokClient(makeConfig());
    // 404 means the server is up and responding — connected=true
    await expect(client.testConnection()).resolves.toBe(true);
  });

  it('500 Internal Server Error — retried then fails', { timeout: 30_000 }, async () => {
    fetchSpy.mockResolvedValue(mockResponse(500, '{}'));
    const client = new OpenGrokClient(makeConfig());
    await expect(client.testConnection()).resolves.toBe(false);
  });

  it('502 Bad Gateway — retried then fails', { timeout: 30_000 }, async () => {
    fetchSpy.mockResolvedValue(mockResponse(502, '{}'));
    const client = new OpenGrokClient(makeConfig());
    await expect(client.testConnection()).resolves.toBe(false);
  });

  it('503 Service Unavailable — retried then fails', { timeout: 30_000 }, async () => {
    fetchSpy.mockResolvedValue(mockResponse(503, '{}'));
    const client = new OpenGrokClient(makeConfig());
    await expect(client.testConnection()).resolves.toBe(false);
  });

  it('429 Too Many Requests — server is reachable (rate limited)', async () => {
    fetchSpy.mockResolvedValue(mockResponse(429, '{}'));
    const client = new OpenGrokClient(makeConfig());
    // 429 means the server is up and responding — connected=true
    await expect(client.testConnection()).resolves.toBe(true);
  });

  it('401 on search throws with actionable message', async () => {
    fetchSpy.mockResolvedValue(mockResponse(401, '{}'));
    const client = new OpenGrokClient(makeConfig());
    await expect(client.search('test', 'full')).rejects.toThrow(/401/);
  });

  it('403 on getFileContent throws', async () => {
    fetchSpy.mockResolvedValue(mockResponse(403, '{}'));
    const client = new OpenGrokClient(makeConfig());
    await expect(client.getFileContent('proj', 'file.cpp')).rejects.toThrow(/403/);
  });

  it('500 on getFileHistory retries and ultimately fails', { timeout: 30_000 }, async () => {
    fetchSpy.mockResolvedValue(mockResponse(500, ''));
    const client = new OpenGrokClient(makeConfig());
    await expect(client.getFileHistory('proj', 'file.cpp')).rejects.toThrow(/500/);
  });
});

// -----------------------------------------------------------------------
// Phase 7.2: Network failure / timeout tests
// -----------------------------------------------------------------------

describe('Network failure tests', () => {
  it('connection refused (ECONNREFUSED) fails after retries', { timeout: 30_000 }, async () => {
    fetchSpy.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));
    const client = new OpenGrokClient(makeConfig());
    await expect(client.testConnection()).resolves.toBe(false);
  });

  it('DNS failure (ENOTFOUND) fails after retries', { timeout: 30_000 }, async () => {
    fetchSpy.mockRejectedValue(new Error('getaddrinfo ENOTFOUND example.com'));
    const client = new OpenGrokClient(makeConfig());
    await expect(client.testConnection()).resolves.toBe(false);
  });

  it('timeout error (AbortError) propagates', { timeout: 30_000 }, async () => {
    const abortError = new DOMException('signal timed out', 'AbortError');
    fetchSpy.mockRejectedValue(abortError);
    const client = new OpenGrokClient(makeConfig());
    await expect(client.testConnection()).resolves.toBe(false);
  });

  it('partial response / network reset fails after retries', { timeout: 30_000 }, async () => {
    fetchSpy.mockRejectedValue(new Error('network connection was reset'));
    const client = new OpenGrokClient(makeConfig());
    await expect(client.search('test', 'full')).rejects.toThrow();
  });

  it('timeout on search propagates error', { timeout: 30_000 }, async () => {
    const abortError = new DOMException('signal timed out', 'AbortError');
    fetchSpy.mockRejectedValue(abortError);
    const client = new OpenGrokClient(makeConfig());
    await expect(client.search('test', 'full')).rejects.toThrow();
  });
});

// -----------------------------------------------------------------------
// Phase 7.4: Cache race condition tests
// -----------------------------------------------------------------------

describe('TTLCache — concurrent operations', () => {
  it('concurrent set() calls with byte budget respected', () => {
    const cache = new TTLCache<string, string>(10, 100, 60_000);
    // Simulate concurrent writes that collectively exceed byte budget
    const results = [];
    for (let i = 0; i < 20; i++) {
      cache.set(`key-${i}`, `value-${i}`, 10);
      results.push(cache.has(`key-${i}`));
    }
    // Latest entries should be present, oldest evicted
    expect(cache.has('key-19')).toBe(true);
    expect(cache.has('key-18')).toBe(true);
    // Oldest should be evicted due to maxEntries (10)
    expect(cache.has('key-0')).toBe(false);
  });

  it('concurrent set() with large values evicts to fit byte budget', () => {
    const cache = new TTLCache<string, string>(100, 50, 60_000);
    // Each entry is 20 bytes, budget is 50 bytes => max 2 entries
    cache.set('a', 'x'.repeat(20), 20);
    cache.set('b', 'y'.repeat(20), 20);
    cache.set('c', 'z'.repeat(20), 20);
    // 'a' should be evicted since 3*20=60 > 50
    expect(cache.has('a')).toBe(false);
    expect(cache.has('c')).toBe(true);
  });

  it('TTL expiry during rapid get/set cycles', () => {
    vi.useFakeTimers();
    const cache = new TTLCache<string, string>(10, 10000, 100); // 100ms TTL
    cache.set('key1', 'val1', 4);
    expect(cache.get('key1')).toBe('val1');

    // Advance past TTL
    vi.advanceTimersByTime(150);
    expect(cache.get('key1')).toBeUndefined();

    // Set new value after expiry
    cache.set('key1', 'val2', 4);
    expect(cache.get('key1')).toBe('val2');
    vi.useRealTimers();
  });

  it('evictExpired triggers on every 10th write', () => {
    vi.useFakeTimers();
    const cache = new TTLCache<string, string>(100, 100000, 50); // 50ms TTL
    // Insert entries
    for (let i = 0; i < 5; i++) {
      cache.set(`old-${i}`, `v${i}`, 5);
    }
    // Advance past TTL
    vi.advanceTimersByTime(100);
    // Write 10 more entries to trigger eviction on the 10th
    for (let i = 0; i < 10; i++) {
      cache.set(`new-${i}`, `v${i}`, 5);
    }
    // Old entries should be gone (expired + eviction triggered)
    for (let i = 0; i < 5; i++) {
      expect(cache.get(`old-${i}`)).toBeUndefined();
    }
    // New entries should exist
    expect(cache.get('new-9')).toBe('v9');
    vi.useRealTimers();
  });

  it('clear() resets all state', () => {
    const cache = new TTLCache<string, string>(10, 10000, 60_000);
    cache.set('a', 'val-a', 5);
    cache.set('b', 'val-b', 5);
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('has() returns false for expired entries', () => {
    vi.useFakeTimers();
    const cache = new TTLCache<string, string>(10, 10000, 50);
    cache.set('x', 'y', 1);
    expect(cache.has('x')).toBe(true);
    vi.advanceTimersByTime(100);
    expect(cache.has('x')).toBe(false);
    vi.useRealTimers();
  });
});
