import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildFileOverview, buildCallChain } from '../server/intelligence.js';
import type { OpenGrokClient } from '../server/client/index.js';

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

function makeClient(overrides: Partial<Record<string, (...args: any[]) => any>> = {}): OpenGrokClient {
  return {
    search: vi.fn().mockResolvedValue({
      query: '', searchType: 'refs', totalCount: 0, timeMs: 1,
      results: [], startIndex: 0, endIndex: 0, hasMore: false,
    }),
    getFileSymbols: vi.fn().mockResolvedValue({
      project: 'proj', path: 'file.cpp', symbols: [],
    }),
    getFileContent: vi.fn().mockResolvedValue({
      project: 'proj', path: 'file.cpp',
      content: '#include "EventLoop.h"\n#include <vector>\nvoid foo() {}',
      lineCount: 3, sizeBytes: 50, startLine: 1,
    }),
    getFileHistory: vi.fn().mockResolvedValue({
      project: 'proj', path: 'file.cpp',
      entries: [
        { revision: 'abcdef12', date: '2025-01-01', author: 'Alice <alice@example.com>', message: 'fix bug' },
        { revision: 'beef1234', date: '2025-01-02', author: 'Bob <bob@example.com>', message: 'refactor' },
      ],
    }),
    ...overrides,
  } as unknown as OpenGrokClient;
}

// ---------------------------------------------------------------------------
// buildFileOverview
// ---------------------------------------------------------------------------

describe('buildFileOverview', () => {
  it('returns correct lang for .cpp file', async () => {
    const client = makeClient();
    const result = await buildFileOverview(client, 'proj', 'src/EventLoop.cpp');
    expect(result.lang).toBe('cpp');
  });

  it('returns correct lang for .py file', async () => {
    const client = makeClient();
    const result = await buildFileOverview(client, 'proj', 'main.py');
    expect(result.lang).toBe('python');
  });

  it('extracts recentAuthors from history', async () => {
    const client = makeClient();
    const result = await buildFileOverview(client, 'proj', 'file.cpp');
    expect(result.recentAuthors).toContain('Alice');
    expect(result.recentAuthors).toContain('Bob');
  });

  it('returns sizeLines from file content', async () => {
    const client = makeClient();
    const result = await buildFileOverview(client, 'proj', 'file.cpp');
    expect(result.sizeLines).toBe(3);
  });

  it('extracts C++ imports from file header', async () => {
    const client = makeClient();
    const result = await buildFileOverview(client, 'proj', 'file.cpp');
    expect(result.imports).toContain('EventLoop.h');
    expect(result.imports).toContain('vector');
  });

  it('extracts JS/TS imports (non-C++ generic path) from file header', async () => {
    const client = makeClient({
      getFileContent: vi.fn().mockResolvedValue({
        project: 'proj', path: 'index.ts',
        content: "import { foo } from './foo';\nimport 'bar';\nconst x = require './baz';",
        lineCount: 3, sizeBytes: 70, startLine: 1,
      }),
    });
    const result = await buildFileOverview(client, 'proj', 'index.ts');
    expect(result.imports).toContain('./foo');
    expect(result.imports).toContain('bar');
  });

  it('makes parallel API calls (symbols + content + history)', async () => {
    const client = makeClient();
    await buildFileOverview(client, 'proj', 'file.cpp');
    // All three should have been called
    expect(client.getFileSymbols).toHaveBeenCalledWith('proj', 'file.cpp');
    expect(client.getFileContent).toHaveBeenCalledWith('proj', 'file.cpp', 1, 60);
    expect(client.getFileHistory).toHaveBeenCalledWith('proj', 'file.cpp', 3);
  });

  it('handles settled-failed symbol request gracefully', async () => {
    const client = makeClient({
      getFileSymbols: vi.fn().mockRejectedValue(new Error('symbols unavailable')),
    });
    const result = await buildFileOverview(client, 'proj', 'file.cpp');
    // Should still return a result without throwing.
    // With tree-sitter support for .cpp, symbols may be extracted from file content
    // (the mock content has `void foo() {}`), so topLevelSymbols may be non-empty.
    expect(Array.isArray(result.topLevelSymbols)).toBe(true);
    expect(result.recentAuthors.length).toBeGreaterThan(0); // history succeeded
  });

  it('handles settled-failed history request gracefully', async () => {
    const client = makeClient({
      getFileHistory: vi.fn().mockRejectedValue(new Error('history unavailable')),
    });
    const result = await buildFileOverview(client, 'proj', 'file.cpp');
    expect(result.recentAuthors).toEqual([]);
    expect(result.lastRevision).toBe('unknown');
  });

  it('includes topLevelSymbols from file symbols', async () => {
    // Provide content that actually contains EventLoop so tree-sitter can find it.
    // When tree-sitter returns results, they take precedence over OpenGrok symbols.
    const cppContent = [
      '#include "EventLoop.h"',
      'class EventLoop {',
      'public:',
      '  void run() {}',
      '};',
    ].join('\n');
    const client = makeClient({
      getFileSymbols: vi.fn().mockResolvedValue({
        project: 'proj', path: 'file.cpp',
        symbols: [
          { symbol: 'EventLoop', type: 'class', line: 10, lineStart: 10, lineEnd: 50, signature: null, namespace: null },
          { symbol: 'run', type: 'function', line: 20, lineStart: 20, lineEnd: 30, signature: '()', namespace: null },
        ],
      }),
      getFileContent: vi.fn().mockResolvedValue({
        project: 'proj', path: 'file.cpp',
        content: cppContent,
        lineCount: 5, sizeBytes: cppContent.length, startLine: 1,
      }),
    });
    const result = await buildFileOverview(client, 'proj', 'file.cpp');
    expect(result.topLevelSymbols.length).toBeGreaterThan(0);
    // Tree-sitter or OpenGrok should find EventLoop in this content
    expect(result.topLevelSymbols.some((s) => s.symbol.includes('EventLoop'))).toBe(true);
  });

  it('throws a contextual error when symbols, content, and history all fail', async () => {
    const client = makeClient({
      getFileSymbols: vi.fn().mockRejectedValue(new Error('no symbols')),
      getFileContent: vi.fn().mockRejectedValue(new Error('no content')),
      getFileHistory: vi.fn().mockRejectedValue(new Error('no history')),
    });
    await expect(buildFileOverview(client, 'proj', 'missing.cpp')).rejects.toThrow(
      /getFileOverview: project 'proj', path 'missing.cpp'/
    );
  });
});

