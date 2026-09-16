import { describe, it, expect } from 'vitest';
import {
  formatSearchResults,
  formatFileContent,
  formatFileHistory,
  formatDirectoryListing,
  formatProjectsList,
  formatAnnotate,
  formatBatchSearchResults,
  formatBatchSearchResultsTSV,
  formatSearchResultsTOON,
  formatBatchSearchResultsTOON,
  formatSearchAndRead,
  formatSymbolContext,
  formatFileSymbols,
  formatFileDiff,
} from '../server/formatters/index.js';
import type { SearchAndReadEntry, SymbolContextResult } from '../server/formatters/index.js';
import type { FileDiff } from '../server/models.js';
import type {
  SearchResults,
  FileContent,
  FileHistory,
  DirectoryEntry,
  Project,
  AnnotatedFile,
  FileSymbols,
} from '../server/models.js';

// ---------------------------------------------------------------------------
// formatSearchResults
// ---------------------------------------------------------------------------

describe('formatSearchResults', () => {
  const mockResults: SearchResults = {
    query: 'WeatherStation',
    searchType: 'full',
    totalCount: 2,
    timeMs: 42,
    results: [
      {
        project: 'release-2.x',
        path: '/path/to/file.cpp',
        matches: [
          { lineNumber: 10, lineContent: 'void WeatherStation() {' },
          { lineNumber: 15, lineContent: '  // end' },
        ],
      },
    ],
    startIndex: 0,
    endIndex: 1,
  };

  it('includes the query in the header', () => {
    const output = formatSearchResults(mockResults);
    expect(output).toContain('WeatherStation');
  });

  it('includes project and path', () => {
    const output = formatSearchResults(mockResults);
    expect(output).toContain('release-2.x');
    expect(output).toContain('/path/to/file.cpp');
  });

  it('emits compact one-line-per-match format', () => {
    const output = formatSearchResults(mockResults);
    // Compact format: path (project) Lline: content — no OpenGrok links
    expect(output).toContain('/path/to/file.cpp (release-2.x) L10:');
    expect(output).not.toContain('View in OpenGrok');
  });

  it('strips HTML tags from line content', () => {
    const results: SearchResults = {
      ...mockResults,
      results: [{
        ...mockResults.results[0],
        matches: [{ lineNumber: 1, lineContent: '<b>bold</b> text' }],
      }],
    };
    const output = formatSearchResults(results);
    expect(output).not.toContain('<b>');
    expect(output).toContain('bold text');
  });

  it('decodes HTML entities (&lt; &gt; &amp; &quot; &#39;) in line content', () => {
    const results: SearchResults = {
      ...mockResults,
      results: [{
        ...mockResults.results[0],
        matches: [{ lineNumber: 1, lineContent: 'if (a &lt; b &amp;&amp; c &gt; d) return &quot;ok&#39;s&quot;;' }],
      }],
    };
    const output = formatSearchResults(results);
    expect(output).toContain('if (a < b && c > d)');
    expect(output).toContain('"ok\'s"');
  });

  it('returns no results message when results is empty', () => {
    const empty: SearchResults = { ...mockResults, results: [], totalCount: 0 };
    const output = formatSearchResults(empty);
    expect(output).toContain('No results found');
  });

  it('shows pagination note when has_more', () => {
    const paged: SearchResults = { ...mockResults, totalCount: 100, endIndex: 1 };
    const output = formatSearchResults(paged);
    expect(output).toContain('of 100 results');
  });

  it('shows search header with timing', () => {
    const output = formatSearchResults(mockResults);
    expect(output).toContain('42ms');
    expect(output).toMatch(/2.* matches/);
  });
});

// ---------------------------------------------------------------------------
// formatFileContent
// ---------------------------------------------------------------------------

