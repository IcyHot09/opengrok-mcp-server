/**
 * Sandbox spec contract test (P0-1, direction (b)).
 *
 * The bridge in createSandboxAPI() returns FULL shapes; the Zod `returns`
 * schemas in sandbox-schemas/ must describe that actual behavior. This test
 * feeds representative mock-client results through every createSandboxAPI()
 * method and `returns.parse()`s the output — any drift between bridge and
 * schema fails here. Regenerate the spec snapshot with `npm run generate:spec`
 * after schema changes.
 */
import { describe, it, expect, vi } from 'vitest';
import { createSandboxAPI } from '../server/sandbox/index.js';
import type { OpenGrokClient } from '../server/client/index.js';
import type { MemoryBank } from '../server/memory/memory-bank.js';
import type { MethodSchema } from '../server/sandbox/schemas/generator.js';
import { SEARCH_METHODS } from '../server/sandbox/schemas/search.js';
import { READ_NAVIGATE_METHODS } from '../server/sandbox/schemas/read-navigate.js';
import { HISTORY_BLAME_METHODS } from '../server/sandbox/schemas/history-blame.js';
import { CODE_INTELLIGENCE_METHODS } from '../server/sandbox/schemas/code-intelligence.js';
import { SYSTEM_METHODS } from '../server/sandbox/schemas/system.js';
import { FEATURE_FLAG_METHODS } from '../server/sandbox/schemas/feature-flag.js';

const ALL_METHODS: MethodSchema[] = [
  ...SEARCH_METHODS,
  ...READ_NAVIGATE_METHODS,
  ...HISTORY_BLAME_METHODS,
  ...CODE_INTELLIGENCE_METHODS,
  ...SYSTEM_METHODS,
  ...FEATURE_FLAG_METHODS,
];

function schemaFor(name: string): MethodSchema {
  const found = ALL_METHODS.find((m) => m.name === name);
  if (!found) throw new Error(`no MethodSchema for sandbox method "${name}"`);
  return found;
}

// ---------------------------------------------------------------------------
// Representative full-shape fixtures (same shape as real client return types)
// ---------------------------------------------------------------------------

const SEARCH_PAGE = {
  query: 'handleCrash',
  searchType: 'refs',
  totalCount: 3,
  timeMs: 12,
  results: [
    {
      project: 'myproject',
      path: 'src/crash.cpp',
      matches: [
        { lineNumber: 10, lineContent: 'void handleCrash() {}' },
        { lineNumber: 42, lineContent: '  handleCrash();' },
      ],
    },
    {
      project: 'myproject',
      path: 'src/main.cpp',
      matches: [{ lineNumber: 7, lineContent: 'handleCrash();' }],
    },
  ],
  startIndex: 0,
  endIndex: 1,
};

const FILE_CONTENT = {
  project: 'myproject',
  path: 'src/crash.cpp',
  content: 'void handleCrash() {}\n',
  lineCount: 1,
  sizeBytes: 22,
  startLine: 10,
};

const SYMBOLS = {
  project: 'myproject',
  path: 'src/crash.cpp',
  symbols: [
    { symbol: 'handleCrash', type: 'function', signature: 'void handleCrash()', line: 10, lineStart: 10, lineEnd: 12, namespace: null },
    { symbol: 'kLimit', type: 'variable', signature: null, line: 3, lineStart: 3, lineEnd: 3, namespace: null },
  ],
};

const HISTORY = {
  project: 'myproject',
  path: 'src/crash.cpp',
  entries: [
    { revision: 'aaa111', date: '2026-01-01', author: 'dev', message: 'fix crash' },
    { revision: 'bbb222', date: '2026-01-02', author: 'dev', message: 'tweak' },
    { revision: 'ccc333', date: '2026-01-03', author: 'dev', message: 'docs' },
  ],
};

const ANNOTATE = {
  project: 'myproject',
  path: 'src/crash.cpp',
  lines: [
    { lineNumber: 1, revision: 'aaa111', author: 'dev', date: '2026-01-01', content: 'void handleCrash() {}' },
  ],
};

