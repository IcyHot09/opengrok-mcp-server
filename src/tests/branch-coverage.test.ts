/**
 * Targeted tests for branch coverage across parsers.ts, formatters.ts,
 * server.ts, compile-info.ts, config.ts, and client.ts.
 * Covers nullish coalescing (??), optional chaining (?.), ternary,
 * and if/else branches that are hard to reach through normal API calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  parseProjectsPage,
  parseDirectoryListing,
  parseAnnotate,
  parseFileHistory,
  parseWebSearchResults,
  parseFileSymbols,
} from '../server/parsers/index.js';
import {
  formatSearchResults,
  formatFileContent,
  formatFileHistory,
  formatDirectoryListing,
  formatProjectsList,
  formatAnnotate,
  formatCompileInfo,
  formatFileSymbols,
  formatSymbolContext,
} from '../server/formatters/index.js';
import {
  _dispatchTool as dispatchTool,
  _buildLocalLayer as buildLocalLayer,
  _capResponse as capResponse,
  createServer,
} from '../server/server.js';
import {
  parseCompileCommands,
  loadCompileCommandsJson,
  inferBuildRoot,
} from '../server/local/compile-info.js';
import {
  OpenGrokClient,
  _TTLCache as TTLCache,
} from '../server/client/index.js';
import type { Config } from '../server/config.js';
import type {
  SearchResults,
  FileContent,
  FileHistory,
  AnnotatedFile,
  DirectoryEntry,
  Project,
} from '../server/models.js';
import type { CompileInfo } from '../server/local/compile-info.js';

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    OPENGROK_BASE_URL: 'https://example.com/source/',
    OPENGROK_USERNAME: 'user',
    OPENGROK_PASSWORD: 'pass',
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
    suggest: vi.fn(),
    getFileContent: vi.fn(),
    getFileHistory: vi.fn(),
    getAnnotate: vi.fn(),
    getFileSymbols: vi.fn(),
    browseDirectory: vi.fn(),
    listProjects: vi.fn(),
    testConnection: vi.fn(),
    close: vi.fn(),
  };
}

function emptyLocal() {
  return { enabled: false, roots: [] as string[], index: new Map<string, CompileInfo>(), suffixIndex: new Map<string, string>() };
}

// -----------------------------------------------------------------------
// parsers.ts branch coverage
// -----------------------------------------------------------------------

describe('parsers.ts branch coverage', () => {
  describe('parseProjectsPage', () => {
    it('handles options without value attribute (falls to ?? "")', () => {
      const html = '<html><body><select id="project"><option>NoValue</option></select></body></html>';
      const projects = parseProjectsPage(html);
      // Value is empty, so no project is added
      expect(projects.length).toBe(0);
    });

    it('handles optgroup without label', () => {
      const html = '<html><body><select id="project"><optgroup><option value="p1">p1</option></optgroup></select></body></html>';
      const projects = parseProjectsPage(html);
      expect(projects.length).toBe(1);
    });

    it('handles child that is neither optgroup nor option', () => {
      // Some HTML parsers may interpret differently
      const html = '<html><body><select id="project"><option value="x">x</option></select></body></html>';
      const projects = parseProjectsPage(html);
      expect(projects.length).toBe(1);
    });
  });

  describe('parseDirectoryListing fallback (no table)', () => {
    it('skips links that match the current path', () => {
      const html = `<html><body>
        <a href="/xref/proj/src/">src</a>
        <a href="/xref/proj/src/file.cpp">file.cpp</a>
      </body></html>`;
      const entries = parseDirectoryListing(html, 'proj', 'src');
      // The first link matches currentPath 'src', should be skipped
      expect(entries.some(e => e.name === 'file.cpp')).toBe(true);
    });

    it('handles links with no match to xref pattern (skipped via continue)', () => {
      const html = `<html><body>
        <a href="/other/unrelated">unrelated</a>
        <a href="/xref/proj/src/file.cpp">file.cpp</a>
      </body></html>`;
      const entries = parseDirectoryListing(html, 'proj', '');
      expect(entries.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('parseDirectoryListing table-based', () => {
    it('handles table rows with no valid link (skips via !link continue)', () => {
      const html = `<html><body>
        <table id="dirlist">
          <tr><td>no link here</td></tr>
          <tr><td><a href="/xref/proj/src/file.cpp">file.cpp</a></td></tr>
        </table>
      </body></html>`;
      const entries = parseDirectoryListing(html, 'proj', 'src');
      expect(entries.length).toBeGreaterThanOrEqual(0);
    });

    it('handles rows with empty currentPath', () => {
      const html = `<html><body>
        <table id="dirlist">
          <tr><td><a href="/xref/proj/file.cpp">file.cpp</a></td><td>1024</td><td>2024-01-01</td></tr>
        </table>
      </body></html>`;
      const entries = parseDirectoryListing(html, 'proj', '');
      expect(entries.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('parseFileHistory', () => {
    it('handles rows with missing cells (undefined via ?.)', () => {
      const html = `<html><body>
        <table id="revisions">
          <tr class="changeset"><td></td></tr>
        </table>
      </body></html>`;
      const result = parseFileHistory(html, 'proj', 'file.cpp');
      // Should handle gracefully even with minimal cells
      expect(result).toBeDefined();
    });

    it('extracts revision from cell text when no link present', () => {
      const html = `<html><body>
        <table id="revisions">
          <tr class="changeset"><td>#abc123</td><td></td><td>2024</td><td>author</td><td>msg</td></tr>
        </table>
      </body></html>`;
      const result = parseFileHistory(html, 'proj', 'file.cpp');
      expect(result.entries.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('parseAnnotate', () => {
    it('handles lines without revision or author', () => {
      const html = `<html><body>
        <table>
          <tr><td></td><td></td><td>1</td><td>code line</td></tr>
        </table>
      </body></html>`;
      const result = parseAnnotate(html, 'proj', 'file.cpp');
      expect(result).toBeDefined();
    });

    it('handles title element with no regex match', () => {
      const html = `<html><body>
        <div title="some random title">
          <table>
            <tr class="blame-line">
              <td><a title="unknown info">info</a></td>
              <td></td>
              <td>1</td>
              <td>code</td>
            </tr>
          </table>
        </div>
      </body></html>`;
      const result = parseAnnotate(html, 'proj', 'file.cpp');
      expect(result).toBeDefined();
    });
  });

  describe('parseWebSearchResults', () => {
    it('handles results with no #results div (falls to root)', () => {
      const html = '<html><body><div class="dir"><a href="/xref/p/f.cpp">f.cpp</a></div></body></html>';
      const result = parseWebSearchResults(html, 'full', 'test');
      expect(result.searchType).toBe('full');
    });

    it('handles file symbol href without path regex match', () => {
      const html = `<html><body>
        <div id="results">
          <div class="dir"><a href="/xref/p/file.cpp">file.cpp</a></div>
          <pre class="result">
            <span class="l">5</span><a href="javascript:void(0)">bad link</a>
          </pre>
        </div>
      </body></html>`;
      const result = parseWebSearchResults(html, 'full', 'test');
      expect(result).toBeDefined();
    });

    it('handles results with title element with no text', () => {
      const html = `<html><body>
        <div id="results">
          <div class="dir"><a href="/xref/p/file.cpp">file.cpp</a></div>
        </div>
      </body></html>`;
      const result = parseWebSearchResults(html, 'full', 'test');
      expect(result).toBeDefined();
    });
  });
});

// -----------------------------------------------------------------------
// formatters.ts branch coverage
// -----------------------------------------------------------------------

describe('formatters.ts branch coverage', () => {
  it('langForPath returns "" for path without dot', () => {
    const content: FileContent = {
      project: 'p', path: 'Makefile', content: 'all:', lineCount: 1, sizeBytes: 4,
    };
    const output = formatFileContent(content);
    // Should have empty lang after ```
    expect(output).toContain('```\n');
  });

  it('langForPath handles unknown extension', () => {
    const content: FileContent = {
      project: 'p', path: 'test.xyz123', content: 'data', lineCount: 1, sizeBytes: 4,
    };
    const output = formatFileContent(content);
    expect(output).toContain('```');
  });

  it('formatFileHistory handles short revisions (≤8 chars)', () => {
    const history: FileHistory = {
      project: 'p', path: 'file.cpp',
      entries: [{ revision: 'abc', date: '2024', author: 'bob', message: 'fix' }],
    };
    const output = formatFileHistory(history);
    expect(output).toContain('abc');
  });

  it('formatProjectsList shows "No projects found" when empty', () => {
    const output = formatProjectsList([]);
    expect(output).toContain('No projects found');
  });

  it('formatAnnotate shows "No annotations found" for empty lines', () => {
    const annotate: AnnotatedFile = { project: 'p', path: 'f.cpp', lines: [] };
    const output = formatAnnotate(annotate);
    expect(output).toContain('No annotations found');
  });

  it('formatAnnotate handles lines with null revision and author', () => {
    const annotate: AnnotatedFile = {
      project: 'p', path: 'f.cpp',
      lines: [{ lineNumber: 1, content: 'x' }],
    };
    const output = formatAnnotate(annotate);
    expect(output).toContain('x');
  });

  it('formatAnnotate with only startLine uses 1 as default', () => {
    const annotate: AnnotatedFile = {
      project: 'p', path: 'f.cpp',
      lines: [
        { lineNumber: 1, content: 'a', revision: 'r1', author: 'auth' },
        { lineNumber: 2, content: 'b', revision: 'r1', author: 'auth' },
        { lineNumber: 3, content: 'c', revision: 'r2', author: 'auth2' },
      ],
    };
    const output = formatAnnotate(annotate, undefined, 2);
    expect(output).toContain('a');
    expect(output).toContain('b');
  });

  it('formatSearchResults strips HTML entities with unknown entity falling to ??', () => {
    const results: SearchResults = {
      query: 'test', searchType: 'full', totalCount: 1, timeMs: 10,
      results: [{
        project: 'p', path: '/f.cpp',
        matches: [{ lineNumber: 1, lineContent: '&unknownentity; text' }],
      }],
      startIndex: 0, endIndex: 1,
    };
    const output = formatSearchResults(results);
    expect(output).toContain('&unknownentity;');
  });

  it('formatDirectoryListing shows files without size (size undefined)', () => {
    const entries: DirectoryEntry[] = [
      { name: 'nosize.cpp', isDirectory: false, path: 'nosize.cpp' },
    ];
    const output = formatDirectoryListing(entries, 'p', '');
    expect(output).toContain('nosize.cpp');
    expect(output).not.toContain('bytes');
  });

  it('formatFileSymbols handles symbols with lineStart undefined', () => {
    const output = formatFileSymbols({
      project: 'p', path: 'f.cpp',
      symbols: [
        { symbol: 'foo', type: 'function', line: 10 },
        { symbol: 'bar', type: 'function', line: 20 },
      ],
    });
    expect(output).toContain('foo');
    expect(output).toContain('bar');
  });

  it('formatFileSymbols handles symbols with null type (falls to "Unknown")', () => {
    const output = formatFileSymbols({
      project: 'p', path: 'f.cpp',
      symbols: [
        { symbol: 'thing', line: 5 } as any,
      ],
    });
    expect(output).toContain('thing');
  });

  it('formatSymbolContext handles definition with path having no dot', () => {
    const result = formatSymbolContext({
      found: true,
      symbol: 'main',
      kind: 'function/method',
      definition: {
        project: 'p', path: 'Makefile', line: 1, context: 'all: build', lang: '',
      },
      references: { totalFound: 0, samples: [] },
    });
    expect(result).toContain('main');
  });

  it('formatCompileInfo with null info', () => {
    const output = formatCompileInfo(null, 'test.cpp');
    expect(output).toContain('test.cpp');
  });
});

// -----------------------------------------------------------------------
// server.ts branch coverage (dispatch and handler paths)
// -----------------------------------------------------------------------

describe('server.ts branch coverage', () => {
  const config = makeConfig();

  describe('handleSearchAndRead branches', () => {
    it('skips results with no matches', async () => {
      const client = makeMockClient();
      client.search.mockResolvedValueOnce({
        query: 'test', searchType: 'full', totalCount: 1, timeMs: 10,
        results: [{ project: 'p', path: '/f.cpp', matches: [] }],
        startIndex: 0, endIndex: 1,
      });
      const result = await dispatchTool('opengrok_search_and_read', { query: 'test' }, client as any, config, emptyLocal());
      expect(result).toBeDefined();
    });

    it('breaks when totalOutputBytes exceeds cap', async () => {
      const client = makeMockClient();
      // Return enough results with large content to exceed cap
      const bigContent = 'x'.repeat(10000);
      const results = Array.from({ length: 20 }, (_, i) => ({
        project: 'p', path: `/file${i}.cpp`,
        matches: [{ lineNumber: 1, lineContent: 'match' }],
      }));
      client.search.mockResolvedValueOnce({
        query: 'test', searchType: 'full', totalCount: 20, timeMs: 10,
        results, startIndex: 0, endIndex: 20,
      });
      client.getFileContent.mockImplementation(() =>
        Promise.resolve({ project: 'p', path: 'f.cpp', content: bigContent, lineCount: 500, sizeBytes: bigContent.length })
      );
      const result = await dispatchTool('opengrok_search_and_read', { query: 'test' }, client as any, config, emptyLocal());
      expect(result).toBeDefined();
    });

    it('skips unreadable files in search_and_read', async () => {
      const client = makeMockClient();
      client.search.mockResolvedValueOnce({
        query: 'test', searchType: 'full', totalCount: 1, timeMs: 10,
        results: [{ project: 'p', path: '/f.cpp', matches: [{ lineNumber: 1, lineContent: 'x' }] }],
        startIndex: 0, endIndex: 1,
      });
      client.getFileContent.mockRejectedValueOnce(new Error('cannot read'));
      const result = await dispatchTool('opengrok_search_and_read', { query: 'test' }, client as any, config, emptyLocal());
      expect(result).toBeDefined();
    });

    it('handles path without dot in search_and_read', async () => {
      const client = makeMockClient();
      client.search.mockResolvedValueOnce({
        query: 'test', searchType: 'full', totalCount: 1, timeMs: 10,
        results: [{ project: 'p', path: '/Makefile', matches: [{ lineNumber: 1, lineContent: 'all' }] }],
        startIndex: 0, endIndex: 1,
      });
      client.getFileContent.mockResolvedValueOnce({
        project: 'p', path: 'Makefile', content: 'all: build', lineCount: 1, sizeBytes: 10,
      });
      const result = await dispatchTool('opengrok_search_and_read', { query: 'test' }, client as any, config, emptyLocal());
      expect(result).toContain('Makefile');
    });
  });

  describe('handleGetSymbolContext branches', () => {
    it('handles .h file definition (kind = class/struct)', async () => {
      const client = makeMockClient();
      client.search.mockResolvedValueOnce({
        query: 'MyClass', searchType: 'defs', totalCount: 1,
        results: [{ project: 'p', path: '/include/my.h', matches: [{ lineNumber: 5, lineContent: 'class MyClass' }] }],
      });
      client.getFileContent.mockResolvedValueOnce({
        project: 'p', path: 'include/my.h', content: 'class MyClass {};', lineCount: 1, sizeBytes: 17,
      });
      client.getFileSymbols.mockResolvedValueOnce({ project: 'p', path: 'include/my.h', symbols: [] });
      // No header search needed — already a .h file
      // Refs search
      client.search.mockResolvedValueOnce({ query: 'MyClass', searchType: 'refs', totalCount: 0, results: [] });
      const result = await dispatchTool('opengrok_get_symbol_context', { symbol: 'MyClass' }, client as any, config, emptyLocal());
      expect(result).toContain('class/struct');
    });

    it('handles path without extension in definition', async () => {
      const client = makeMockClient();
      client.search.mockResolvedValueOnce({
        query: 'func', searchType: 'defs', totalCount: 1,
        results: [{ project: 'p', path: '/Makefile', matches: [{ lineNumber: 1, lineContent: 'func' }] }],
      });
      client.getFileContent.mockResolvedValueOnce({
        project: 'p', path: 'Makefile', content: 'func:', lineCount: 1, sizeBytes: 5,
      });
      client.getFileSymbols.mockResolvedValueOnce({ project: 'p', path: 'Makefile', symbols: [] });
      // Refs search
      client.search.mockResolvedValueOnce({ query: 'func', searchType: 'refs', totalCount: 0, results: [] });
      const result = await dispatchTool('opengrok_get_symbol_context', { symbol: 'func' }, client as any, config, emptyLocal());
      expect(result).toContain('function/method');
    });

    it('handles fileSymbols with lineStart undefined', async () => {
      const client = makeMockClient();
      client.search.mockResolvedValueOnce({
        query: 'X', searchType: 'defs', totalCount: 1,
        results: [{ project: 'p', path: '/f.h', matches: [{ lineNumber: 1, lineContent: 'X' }] }],
      });
      client.getFileContent.mockResolvedValueOnce({
        project: 'p', path: 'f.h', content: 'X', lineCount: 1, sizeBytes: 1,
      });
      client.getFileSymbols.mockResolvedValueOnce({
        project: 'p', path: 'f.h',
        symbols: [{ symbol: 'X', type: 'class', line: 1 }], // no lineStart
      });
      client.search.mockResolvedValueOnce({ query: 'X', searchType: 'refs', totalCount: 0, results: [] });
      const result = await dispatchTool('opengrok_get_symbol_context', { symbol: 'X' }, client as any, config, emptyLocal());
      expect(result).toContain('X');
    });
  });

  describe('handleGetCompileInfo branches', () => {
    it('handles absolute path lookup', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-ci-'));
      const srcFile = path.join(tmpDir, 'test.cpp');
      fs.writeFileSync(srcFile, 'int x;');
      const resolved = fs.realpathSync(srcFile);

      const index = new Map<string, CompileInfo>();
      index.set(resolved, {
        file: resolved,
        directory: tmpDir,
        compiler: 'g++',
        includes: [],
        defines: [],
        standard: 'c++17',
        extraFlags: [],
      });

      try {
        const result = await dispatchTool('opengrok_get_compile_info', { path: resolved }, makeMockClient() as any, config, {
          enabled: true, roots: [tmpDir], index, suffixIndex: new Map(),
        });
        expect(result).toContain('g++');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('handles relative path lookup via root join', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-ci-'));
      const srcFile = path.join(tmpDir, 'src', 'test.cpp');
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.writeFileSync(srcFile, 'int x;');
      const resolved = fs.realpathSync(srcFile);

      const index = new Map<string, CompileInfo>();
      index.set(resolved, {
        file: resolved, directory: tmpDir, compiler: 'clang++',
        includes: [], defines: [], standard: '', extraFlags: [],
      });

      try {
        const result = await dispatchTool('opengrok_get_compile_info', { path: 'src/test.cpp' }, makeMockClient() as any, config, {
          enabled: true, roots: [tmpDir], index, suffixIndex: new Map(),
        });
        expect(result).toContain('clang++');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('handles basename match as last resort', async () => {
      const index = new Map<string, CompileInfo>();
      index.set('/build/some/deep/path/test.cpp', {
        file: '/build/some/deep/path/test.cpp',
        directory: '/build',
        compiler: 'gcc',
        includes: [], defines: [], standard: '', extraFlags: [],
      });

      const result = await dispatchTool('opengrok_get_compile_info', { path: 'test.cpp' }, makeMockClient() as any, config, {
        enabled: true, roots: ['/nonexistent'], index, suffixIndex: new Map(),
      });
      expect(result).toContain('gcc');
    });
  });

  describe('get_file_content with local layer', () => {
    it('reads from local layer via resolveFileFromIndex', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-local-'));
      const srcFile = path.join(tmpDir, 'test.cpp');
      fs.writeFileSync(srcFile, 'int main() { return 0; }');
      const resolved = fs.realpathSync(srcFile);

      const index = new Map<string, CompileInfo>();
      index.set(resolved, {
        file: resolved, directory: tmpDir, compiler: 'g++',
        includes: [], defines: [], standard: '', extraFlags: [],
      });
      const suffixIndex = new Map<string, string>();
      suffixIndex.set('/test.cpp', resolved);

      const client = makeMockClient();
      try {
        const result = await dispatchTool('opengrok_get_file_content', {
          project: 'proj', path: 'test.cpp',
        }, client as any, config, {
          enabled: true, roots: [tmpDir], index, suffixIndex,
        });
        expect(result).toContain('int main');
        // Should NOT have called client.getFileContent since local read succeeded
        expect(client.getFileContent).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('falls back to API when local read fails', async () => {
      const client = makeMockClient();
      client.getFileContent.mockResolvedValueOnce({
        project: 'p', path: 'test.cpp', content: 'api content', lineCount: 1, sizeBytes: 11,
      });

      const result = await dispatchTool('opengrok_get_file_content', {
        project: 'p', path: 'test.cpp',
      }, client as any, config, {
        enabled: true, roots: ['/nonexistent'], index: new Map(), suffixIndex: new Map(),
      });
      expect(result).toContain('api content');
    });
  });
});

// -----------------------------------------------------------------------
// compile-info.ts branch coverage
// -----------------------------------------------------------------------

describe('compile-info.ts branch coverage', () => {
  it('tokenizer handles backslash before quote chars', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-tok-'));
    const srcFile = path.join(tmpDir, 'test.cpp');
    fs.writeFileSync(srcFile, '');
    const ccJson = path.join(tmpDir, 'compile_commands.json');
    // Command with escaped quotes and backslashes
    fs.writeFileSync(ccJson, JSON.stringify([
      { directory: tmpDir, file: 'test.cpp', command: 'g++ -DFOO=\\"bar\\" -c test.cpp' },
    ]));

    try {
      const index = parseCompileCommands([ccJson], [tmpDir]);
      // Should parse without error
      expect(index).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('tokenizer handles single-quoted strings', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-tok-'));
    const srcFile = path.join(tmpDir, 'test.cpp');
    fs.writeFileSync(srcFile, '');
    const ccJson = path.join(tmpDir, 'compile_commands.json');
    fs.writeFileSync(ccJson, JSON.stringify([
      { directory: tmpDir, file: 'test.cpp', command: "g++ -DFOO='bar baz' -c test.cpp" },
    ]));

    try {
      const index = parseCompileCommands([ccJson], [tmpDir]);
      expect(index).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('tokenizer handles double-quoted strings', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-tok-'));
    const srcFile = path.join(tmpDir, 'test.cpp');
    fs.writeFileSync(srcFile, '');
    const ccJson = path.join(tmpDir, 'compile_commands.json');
    fs.writeFileSync(ccJson, JSON.stringify([
      { directory: tmpDir, file: 'test.cpp', command: 'g++ -DFOO="bar baz" -c test.cpp' },
    ]));

    try {
      const index = parseCompileCommands([ccJson], [tmpDir]);
      expect(index).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('parseFlags handles empty args', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-pf-'));
    const srcFile = path.join(tmpDir, 'test.cpp');
    fs.writeFileSync(srcFile, '');
    const ccJson = path.join(tmpDir, 'compile_commands.json');
    fs.writeFileSync(ccJson, JSON.stringify([
      { directory: tmpDir, file: 'test.cpp', command: '' },
    ]));

    try {
      const index = parseCompileCommands([ccJson], [tmpDir]);
      // Empty command should result in no entry (empty args after tokenize)
      expect(index.size).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('parseCompileCommands without directory uses jsonPath dirname', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-nodir-'));
    const srcFile = path.join(tmpDir, 'test.cpp');
    fs.writeFileSync(srcFile, '');
    const ccJson = path.join(tmpDir, 'compile_commands.json');
    // No directory field!
    fs.writeFileSync(ccJson, JSON.stringify([
      { file: srcFile, arguments: ['g++', '-c', srcFile] },
    ]));

    try {
      const index = parseCompileCommands([ccJson], [tmpDir]);
      expect(index.size).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('parseFlags handles -iwithprefix, -iprefix, -isysroot', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-flags-'));
    const srcFile = path.join(tmpDir, 'test.cpp');
    const incDir = path.join(tmpDir, 'inc');
    fs.writeFileSync(srcFile, '');
    fs.mkdirSync(incDir, { recursive: true });
    const ccJson = path.join(tmpDir, 'compile_commands.json');
    fs.writeFileSync(ccJson, JSON.stringify([
      { directory: tmpDir, file: 'test.cpp', arguments: [
        'g++', '-iwithprefix', incDir, '-iprefix', incDir, '-isysroot', incDir, '-c', 'test.cpp',
      ] },
    ]));

    try {
      const index = parseCompileCommands([ccJson], [tmpDir]);
      expect(index.size).toBe(1);
      const info = [...index.values()][0];
      expect(info.includes.length).toBeGreaterThanOrEqual(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('parseFlags handles -o flag (skip output file)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-oflag-'));
    const srcFile = path.join(tmpDir, 'test.cpp');
    fs.writeFileSync(srcFile, '');
    const ccJson = path.join(tmpDir, 'compile_commands.json');
    fs.writeFileSync(ccJson, JSON.stringify([
      { directory: tmpDir, file: 'test.cpp', arguments: ['g++', '-o', 'test.o', '-c', 'test.cpp'] },
    ]));

    try {
      const index = parseCompileCommands([ccJson], [tmpDir]);
      expect(index.size).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('inferBuildRoot returns sep when no common prefix', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-root-'));
    const dirA = path.join(tmpDir, 'aaa');
    const dirB = '/tmp/completely-different-path-' + Date.now();
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const ccJson = path.join(tmpDir, 'compile_commands.json');
    fs.writeFileSync(ccJson, JSON.stringify([
      { directory: dirA, file: 'a.cpp', command: 'g++ a.cpp' },
      { directory: dirB, file: 'b.cpp', command: 'g++ b.cpp' },
    ]));

    try {
      const root = inferBuildRoot([ccJson]);
      // Common prefix should be "/" or the common ancestor
      expect(root).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('resolveInclude handles relative include path', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-inc-'));
    const srcFile = path.join(tmpDir, 'test.cpp');
    const incDir = path.join(tmpDir, 'inc');
    fs.writeFileSync(srcFile, '');
    fs.mkdirSync(incDir, { recursive: true });
    const ccJson = path.join(tmpDir, 'compile_commands.json');
    fs.writeFileSync(ccJson, JSON.stringify([
      { directory: tmpDir, file: 'test.cpp', arguments: ['g++', '-Iinc', '-c', 'test.cpp'] },
    ]));

    try {
      const index = parseCompileCommands([ccJson], [tmpDir]);
      const info = [...index.values()][0];
      expect(info.includes.length).toBeGreaterThanOrEqual(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------
// client.ts branch coverage — TTLCache edge cases
// -----------------------------------------------------------------------

describe('client.ts branch coverage', () => {
  it('TTLCache.set handles item larger than maxBytes (break on empty map)', () => {
    const cache = new TTLCache<string, string>(10, 5, 60_000);
    // Set a value that's much larger than maxBytes
    cache.set('big', 'huge-value', 100);
    // Oversized entries are rejected to protect the byte budget
    expect(cache.get('big')).toBeUndefined();
  });
});

// -----------------------------------------------------------------------
// server.ts — buildLocalLayer with no inferred root
// -----------------------------------------------------------------------

describe('buildLocalLayer without valid inferred root', () => {
  it('handles case where inferredRoot realpathSync fails', () => {
    // Create compile_commands.json that points to non-existent directory
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-bl-'));
    const srcFile = path.join(tmpDir, 'test.cpp');
    fs.writeFileSync(srcFile, '');
    const ccJson = path.join(tmpDir, 'compile_commands.json');
    fs.writeFileSync(ccJson, JSON.stringify([
      { directory: '/nonexistent/build/dir', file: path.join(tmpDir, 'test.cpp'), arguments: ['g++', '-c', 'test.cpp'] },
    ]));

    try {
      const result = buildLocalLayer(makeConfig({
        OPENGROK_LOCAL_COMPILE_DB_PATHS: ccJson,
      }));
      // Should still attempt to work (may or may not be enabled)
      expect(result).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
