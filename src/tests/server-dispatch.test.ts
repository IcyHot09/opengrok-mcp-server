/**
 * Comprehensive tests for server.ts — dispatchTool handlers.
 * Directly exercises all 14 tool dispatch cases + compound handlers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  _dispatchTool as dispatchTool,
  _buildLocalLayer as buildLocalLayer,
  _tryLocalRead as tryLocalRead,
  _readFileAtAbsPath as readFileAtAbsPath,
} from '../server/server.js';
import type { _LocalLayer as LocalLayer } from '../server/server.js';
import type { Config } from '../server/config.js';
import type { CompileInfo } from '../server/local/compile-info.js';

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

function makeMockClient() {
  return {
    search: vi.fn(),
    searchPattern: vi.fn(),
    suggest: vi.fn(),
    getFileContent: vi.fn(),
    getFileHistory: vi.fn(),
    browseDirectory: vi.fn(),
    listProjects: vi.fn(),
    getAnnotate: vi.fn(),
    getFileSymbols: vi.fn(),
    testConnection: vi.fn(),
    warmCache: vi.fn(),
    close: vi.fn(),
  };
}

function emptyLocal(): LocalLayer {
  return { enabled: false, roots: [], index: new Map(), suffixIndex: new Map() };
}

const config = makeConfig();

// -----------------------------------------------------------------------
// search_code
// -----------------------------------------------------------------------

describe('dispatchTool — opengrok_search_code', () => {
  it('dispatches search and returns formatted output', async () => {
    const client = makeMockClient();
    client.search.mockResolvedValue({
      query: 'test',
      searchType: 'full',
      totalCount: 1,
      results: [{ project: 'proj', path: '/file.cpp', matches: [{ lineNumber: 10, lineContent: 'test' }] }],
    });
    const result = await dispatchTool('opengrok_search_code', { query: 'test', search_type: 'full' }, client as any, config, emptyLocal());
    expect(result).toContain('test');
    expect(client.search).toHaveBeenCalledOnce();
  });

  it('includes file_type param', async () => {
    const client = makeMockClient();
    client.search.mockResolvedValue({ query: 'x', searchType: 'full', totalCount: 0, results: [] });
    await dispatchTool('opengrok_search_code', { query: 'x', search_type: 'full', file_type: 'cxx' }, client as any, config, emptyLocal());
    expect(client.search).toHaveBeenCalledWith('x', 'full', ['release-2.x'], 10, 0, 'cxx', undefined, undefined, undefined, undefined);
  });

  it('applies default project when projects not specified', async () => {
    const client = makeMockClient();
    client.search.mockResolvedValue({ query: 'x', searchType: 'full', totalCount: 0, results: [] });
    await dispatchTool('opengrok_search_code', { query: 'x', search_type: 'full' }, client as any, config, emptyLocal());
    expect(client.search.mock.calls[0][2]).toEqual(['release-2.x']);
  });

  it('dir maps to the pathFilter argument', async () => {
    const client = makeMockClient();
    client.search.mockResolvedValue({ query: 'x', searchType: 'full', totalCount: 0, results: [] });
    await dispatchTool('opengrok_search_code', { query: 'x', search_type: 'full', dir: 'src/server' }, client as any, config, emptyLocal());
    expect(client.search.mock.calls[0][8]).toBe('src/server');
  });

  it('path_filter wins over dir', async () => {
    const client = makeMockClient();
    client.search.mockResolvedValue({ query: 'x', searchType: 'full', totalCount: 0, results: [] });
    await dispatchTool('opengrok_search_code', { query: 'x', search_type: 'full', path_filter: 'src/a', dir: 'src/b' }, client as any, config, emptyLocal());
    expect(client.search.mock.calls[0][8]).toBe('src/a');
  });

  it('file dispatches to getAllMatchesInFile (no client.search)', async () => {
    const client = makeMockClient();
    client.getAllMatchesInFile = vi.fn().mockResolvedValue([{ lineNumber: 3, lineContent: 'x' }]);
    const result = await dispatchTool('opengrok_search_code', { query: 'x', search_type: 'full', file: 'src/a.cpp' }, client as any, config, emptyLocal());
    expect(client.getAllMatchesInFile).toHaveBeenCalledWith('release-2.x', '/src/a.cpp', 'x', 'full', 10);
    expect(client.search).not.toHaveBeenCalled();
    expect(result).toContain('src/a.cpp');
  });

  it('file without a project throws', async () => {
    const client = makeMockClient();
    client.getAllMatchesInFile = vi.fn();
    const noDefault = makeConfig({ OPENGROK_DEFAULT_PROJECT: '' });
    await expect(dispatchTool('opengrok_search_code', { query: 'x', search_type: 'full', file: 'a.cpp', projects: [] }, client as any, noDefault, emptyLocal())).rejects.toThrow(/requires a project/);
  });

  it('file + cursor is rejected as expired', async () => {
    const client = makeMockClient();
    client.getAllMatchesInFile = vi.fn();
    const { encodeCursor } = await import('../server/pagination/cursor-codec.js');
    const cursor = encodeCursor({ t: 'offset', v: 5, m: 'search' });
    await expect(dispatchTool('opengrok_search_code', { query: 'x', search_type: 'full', file: 'a.cpp', cursor }, client as any, config, emptyLocal())).rejects.toThrow(/expired/i);
  });
});

// -----------------------------------------------------------------------
// find_file
// -----------------------------------------------------------------------

describe('dispatchTool — opengrok_find_file', () => {
  it('delegates to search with path type', async () => {
    const client = makeMockClient();
    client.search.mockResolvedValue({ query: 'main.cpp', searchType: 'path', totalCount: 1, results: [{ project: 'proj', path: '/main.cpp', matches: [] }] });
    const result = await dispatchTool('opengrok_find_file', { path_pattern: 'main.cpp' }, client as any, config, emptyLocal());
    expect(client.search).toHaveBeenCalledWith('main.cpp', 'path', ['release-2.x'], 10, 0);
    expect(result).toBeDefined();
  });

  it('resolves a findFile cursor to a start offset (client is search-strict)', async () => {
    const client = makeMockClient();
    client.search.mockResolvedValue({ query: 'main.cpp', searchType: 'path', totalCount: 1, results: [] });
    const { encodeCursor } = await import('../server/pagination/cursor-codec.js');
    const cursor = encodeCursor({ t: 'offset', v: 7, m: 'findFile' });
    await dispatchTool('opengrok_find_file', { path_pattern: 'main.cpp', cursor }, client as any, config, emptyLocal());
    expect(client.search).toHaveBeenCalledWith('main.cpp', 'path', ['release-2.x'], 10, 7);
  });
});

// -----------------------------------------------------------------------
// search_pattern
// -----------------------------------------------------------------------

describe('dispatchTool — opengrok_search_pattern', () => {
  it('delegates to searchPattern with regexp=true URL semantics', async () => {
    const client = makeMockClient();
    client.searchPattern.mockResolvedValue({
      query: 'void\\s+\\w+',
      searchType: 'full',
      totalCount: 1,
      timeMs: 5,
      results: [{ project: 'proj', path: '/src/main.cpp', matches: [{ lineNumber: 10, lineContent: 'void main()' }] }],
      startIndex: 0,
      endIndex: 1,
    });
    const result = await dispatchTool('opengrok_search_pattern', { pattern: 'void\\s+\\w+' }, client as any, config, emptyLocal());
    expect(client.searchPattern).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: 'void\\s+\\w+', projects: ['release-2.x'] })
    );
    expect(result).toContain('main.cpp');
  });
});

// -----------------------------------------------------------------------
// get_file_content
// -----------------------------------------------------------------------

describe('dispatchTool — opengrok_get_file_content', () => {
  it('fetches from remote API', async () => {
    const client = makeMockClient();
    client.getFileContent.mockResolvedValue({
      project: 'proj',
      path: 'file.cpp',
      content: 'int main() {}',
      lineCount: 1,
      sizeBytes: 14,
    });
    const result = await dispatchTool('opengrok_get_file_content', { project: 'proj', path: 'file.cpp' }, client as any, config, emptyLocal());
    expect(result).toContain('int main()');
  });

  it('tries local layer when enabled', async () => {
    const client = makeMockClient();
    client.getFileContent.mockResolvedValue({
      project: 'proj', path: 'file.cpp', content: 'remote content', lineCount: 1, sizeBytes: 14,
    });
    const info: CompileInfo = {
      file: '/build/src/file.cpp', directory: '/build', compiler: 'g++',
      includes: [], defines: [], standard: 'c++17', extraFlags: [],
    };
    const local: LocalLayer = {
      enabled: true,
      roots: ['/build/src'],
      index: new Map([['/build/src/file.cpp', info]]),
      suffixIndex: new Map([['/src/file.cpp', '/build/src/file.cpp']]),
    };
    // readFileAtAbsPath will fail since the file doesn't exist on disk, fall through to API
    const result = await dispatchTool('opengrok_get_file_content', { project: 'proj', path: 'src/file.cpp' }, client as any, config, local);
    expect(result).toContain('remote content');
  });
});

// -----------------------------------------------------------------------
// get_file_history
// -----------------------------------------------------------------------

describe('dispatchTool — opengrok_get_file_history', () => {
  it('fetches file history', async () => {
    const client = makeMockClient();
    client.getFileHistory.mockResolvedValue({
      project: 'proj', path: 'file.cpp',
      entries: [{ revision: 'abc123', author: 'dev', date: '2024-01-01', message: 'fix' }],
    });
    const result = await dispatchTool('opengrok_get_file_history', { project: 'proj', path: 'file.cpp' }, client as any, config, emptyLocal());
    expect(result).toContain('abc123');
  });
});

// -----------------------------------------------------------------------
// browse_directory
// -----------------------------------------------------------------------

describe('dispatchTool — opengrok_browse_directory', () => {
  it('fetches directory listing', async () => {
    const client = makeMockClient();
    client.browseDirectory.mockResolvedValue([
      { name: 'src', isDirectory: true, size: null },
      { name: 'file.cpp', isDirectory: false, size: '1234' },
    ]);
    const result = await dispatchTool('opengrok_browse_directory', { project: 'proj', path: 'root' }, client as any, config, emptyLocal());
    expect(result).toContain('src');
    expect(result).toContain('file.cpp');
  });
});

// -----------------------------------------------------------------------
// list_projects
// -----------------------------------------------------------------------

describe('dispatchTool — opengrok_list_projects', () => {
  it('lists all projects', async () => {
    const client = makeMockClient();
    client.listProjects.mockResolvedValue([
      { name: 'release-2.x', indexedDate: '2024-01-01' },
      { name: 'release-2.x-win', indexedDate: '2024-01-01' },
    ]);
    const result = await dispatchTool('opengrok_list_projects', {}, client as any, config, emptyLocal());
    expect(result).toContain('release-2.x');
    expect(result).toContain('release-2.x-win');
  });

  it('lists projects with filter', async () => {
    const client = makeMockClient();
    client.listProjects.mockResolvedValue([{ name: 'release-2.x', indexedDate: '2024-01-01' }]);
    await dispatchTool('opengrok_list_projects', { filter: 'release' }, client as any, config, emptyLocal());
    expect(client.listProjects).toHaveBeenCalledWith('release');
  });
});

// -----------------------------------------------------------------------
// get_file_annotate
// -----------------------------------------------------------------------

describe('dispatchTool — opengrok_get_file_annotate', () => {
  it('fetches annotate data', async () => {
    const client = makeMockClient();
    client.getAnnotate.mockResolvedValue({
      project: 'proj', path: 'file.cpp',
      lines: [{ lineNumber: 1, revision: 'abc', author: 'dev', date: '2024', content: 'code' }],
    });
    const result = await dispatchTool('opengrok_get_file_annotate', { project: 'proj', path: 'file.cpp' }, client as any, config, emptyLocal());
    expect(result).toContain('abc');
  });

  it('with line range', async () => {
    const client = makeMockClient();
    client.getAnnotate.mockResolvedValue({
      project: 'proj', path: 'file.cpp',
      lines: [
        { lineNumber: 1, revision: 'r1', author: 'a', date: '2024', content: 'line1' },
        { lineNumber: 2, revision: 'r2', author: 'a', date: '2024', content: 'line2' },
        { lineNumber: 3, revision: 'r3', author: 'a', date: '2024', content: 'line3' },
      ],
    });
    const result = await dispatchTool('opengrok_get_file_annotate', { project: 'proj', path: 'file.cpp', start_line: 2, end_line: 3 }, client as any, config, emptyLocal());
    expect(result).toContain('line2');
  });
});

// -----------------------------------------------------------------------
// search_suggest
// -----------------------------------------------------------------------

describe('dispatchTool — opengrok_search_suggest', () => {
  it('returns suggestions', async () => {
    const client = makeMockClient();
    client.suggest.mockResolvedValue({ suggestions: ['main', 'malloc'], time: 5, partialResult: false });
    const result = await dispatchTool('opengrok_search_suggest', { query: 'ma' }, client as any, config, emptyLocal());
    expect(result).toContain('main');
    expect(result).toContain('malloc');
  });

  it('returns no suggestions message', async () => {
    const client = makeMockClient();
    client.suggest.mockResolvedValue({ suggestions: [], time: 10, partialResult: false });
    const result = await dispatchTool('opengrok_search_suggest', { query: 'zzz' }, client as any, config, emptyLocal());
    expect(result).toContain('No suggestions found');
  });

  it('returns empty index message when time is 0', async () => {
    const client = makeMockClient();
    client.suggest.mockResolvedValue({ suggestions: [], time: 0, partialResult: false });
    const result = await dispatchTool('opengrok_search_suggest', { query: 'zzz' }, client as any, config, emptyLocal());
    expect(result).toContain('suggester index');
  });
});

// -----------------------------------------------------------------------
// batch_search
// -----------------------------------------------------------------------

describe('dispatchTool — opengrok_batch_search', () => {
  it('handles multiple queries', async () => {
    const client = makeMockClient();
    client.search.mockResolvedValue({ query: 'q', searchType: 'full', totalCount: 0, results: [] });
    const result = await dispatchTool('opengrok_batch_search', {
      queries: [
        { query: 'foo', search_type: 'full' },
        { query: 'bar', search_type: 'defs' },
      ],
    }, client as any, config, emptyLocal());
    expect(client.search).toHaveBeenCalledTimes(2);
    expect(result).toBeDefined();
  });

  it('top-level dir applies to queries without their own filter', async () => {
    const client = makeMockClient();
    client.search.mockResolvedValue({ query: 'q', searchType: 'full', totalCount: 0, results: [] });
    await dispatchTool('opengrok_batch_search', {
      queries: [
        { query: 'foo', search_type: 'full' },
        { query: 'bar', search_type: 'full', dir: 'src/own' },
      ],
      dir: 'src/top',
    }, client as any, config, emptyLocal());
    expect(client.search.mock.calls[0][8]).toBe('src/top');
    expect(client.search.mock.calls[1][8]).toBe('src/own');
  });

  it('per-query file and top-level file dispatch to getAllMatchesInFile', async () => {
    const client = makeMockClient();
    client.getAllMatchesInFile = vi.fn().mockResolvedValue([{ lineNumber: 1, lineContent: 'x' }]);
    const result = await dispatchTool('opengrok_batch_search', {
      queries: [
        { query: 'foo', search_type: 'full', file: 'src/a.cpp' },
        { query: 'bar', search_type: 'full' },
      ],
      file: 'src/default.cpp',
    }, client as any, config, emptyLocal());
    expect(client.getAllMatchesInFile).toHaveBeenCalledTimes(2);
    expect(client.getAllMatchesInFile.mock.calls[0][1]).toBe('/src/a.cpp');
    expect(client.getAllMatchesInFile.mock.calls[1][1]).toBe('/src/default.cpp');
    expect(client.search).not.toHaveBeenCalled();
    expect(result).toBeDefined();
  });
});

// -----------------------------------------------------------------------
// search_and_read
// -----------------------------------------------------------------------

describe('dispatchTool — opengrok_search_and_read', () => {
  it('searches and reads file content', async () => {
    const client = makeMockClient();
    client.search.mockResolvedValue({
      query: 'main', searchType: 'full', totalCount: 1,
      results: [{ project: 'proj', path: '/src/main.cpp', matches: [{ lineNumber: 10, lineContent: 'int main()' }] }],
    });
    client.getFileContent.mockResolvedValue({
      project: 'proj', path: 'src/main.cpp', content: 'int main() { return 0; }', lineCount: 1, sizeBytes: 24,
    });
    const result = await dispatchTool('opengrok_search_and_read', {
      query: 'main', search_type: 'full',
    }, client as any, config, emptyLocal());
    expect(result).toContain('main');
  });

  it('handles file read failure gracefully', async () => {
    const client = makeMockClient();
    client.search.mockResolvedValue({
      query: 'test', searchType: 'full', totalCount: 1,
      results: [{ project: 'proj', path: '/file.cpp', matches: [{ lineNumber: 5, lineContent: 'test' }] }],
    });
    client.getFileContent.mockRejectedValue(new Error('not found'));
    const result = await dispatchTool('opengrok_search_and_read', { query: 'test', search_type: 'full' }, client as any, config, emptyLocal());
    // should not throw, just skip that file
    expect(result).toBeDefined();
  });

  it('respects context_lines', async () => {
    const client = makeMockClient();
    client.search.mockResolvedValue({
      query: 'x', searchType: 'full', totalCount: 1,
      results: [{ project: 'p', path: '/f.cpp', matches: [{ lineNumber: 50, lineContent: 'x' }] }],
    });
    client.getFileContent.mockResolvedValue({ project: 'p', path: 'f.cpp', content: 'ctx', lineCount: 1, sizeBytes: 3 });
    await dispatchTool('opengrok_search_and_read', { query: 'x', search_type: 'full', context_lines: 20 }, client as any, config, emptyLocal());
    // The startLine/endLine should be 30,70 with context_lines=20
    const call = client.getFileContent.mock.calls[0];
    expect(call[2]).toBe(30); // startLine
    expect(call[3]).toBe(70); // endLine
  });

  it('dir maps to the pathFilter argument', async () => {
    const client = makeMockClient();
    client.search.mockResolvedValue({ query: 'x', searchType: 'full', totalCount: 0, results: [] });
    await dispatchTool('opengrok_search_and_read', { query: 'x', search_type: 'full', dir: 'src/only' }, client as any, config, emptyLocal());
    expect(client.search.mock.calls[0][8]).toBe('src/only');
  });

  it('file restricts the read to a single file', async () => {
    const client = makeMockClient();
    client.getAllMatchesInFile = vi.fn().mockResolvedValue([{ lineNumber: 5, lineContent: 'x' }]);
    client.getFileContent.mockResolvedValue({ project: 'release-2.x', path: 'src/f.cpp', content: 'ctx', lineCount: 1, sizeBytes: 3 });
    const result = await dispatchTool('opengrok_search_and_read', { query: 'x', search_type: 'full', file: 'src/f.cpp' }, client as any, config, emptyLocal());
    expect(client.getAllMatchesInFile).toHaveBeenCalledWith('release-2.x', '/src/f.cpp', 'x', 'full', 3);
    expect(client.search).not.toHaveBeenCalled();
    expect(result).toContain('src/f.cpp');
  });
});

// -----------------------------------------------------------------------
// get_symbol_context
// -----------------------------------------------------------------------

describe('dispatchTool — opengrok_get_symbol_context', () => {
  it('returns not-found when no definitions', async () => {
    const client = makeMockClient();
    client.search.mockResolvedValue({ query: 'Unknown', searchType: 'defs', totalCount: 0, results: [] });
    const result = await dispatchTool('opengrok_get_symbol_context', { symbol: 'Unknown' }, client as any, config, emptyLocal());
    expect(result).toContain('not found');
  });

  it('returns full context on found symbol', async () => {
    const client = makeMockClient();
    // Defs search (first call — uses 'defs' which goes through web search internally)
    client.search.mockResolvedValueOnce({
      query: 'MyClass', searchType: 'defs', totalCount: 1,
      results: [{ project: 'proj', path: '/src/my_class.cpp', matches: [{ lineNumber: 15, lineContent: 'class MyClass' }] }],
    });
    client.getFileContent.mockResolvedValueOnce({
      project: 'proj', path: 'src/my_class.cpp', content: 'class MyClass { };', lineCount: 1, sizeBytes: 19,
    });
    client.getFileSymbols.mockResolvedValueOnce({
      project: 'proj', path: 'src/my_class.cpp',
      symbols: [{ symbol: 'MyClass', type: 'class', line: 15, lineStart: 15 }],
    });
    // Header search (include_header defaults to true, path is .cpp)
    client.search.mockResolvedValueOnce({
      query: 'MyClass', searchType: 'defs', totalCount: 0, results: [],
    });
    // Refs search (called after header search)
    client.search.mockResolvedValueOnce({
      query: 'MyClass', searchType: 'refs', totalCount: 2,
      results: [{ project: 'proj', path: '/other.cpp', matches: [{ lineNumber: 5, lineContent: 'MyClass obj;' }] }],
    });
    const result = await dispatchTool('opengrok_get_symbol_context', { symbol: 'MyClass' }, client as any, config, emptyLocal());
    expect(result).toContain('MyClass');
    expect(result).toContain('References');
  });

  it('searches header for cpp files when include_header is true', async () => {
    const client = makeMockClient();
    // First defs search (finds .cpp)
    client.search.mockResolvedValueOnce({
      query: 'Func', searchType: 'defs', totalCount: 1,
      results: [{ project: 'p', path: '/src/file.cpp', matches: [{ lineNumber: 10, lineContent: 'void Func()' }] }],
    });
    client.getFileContent.mockResolvedValueOnce({
      project: 'p', path: 'src/file.cpp', content: 'void Func() {}', lineCount: 1, sizeBytes: 15,
    });
    client.getFileSymbols.mockResolvedValueOnce({ project: 'p', path: 'src/file.cpp', symbols: [] });
    // Header search (finds .h)
    client.search.mockResolvedValueOnce({
      query: 'Func', searchType: 'defs', totalCount: 2,
      results: [
        { project: 'p', path: '/src/file.cpp', matches: [{ lineNumber: 10, lineContent: 'void Func()' }] },
        { project: 'p', path: '/include/file.h', matches: [{ lineNumber: 5, lineContent: 'void Func();' }] },
      ],
    });
    client.getFileContent.mockResolvedValueOnce({
      project: 'p', path: 'include/file.h', content: 'void Func();', lineCount: 1, sizeBytes: 12,
    });
    // Refs search
    client.search.mockResolvedValueOnce({
      query: 'Func', searchType: 'refs', totalCount: 0, results: [],
    });
    const result = await dispatchTool('opengrok_get_symbol_context', {
      symbol: 'Func', include_header: true,
    }, client as any, config, emptyLocal());
    expect(result).toContain('Func');
  });

  it('handles fileSymbols failure gracefully', async () => {
    const client = makeMockClient();
    // Defs search
    client.search.mockResolvedValueOnce({
      query: 'Sym', searchType: 'defs', totalCount: 1,
      results: [{ project: 'p', path: '/f.cpp', matches: [{ lineNumber: 5, lineContent: 'Sym' }] }],
    });
    client.getFileContent.mockResolvedValueOnce({
      project: 'p', path: 'f.cpp', content: 'code', lineCount: 1, sizeBytes: 4,
    });
    client.getFileSymbols.mockRejectedValueOnce(new Error('no symbols'));
    // Header search (include_header defaults to true, path is .cpp)
    client.search.mockResolvedValueOnce({
      query: 'Sym', searchType: 'defs', totalCount: 0, results: [],
    });
    // Refs search
    client.search.mockResolvedValueOnce({ query: 'Sym', searchType: 'refs', totalCount: 0, results: [] });
    const result = await dispatchTool('opengrok_get_symbol_context', { symbol: 'Sym' }, client as any, config, emptyLocal());
    expect(result).toContain('Sym');
  });
});

// -----------------------------------------------------------------------
// index_health
// -----------------------------------------------------------------------

describe('dispatchTool — opengrok_index_health', () => {
  it('reports connected with latency and project count', async () => {
    const client = makeMockClient();
    client.testConnection.mockResolvedValue(true);
    client.listProjects.mockResolvedValue([
      { name: 'project1', category: 'cat1' },
      { name: 'project2', category: 'cat1' },
    ]);
    const result = await dispatchTool('opengrok_index_health', {}, client as any, config, emptyLocal());
    expect(result).toContain('Connected');
    expect(result).toContain('Latency');
    expect(result).toContain('Indexed projects');
    expect(result).toContain('2');
  });

  it('reports connection failed', async () => {
    const client = makeMockClient();
    client.testConnection.mockResolvedValue(false);
    client.listProjects.mockResolvedValue([]);
    const result = await dispatchTool('opengrok_index_health', {}, client as any, config, emptyLocal());
    expect(result).toContain('Connected');
    expect(result).toContain('false');
  });

  it('includes warning when project list fetch fails', async () => {
    const client = makeMockClient();
    client.testConnection.mockResolvedValue(true);
    client.listProjects.mockRejectedValue(new Error('Network error'));
    const result = await dispatchTool('opengrok_index_health', {}, client as any, config, emptyLocal());
    expect(result).toContain('Connected');
    expect(result).toContain('Warnings');
    expect(result).toContain('Could not retrieve project list');
  });

  it('returns JSON format when requested', async () => {
    const client = makeMockClient();
    client.testConnection.mockResolvedValue(true);
    client.listProjects.mockResolvedValue([{ name: 'project1' }]);
    const result = await dispatchTool('opengrok_index_health', { response_format: 'json' }, client as any, config, emptyLocal());
    const parsed = JSON.parse(result as string);
    expect(parsed.connected).toBe(true);
    expect(typeof parsed.latencyMs).toBe('number');
    expect(parsed.indexedProjects).toBe(1);
    expect(Array.isArray(parsed.warnings)).toBe(true);
  });

  it('calls warmCache on successful connection', async () => {
    const client = makeMockClient();
    client.testConnection.mockResolvedValue(true);
    client.listProjects.mockResolvedValue([]);
    await dispatchTool('opengrok_index_health', {}, client as any, config, emptyLocal());
    expect(client.warmCache).toHaveBeenCalled();
  });

  it('does not call warmCache on failed connection', async () => {
    const client = makeMockClient();
    client.testConnection.mockResolvedValue(false);
    client.listProjects.mockResolvedValue([]);
    await dispatchTool('opengrok_index_health', {}, client as any, config, emptyLocal());
    expect(client.warmCache).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// get_compile_info
// -----------------------------------------------------------------------

describe('dispatchTool — opengrok_get_compile_info', () => {
  it('reports local layer not enabled', async () => {
    const client = makeMockClient();
    const result = await dispatchTool('opengrok_get_compile_info', { path: 'file.cpp' }, client as any, config, emptyLocal());
    expect(result).toContain('not enabled');
  });

  it('reports no compile entries loaded', async () => {
    const client = makeMockClient();
    const local: LocalLayer = { enabled: true, roots: [], index: new Map(), suffixIndex: new Map() };
    const result = await dispatchTool('opengrok_get_compile_info', { path: 'file.cpp' }, client as any, config, local);
    expect(result).toContain('no compile entries');
  });

  it('not found by basename', async () => {
    const client = makeMockClient();
    const info: CompileInfo = {
      file: '/build/src/other.cpp', directory: '/build', compiler: 'g++',
      includes: [], defines: [], standard: 'c++17', extraFlags: [],
    };
    const local: LocalLayer = {
      enabled: true, roots: ['/build/src'],
      index: new Map([['/build/src/other.cpp', info]]),
      suffixIndex: new Map(),
    };
    const result = await dispatchTool('opengrok_get_compile_info', { path: 'unknown.cpp' }, client as any, config, local);
    expect(result).toContain('No compile information');
  });
});

// -----------------------------------------------------------------------
// get_file_symbols
// -----------------------------------------------------------------------

describe('dispatchTool — opengrok_get_file_symbols', () => {
  it('returns symbols', async () => {
    const client = makeMockClient();
    client.getFileSymbols.mockResolvedValue({
      project: 'proj', path: 'file.cpp',
      symbols: [
        { symbol: 'main', type: 'Function', line: 10, lineStart: 10, signature: 'int main()' },
        { symbol: 'MyClass', type: 'Class', line: 3, lineStart: 3, signature: '' },
      ],
    });
    const result = await dispatchTool('opengrok_get_file_symbols', { project: 'proj', path: 'file.cpp' }, client as any, config, emptyLocal());
    expect(result).toContain('main');
    expect(result).toContain('MyClass');
  });

  it('returns no-symbols message', async () => {
    const client = makeMockClient();
    client.getFileSymbols.mockResolvedValue({ project: 'proj', path: 'file.cpp', symbols: [] });
    const result = await dispatchTool('opengrok_get_file_symbols', { project: 'proj', path: 'file.cpp' }, client as any, config, emptyLocal());
    expect(result).toContain('No symbols found');
  });
});

// -----------------------------------------------------------------------
// unknown tool
// -----------------------------------------------------------------------

describe('dispatchTool — opengrok_what_changed', () => {
  const recentDate = new Date();
  recentDate.setDate(recentDate.getDate() - 2); // 2 days ago — within default 7-day window
  const recentDateStr = recentDate.toISOString().slice(0, 10);

  it('returns formatted output grouped by commit', async () => {
    const client = makeMockClient();
    client.getFileHistory.mockResolvedValue({
      project: 'proj', path: 'src/EventLoop.cpp',
      entries: [
        { revision: 'abc12345', author: 'John Doe', date: recentDateStr, message: 'fix event loop' },
      ],
    });
    client.getAnnotate.mockResolvedValue({
      project: 'proj', path: 'src/EventLoop.cpp',
      lines: [
        { lineNumber: 42, revision: 'abc12345', author: 'John Doe', date: recentDateStr, content: 'line content' },
        { lineNumber: 43, revision: 'abc12345', author: 'John Doe', date: recentDateStr, content: 'next line' },
      ],
    });
    const result = await dispatchTool('opengrok_what_changed', { project: 'proj', path: 'src/EventLoop.cpp' }, client as any, config, emptyLocal());
    expect(result).toContain('Recent changes');
    expect(result).toContain('abc1234');
    expect(result).toContain('John Doe');
    expect(result).toContain('42');
  });

  it('reports no changes when no commits fall within since_days', async () => {
    const client = makeMockClient();
    client.getFileHistory.mockResolvedValue({
      project: 'proj', path: 'file.cpp',
      entries: [
        { revision: 'old00001', author: 'Dev', date: '2000-01-01', message: 'ancient commit' },
      ],
    });
    client.getAnnotate.mockResolvedValue({
      project: 'proj', path: 'file.cpp',
      lines: [
        { lineNumber: 1, revision: 'old00001', author: 'Dev', date: '2000-01-01', content: 'old line' },
      ],
    });
    const result = await dispatchTool('opengrok_what_changed', { project: 'proj', path: 'file.cpp', since_days: 7 }, client as any, config, emptyLocal());
    expect(result).toContain('No lines changed');
  });

  it('calls getFileHistory and getAnnotate in parallel', async () => {
    const client = makeMockClient();
    client.getFileHistory.mockResolvedValue({ project: 'proj', path: 'file.cpp', entries: [] });
    client.getAnnotate.mockResolvedValue({ project: 'proj', path: 'file.cpp', lines: [] });
    await dispatchTool('opengrok_what_changed', { project: 'proj', path: 'file.cpp' }, client as any, config, emptyLocal());
    expect(client.getFileHistory).toHaveBeenCalledWith('proj', 'file.cpp');
    expect(client.getAnnotate).toHaveBeenCalledWith('proj', 'file.cpp');
  });
});

describe('dispatchTool — unknown', () => {
  it('returns error for unknown tool name', async () => {
    const client = makeMockClient();
    const result = await dispatchTool('nonexistent_tool', {}, client as any, config, emptyLocal());
    expect(result).toContain('Unknown tool');
  });
});

// -----------------------------------------------------------------------
// buildLocalLayer
// -----------------------------------------------------------------------

describe('buildLocalLayer', () => {
  it('returns disabled when no paths configured', () => {
    const local = buildLocalLayer(makeConfig());
    expect(local.enabled).toBe(false);
    expect(local.index.size).toBe(0);
  });

  it('returns disabled when paths are whitespace', () => {
    const local = buildLocalLayer(makeConfig({ OPENGROK_LOCAL_COMPILE_DB_PATHS: '   ' }));
    expect(local.enabled).toBe(false);
  });
});

// -----------------------------------------------------------------------
// tryLocalRead
// -----------------------------------------------------------------------

describe('tryLocalRead', () => {
  it('returns null for traversal paths', async () => {
    const result = await tryLocalRead('../../../etc/passwd', ['/some/root']);
    expect(result).toBeNull();
  });

  it('returns null for non-existent roots', async () => {
    const result = await tryLocalRead('file.cpp', ['/nonexistent/root/path']);
    expect(result).toBeNull();
  });

  it('returns null for bare ".."', async () => {
    const result = await tryLocalRead('..', ['/tmp']);
    expect(result).toBeNull();
  });

  it('returns null for path ending in "/..."', async () => {
    const result = await tryLocalRead('foo/..', ['/tmp']);
    expect(result).toBeNull();
  });
});

// -----------------------------------------------------------------------
// readFileAtAbsPath
// -----------------------------------------------------------------------

describe('readFileAtAbsPath', () => {
  it('returns null for non-existent file', async () => {
    const result = await readFileAtAbsPath('/nonexistent/file/path.cpp');
    expect(result).toBeNull();
  });
});

// -----------------------------------------------------------------------
// dispatchTool — opengrok_dependency_map
// -----------------------------------------------------------------------

describe('dispatchTool — opengrok_dependency_map', () => {
  it('returns dependency map for direction=both', async () => {
    const client = makeMockClient();
    // "uses": getFileContent returns a C++ file that includes Timer.h
    client.getFileContent.mockResolvedValue({
      project: 'proj', path: 'src/EventLoop.cpp',
      content: '#include "Timer.h"\nvoid run() {}',
      lineCount: 2, sizeBytes: 33, startLine: 1,
    });
    // "uses": path search for stem "Timer" returns Timer.cpp
    client.search.mockResolvedValueOnce({
      query: 'Timer',
      searchType: 'path',
      totalCount: 1,
      timeMs: 5,
      results: [{ project: 'proj', path: 'src/Timer.cpp', matches: [] }],
      startIndex: 0,
      endIndex: 1,
    });
    // "used_by": refs search returns main.cpp
    client.search.mockResolvedValueOnce({
      query: 'EventLoop.cpp',
      searchType: 'refs',
      totalCount: 1,
      timeMs: 5,
      results: [{ project: 'proj', path: 'src/main.cpp', matches: [] }],
      startIndex: 0,
      endIndex: 1,
    });
    const result = await dispatchTool(
      'opengrok_dependency_map',
      { project: 'proj', path: 'src/EventLoop.cpp', depth: 1, direction: 'both' },
      client as any, config, emptyLocal()
    );
    expect(result).toContain('Dependency map');
    expect(result).toContain('EventLoop.cpp');
    expect(result).toContain('Timer.cpp');
    expect(result).toContain('main.cpp');
  });

  it('makes no search calls when file has no imports (direction=uses)', async () => {
    const client = makeMockClient();
    // File with no import statements → extractImports returns [] → no searches
    client.getFileContent.mockResolvedValue({
      project: 'proj', path: 'src/foo.h',
      content: 'struct Foo { int x; };',
      lineCount: 1, sizeBytes: 22, startLine: 1,
    });
    const result = await dispatchTool(
      'opengrok_dependency_map',
      { project: 'proj', path: 'src/foo.h', depth: 1, direction: 'uses' },
      client as any, config, emptyLocal()
    );
    expect(client.search).not.toHaveBeenCalled();
    expect(result).toContain('No dependency');
  });

  it('only runs refs search for direction=used_by', async () => {
    const client = makeMockClient();
    client.search.mockResolvedValue({
      query: 'foo.h',
      searchType: 'refs',
      totalCount: 0,
      timeMs: 5,
      results: [],
      startIndex: 0,
      endIndex: 0,
    });
    await dispatchTool(
      'opengrok_dependency_map',
      { project: 'proj', path: 'src/foo.h', depth: 1, direction: 'used_by' },
      client as any, config, emptyLocal()
    );
    expect(client.search).toHaveBeenCalledTimes(1);
    expect(client.search).toHaveBeenCalledWith('foo.h', 'refs', ['proj'], 20);
  });

  it('recurses to depth=2 for uses', async () => {
    const client = makeMockClient();
    // Level 1: foo.h includes bar.h
    client.getFileContent.mockResolvedValueOnce({
      project: 'proj', path: 'src/foo.h',
      content: '#include "bar.h"\n',
      lineCount: 1, sizeBytes: 17, startLine: 1,
    });
    // Level 2: bar.h includes baz.h
    client.getFileContent.mockResolvedValueOnce({
      project: 'proj', path: 'src/bar.h',
      content: '#include "baz.h"\n',
      lineCount: 1, sizeBytes: 17, startLine: 1,
    });
    // Level 1: path search for "bar" → bar.h
    client.search.mockResolvedValueOnce({
      query: 'bar',
      searchType: 'path',
      totalCount: 1,
      timeMs: 5,
      results: [{ project: 'proj', path: 'src/bar.h', matches: [] }],
      startIndex: 0,
      endIndex: 1,
    });
    // Level 2: path search for "baz" → baz.h
    client.search.mockResolvedValueOnce({
      query: 'baz',
      searchType: 'path',
      totalCount: 1,
      timeMs: 5,
      results: [{ project: 'proj', path: 'src/baz.h', matches: [] }],
      startIndex: 0,
      endIndex: 1,
    });
    const result = await dispatchTool(
      'opengrok_dependency_map',
      { project: 'proj', path: 'src/foo.h', depth: 2, direction: 'uses' },
      client as any, config, emptyLocal()
    );
    expect(client.search).toHaveBeenCalledTimes(2);
    expect(result).toContain('bar.h');
    expect(result).toContain('baz.h');
    expect(result).toContain('Level 1');
    expect(result).toContain('Level 2');
  });

  it('returns no-dep message when results are empty', async () => {
    const client = makeMockClient();
    // No imports in file → uses direction finds nothing
    client.getFileContent.mockResolvedValue({
      project: 'proj', path: 'src/lone.cpp',
      content: 'int main() { return 0; }',
      lineCount: 1, sizeBytes: 24, startLine: 1,
    });
    // used_by: refs search returns empty
    client.search.mockResolvedValue({
      query: 'lone.cpp',
      searchType: 'refs',
      totalCount: 0,
      timeMs: 5,
      results: [],
      startIndex: 0,
      endIndex: 0,
    });
    const result = await dispatchTool(
      'opengrok_dependency_map',
      { project: 'proj', path: 'src/lone.cpp', depth: 1, direction: 'both' },
      client as any, config, emptyLocal()
    );
    expect(result).toContain('No dependency');
  });
});

// -----------------------------------------------------------------------
// Zod input schema rejection — CI gate
// -----------------------------------------------------------------------

describe('dispatchTool — Zod input schema rejection', () => {
  const client = makeMockClient();
  const localLayer = emptyLocal();

  const invalidInputCases: Array<{ tool: string; input: Record<string, unknown>; expectedField: string }> = [
    { tool: 'opengrok_search_code',     input: {},                                  expectedField: 'query' },
    { tool: 'opengrok_search_pattern',  input: {},                                  expectedField: 'pattern' },
    { tool: 'opengrok_dependency_map',  input: {},                                  expectedField: 'project' },
    { tool: 'opengrok_what_changed',    input: {},                                  expectedField: 'project' },
    { tool: 'opengrok_get_file_content',input: {},                                  expectedField: 'project' },
    { tool: 'opengrok_get_file_history',input: {},                                  expectedField: 'project' },
    { tool: 'opengrok_browse_directory',input: {},                                  expectedField: 'project' },
    { tool: 'opengrok_get_file_annotate',input: {},                                 expectedField: 'project' },
    { tool: 'opengrok_search_suggest',  input: {},                                  expectedField: 'query' },
    { tool: 'opengrok_get_file_symbols',input: {},                                  expectedField: 'project' },
  ];

  it.each(invalidInputCases)(
    '$tool rejects missing required field: $expectedField',
    async ({ tool, input, expectedField }) => {
      await expect(
        dispatchTool(tool, input, client as any, config, localLayer)
      ).rejects.toThrow(expectedField);
    }
  );
});