// ---------------------------------------------------------------------------
// buildCallChain
// ---------------------------------------------------------------------------

describe('buildCallChain', () => {
  it('returns empty callers when no refs found', async () => {
    const client = makeClient();
    const result = await buildCallChain(client, 'UnknownFn', 'callers', 2);
    expect(result.callers).toEqual([]);
    expect(result.symbol).toBe('UnknownFn');
  });

  it('callers direction: makes a refs search', async () => {
    const client = makeClient();
    await buildCallChain(client, 'MyFn', 'callers', 1);
    expect(client.search).toHaveBeenCalledWith('MyFn', 'refs', undefined, 10, 0, undefined);
  });

  it('callees direction: returns callees via tree-sitter AST analysis', async () => {
    const cppSource = [
      '#include "app.h"',
      'int computeTotal(int a, int b) {',
      '  return a + b;',
      '}',
      'void processRequest() {',
      '  int total = computeTotal(1, 2);',
      '  logResult(total);',
      '}',
    ].join('\n');
    const defPath = '/src/app.cpp';
    const client = makeClient({
      search: vi.fn().mockImplementation((query: string, type: string) => {
        if (type === 'defs') {
          const lineNumber = query === 'processRequest' ? 5 : 2;
          return Promise.resolve({
            query, searchType: type, totalCount: 1, timeMs: 1,
            results: [{ project: 'proj', path: defPath, matches: [{ lineNumber, lineContent: `${query}()` }] }],
            startIndex: 0, endIndex: 1, hasMore: false,
          });
        }
        return Promise.resolve({
          query, searchType: type, totalCount: 0, timeMs: 1,
          results: [], startIndex: 0, endIndex: 0, hasMore: false,
        });
      }),
      getFileContent: vi.fn().mockResolvedValue({
        project: 'proj', path: defPath, content: cppSource,
        lineCount: 8, sizeBytes: cppSource.length, startLine: 1,
      }),
    });
    const result = await buildCallChain(client, 'processRequest', 'callees', 1, 'proj');
    expect(result.callees.length).toBeGreaterThan(0);
    const names = result.callees.map((c) => c.symbol);
    expect(names).toContain('computeTotal');
    expect(names).toContain('logResult');
  });

  it('callees direction: empty callees with a note for unsupported languages', async () => {
    const client = makeClient({
      search: vi.fn().mockImplementation((query: string, type: string) => {
        if (type === 'defs') {
          return Promise.resolve({
            query, searchType: type, totalCount: 1, timeMs: 1,
            results: [{ project: 'proj', path: '/src/query.xyz', matches: [{ lineNumber: 1, lineContent: query }] }],
            startIndex: 0, endIndex: 1, hasMore: false,
          });
        }
        return Promise.resolve({
          query, searchType: type, totalCount: 0, timeMs: 1,
          results: [], startIndex: 0, endIndex: 0, hasMore: false,
        });
      }),
    });
    const result = await buildCallChain(client, 'mysteryFn', 'callees', 1, 'proj');
    expect(result.callees).toEqual([]);
    expect(result.calleesNote).toMatch(/not support/);
  });

  it('callees direction: leaf functions report no callees found', async () => {
    const pySource = 'def lonely():\n    pass\n';
    const defPath = '/src/util.py';
    const client = makeClient({
      search: vi.fn().mockImplementation((query: string, type: string) => {
        if (type === 'defs') {
          return Promise.resolve({
            query, searchType: type, totalCount: 1, timeMs: 1,
            results: [{ project: 'proj', path: defPath, matches: [{ lineNumber: 1, lineContent: 'def lonely():' }] }],
            startIndex: 0, endIndex: 1, hasMore: false,
          });
        }
        return Promise.resolve({
          query, searchType: type, totalCount: 0, timeMs: 1,
          results: [], startIndex: 0, endIndex: 0, hasMore: false,
        });
      }),
      getFileContent: vi.fn().mockResolvedValue({
        project: 'proj', path: defPath, content: pySource,
        lineCount: 2, sizeBytes: pySource.length, startLine: 1,
      }),
    });
    const result = await buildCallChain(client, 'lonely', 'callees', 1, 'proj');
    expect(result.callees).toEqual([]);
    expect(result.calleesNote).toMatch(/Leaf function/);
  });

  it('caps depth at MAX_CALL_CHAIN_DEPTH (4)', async () => {
    const client = makeClient();
    const result = await buildCallChain(client, 'DeepFn', 'callers', 10);
    expect(result.truncatedAt).toBe(4);
  });

  it('does not truncate when depth <= 4', async () => {
    const client = makeClient();
    const result = await buildCallChain(client, 'MyFn', 'callers', 2);
    expect(result.truncatedAt).toBeUndefined();
  });

  it('handles error in refs search gracefully', async () => {
    const client = makeClient({
      search: vi.fn().mockRejectedValue(new Error('search failed')),
    });
    const result = await buildCallChain(client, 'MyFn', 'callers', 2);
    expect(result.callers).toEqual([]);
  });

  it('returns caller nodes when refs are found', async () => {
    const client = makeClient({
      search: vi.fn().mockResolvedValue({
        query: 'crashHandler', searchType: 'refs', totalCount: 1, timeMs: 1,
        results: [{
          project: 'myproject',
          path: 'src/main.cpp',
          matches: [{ lineNumber: 42, lineContent: 'crashHandler()' }],
        }],
        startIndex: 0, endIndex: 1, hasMore: false,
      }),
      getFileSymbols: vi.fn().mockResolvedValue({
        project: 'myproject', path: 'src/main.cpp',
        symbols: [
          { symbol: 'main', type: 'function', line: 1, lineStart: 1, lineEnd: 100, signature: '()', namespace: null },
        ],
      }),
    });
    const result = await buildCallChain(client, 'crashHandler', 'callers', 1);
    expect(result.callers.length).toBeGreaterThan(0);
    expect(result.callers[0].path).toBe('src/main.cpp');
    expect(result.callers[0].project).toBe('myproject');
  });

  it('recursively follows callers when depth > 1 and callerSym is found (covers lines 163-171)', async () => {
    // Set up: first search finds 'init' calling 'crashHandler'
    // 'init' is resolved to symbol 'main' via getFileSymbols
    // depth=2 means it will recurse into traceCallers for 'main'
    let searchCallCount = 0;
    const client = makeClient({
      search: vi.fn().mockImplementation((_sym: string) => {
        searchCallCount++;
        if (searchCallCount === 1) {
          // First call: refs for the original symbol
          return Promise.resolve({
            query: 'doWork', searchType: 'refs', totalCount: 1, timeMs: 1,
            results: [{
              project: 'proj', path: 'src/init.cpp',
              matches: [{ lineNumber: 5, lineContent: 'doWork()' }],
            }],
            startIndex: 0, endIndex: 1, hasMore: false,
          });
        }
        // Subsequent calls: no more refs (stop recursion)
        return Promise.resolve({
          query: 'init', searchType: 'refs', totalCount: 0, timeMs: 1,
          results: [],
          startIndex: 0, endIndex: 0, hasMore: false,
        });
      }),
      getFileSymbols: vi.fn().mockResolvedValue({
        project: 'proj', path: 'src/init.cpp',
        symbols: [
          { symbol: 'init', type: 'function', line: 1, lineStart: 1, lineEnd: 20, signature: '()', namespace: null },
        ],
      }),
    });
    const result = await buildCallChain(client, 'doWork', 'callers', 2);
    // Should have found callers and recursed (depth > 1 path covered)
    expect(result.callers.length).toBeGreaterThan(0);
  });

  it('getEnclosingFunction returns null when getFileSymbols throws (coverage for line 194)', async () => {
    // When refs are found but getFileSymbols throws for the caller's file,
    // the node should still be added (using path:line as fallback symbol)
    const client = makeClient({
      search: vi.fn().mockResolvedValue({
        query: 'myFn', searchType: 'refs', totalCount: 1, timeMs: 1,
        results: [{
          project: 'proj',
          path: 'src/caller.ts',
          matches: [{ lineNumber: 10, lineContent: 'myFn()' }],
        }],
        startIndex: 0, endIndex: 1, hasMore: false,
      }),
      getFileSymbols: vi.fn().mockRejectedValue(new Error('symbols fetch failed')),
    });
    const result = await buildCallChain(client, 'myFn', 'callers', 1);
    // Node created with fallback symbol (path:line) since getEnclosingFunction returned null
    expect(result.callers.length).toBeGreaterThan(0);
    expect(result.callers[0].symbol).toContain('src/caller.ts');
  });
});