const DIR_ENTRIES = [
  { name: 'crash.cpp', isDirectory: false, path: 'src/crash.cpp', size: 22, lastModified: '2026-01-01' },
  { name: 'util', isDirectory: true, path: 'src/util' },
];

const DIFF = {
  project: 'myproject',
  path: 'src/crash.cpp',
  rev1: 'aaa111',
  rev2: 'bbb222',
  hunks: [
    {
      oldStart: 10, oldCount: 3, newStart: 10, newCount: 4,
      lines: [
        { type: 'context', oldLineNumber: 10, newLineNumber: 10, content: 'void handleCrash() {' },
        { type: 'added', newLineNumber: 11, content: '  log();' },
        { type: 'removed', oldLineNumber: 11, content: '  run();' },
      ],
    },
    {
      oldStart: 40, oldCount: 1, newStart: 41, newCount: 1,
      lines: [{ type: 'context', oldLineNumber: 40, newLineNumber: 41, content: '}' }],
    },
  ],
  unifiedDiff: '@@ -10,3 +10,4 @@\n',
  stats: { added: 1, removed: 1 },
};

function makeContractClient(): OpenGrokClient {
  return {
    search: vi.fn().mockResolvedValue(structuredClone(SEARCH_PAGE)),
    getFileContent: vi.fn().mockResolvedValue({ ...FILE_CONTENT }),
    getFileHistory: vi.fn().mockResolvedValue(structuredClone(HISTORY)),
    getAnnotate: vi.fn().mockResolvedValue(structuredClone(ANNOTATE)),
    getFileSymbols: vi.fn().mockResolvedValue(structuredClone(SYMBOLS)),
    browseDirectory: vi.fn().mockResolvedValue(structuredClone(DIR_ENTRIES)),
    getFileDiff: vi.fn().mockResolvedValue(structuredClone(DIFF)),
    suggest: vi.fn().mockResolvedValue({ suggestions: ['handleCrash', 'handleCrashAsync'], time: 4, partialResult: false }),
    testConnection: vi.fn().mockResolvedValue(true),
    getBaseUrl: vi.fn().mockReturnValue('https://og.example.com/source/'),
    getAllMatchesInFile: vi.fn().mockResolvedValue([{ lineNumber: 10, lineContent: 'void handleCrash() {}' }]),
    listProjects: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
  } as unknown as OpenGrokClient;
}

function makeContractMemoryBank(): MemoryBank {
  return {
    read: vi.fn().mockResolvedValue('task content'),
    write: vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn(),
    getStatusLine: vi.fn().mockResolvedValue(''),
    getFileReference: vi.fn().mockResolvedValue(undefined),
  } as unknown as MemoryBank;
}

// ---------------------------------------------------------------------------
// Contract: every bridge method output parses against its `returns` schema
// ---------------------------------------------------------------------------

