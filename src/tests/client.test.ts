import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the security-sensitive functions in isolation.
// For client tests that require real HTTP, use the live test script instead.

// ---------------------------------------------------------------------------
// assertSafePath (re-exported for testing)
// We test the path validation logic directly since it's critical security code.
// ---------------------------------------------------------------------------

// Import the relevant private logic by testing via the public interface
import { loadConfig, resetConfig } from '../server/config.js';

describe('loadConfig', () => {
  beforeEach(() => {
    resetConfig();
  });

  it('uses defaults when no env vars are set', () => {
    // Remove relevant env vars
    const saved = {
      OPENGROK_BASE_URL: process.env.OPENGROK_BASE_URL,
      OPENGROK_USERNAME: process.env.OPENGROK_USERNAME,
      OPENGROK_PASSWORD: process.env.OPENGROK_PASSWORD,
    };
    delete process.env.OPENGROK_BASE_URL;
    delete process.env.OPENGROK_USERNAME;
    delete process.env.OPENGROK_PASSWORD;

    const config = loadConfig();
    expect(config.OPENGROK_BASE_URL).toBe('');
    expect(config.OPENGROK_VERIFY_SSL).toBe(true);
    expect(config.OPENGROK_CACHE_ENABLED).toBe(true);
    expect(config.OPENGROK_RATELIMIT_ENABLED).toBe(true);
    expect(config.OPENGROK_RATELIMIT_RPM).toBe(60);

    // Restore
    Object.assign(process.env, saved);
  });

  it('reads OPENGROK_BASE_URL from environment', () => {
    process.env.OPENGROK_BASE_URL = 'https://my-opengrok.example.com/source/';
    const config = loadConfig();
    expect(config.OPENGROK_BASE_URL).toBe('https://my-opengrok.example.com/source/');
    delete process.env.OPENGROK_BASE_URL;
  });

  it('parses OPENGROK_VERIFY_SSL=false correctly', () => {
    process.env.OPENGROK_VERIFY_SSL = 'false';
    const config = loadConfig();
    expect(config.OPENGROK_VERIFY_SSL).toBe(false);
    delete process.env.OPENGROK_VERIFY_SSL;
  });

  it('parses OPENGROK_CACHE_ENABLED=false correctly', () => {
    process.env.OPENGROK_CACHE_ENABLED = 'false';
    const config = loadConfig();
    expect(config.OPENGROK_CACHE_ENABLED).toBe(false);
    delete process.env.OPENGROK_CACHE_ENABLED;
  });
});

// ---------------------------------------------------------------------------
// Path safety (inline logic test)
// ---------------------------------------------------------------------------