// ---------------------------------------------------------------------------
// extractImports + langFromPath (helpers powering buildDependencyGraph "uses")
// ---------------------------------------------------------------------------
import { extractImports, langFromPath } from '../server/intelligence.js';

describe('extractImports', () => {
  it('extracts C++ #include directives', () => {
    const text = '#include "EventLoop.h"\n#include <vector>\nvoid foo() {}';
    expect(extractImports(text, 'cpp')).toEqual(['EventLoop.h', 'vector']);
  });

  it('extracts TypeScript import paths', () => {
    const text = "import { foo } from './utils/helper';\nimport type Bar from 'bar';";
    const imports = extractImports(text, 'typescript');
    expect(imports).toContain('./utils/helper');
    expect(imports).toContain('bar');
  });

  it('deduplicates imports', () => {
    const text = "import 'react';\nimport React from 'react';";
    const imports = extractImports(text, 'typescript');
    expect(imports.filter((i) => i === 'react')).toHaveLength(1);
  });

  it('returns empty array for file with no imports', () => {
    const text = 'const x = 1;\n';
    expect(extractImports(text, 'typescript')).toEqual([]);
  });
});

describe('langFromPath', () => {
  it('maps .cpp to cpp', () => expect(langFromPath('foo/bar.cpp')).toBe('cpp'));
  it('maps .ts to typescript', () => expect(langFromPath('src/index.ts')).toBe('typescript'));
  it('maps .py to python', () => expect(langFromPath('main.py')).toBe('python'));
  it('maps .go to go', () => expect(langFromPath('cmd/main.go')).toBe('go'));
  it('maps OpenGrok analyzer aliases (cxx, sh, golang extensions)', () => {
    expect(langFromPath('a.cxx')).toBe('cpp');
    expect(langFromPath('run.sh')).toBe('bash');
    expect(langFromPath('x.ps1')).toBe('powershell');
  });
  it('falls back to extension for unknown types', () => expect(langFromPath('foo.xyz')).toBe('xyz'));
});

