import { describe, it, expect, afterEach } from 'vitest';
import {
  formatSearchResultsTSV,
  formatSymbolContextYAML,
  formatFileContentText,
  selectFormat,
} from '../server/formatters/index.js';
import type { SearchResults, FileContent } from '../server/models.js';
import type { SymbolContextResult } from '../server/formatters/index.js';

// ---------------------------------------------------------------------------
// formatSearchResultsTSV
// ---------------------------------------------------------------------------

describe('formatSearchResultsTSV', () => {
  const makeResults = (overrides: Partial<SearchResults> = {}): SearchResults => ({
    query: 'handleCrash',
    searchType: 'refs',
    totalCount: 2,
    timeMs: 12,
    results: [
      {
        project: 'myproject',
        path: 'src/crash.cpp',
        matches: [
          { lineNumber: 42, lineContent: 'void handleCrash()' },
          { lineNumber: 50, lineContent: 'handleCrash();' },
        ],
      },
    ],
    startIndex: 0,
    endIndex: 1,
    ...overrides,
  });

  it('produces tab-separated rows with correct columns', () => {
    const output = formatSearchResultsTSV(makeResults());
    const lines = output.split('\n');
    // Header line
    expect(lines[1]).toBe('path\tproject\tline\tcontent');
    // Data row
    const dataRow = lines[2];
    const cols = dataRow.split('\t');
    expect(cols[0]).toBe('src/crash.cpp');
    expect(cols[1]).toBe('myproject');
    expect(cols[2]).toBe('42');
    expect(cols[3]).toContain('handleCrash');
  });

  it('does not contain markdown code fences', () => {
    const output = formatSearchResultsTSV(makeResults());
    expect(output).not.toContain('```');
  });

  it('includes summary header comment', () => {
    const output = formatSearchResultsTSV(makeResults());
    expect(output).toMatch(/^# Search:/);
    expect(output).toContain('handleCrash');
  });

  it('replaces tabs in content with spaces to keep TSV valid', () => {
    const results = makeResults({
      results: [{
        project: 'p', path: 'a.cpp',
        matches: [{ lineNumber: 1, lineContent: 'foo\tbar' }],
      }],
    });
    const output = formatSearchResultsTSV(results);
    // Each data row should have exactly 3 tabs (4 columns)
    const dataRow = output.split('\n').find(l => l.startsWith('a.cpp'));
    expect(dataRow).toBeDefined();
    expect((dataRow!.match(/\t/g) ?? []).length).toBe(3);
  });

  it('shows pagination note when not all results are shown', () => {
    const results = makeResults({ totalCount: 100, endIndex: 1 });
    const output = formatSearchResultsTSV(results);
    expect(output).toContain('Showing');
  });
});

// ---------------------------------------------------------------------------
// formatSymbolContextYAML
// ---------------------------------------------------------------------------

describe('formatSymbolContextYAML', () => {
  const makeSymbolResult = (overrides: Partial<SymbolContextResult> = {}): SymbolContextResult => ({
    found: true,
    symbol: 'EventLoop',
    kind: 'class/struct',
    definition: {
      project: 'myproject',
      path: 'src/EventLoop.h',
      line: 45,
      context: '#include <string>\nclass EventLoop {\n  void run();\n};',
      lang: 'cpp',
    },
    references: {
      totalFound: 12,
      samples: [
        { path: 'src/main.cpp', project: 'myproject', lineNumber: 10, content: 'EventLoop loop;' },
      ],
    },
    ...overrides,
  });

  it('produces valid YAML output', async () => {
    const yaml = await import('js-yaml');
    const output = formatSymbolContextYAML(makeSymbolResult());
    expect(() => yaml.load(output)).not.toThrow();
  });

  it('includes symbol name and kind', () => {
    const output = formatSymbolContextYAML(makeSymbolResult());
    expect(output).toContain('EventLoop');
    expect(output).toContain('class/struct');
  });

  it('handles C++ colons in code content without breaking YAML', async () => {
    const yaml = await import('js-yaml');
    const result = makeSymbolResult({
      definition: {
        project: 'p', path: 'a.cpp', line: 1,
        context: 'std::vector<std::string>: unexpected token: {"key": "value"}',
        lang: 'cpp',
      },
    });
    const output = formatSymbolContextYAML(result);
    // Should still parse as valid YAML despite colons
    expect(() => yaml.load(output)).not.toThrow();
  });

  it('handles not-found symbol', () => {
    const result: SymbolContextResult = {
      found: false,
      symbol: 'UnknownSym',
      kind: 'unknown',
      references: { totalFound: 0, samples: [] },
    };
    const output = formatSymbolContextYAML(result);
    expect(output).toContain('found: false');
    expect(output).toContain('UnknownSym');
  });
});

// ---------------------------------------------------------------------------
// formatFileContentText
// ---------------------------------------------------------------------------

describe('formatFileContentText', () => {
  const makeFileContent = (overrides: Partial<FileContent> = {}): FileContent => ({
    project: 'myproject',
    path: 'src/EventLoop.cpp',
    content: 'void EventLoop::run() {\n  while (running_) {\n    poll();\n  }\n}',
    lineCount: 5,
    sizeBytes: 60,
    startLine: 120,
    ...overrides,
  });

  it('does not contain markdown code fences', () => {
    const output = formatFileContentText(makeFileContent());
    expect(output).not.toContain('```');
  });

  it('includes filename, project, and line range in compact header', () => {
    const output = formatFileContentText(makeFileContent());
    expect(output).toContain('EventLoop.cpp');
    expect(output).toContain('myproject');
    expect(output).toContain('L120');
  });

  it('includes raw code content', () => {
    const output = formatFileContentText(makeFileContent());
    expect(output).toContain('EventLoop::run');
  });

  it('defaults startLine to 1 when not provided', () => {
    const content = makeFileContent({ startLine: undefined });
    const output = formatFileContentText(content);
    expect(output).toContain('L1-');
  });
});

// ---------------------------------------------------------------------------
// selectFormat
// ---------------------------------------------------------------------------

describe('selectFormat', () => {
  afterEach(() => {
    delete process.env.OPENGROK_RESPONSE_FORMAT_OVERRIDE;
  });

  it('auto-selects tsv for search responses', () => {
    expect(selectFormat('search')).toBe('tsv');
  });

  it('auto-selects yaml for symbol responses', () => {
    expect(selectFormat('symbol')).toBe('yaml');
  });

  it('auto-selects text for code responses', () => {
    expect(selectFormat('code')).toBe('text');
  });

  it('auto-selects markdown for generic responses', () => {
    expect(selectFormat('generic')).toBe('markdown');
  });

  it('respects explicit per-call format over auto', () => {
    expect(selectFormat('search', 'markdown')).toBe('markdown');
    expect(selectFormat('symbol', 'json')).toBe('json');
  });

  it('respects OPENGROK_RESPONSE_FORMAT_OVERRIDE env var', () => {
    process.env.OPENGROK_RESPONSE_FORMAT_OVERRIDE = 'json';
    expect(selectFormat('search')).toBe('json');
    expect(selectFormat('symbol', 'tsv')).toBe('json'); // override wins
  });

  it('ignores invalid OPENGROK_RESPONSE_FORMAT_OVERRIDE', () => {
    process.env.OPENGROK_RESPONSE_FORMAT_OVERRIDE = 'invalid-format';
    expect(selectFormat('search')).toBe('tsv'); // falls back to auto
  });

  it('defaults to markdown when perCallFormat is auto', () => {
    expect(selectFormat('generic', 'auto')).toBe('markdown');
  });
});