describe('path traversal detection', () => {
  // Exercise the same path rules as assertSafePath here for isolated unit testing
  function isSafePath(path: string): boolean {
    const normalized = path.replace(/\\/g, '/');
    return !(
      normalized.includes('/../') ||
      normalized.startsWith('../') ||
      normalized.endsWith('/..') ||
      normalized === '..'
    );
  }

  it('accepts normal paths', () => {
    expect(isSafePath('pandora/source/file.cpp')).toBe(true);
    expect(isSafePath('/pandora/source/file.cpp')).toBe(true);
    expect(isSafePath('file.cpp')).toBe(true);
  });

  it('rejects path traversal sequences', () => {
    expect(isSafePath('../etc/passwd')).toBe(false);
    expect(isSafePath('foo/../../etc/passwd')).toBe(false);
    expect(isSafePath('foo/..')).toBe(false);
    expect(isSafePath('..')).toBe(false);
  });

  it('rejects backslash-based traversal (Windows)', () => {
    expect(isSafePath('foo\\..\\etc\\passwd')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Zod schema validation for tool arguments
// ---------------------------------------------------------------------------

import {
  SearchCodeArgs,
  GetFileContentArgs,
  BrowseDirectoryArgs,
} from '../server/models.js';

describe('SearchCodeArgs schema', () => {
  it('accepts valid args', () => {
    const result = SearchCodeArgs.safeParse({ query: 'WeatherStation', max_results: 10 });
    expect(result.success).toBe(true);
  });

  it('rejects empty query', () => {
    const result = SearchCodeArgs.safeParse({ query: '' });
    expect(result.success).toBe(false);
  });

  it('rejects max_results > 100', () => {
    const result = SearchCodeArgs.safeParse({ query: 'test', max_results: 101 });
    expect(result.success).toBe(false);
  });

  it('defaults search_type to full', () => {
    const result = SearchCodeArgs.safeParse({ query: 'test' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.search_type).toBe('full');
  });
});

describe('GetFileContentArgs schema', () => {
  it('accepts valid project and path', () => {
    const result = GetFileContentArgs.safeParse({
      project: 'release-2.x',
      path: 'pandora/file.cpp',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing path', () => {
    const result = GetFileContentArgs.safeParse({ project: 'release-2.x' });
    expect(result.success).toBe(false);
  });
});

describe('BrowseDirectoryArgs schema', () => {
  it('defaults path to empty string', () => {
    const result = BrowseDirectoryArgs.safeParse({ project: 'release-2.x' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.path).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Config NaN guard (validates Phase 1 fix — zIntString rejects non-numeric)
// ---------------------------------------------------------------------------

describe('config NaN guard', () => {
  let savedEnv: Record<string, string | undefined>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    resetConfig();
    savedEnv = {
      OPENGROK_BASE_URL: process.env.OPENGROK_BASE_URL,
      OPENGROK_TIMEOUT: process.env.OPENGROK_TIMEOUT,
      OPENGROK_CACHE_MAX_SIZE: process.env.OPENGROK_CACHE_MAX_SIZE,
    };
    process.env.OPENGROK_BASE_URL = 'https://example.com/source/';
  });

  afterEach(() => {
    Object.entries(savedEnv).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
    resetConfig();
    stderrSpy.mockRestore();
  });

  it('rejects non-numeric OPENGROK_TIMEOUT', () => {
    process.env.OPENGROK_TIMEOUT = 'abc';
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit'); }) as never);
    try {
      loadConfig();
      // If we get here, process.exit was never called — fail the test
      expect.unreachable('loadConfig should have called process.exit');
    } catch (e: any) {
      // Either Zod transform error or our mocked process.exit error — both acceptable
      expect(e.message).toMatch(/process\.exit|expected integer/);
    } finally {
      mockExit.mockRestore();
    }
  });

  it('rejects non-numeric OPENGROK_CACHE_MAX_SIZE', () => {
    process.env.OPENGROK_CACHE_MAX_SIZE = 'not-a-number';
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('process.exit'); }) as never);
    try {
      loadConfig();
      expect.unreachable('loadConfig should have called process.exit');
    } catch (e: any) {
      expect(e.message).toMatch(/process\.exit|expected integer/);
    } finally {
      mockExit.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// extractLineRange (indexOf-based extraction)
// ---------------------------------------------------------------------------

import { extractLineRange } from '../server/client/index.js';

describe('extractLineRange', () => {
  const sampleContent = 'line1\nline2\nline3\nline4\nline5';

  it('returns full content when no range specified', () => {
    const result = extractLineRange(sampleContent);
    expect(result.text).toBe(sampleContent);
    expect(result.totalLines).toBe(5);
  });

  it('extracts a middle range', () => {
    const result = extractLineRange(sampleContent, 2, 4);
    expect(result.text).toBe('line2\nline3\nline4');
    expect(result.totalLines).toBe(5);
  });

  it('extracts a single line', () => {
    const result = extractLineRange(sampleContent, 3, 3);
    expect(result.text).toBe('line3');
    expect(result.totalLines).toBe(5);
  });

  it('clamps range beyond end of content', () => {
    const result = extractLineRange(sampleContent, 4, 100);
    expect(result.text).toBe('line4\nline5');
    expect(result.totalLines).toBe(5);
  });

  it('handles empty content', () => {
    const result = extractLineRange('', 1, 1);
    expect(result.text).toBe('');
    expect(result.totalLines).toBe(1);
  });

  it('handles content without trailing newline', () => {
    const result = extractLineRange('abc\ndef', 2, 2);
    expect(result.text).toBe('def');
    expect(result.totalLines).toBe(2);
  });

  it('handles content with trailing newline', () => {
    const result = extractLineRange('abc\ndef\n', 1, 2);
    expect(result.text).toBe('abc\ndef');
    expect(result.totalLines).toBe(3);
  });

  it('returns first line when range is 1,1', () => {
    const result = extractLineRange(sampleContent, 1, 1);
    expect(result.text).toBe('line1');
  });
});

// ---------------------------------------------------------------------------
// fileType allowlist (P1-1 — verified against OpenGrok AnalyzerGuru list)
// ---------------------------------------------------------------------------
import { normalizeFileType, validateFileType, VALID_FILE_TYPES } from '../server/client/index.js';

describe('fileType allowlist', () => {
  it('accepts genuine analyzer names (cobol, ocaml, mandoc, troff)', () => {
    for (const t of ['cobol', 'ocaml', 'mandoc', 'troff', 'cxx', 'golang', 'sh']) {
      expect(VALID_FILE_TYPES.has(t)).toBe(true);
      expect(validateFileType(t)).toBe(t);
    }
  });

  it('maps makefile → sh (Makefiles are indexed by the Sh analyzer)', () => {
    expect(normalizeFileType('makefile')).toBe('sh');
    expect(validateFileType('makefile')).toBe('sh');
  });

  it('keeps existing aliases (cpp→cxx, shell→sh)', () => {
    expect(validateFileType('cpp')).toBe('cxx');
    expect(validateFileType('shell')).toBe('sh');
  });

  it('still throws for unknown types', () => {
    expect(() => validateFileType('notalang')).toThrow(/Invalid fileType/);
  });

  it('SearchCodeArgs file_type accepts makefile/cobol and rejects unknown', () => {
    const ok = SearchCodeArgs.safeParse({ query: 'x', file_type: 'makefile' });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.file_type).toBe('sh');
    const ok2 = SearchCodeArgs.safeParse({ query: 'x', file_type: 'cobol' });
    expect(ok2.success).toBe(true);
    expect(SearchCodeArgs.safeParse({ query: 'x', file_type: 'notalang' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TTLCache.evictExpired
// ---------------------------------------------------------------------------
import { TTLCache } from '../server/client/index.js';

describe('TTLCache.evictExpired', () => {
  it('removes entries older than TTL when eviction is triggered on the 10th write', () => {
    const mockNow = vi.spyOn(Date, 'now');
    let time = 1_000_000;
    mockNow.mockImplementation(() => time);

    try {
      // TTL of 100 ms
      const cache = new TTLCache<string, string>(100, 10_000_000, 100);

      // Write an entry that will expire
      cache.set('stale', 'value', 10);

      // Advance past the TTL
      time += 200;

      // Write 9 more entries to trigger the eviction on the 10th write (writeCount % 10 === 0)
      // The first write above was #1, so we need 9 more to hit #10
      for (let i = 0; i < 9; i++) {
        cache.set(`fresh-${i}`, `v${i}`, 10);
      }

      // 'stale' should have been evicted
      expect(cache.get('stale')).toBeUndefined();
      // Fresh entries should still be present
      expect(cache.get('fresh-0')).toBe('v0');
    } finally {
      mockNow.mockRestore();
    }
  });
});