describe('formatFileContent', () => {
  const mockContent: FileContent = {
    project: 'release-2.x',
    path: 'path/to/file.cpp',
    content: 'line1\nline2\nline3',
    lineCount: 3,
    sizeBytes: 17,
  };

  it('includes filename in header', () => {
    const output = formatFileContent(mockContent);
    expect(output).toContain('file.cpp');
  });

  it('includes project and size info', () => {
    const output = formatFileContent(mockContent);
    expect(output).toContain('release-2.x');
    expect(output).toContain('17');
  });

  it('uses cpp syntax highlighting for .cpp files', () => {
    const output = formatFileContent(mockContent);
    expect(output).toContain('```cpp');
  });

  it('includes line numbers when showLineNumbers=true', () => {
    const output = formatFileContent(mockContent, true);
    expect(output).toContain('1 | line1');
    expect(output).toContain('2 | line2');
  });
});

// ---------------------------------------------------------------------------
// formatFileHistory
// ---------------------------------------------------------------------------

describe('formatFileHistory', () => {
  const mockHistory: FileHistory = {
    project: 'release-2.x',
    path: 'path/to/file.cpp',
    entries: [
      {
        revision: 'abc12345678',
        date: '2024-01-15',
        author: 'john.doe <john@example.com>',
        message: 'Fix memory leak',
        updateForm: '58321',
      },
    ],
  };

  it('shows revision (truncated to 8 chars)', () => {
    const output = formatFileHistory(mockHistory);
    expect(output).toContain('abc12345');
    expect(output).not.toContain('abc123456789'); // not full
  });

  it('strips email from author', () => {
    const output = formatFileHistory(mockHistory);
    expect(output).toContain('john.doe');
    expect(output).not.toContain('john@example.com');
  });

  it('returns no history message for empty entries', () => {
    const empty: FileHistory = { ...mockHistory, entries: [] };
    const output = formatFileHistory(empty);
    expect(output).toContain('No history entries');
  });
});

// ---------------------------------------------------------------------------
// formatDirectoryListing
// ---------------------------------------------------------------------------

describe('formatDirectoryListing', () => {
  const entries: DirectoryEntry[] = [
    { name: 'pandora', isDirectory: true, path: 'pandora' },
    { name: 'README.md', isDirectory: false, path: 'README.md', size: 1024 },
  ];

  it('shows directories first', () => {
    const output = formatDirectoryListing(entries, 'release-2.x', '');
    const dirIdx = output.indexOf('pandora');
    const fileIdx = output.indexOf('README.md');
    expect(dirIdx).toBeLessThan(fileIdx);
  });

  it('shows DIR and FILE prefixes (no emoji)', () => {
    const output = formatDirectoryListing(entries, 'release-2.x', '');
    expect(output).toContain('DIR  pandora/');
    expect(output).toContain('FILE README.md');
    expect(output).not.toContain('📁');
    expect(output).not.toContain('📄');
  });

  it('shows file size in bytes', () => {
    const output = formatDirectoryListing(entries, 'release-2.x', '');
    // toLocaleString formats 1024 as '1,024' on most locales
    expect(output).toMatch(/1[,.]?024/);
    expect(output).toContain('bytes');
  });
});

// ---------------------------------------------------------------------------
// formatProjectsList
// ---------------------------------------------------------------------------

describe('formatProjectsList', () => {
  const projects: Project[] = [
    { name: 'release-2.x', category: 'Main' },
    { name: 'release-2.x-win', category: 'Main' },
    { name: 'v1.8-stable', category: 'Legacy' },
  ];

  it('groups by category', () => {
    const output = formatProjectsList(projects);
    expect(output).toContain('### Main');
    expect(output).toContain('### Legacy');
  });

  it('shows total count', () => {
    const output = formatProjectsList(projects);
    expect(output).toContain('3 projects');
  });
});

// ---------------------------------------------------------------------------
// formatAnnotate
// ---------------------------------------------------------------------------