describe('sandbox-spec contract — bridge outputs match `returns` schemas', () => {
  it('search() full SearchResults parse', async () => {
    const api = createSandboxAPI(makeContractClient(), makeContractMemoryBank());
    const out = await api.search('handleCrash', { searchType: 'refs', maxResults: 5 });
    expect(() => schemaFor('search').returns.parse(out)).not.toThrow();
    const parsed = schemaFor('search').returns.parse(out) as { cursor?: string };
    expect(typeof parsed.cursor).toBe('string'); // endIndex(1) < totalCount(3)
  });

  it('batchSearch() fulfilled + error shapes parse', async () => {
    const client = makeContractClient();
    (client.search as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(structuredClone(SEARCH_PAGE));
    const api = createSandboxAPI(client, makeContractMemoryBank());
    const out = (await api.batchSearch([
      { query: 'bad query (' },
      { query: 'handleCrash', searchType: 'refs' },
    ])) as unknown[];
    expect(out).toHaveLength(2);
    expect(() => schemaFor('batchSearch').returns.parse(out)).not.toThrow();
    expect((out[0] as Record<string, unknown>)._error).toBe('boom');
  });

  it('findFile() full result with matches parses', async () => {
    const api = createSandboxAPI(makeContractClient(), makeContractMemoryBank());
    const out = await api.findFile('crash.cpp', {});
    expect(() => schemaFor('findFile').returns.parse(out)).not.toThrow();
  });

  it('searchSuggest() {query, field, suggestions, time} parses', async () => {
    const api = createSandboxAPI(makeContractClient(), makeContractMemoryBank());
    const out = await api.searchSuggest('handleCr', { field: 'defs' });
    expect(() => schemaFor('searchSuggest').returns.parse(out)).not.toThrow();
  });

  it('getFileContent() {project,path,content,lineCount,sizeBytes,startLine} parses', async () => {
    const api = createSandboxAPI(makeContractClient(), makeContractMemoryBank());
    const out = await api.getFileContent('myproject', 'src/crash.cpp', { startLine: 10, endLine: 10 });
    expect(() => schemaFor('getFileContent').returns.parse(out)).not.toThrow();
  });

  it('browseDir() {project,path,entries} + paged {cursor,total} parse', async () => {
    const api = createSandboxAPI(makeContractClient(), makeContractMemoryBank());
    const plain = await api.browseDir('myproject', 'src');
    expect(() => schemaFor('browseDir').returns.parse(plain)).not.toThrow();
    const paged = await api.browseDir('myproject', 'src', { limit: 1 });
    expect(() => schemaFor('browseDir').returns.parse(paged)).not.toThrow();
    expect((paged as Record<string, unknown>).total).toBe(2);
    expect(typeof (paged as Record<string, unknown>).cursor).toBe('string');
  });

  it('getFileSymbols() {project,path,symbols} + paged {cursor,total} parse', async () => {
    const api = createSandboxAPI(makeContractClient(), makeContractMemoryBank());
    const plain = await api.getFileSymbols('myproject', 'src/crash.cpp');
    expect(() => schemaFor('getFileSymbols').returns.parse(plain)).not.toThrow();
    const paged = await api.getFileSymbols('myproject', 'src/crash.cpp', { limit: 1 });
    expect(() => schemaFor('getFileSymbols').returns.parse(paged)).not.toThrow();
    expect((paged as Record<string, unknown>).total).toBe(2);
  });

  it('getFileOverview() full FileOverviewAPIResult parses', async () => {
    const api = createSandboxAPI(makeContractClient(), makeContractMemoryBank());
    // Unsupported tree-sitter lang keeps the overview on the regex/OpenGrok path.
    const out = await api.getFileOverview('myproject', 'notes.zzz');
    const parsed = schemaFor('getFileOverview').returns.parse(out) as Record<string, unknown>;
    expect(parsed.project).toBe('myproject');
    expect(Array.isArray(parsed.topLevelSymbols)).toBe(true);
    expect(typeof parsed.sizeBytes).toBe('number');
  });

  it('getFileAnnotate() {project,path,lines[]} parses', async () => {
    const api = createSandboxAPI(makeContractClient(), makeContractMemoryBank());
    const out = await api.getFileAnnotate('myproject', 'src/crash.cpp');
    expect(() => schemaFor('getFileAnnotate').returns.parse(out)).not.toThrow();
  });

  it('getFileHistory() entries + cursor parse', async () => {
    const api = createSandboxAPI(makeContractClient(), makeContractMemoryBank());
    const out = await api.getFileHistory('myproject', 'src/crash.cpp', { maxEntries: 2 });
    expect(() => schemaFor('getFileHistory').returns.parse(out)).not.toThrow();
    expect(typeof (out as Record<string, unknown>).cursor).toBe('string');
  });

  it('getFileDiff() full diff + paged hunks parse', async () => {
    const api = createSandboxAPI(makeContractClient(), makeContractMemoryBank());
    const plain = await api.getFileDiff('myproject', 'src/crash.cpp', 'aaa111', 'bbb222');
    expect(() => schemaFor('getFileDiff').returns.parse(plain)).not.toThrow();
    const paged = await api.getFileDiff('myproject', 'src/crash.cpp', 'aaa111', 'bbb222', { limit: 1 });
    expect(() => schemaFor('getFileDiff').returns.parse(paged)).not.toThrow();
    expect((paged as Record<string, unknown>).total).toBe(2);
  });

  it('getSymbolContext() found + not-found shapes parse', async () => {
    const client = makeContractClient();
    (client.search as ReturnType<typeof vi.fn>).mockImplementation((q: string, type: string) => {
      if (type === 'defs') {
        return Promise.resolve({
          query: q, searchType: 'defs', totalCount: 1, timeMs: 1,
          results: [{ project: 'myproject', path: 'src/crash.cpp', matches: [{ lineNumber: 10, lineContent: 'void handleCrash() {}' }] }],
          startIndex: 0, endIndex: 1,
        });
      }
      return Promise.resolve({
        query: q, searchType: 'refs', totalCount: 1, timeMs: 1,
        results: [{ project: 'myproject', path: 'src/main.cpp', matches: [{ lineNumber: 7, lineContent: 'handleCrash();' }] }],
        startIndex: 0, endIndex: 1,
      });
    });
    const api = createSandboxAPI(client, makeContractMemoryBank());
    const found = await api.getSymbolContext('handleCrash', {});
    expect(() => schemaFor('getSymbolContext').returns.parse(found)).not.toThrow();

    const emptyClient = makeContractClient();
    (emptyClient.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: 'nope', searchType: 'defs', totalCount: 0, timeMs: 1, results: [], startIndex: 0, endIndex: 0,
    });
    const api2 = createSandboxAPI(emptyClient, makeContractMemoryBank());
    const notFound = await api2.getSymbolContext('nope', {});
    expect(() => schemaFor('getSymbolContext').returns.parse(notFound)).not.toThrow();
  });

  it('traceCallChain() shape parses', async () => {
    const client = makeContractClient();
    (client.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: 'missing', searchType: 'refs', totalCount: 0, timeMs: 1, results: [], startIndex: 0, endIndex: 0,
    });
    const api = createSandboxAPI(client, makeContractMemoryBank());
    const out = await api.traceCallChain('missing', { direction: 'callers', depth: 1 });
    expect(() => schemaFor('traceCallChain').returns.parse(out)).not.toThrow();
  });

  it('indexHealth() {connected,latencyMs,baseUrl} parses', async () => {
    const api = createSandboxAPI(makeContractClient(), makeContractMemoryBank());
    const out = await api.indexHealth();
    expect(() => schemaFor('indexHealth').returns.parse(out)).not.toThrow();
  });

  it('getCompileInfo() raw-or-null parses (value and null)', async () => {
    const raw = { file: 'x.cpp', compiler: 'g++', includes: [], defines: [], extraFlags: [] };
    const api = createSandboxAPI(makeContractClient(), makeContractMemoryBank(), {
      getCompileInfoFn: async () => raw,
    });
    const valued = await api.getCompileInfo('x.cpp');
    expect(() => schemaFor('getCompileInfo').returns.parse(valued)).not.toThrow();
    const apiNull = createSandboxAPI(makeContractClient(), makeContractMemoryBank());
    const nulled = await apiNull.getCompileInfo('x.cpp');
    expect(() => schemaFor('getCompileInfo').returns.parse(nulled)).not.toThrow();
  });

  it('readMemory()/writeMemory()/elicit()/sample() parse', async () => {
    const api = createSandboxAPI(makeContractClient(), makeContractMemoryBank());
    const read = await api.readMemory('active-task.md');
    expect(() => schemaFor('readMemory').returns.parse(read)).not.toThrow();
    const written = await api.writeMemory('active-task.md', 'x');
    expect(() => schemaFor('writeMemory').returns.parse(written)).not.toThrow();
    const elicited = await api.elicit('q?', { type: 'object', properties: {} });
    expect(() => schemaFor('elicit').returns.parse(elicited)).not.toThrow();
    const sampled = await api.sample('hi');
    expect(() => schemaFor('sample').returns.parse(sampled)).not.toThrow();
  });

  it('every SandboxAPI method has a MethodSchema', () => {
    const api = createSandboxAPI(makeContractClient(), makeContractMemoryBank());
    const bridgeMethods = Object.keys(api).filter((k) => k !== 'constructor');
    expect(bridgeMethods.length).toBeGreaterThan(0);
    for (const name of bridgeMethods) {
      expect(ALL_METHODS.some((m) => m.name === name), `missing schema for ${name}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// P0-2: cursor round-trip + expired handling for newly-paged methods
// ---------------------------------------------------------------------------

describe('sandbox cursor paging — symbols/browse/diff', () => {
  it('getFileSymbols round-trips pages and rejects foreign cursors', async () => {
    const api = createSandboxAPI(makeContractClient(), makeContractMemoryBank());
    const page1 = await api.getFileSymbols('myproject', 'src/crash.cpp', { limit: 1 }) as Record<string, unknown>;
    expect((page1.symbols as unknown[])).toHaveLength(1);
    const page2 = await api.getFileSymbols('myproject', 'src/crash.cpp', { limit: 1, cursor: page1.cursor as string }) as Record<string, unknown>;
    expect((page2.symbols as unknown[])).toHaveLength(1);
    expect(page2.cursor).toBeUndefined(); // last page
    // Cross-method cursor → expired sentinel
    const searchOut = await api.search('handleCrash', {}) as Record<string, unknown>;
    const expired = await api.getFileSymbols('myproject', 'src/crash.cpp', { cursor: searchOut.cursor as string }) as Record<string, unknown>;
    expect(expired._cursorExpired).toBe(true);
    const garbage = await api.getFileSymbols('myproject', 'src/crash.cpp', { cursor: 'not-a-cursor' }) as Record<string, unknown>;
    expect(garbage._cursorExpired).toBe(true);
  });

  it('browseDir round-trips pages and rejects foreign cursors', async () => {
    const api = createSandboxAPI(makeContractClient(), makeContractMemoryBank());
    const page1 = await api.browseDir('myproject', 'src', { limit: 1 }) as Record<string, unknown>;
    expect((page1.entries as unknown[])).toHaveLength(1);
    const page2 = await api.browseDir('myproject', 'src', { limit: 1, cursor: page1.cursor as string }) as Record<string, unknown>;
    expect((page2.entries as unknown[])).toHaveLength(1);
    expect(page2.cursor).toBeUndefined();
    const expired = await api.browseDir('myproject', 'src', { cursor: 'not-a-cursor' }) as Record<string, unknown>;
    expect(expired._cursorExpired).toBe(true);
  });

  it('getFileDiff round-trips hunk pages and rejects foreign cursors', async () => {
    const api = createSandboxAPI(makeContractClient(), makeContractMemoryBank());
    const page1 = await api.getFileDiff('myproject', 'src/crash.cpp', 'aaa111', 'bbb222', { limit: 1 }) as Record<string, unknown>;
    expect((page1.hunks as unknown[])).toHaveLength(1);
    expect(typeof page1.cursor).toBe('string');
    const page2 = await api.getFileDiff('myproject', 'src/crash.cpp', 'aaa111', 'bbb222', { limit: 1, cursor: page1.cursor as string }) as Record<string, unknown>;
    expect((page2.hunks as unknown[])).toHaveLength(1);
    expect(page2.cursor).toBeUndefined();
    const expired = await api.getFileDiff('myproject', 'src/crash.cpp', 'aaa111', 'bbb222', { cursor: 'bogus' }) as Record<string, unknown>;
    expect(expired._cursorExpired).toBe(true);
  });
});