// ---------------------------------------------------------------------------
// AST-aware truncation + expansion (require tree-sitter grammars in grammars/)
// ---------------------------------------------------------------------------
import { truncateAtBoundary, expandToFunctionBoundary } from '../server/intelligence/ast-truncation.js';
import { extractCallees } from '../server/intelligence/callee-extractor.js';
import { getTreeSitterLineBudget, commonPrefixSegments } from '../server/intelligence.js';

const PY_SRC = 'def alpha():\n    return 1\n\ndef beta():\n    return 2\n';

describe('truncateAtBoundary', () => {
  it('returns full content when the file fits within maxLines', async () => {
    const result = await truncateAtBoundary(PY_SRC, 50, 'python');
    expect(result).not.toBeNull();
    expect(result!.content).toBe(PY_SRC);
    expect(result!.truncatedAtLine).toBe(result!.totalLines);
    expect(result!.symbols.map((s) => s.name)).toEqual(
      expect.arrayContaining(['alpha', 'beta'])
    );
  });

  it('truncates at a symbol boundary instead of mid-definition', async () => {
    // alpha spans lines 1-2, beta spans lines 4-5 — maxLines 3 must stop at line 2
    const result = await truncateAtBoundary(PY_SRC, 3, 'python');
    expect(result).not.toBeNull();
    expect(result!.truncatedAtLine).toBe(2);
    expect(result!.includedLines).toBe(2);
    expect(result!.content).toContain('alpha');
    expect(result!.content).not.toContain('beta');
  });

  it('returns null for unsupported languages', async () => {
    await expect(truncateAtBoundary(PY_SRC, 3, 'notalanguage')).resolves.toBeNull();
  });
});