describe('formatAnnotate', () => {
  const annotated: AnnotatedFile = {
    project: 'release-2.x',
    path: 'path/to/file.cpp',
    lines: [
      { lineNumber: 1, revision: 'abc1234', author: 'john', date: '2024-01-01', content: 'int x = 0;' },
      { lineNumber: 2, revision: 'def5678', author: 'jane', date: '2024-01-02', content: 'return x;' },
    ],
  };

  it('shows revision and author', () => {
    const output = formatAnnotate(annotated);
    expect(output).toContain('abc1234');
    expect(output).toContain('john');
  });

  it('truncates at 50 lines by default and shows remaining count', () => {
    const manyLines: AnnotatedFile = {
      ...annotated,
      lines: Array.from({ length: 150 }, (_, i) => ({
        lineNumber: i + 1,
        revision: 'aaa',
        author: 'x',
        date: '',
        content: `line ${i + 1}`,
      })),
    };
    const output = formatAnnotate(manyLines);
    expect(output).toContain('Showing first 50 of 150 lines');
  });

  it('respects startLine/endLine range', () => {
    const manyLines: AnnotatedFile = {
      ...annotated,
      lines: Array.from({ length: 100 }, (_, i) => ({
        lineNumber: i + 1,
        revision: 'rev' + i,
        author: 'author' + i,
        date: '',
        content: `line ${i + 1}`,
      })),
    };
    const output = formatAnnotate(manyLines, 10, 20);
    // Should contain L10 but not L1 or L21
    expect(output).toContain('L10:');
    expect(output).not.toContain('L1:');
    expect(output).not.toContain('L21:');
  });
});

// ---------------------------------------------------------------------------
// formatBatchSearchResults
// ---------------------------------------------------------------------------

describe('formatBatchSearchResults', () => {
  const mockSearchResults = {
    query: 'WeatherStation',
    searchType: 'defs',
    results: {
      query: 'WeatherStation',
      searchType: 'defs',
      totalCount: 1,
      timeMs: 10,
      startIndex: 0,
      endIndex: 1,
      results: [
        {
          project: 'release-2.x',
          path: '/src/backup.cpp',
          matches: [{ lineNumber: 5, lineContent: 'void WeatherStation() {' }],
        },
      ],
    },
  };

  it('shows batch header with query count', () => {
    const output = formatBatchSearchResults([mockSearchResults]);
    expect(output.toLowerCase()).toContain('batch');
    expect(output).toContain('WeatherStation');
  });

  it('includes matched paths', () => {
    const output = formatBatchSearchResults([mockSearchResults]);
    expect(output).toContain('/src/backup.cpp');
  });

  it('handles empty batch', () => {
    const output = formatBatchSearchResults([]);
    expect(output).toContain('0');
  });
});

// ---------------------------------------------------------------------------
// formatBatchSearchResultsTSV
// ---------------------------------------------------------------------------

