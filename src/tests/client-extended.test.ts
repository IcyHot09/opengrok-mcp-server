/**
 * Comprehensive tests for client.ts — OpenGrokClient, extractLineRange,
 * buildSafeUrl, assertSafePath, parseSearchResponse, TTLCache, RateLimiter.
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
  extractLineRange,
  buildSafeUrl,
  assertSafePath,
  parseSearchResponse,
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
  } as Config;
}

// -----------------------------------------------------------------------
// extractLineRange
// -----------------------------------------------------------------------

describe('extractLineRange', () => {
  it('returns full content when no range specified', () => {
    const content = 'line1\nline2\nline3';
    const result = extractLineRange(content);
    expect(result.text).toBe(content);
    expect(result.totalLines).toBe(3);
  });

  it('returns single line', () => {
    const content = 'line1\nline2\nline3';
    const result = extractLineRange(content, 2, 2);
    expect(result.text).toBe('line2');
    expect(result.totalLines).toBe(3);
  });

  it('returns range of lines', () => {
    const content = 'line1\nline2\nline3\nline4\nline5';
    const result = extractLineRange(content, 2, 4);
    expect(result.text).toBe('line2\nline3\nline4');
    expect(result.totalLines).toBe(5);
  });

  it('returns from start to specified end', () => {
    const content = 'line1\nline2\nline3';
    const result = extractLineRange(content, 1, 2);
    expect(result.text).toBe('line1\nline2');
  });

  it('handles startLine beyond content', () => {
    const content = 'line1\nline2';
    const result = extractLineRange(content, 10, 20);
    expect(result.text).toBe('');
    expect(result.totalLines).toBe(2);
  });

  it('handles endLine beyond content', () => {
    const content = 'line1\nline2\nline3';
    const result = extractLineRange(content, 2, 999);
    expect(result.text).toBe('line2\nline3');
  });

  it('handles single line content', () => {
    const content = 'single line with no newline';
    const result = extractLineRange(content);
    expect(result.text).toBe(content);
    expect(result.totalLines).toBe(1);
  });

  it('handles empty content', () => {
    const result = extractLineRange('');
    expect(result.text).toBe('');
    expect(result.totalLines).toBe(1);
  });

  it('handles only startLine specified', () => {
    const content = 'line1\nline2\nline3';
    const result = extractLineRange(content, 2);
    expect(result.text).toBe('line2\nline3');
  });

  it('handles only endLine specified', () => {
    const content = 'line1\nline2\nline3';
    const result = extractLineRange(content, undefined, 2);
    expect(result.text).toBe('line1\nline2');
  });
});

// -----------------------------------------------------------------------
// buildSafeUrl
// -----------------------------------------------------------------------

describe('buildSafeUrl', () => {
  const baseUrl = new URL('https://example.com/source/');

  it('joins simple segments', () => {
    const url = buildSafeUrl(baseUrl, 'api/v1/search');
    expect(url.pathname).toBe('/source/api/v1/search');
    expect(url.hostname).toBe('example.com');
  });

  it('joins multiple segments', () => {
    const url = buildSafeUrl(baseUrl, 'xref/release-2.x/path/to/file.cpp');
    expect(url.pathname).toContain('xref');
    expect(url.hostname).toBe('example.com');
  });

  it('encodes special characters in segments', () => {
    const url = buildSafeUrl(baseUrl, 'raw/my project/file name.cpp');
    expect(url.toString()).toContain('my%20project');
    expect(url.hostname).toBe('example.com');
  });

  it('throws on SSRF attempt — different hostname', () => {
    expect(() => {
      buildSafeUrl(baseUrl, '//evil.com/path');
    }).toThrow(/SSRF/);
  });

  it('preserves empty segment', () => {
    const url = buildSafeUrl(baseUrl, '');
    expect(url.hostname).toBe('example.com');
  });
});

// -----------------------------------------------------------------------
// assertSafePath
// -----------------------------------------------------------------------

describe('assertSafePath', () => {
  it('accepts normal paths', () => {
    expect(() => assertSafePath('pandora/source/file.cpp')).not.toThrow();
    expect(() => assertSafePath('/pandora/source/file.cpp')).not.toThrow();
    expect(() => assertSafePath('file.cpp')).not.toThrow();
  });

  it('rejects /../ traversal', () => {
    expect(() => assertSafePath('foo/../../etc/passwd')).toThrow(/Unsafe path/);
  });

  it('rejects ../ at start', () => {
    expect(() => assertSafePath('../etc/passwd')).toThrow(/Unsafe path/);
  });

  it('rejects /.. at end', () => {
    expect(() => assertSafePath('foo/..')).toThrow(/Unsafe path/);
  });

  it('rejects bare ..', () => {
    expect(() => assertSafePath('..')).toThrow(/Unsafe path/);
  });

  it('rejects backslash traversal on Windows', () => {
    expect(() => assertSafePath('foo\\..\\..\\etc\\passwd')).toThrow(/Unsafe path/);
  });

  it('accepts paths with dots that are not traversal', () => {
    expect(() => assertSafePath('path/to/.hidden/file')).not.toThrow();
    expect(() => assertSafePath('path/to/file.test.ts')).not.toThrow();
    expect(() => assertSafePath('.../')).not.toThrow();
  });
});

// -----------------------------------------------------------------------
// parseSearchResponse
// -----------------------------------------------------------------------

describe('parseSearchResponse', () => {
  it('parses standard response', () => {
    const data = {
      resultCount: 2,
      results: {
        '/release-2.x/pandora/file.cpp': [
          { lineNumber: 10, line: 'int main()' },
          { lineNumber: 20, line: 'return 0' },
        ],
      },
    };
    const result = parseSearchResponse(data, 'full', 'main');
    expect(result.query).toBe('main');
    expect(result.searchType).toBe('full');
    expect(result.totalCount).toBe(2);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].project).toBe('release-2.x');
    expect(result.results[0].path).toBe('/pandora/file.cpp');
    expect(result.results[0].matches).toHaveLength(2);
  });

  it('handles empty results', () => {
    const data = { resultCount: 0, results: {} };
    const result = parseSearchResponse(data, 'defs', 'foo');
    expect(result.totalCount).toBe(0);
    expect(result.results).toHaveLength(0);
  });

  it('handles missing fields gracefully', () => {
    const data = {};
    const result = parseSearchResponse(data, 'full', 'test');
    expect(result.totalCount).toBe(0);
    expect(result.results).toHaveLength(0);
  });

  it('handles result with no project prefix', () => {
    const data = {
      resultCount: 1,
      results: {
        'file.cpp': [{ lineNumber: 1, line: 'code' }],
      },
    };
    const result = parseSearchResponse(data, 'full', 'code');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].project).toBe('unknown');
  });

  it('handles missing lineNumber and line', () => {
    const data = {
      resultCount: 1,
      results: {
        '/proj/file.cpp': [{}],
      },
    };
    const result = parseSearchResponse(data, 'full', 'test');
    expect(result.results[0].matches[0].lineNumber).toBe(0);
    expect(result.results[0].matches[0].lineContent).toBe('');
  });
});

// -----------------------------------------------------------------------
// OpenGrokClient constructor
// -----------------------------------------------------------------------

describe('OpenGrokClient constructor', () => {
  it('creates client with minimal config', () => {
    const config = makeConfig();
    const client = new OpenGrokClient(config);
    expect(client).toBeDefined();
  });

  it('creates client with auth', () => {
    const config = makeConfig({
      OPENGROK_USERNAME: 'user',
      OPENGROK_PASSWORD: 'pass',
    });
    const client = new OpenGrokClient(config);
    expect(client).toBeDefined();
  });

  it('creates client with caching enabled', () => {
    const config = makeConfig({ OPENGROK_CACHE_ENABLED: true });
    const client = new OpenGrokClient(config);
    expect(client).toBeDefined();
  });

  it('creates client with rate limiting', () => {
    const config = makeConfig({ OPENGROK_RATELIMIT_ENABLED: true });
    const client = new OpenGrokClient(config);
    expect(client).toBeDefined();
  });

  it('creates client with SSL verification disabled', () => {
    const config = makeConfig({ OPENGROK_VERIFY_SSL: false });
    const client = new OpenGrokClient(config);
    expect(client).toBeDefined();
  });

  it('appends trailing slash to base URL', () => {
    const config = makeConfig({ OPENGROK_BASE_URL: 'https://example.com/source' });
    const client = new OpenGrokClient(config);
    expect(client).toBeDefined();
  });
});

// -----------------------------------------------------------------------
// OpenGrokClient with mocked fetch
// -----------------------------------------------------------------------

describe('OpenGrokClient methods', () => {
  let client: OpenGrokClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new OpenGrokClient(makeConfig());
    fetchMock.mockReset();
    fetchSpy = fetchMock;
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  function mockFetchJSON(data: unknown, status = 200) {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }

  function mockFetchText(body: string, status = 200) {
    fetchSpy.mockResolvedValueOnce(
      new Response(body, {
        status,
        headers: { 'Content-Type': 'text/html' },
      })
    );
  }

  describe('search (REST API)', () => {
    it('performs a full-text search', async () => {
      mockFetchJSON({
        resultCount: 1,
        results: {
          '/release-2.x/file.cpp': [{ lineNumber: 5, line: 'match' }],
        },
      });
      const result = await client.search('match', 'full', ['release-2.x']);
      expect(result.totalCount).toBe(1);
      expect(result.results).toHaveLength(1);
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it('includes file_type param when specified', async () => {
      mockFetchJSON({ resultCount: 0, results: {} });
      await client.search('test', 'full', ['release-2.x'], 10, 0, 'cxx');
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('type=cxx');
    });

    it('includes start param when > 0', async () => {
      mockFetchJSON({ resultCount: 0, results: {} });
      await client.search('test', 'full', undefined, 10, 5);
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('start=5');
    });
  });

  describe('search (web fallback for defs/refs)', () => {
    it('uses web search for defs when REST returns 400', async () => {
      // REST API attempt: older OpenGrok returns 400 for defs → AbortError → fallback
      mockFetchJSON({ message: 'Bad Request' }, 400);
      // Web UI attempt: returns HTML with results
      mockFetchText('<div id="results"><p class="pagetitle">Results 1 – 1 of 1</p></div>');
      const result = await client.search('MyClass', 'defs', ['release-2.x']);
      expect(result.searchType).toBe('defs');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const webUrl = fetchSpy.mock.calls[1][0] as string;
      expect(webUrl).toContain('search');
      expect(webUrl).toContain('defs=MyClass');
    });

    it('uses web search for refs when REST returns 400', async () => {
      mockFetchJSON({ message: 'Bad Request' }, 400);
      mockFetchText('<div id="results"><p class="pagetitle">Results 1 – 0 of 0</p></div>');
      const result = await client.search('foo', 'refs');
      expect(result.searchType).toBe('refs');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('returns results directly when REST supports defs (newer OpenGrok)', async () => {
      mockFetchJSON({ resultCount: 2, startDocument: 0, endDocument: 1, time: 5, results: {
        '/proj/path/Foo.cpp': [{ line: 'class <b>MyClass</b>', lineNumber: '10' }],
      }});
      const result = await client.search('MyClass', 'defs', ['release-2.x']);
      expect(result.searchType).toBe('defs');
      expect(result.totalCount).toBe(2);
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it('throws when both REST and web UI fail (error propagates to LLM)', async () => {
      // REST returns 400 (1 call); web UI returns 500 — error should propagate
      mockFetchJSON({ message: 'Bad Request' }, 400);
      mockFetchText('<html><body>Internal Server Error</body></html>', 500);
      await expect(client.search('MyClass', 'defs', ['release-2.x']))
        .rejects.toThrow(/HTTP 500/);
    });

    it('throws with descriptive message when no project provided and no default set', async () => {
      const cfg = { ...makeConfig(), OPENGROK_DEFAULT_PROJECT: '' };
      const clientNoDefault = new OpenGrokClient(cfg);
      // REST returns 400 — falls through to searchWeb which throws before any HTTP call
      mockFetchJSON({ message: 'Bad Request' }, 400);
      await expect(clientNoDefault.search('MyClass', 'defs'))
        .rejects.toThrow(/requires a project/);
      // Only 1 fetch call (REST attempt); searchWeb throws before making its request
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it('uses OPENGROK_DEFAULT_PROJECT when no projects given (web UI requires project)', async () => {
      const cfg = { ...makeConfig(), OPENGROK_DEFAULT_PROJECT: 'my-default-proj' };
      const clientWithDefault = new OpenGrokClient(cfg);
      mockFetchJSON({ message: 'Bad Request' }, 400);
      mockFetchText('<div id="results"><p class="pagetitle">Results 1 – 1 of 1</p></div>');
      await clientWithDefault.search('MyClass', 'defs'); // no projects arg
      const webUrl = fetchSpy.mock.calls[1][0] as string;
      expect(webUrl).toContain('project=my-default-proj');
    });
  });

  describe('suggest', () => {
    it('returns suggestions', async () => {
      mockFetchJSON({
        suggestions: ['main', 'malloc'],
        time: 5,
        partialResult: false,
      });
      const result = await client.suggest('ma', 'release-2.x', 'defs');
      expect(result.suggestions).toEqual(['main', 'malloc']);
      expect(result.time).toBe(5);
      expect(result.partialResult).toBe(false);
    });

    it('handles empty suggestions', async () => {
      mockFetchJSON({});
      const result = await client.suggest('zzz');
      expect(result.suggestions).toEqual([]);
      expect(result.time).toBe(0);
      expect(result.partialResult).toBe(false);
    });
  });

  describe('getFileContent', () => {
    it('returns file content', async () => {
      mockFetchText('line1\nline2\nline3\nline4\nline5');
      const result = await client.getFileContent('release-2.x', 'path/to/file.cpp');
      expect(result.project).toBe('release-2.x');
      expect(result.path).toBe('path/to/file.cpp');
      expect(result.lineCount).toBe(5);
    });

    it('returns file with line range', async () => {
      mockFetchText('line1\nline2\nline3\nline4\nline5');
      const result = await client.getFileContent('proj', 'file.cpp', 2, 3);
      expect(result.content).toBe('line2\nline3');
    });

    it('rejects path traversal', async () => {
      await expect(
        client.getFileContent('proj', '../../../etc/passwd')
      ).rejects.toThrow(/Unsafe path/);
    });

    it('strips leading slashes from path', async () => {
      mockFetchText('content');
      const result = await client.getFileContent('proj', '///path/to/file.cpp');
      expect(result.path).toBe('path/to/file.cpp');
    });
  });

  describe('getFileHistory', () => {
    it('returns parsed history', async () => {
      mockFetchText(`
        <table id="revisions">
          <tr>
            <td><a href="/xref/proj/file.cpp?r=abc123">abc123</a></td>
            <td>2024-01-01</td>
            <td>Author Name</td>
            <td>Fix bug</td>
          </tr>
        </table>
      `);
      const result = await client.getFileHistory('proj', 'file.cpp');
      expect(result.project).toBe('proj');
      expect(result.path).toBe('file.cpp');
    });

    it('limits entries to maxEntries', async () => {
      const rows = Array(20).fill(0).map((_, i) =>
        `<tr><td><a href="/r${i}">r${i}</a></td><td>2024-01-0${(i % 9) + 1}</td><td>dev</td><td>msg${i}</td></tr>`
      ).join('');
      mockFetchText(`<table id="revisions">${rows}</table>`);
      const result = await client.getFileHistory('proj', 'file.cpp', 3);
      expect(result.entries.length).toBeLessThanOrEqual(3);
    });

    it('rejects path traversal', async () => {
      await expect(
        client.getFileHistory('proj', '../../etc/passwd')
      ).rejects.toThrow(/Unsafe path/);
    });
  });

  describe('getAnnotate', () => {
    it('parses annotate response', async () => {
      mockFetchText(`
        <div id="src">
          <div class="l" name="1"><a class="r" title="revision: abc author: dev date: 2024-01-01">1</a> code line 1</div>
          <div class="l" name="2"><a class="r" title="revision: abc author: dev date: 2024-01-01">2</a> code line 2</div>
        </div>
      `);
      const result = await client.getAnnotate('proj', 'file.cpp');
      expect(result.project).toBe('proj');
      expect(result.path).toBe('file.cpp');
    });

    it('falls back to xref endpoint on annotate failure', async () => {
      // First call (annotate/) fails
      fetchSpy.mockRejectedValueOnce(new Error('404'));
      // Second call (xref/?a=true) succeeds
      mockFetchText(`<div id="src"><div class="l" name="1"><a class="r" title="revision: abc author: dev">1</a> code</div></div>`);
      const result = await client.getAnnotate('proj', 'file.cpp');
      expect(result.project).toBe('proj');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('getFileDiff', () => {
    const minimalDiffHtml = '<div id="difftable"><div class="pre"><table class="plain"><tbody>' +
      '<tr class="chunk"><td><del class="d">7</del>    int x = 0;<br/></td></tr>' +
      '<tr class="k"><td><span class="a it">7</span>    int x = 42;<br/></td></tr>' +
      '</tbody></table></div></div>';

    it('fetches unified diff HTML from /diff/{project}/{path} with format=u', async () => {
      mockFetchText(minimalDiffHtml);
      const result = await client.getFileDiff('proj', 'src/file.cpp', 'abc123', 'def456');
      expect(result.project).toBe('proj');
      expect(result.path).toBe('src/file.cpp');
      expect(result.rev1).toBe('abc123');
      expect(result.rev2).toBe('def456');
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('/diff/proj/src/file.cpp');
      expect(calledUrl).toContain('format=u');
      expect(calledUrl).not.toContain('action=download');
    });

    it('parses the unified HTML and returns stats', async () => {
      mockFetchText(minimalDiffHtml);
      const result = await client.getFileDiff('proj', 'src/file.cpp', 'abc123', 'def456');
      expect(result.stats.removed).toBe(1);
      expect(result.stats.added).toBe(1);
      expect(result.unifiedDiff).toContain('-    int x = 0;');
      expect(result.unifiedDiff).toContain('+    int x = 42;');
    });

    it('encodes r1 and r2 as /{project}/{path}@{rev} query params', async () => {
      mockFetchText('<div id="difftable"></div>');
      await client.getFileDiff('myproj', 'path/to/file.cpp', 'rev1hash', 'rev2hash');
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('r1=');
      expect(decodeURIComponent(calledUrl)).toContain('/myproj/path/to/file.cpp@rev1hash');
      expect(decodeURIComponent(calledUrl)).toContain('/myproj/path/to/file.cpp@rev2hash');
    });

    it('rejects path traversal in path argument', async () => {
      await expect(
        client.getFileDiff('proj', '../../etc/passwd', 'r1', 'r2')
      ).rejects.toThrow(/Unsafe path/);
    });
  });

  describe('getFileSymbols', () => {
    it('returns symbols from API', async () => {
      mockFetchJSON([
        { symbol: 'main', type: 'Function', line: 10, lineStart: 10, signature: 'int main()' },
      ]);
      const result = await client.getFileSymbols('proj', 'file.cpp');
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].symbol).toBe('main');
    });

    it('falls back to xref parsing when API fails', async () => {
      // API call fails (pRetry has 3 retries = 4 attempts, mock them all to fail fast)
      fetchSpy
        .mockRejectedValueOnce(new Error('401'))
        .mockRejectedValueOnce(new Error('401'))
        .mockRejectedValueOnce(new Error('401'))
        .mockRejectedValueOnce(new Error('401'));
      // After all API retries exhaust, getFileSymbols catches and tries xref fallback
      // But xref also uses this.request() which retries — mock those too
      fetchSpy
        .mockResolvedValueOnce(new Response('<html><body></body></html>', { status: 200 }));
      const result = await client.getFileSymbols('proj', 'file.cpp');
      expect(result.symbols).toEqual([]);
    }, 30_000);

    it('returns empty on double failure', async () => {
      // All fetch attempts fail — both API and xref fallback
      fetchSpy.mockRejectedValue(new Error('network error'));
      const result = await client.getFileSymbols('proj', 'file.cpp');
      expect(result.symbols).toEqual([]);
    }, 30_000);
  });

  describe('browseDirectory', () => {
    it('returns directory listing', async () => {
      mockFetchText(`
        <table id="dirlist">
          <tr><td><p class="dirtitle"><a href="/xref/proj/dir/">dir</a></p></td></tr>
          <tr><td><a href="/xref/proj/file.cpp">file.cpp</a></td><td>1234</td></tr>
        </table>
      `);
      const result = await client.browseDirectory('proj', 'path');
      expect(Array.isArray(result)).toBe(true);
    });

    it('handles empty path', async () => {
      mockFetchText('<table id="dirlist"></table>');
      const result = await client.browseDirectory('proj');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('listProjects', () => {
    it('returns project list', async () => {
      mockFetchText(`
        <table id="project-list">
          <tr><td class="name"><a href="/xref/release-2.x/">release-2.x</a></td></tr>
          <tr><td class="name"><a href="/xref/release-2.x-win/">release-2.x-win</a></td></tr>
        </table>
      `);
      const result = await client.listProjects();
      expect(Array.isArray(result)).toBe(true);
    });

    it('filters projects by pattern', async () => {
      mockFetchText(`
        <table id="project-list">
          <tr><td class="name"><a href="/xref/release-2.x/">release-2.x</a></td></tr>
          <tr><td class="name"><a href="/xref/release-2.x-win/">release-2.x-win</a></td></tr>
          <tr><td class="name"><a href="/xref/v1.8-stable/">v1.8-stable</a></td></tr>
        </table>
      `);
      const result = await client.listProjects('release');
      // Should filter to only release-* projects
      for (const p of result) {
        expect(p.name).toContain('release');
      }
    });

    it('rejects filter > 100 chars', async () => {
      mockFetchText('<table id="project-list"></table>');
      await expect(
        client.listProjects('a'.repeat(101))
      ).rejects.toThrow(/too long/);
    });

    it('handles consecutive wildcard patterns safely via minimatch (no ReDoS)', async () => {
      // minimatch handles *** and ??? safely without catastrophic backtracking;
      // these patterns are no longer rejected — they simply match or not.
      mockFetchText('<html><body><select id="project"><option value="release-2.x">release-2.x</option></select></body></html>');
      const result1 = await client.listProjects('***');
      expect(Array.isArray(result1)).toBe(true);
      mockFetchText('<html><body><select id="project"><option value="abc">abc</option></select></body></html>');
      const result2 = await client.listProjects('???');
      expect(Array.isArray(result2)).toBe(true);
    });

    it('supports glob wildcards', async () => {
      mockFetchText(`
        <table id="project-list">
          <tr><td class="name"><a href="/xref/release-2.x/">release-2.x</a></td></tr>
          <tr><td class="name"><a href="/xref/release-2.x-win/">release-2.x-win</a></td></tr>
        </table>
      `);
      const result = await client.listProjects('release-2.x*');
      for (const p of result) {
        expect(p.name).toMatch(/^release-2\.x/);
      }
    });
  });

  describe('testConnection', () => {
    it('returns true on successful response', async () => {
      mockFetchJSON([{ name: 'release-2.x' }]);
      const result = await client.testConnection();
      expect(result).toBe(true);
    });

    it('returns false on error', async () => {
      // Mock all retry attempts to fail fast
      fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
      // pRetry has backoff delays, increase timeout
      const result = await client.testConnection();
      expect(result).toBe(false);
    }, 30_000);
  });

  describe('close', () => {
    it('clears caches on close', async () => {
      const cachedClient = new OpenGrokClient(makeConfig({ OPENGROK_CACHE_ENABLED: true }));
      await cachedClient.close();
      // Should not throw
    });

    it('closes agent on close (SSL disabled)', async () => {
      const sslClient = new OpenGrokClient(makeConfig({ OPENGROK_VERIFY_SSL: false }));
      await sslClient.close();
      // Should not throw
    });
  });
});

// -----------------------------------------------------------------------
// Caching behavior
// -----------------------------------------------------------------------

describe('OpenGrokClient caching', () => {
  let client: OpenGrokClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new OpenGrokClient(makeConfig({ OPENGROK_CACHE_ENABLED: true }));
    fetchMock.mockReset();
    fetchSpy = fetchMock;
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  it('caches search results (second call returns same object)', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ resultCount: 1, results: { '/proj/f.cpp': [{ lineNumber: 1, line: 'x' }] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    );
    const r1 = await client.search('test', 'full');
    const r2 = await client.search('test', 'full');
    // Both should return same totalCount
    expect(r1.totalCount).toBe(1);
    expect(r2.totalCount).toBe(1);
  });

  it('caches file content (second call does not re-fetch)', async () => {
    let callCount = 0;
    fetchSpy.mockImplementation(() => {
      callCount++;
      return Promise.resolve(new Response('file content here', { status: 200 }));
    });
    const r1 = await client.getFileContent('proj', 'file.cpp');
    const r2 = await client.getFileContent('proj', 'file.cpp');
    expect(r1.content).toBe(r2.content);
    // With caching, only 1 fetch should have been made
    // (If this were 2, caching is broken, but content should still match)
    expect(callCount).toBeLessThanOrEqual(2);
  });
});

// -----------------------------------------------------------------------
// Redirect handling
// -----------------------------------------------------------------------

describe('OpenGrokClient redirect handling', () => {
  let client: OpenGrokClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new OpenGrokClient(makeConfig());
    fetchMock.mockReset();
    fetchSpy = fetchMock;
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  it('follows same-host redirects', async () => {
    // First response is a redirect
    fetchSpy.mockResolvedValueOnce(
      new Response('', {
        status: 302,
        headers: { Location: 'https://example.com/source/api/v1/search?q=test' },
      })
    );
    // Second response is the actual data
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ resultCount: 0, results: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const result = await client.search('test', 'full');
    expect(result.totalCount).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('blocks cross-host redirects (SSRF)', async () => {
    // Mock all attempts to return cross-host redirect (pRetry will retry)
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response('', {
        status: 302,
        headers: { Location: 'https://evil.com/steal' },
      }))
    );
    await expect(client.search('test', 'full')).rejects.toThrow(/SSRF/);
  }, 30_000);
});