describe('expandToFunctionBoundary', () => {
  it('expands a match line to its enclosing function body', async () => {
    const result = await expandToFunctionBoundary(PY_SRC, 4, 'python', 50);
    expect(result).not.toBeNull();
    expect(result!.functionName).toBe('beta');
    expect(result!.functionStartLine).toBe(4);
    expect(result!.expandedContent).toContain('return 2');
    expect(result!.expandedContent).not.toContain('alpha');
  });

  it('returns null when the match line is outside any function', async () => {
    await expect(expandToFunctionBoundary(PY_SRC, 3, 'python', 50)).resolves.toBeNull();
  });

  it('returns null for unsupported languages', async () => {
    await expect(expandToFunctionBoundary(PY_SRC, 4, 'notalanguage', 50)).resolves.toBeNull();
  });
});

describe('extractCallees', () => {
  const CPP_SRC = [
    'int helper(int x) {',
    '  return x * 2;',
    '}',
    'int main() {',
    '  int y = helper(21);',
    '  return y;',
    '}',
  ].join('\n');

  it('extracts calls within a C++ function body', async () => {
    const callees = await extractCallees(CPP_SRC, 'main', 'cpp');
    expect(callees.map((c) => c.name)).toContain('helper');
  });

  it('returns empty array for unknown functions', async () => {
    await expect(extractCallees(CPP_SRC, 'nope', 'cpp')).resolves.toEqual([]);
  });

  it('returns empty array for unsupported languages', async () => {
    await expect(extractCallees(CPP_SRC, 'main', 'notalanguage')).resolves.toEqual([]);
  });
});

describe('getTreeSitterLineBudget', () => {
  const OLD = process.env.OPENGROK_CONTEXT_BUDGET;

  afterEach(() => {
    if (OLD === undefined) delete process.env.OPENGROK_CONTEXT_BUDGET;
    else process.env.OPENGROK_CONTEXT_BUDGET = OLD;
  });

  it('scales 200/400/600 by context tier', () => {
    process.env.OPENGROK_CONTEXT_BUDGET = 'minimal';
    expect(getTreeSitterLineBudget()).toBe(200);
    process.env.OPENGROK_CONTEXT_BUDGET = 'generous';
    expect(getTreeSitterLineBudget()).toBe(600);
    process.env.OPENGROK_CONTEXT_BUDGET = 'standard';
    expect(getTreeSitterLineBudget()).toBe(400);
  });

  it('defaults to 400 when unset or unknown', () => {
    delete process.env.OPENGROK_CONTEXT_BUDGET;
    expect(getTreeSitterLineBudget()).toBe(400);
    process.env.OPENGROK_CONTEXT_BUDGET = 'bogus';
    expect(getTreeSitterLineBudget()).toBe(400);
  });
});

describe('commonPrefixSegments', () => {
  it('counts shared leading segments', () => {
    expect(commonPrefixSegments('/src/app/a.cpp', '/src/app/b.cpp')).toBe(3);
    expect(commonPrefixSegments('/src/a.cpp', '/other/b.cpp')).toBe(1);
  });
});