describe('formatBatchSearchResultsTSV', () => {
  const mockSearchResults = {
    query: 'EventLoop',
    searchType: 'defs',
    results: {
      query: 'EventLoop',
      searchType: 'defs',
      totalCount: 2,
      timeMs: 10,
      startIndex: 0,
      endIndex: 2,
      results: [
        {
          project: 'myproject',
          path: 'src/EventLoop.cpp',
          matches: [{ lineNumber: 45, lineContent: 'class EventLoop {' }],
        },
        {
          project: 'myproject',
          path: 'src/EventLoop.h',
          matches: [{ lineNumber: 12, lineContent: 'class EventLoop;' }],
        },
      ],
    },
  };

  it('produces TSV header with correct columns', () => {
    const output = formatBatchSearchResultsTSV([mockSearchResults]);
    const lines = output.split('\n');
    expect(lines[1]).toBe('query\tsearch_type\tpath\tproject\tline\tcontent');
  });

  it('includes comment line with batch summary', () => {
    const output = formatBatchSearchResultsTSV([mockSearchResults]);
    const lines = output.split('\n');
    expect(lines[0]).toMatch(/^# Batch: 1 queries, 2 total matches$/);
  });

  it('produces tab-separated data rows', () => {
    const output = formatBatchSearchResultsTSV([mockSearchResults]);
    const lines = output.split('\n');
    // Check first data row (should be EventLoop.cpp)
    const dataRow = lines[2];
    const cols = dataRow.split('\t');
    expect(cols.length).toBe(6);
    expect(cols[0]).toBe('EventLoop');
    expect(cols[1]).toBe('defs');
    expect(cols[2]).toBe('src/EventLoop.cpp');
    expect(cols[3]).toBe('myproject');
    expect(cols[4]).toBe('45');
    expect(cols[5]).toContain('EventLoop');
  });

  it('replaces tabs in content with spaces', () => {
    const results = {
      query: 'test',
      searchType: 'full',
      results: {
        query: 'test',
        searchType: 'full',
        totalCount: 1,
        timeMs: 5,
        startIndex: 0,
        endIndex: 1,
        results: [{
          project: 'p',
          path: 'a.cpp',
          matches: [{ lineNumber: 1, lineContent: 'foo\tbar\tbaz' }],
        }],
      },
    };
    const output = formatBatchSearchResultsTSV([results]);
    const lines = output.split('\n');
    const dataRow = lines.find(l => l.startsWith('test\tfull\ta.cpp'));
    expect(dataRow).toBeDefined();
    // Should have exactly 5 tabs (6 columns)
    expect((dataRow!.match(/\t/g) ?? []).length).toBe(5);
    expect(dataRow).toContain('foo  bar  baz');
  });

  it('handles empty results with (no results) row', () => {
    const results = {
      query: 'NotFound',
      searchType: 'defs',
      results: {
        query: 'NotFound',
        searchType: 'defs',
        totalCount: 0,
        timeMs: 5,
        startIndex: 0,
        endIndex: 0,
        results: [],
      },
    };
    const output = formatBatchSearchResultsTSV([results]);
    expect(output).toContain('NotFound\tdefs\t(no results)\t\t\t');
  });

  it('handles multiple queries', () => {
    const result1 = {
      query: 'EventLoop',
      searchType: 'defs',
      results: {
        query: 'EventLoop',
        searchType: 'defs',
        totalCount: 1,
        timeMs: 10,
        startIndex: 0,
        endIndex: 1,
        results: [{
          project: 'p1',
          path: 'src/EventLoop.h',
          matches: [{ lineNumber: 12, lineContent: 'class EventLoop;' }],
        }],
      },
    };
    const result2 = {
      query: 'Timer',
      searchType: 'refs',
      results: {
        query: 'Timer',
        searchType: 'refs',
        totalCount: 2,
        timeMs: 15,
        startIndex: 0,
        endIndex: 2,
        results: [{
          project: 'p2',
          path: 'src/timer.cpp',
          matches: [
            { lineNumber: 20, lineContent: 'Timer t;' },
            { lineNumber: 25, lineContent: 't.start();' },
          ],
        }],
      },
    };

    const output = formatBatchSearchResultsTSV([result1, result2]);
    const lines = output.split('\n');
    expect(lines[0]).toMatch(/# Batch: 2 queries, 3 total matches/);
    expect(output).toContain('EventLoop\tdefs');
    expect(output).toContain('Timer\trefs');
  });

  it('does not contain markdown code fences', () => {
    const output = formatBatchSearchResultsTSV([mockSearchResults]);
    expect(output).not.toContain('```');
  });
});

// ---------------------------------------------------------------------------
// formatSearchAndRead
// ---------------------------------------------------------------------------

describe('formatSearchAndRead', () => {
  const entry: SearchAndReadEntry = {
    project: 'release-2.x',
    path: '/src/backup.cpp',
    matchLine: 10,
    context: 'void WeatherStation() {\n  return;\n}',
    lang: 'cpp',
  };

  it('shows query and total count', () => {
    const output = formatSearchAndRead('WeatherStation', 5, [entry]);
    expect(output).toContain('WeatherStation');
    expect(output).toContain('5');
  });

  it('includes file path and match line', () => {
    const output = formatSearchAndRead('WeatherStation', 5, [entry]);
    expect(output).toContain('/src/backup.cpp');
    expect(output).toContain('L10');
  });

  it('includes code context with language fence', () => {
    const output = formatSearchAndRead('WeatherStation', 5, [entry]);
    expect(output).toContain('```cpp');
    expect(output).toContain('void WeatherStation()');
  });

  it('handles empty entries', () => {
    const output = formatSearchAndRead('missing', 0, []);
    expect(output).toContain('0');
  });
});

// ---------------------------------------------------------------------------
// formatSymbolContext
// ---------------------------------------------------------------------------

describe('formatSymbolContext', () => {
  const notFoundResult: SymbolContextResult = {
    found: false,
    symbol: 'MissingClass',
    kind: 'unknown',
    references: { totalFound: 0, samples: [] },
  };

  it('reports not-found gracefully', () => {
    const output = formatSymbolContext(notFoundResult);
    expect(output).toContain('MissingClass');
    expect(output).toContain('not found');
  });

  const foundResult: SymbolContextResult = {
    found: true,
    symbol: 'WeatherStation',
    kind: 'function/method',
    definition: {
      project: 'release-2.x',
      path: '/src/backup.cpp',
      line: 10,
      context: 'void WeatherStation() { return; }',
      lang: 'cpp',
    },
    references: {
      totalFound: 3,
      samples: [
        { path: '/src/main.cpp', project: 'release-2.x', lineNumber: 42, content: 'WeatherStation();' },
      ],
    },
  };

  it('shows symbol name and kind', () => {
    const output = formatSymbolContext(foundResult);
    expect(output).toContain('WeatherStation');
    expect(output).toContain('function/method');
  });

  it('shows definition file and line', () => {
    const output = formatSymbolContext(foundResult);
    expect(output).toContain('/src/backup.cpp');
    expect(output).toContain('L10');
  });

  it('shows reference count', () => {
    const output = formatSymbolContext(foundResult);
    expect(output).toContain('3');
  });

  it('shows reference sample path', () => {
    const output = formatSymbolContext(foundResult);
    expect(output).toContain('/src/main.cpp');
    expect(output).toContain('L42');
  });

  it('omits header section when not provided', () => {
    const output = formatSymbolContext(foundResult);
    // No header property in foundResult, so no "Header:" section
    expect(output).not.toContain('Header:');
  });

  it('shows header section when provided', () => {
    const withHeader: SymbolContextResult = {
      ...foundResult,
      header: {
        project: 'release-2.x',
        path: '/src/backup.h',
        context: 'void WeatherStation();',
        lang: 'cpp',
      },
    };
    const output = formatSymbolContext(withHeader);
    expect(output).toContain('/src/backup.h');
  });
});

// ---------------------------------------------------------------------------
// formatFileSymbols
// ---------------------------------------------------------------------------

describe('formatFileSymbols', () => {
  const mockSymbols: FileSymbols = {
    project: 'release-2.x',
    path: 'TextureAtlasLoader/TextureAtlasLoader.cpp',
    symbols: [
      { symbol: 'DL_OK', type: 'macro', signature: null, line: 12, lineStart: 12, lineEnd: 12, namespace: null },
      { symbol: 'AppgPrint', type: 'function', signature: '(void)', line: 45, lineStart: 45, lineEnd: 52, namespace: null },
      { symbol: 'statbuf', type: 'struct', signature: null, line: 35, lineStart: 35, lineEnd: 40, namespace: null },
      { symbol: 'TextureAtlasLoader', type: 'function', signature: '(int argc, char** argv)', line: 210, lineStart: 210, lineEnd: 280, namespace: null },
    ],
  };

  it('includes filename and project in header', () => {
    const output = formatFileSymbols(mockSymbols);
    expect(output).toContain('TextureAtlasLoader.cpp');
    expect(output).toContain('release-2.x');
  });

  it('includes total symbol count in header', () => {
    const output = formatFileSymbols(mockSymbols);
    expect(output).toContain('4 symbols');
  });

  it('groups symbols by type', () => {
    const output = formatFileSymbols(mockSymbols);
    expect(output).toContain('function (2):');
    expect(output).toContain('macro (1):');
    expect(output).toContain('struct (1):');
  });

  it('shows line numbers for each symbol', () => {
    const output = formatFileSymbols(mockSymbols);
    expect(output).toContain('L45');
    expect(output).toContain('L210');
    expect(output).toContain('L35');
    expect(output).toContain('L12');
  });

  it('shows signature for symbols that have one', () => {
    const output = formatFileSymbols(mockSymbols);
    expect(output).toContain('(int argc, char** argv)');
    expect(output).toContain('(void)');
  });

  it('returns no-symbols message for empty list', () => {
    const empty: FileSymbols = { project: 'release-2.x', path: 'empty.cpp', symbols: [] };
    const output = formatFileSymbols(empty);
    expect(output).toContain('0 symbols');
    expect(output).toContain('No symbols found.');
  });

  it('sorts symbols by line number within each type group', () => {
    const output = formatFileSymbols(mockSymbols);
    // AppgPrint (L45) should come before TextureAtlasLoader (L210) in the function group
    // Search for the indented symbol entries (not the filename in the header)
    const appgPos = output.indexOf('  AppgPrint');
    const mysqlPos = output.indexOf('  TextureAtlasLoader');
    expect(appgPos).toBeLessThan(mysqlPos);
  });

  it('truncates long signatures at 80 characters', () => {
    const longSig = 'a'.repeat(90);
    const withLong: FileSymbols = {
      project: 'release-2.x',
      path: 'foo.cpp',
      symbols: [{ symbol: 'longFn', type: 'function', signature: longSig, line: 1, lineStart: 1, lineEnd: 10, namespace: null }],
    };
    const output = formatFileSymbols(withLong);
    expect(output).toContain('...');
    // Signature should be truncated to 77 + '...' = 80 total
    expect(output).not.toContain(longSig);
  });
});

// ---------------------------------------------------------------------------
// formatFileDiff
// ---------------------------------------------------------------------------

describe('formatFileDiff', () => {
  const sampleDiff: FileDiff = {
    project: 'myproj',
    path: 'src/main.cpp',
    rev1: 'abc12345deadbeef',
    rev2: 'def67890cafebabe',
    hunks: [
      {
        oldStart: 5, oldCount: 4, newStart: 5, newCount: 4,
        lines: [
          { type: 'context', newLineNumber: 5, content: '#include "header.h"' },
          { type: 'removed', oldLineNumber: 6, content: '    int x = 0;' },
          { type: 'added', newLineNumber: 6, content: '    int x = 42;' },
          { type: 'context', newLineNumber: 7, content: '    return x;' },
        ],
      },
    ],
    unifiedDiff: '--- a/src/main.cpp\n+++ b/src/main.cpp\n@@ -5,4 +5,4 @@\n #include "header.h"\n-    int x = 0;\n+    int x = 42;\n     return x;',
    stats: { added: 1, removed: 1 },
  };

  it('wraps unified diff in markdown code fence', () => {
    const output = formatFileDiff(sampleDiff, 'markdown');
    expect(output).toContain('```diff');
    expect(output).toContain('-    int x = 0;');
    expect(output).toContain('+    int x = 42;');
  });

  it('includes header with path, short revs, and stats', () => {
    const output = formatFileDiff(sampleDiff, 'markdown');
    expect(output).toContain('`src/main.cpp`');
    expect(output).toContain('abc12345');
    expect(output).toContain('def67890');
    expect(output).toContain('+1 / -1 lines');
  });

  it('returns JSON with all fields', () => {
    const output = formatFileDiff(sampleDiff, 'json');
    const parsed = JSON.parse(output);
    expect(parsed.project).toBe('myproj');
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.stats.added).toBe(1);
    expect(parsed.stats.removed).toBe(1);
    expect(parsed.hunks[0].lines).toHaveLength(4);
  });

  it('returns TSV with type/oldLine/newLine/content columns', () => {
    const output = formatFileDiff(sampleDiff, 'tsv');
    const lines = output.split('\n');
    expect(lines[0]).toBe('type\toldLine\tnewLine\tcontent');
    expect(lines[1]).toContain('context');
    expect(lines[2]).toContain('removed');
    expect(lines[3]).toContain('added');
  });

  it('returns YAML with stats and unifiedDiff', () => {
    const output = formatFileDiff(sampleDiff, 'yaml');
    expect(output).toContain('project: myproj');
    expect(output).toContain('path: src/main.cpp');
    expect(output).toContain('added: 1');
    expect(output).toContain('removed: 1');
  });

  it('shows "No changes detected" for empty hunks in markdown', () => {
    const emptyDiff: FileDiff = {
      ...sampleDiff,
      hunks: [],
      unifiedDiff: '',
      stats: { added: 0, removed: 0 },
    };
    const output = formatFileDiff(emptyDiff, 'markdown');
    expect(output).toContain('No changes detected');
  });

  it('uses text format without code fences', () => {
    const output = formatFileDiff(sampleDiff, 'text');
    expect(output).not.toContain('```');
    expect(output).toContain('-    int x = 0;');
    expect(output).toContain('+    int x = 42;');
  });

  it('handles short revision hashes without error', () => {
    const shortRevDiff: FileDiff = {
      ...sampleDiff,
      rev1: 'abc',
      rev2: 'def',
    };
    const output = formatFileDiff(shortRevDiff, 'markdown');
    expect(output).toContain('abc');
    expect(output).toContain('def');
  });
});

// ---------------------------------------------------------------------------
// formatSearchResultsTOON
// ---------------------------------------------------------------------------

describe('formatSearchResultsTOON', () => {
  const mockResults = {
    query: 'EventLoop',
    searchType: 'defs',
    totalCount: 2,
    timeMs: 10,
    startIndex: 0,
    endIndex: 2,
    results: [
      {
        project: 'myproject',
        path: 'src/EventLoop.cpp',
        matches: [{ lineNumber: 45, lineContent: 'class EventLoop {' }],
      },
      {
        project: 'myproject',
        path: 'src/EventLoop.h',
        matches: [{ lineNumber: 12, lineContent: 'class EventLoop;' }],
      },
    ],
  };

  it('includes header with query and match count', () => {
    const output = formatSearchResultsTOON(mockResults);
    expect(output).toContain('Search: "EventLoop"');
    expect(output).toContain('2 matches');
  });

  it('includes file paths and content', () => {
    const output = formatSearchResultsTOON(mockResults);
    expect(output).toContain('EventLoop.cpp');
    expect(output).toContain('EventLoop.h');
    expect(output).toContain('class EventLoop');
  });

  it('returns no-results message for empty results', () => {
    const empty = { ...mockResults, results: [], totalCount: 0 };
    const output = formatSearchResultsTOON(empty);
    expect(output).toContain('No results found');
  });

  it('is significantly shorter than JSON for uniform data', () => {
    const jsonOutput = JSON.stringify(mockResults.results, null, 2);
    const toonOutput = formatSearchResultsTOON(mockResults);
    expect(toonOutput.length).toBeLessThan(jsonOutput.length);
  });
});

// ---------------------------------------------------------------------------
// formatBatchSearchResultsTOON
// ---------------------------------------------------------------------------

describe('formatBatchSearchResultsTOON', () => {
  const mockBatch = [
    {
      query: 'EventLoop',
      searchType: 'defs',
      results: {
        query: 'EventLoop',
        searchType: 'defs',
        totalCount: 1,
        timeMs: 5,
        startIndex: 0,
        endIndex: 1,
        results: [
          {
            project: 'myproject',
            path: 'src/EventLoop.cpp',
            matches: [{ lineNumber: 45, lineContent: 'class EventLoop {' }],
          },
        ],
      },
    },
    {
      query: 'Timer',
      searchType: 'full',
      results: {
        query: 'Timer',
        searchType: 'full',
        totalCount: 1,
        timeMs: 3,
        startIndex: 0,
        endIndex: 1,
        results: [
          {
            project: 'myproject',
            path: 'src/Timer.h',
            matches: [{ lineNumber: 10, lineContent: 'class Timer;' }],
          },
        ],
      },
    },
  ];

  it('includes batch header with query count', () => {
    const output = formatBatchSearchResultsTOON(mockBatch);
    expect(output).toContain('Batch: 2 queries');
    expect(output).toContain('2 total matches');
  });

  it('includes data from both queries', () => {
    const output = formatBatchSearchResultsTOON(mockBatch);
    expect(output).toContain('EventLoop');
    expect(output).toContain('Timer');
  });

  it('returns no-results message for empty batch', () => {
    const empty = [{ query: 'nothing', searchType: 'full', results: {
      query: 'nothing', searchType: 'full', totalCount: 0, timeMs: 1,
      startIndex: 0, endIndex: 0, results: [],
    }}];
    const output = formatBatchSearchResultsTOON(empty);
    expect(output).toContain('No results found');
  });
});
