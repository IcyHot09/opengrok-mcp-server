import { describe, it, expect } from 'vitest';
import {
  parseProjectsPage,
  parseDirectoryListing,
  parseFileHistory,
  parseAnnotate,
  parseWebSearchResults,
  parseFileSymbols,
  parseFileDiff,
} from '../server/parsers/index.js';
import {
  PROJECTS_PAGE_HTML,
  DIRECTORY_LISTING_HTML,
  DIRECTORY_LISTING_REAL_HTML,
  FILE_HISTORY_HTML,
  FILE_HISTORY_REAL_HTML,
  ANNOTATE_HTML,
  ANNOTATE_HTML_17X,
  WEB_SEARCH_RESULTS_HTML,
  XREF_FILE_SYMBOLS_HTML,
  DIFF_UNIFIED_HTML,
} from './fixtures/html.js';

// ---------------------------------------------------------------------------
// parseProjectsPage
// ---------------------------------------------------------------------------

describe('parseProjectsPage', () => {
  it('extracts projects with categories from optgroup structure', () => {
    const projects = parseProjectsPage(PROJECTS_PAGE_HTML);
    expect(projects).toHaveLength(3);

    const mainProject = projects.find(p => p.name === 'release-2.x');
    expect(mainProject).toBeDefined();
    expect(mainProject?.category).toBe('Main Releases');

    const winProject = projects.find(p => p.name === 'release-2.x-win');
    expect(winProject?.category).toBe('Main Releases');

    const legacyProject = projects.find(p => p.name === 'v1.8-stable');
    expect(legacyProject?.category).toBe('Legacy');
  });

  it('returns empty array for empty HTML', () => {
    const projects = parseProjectsPage('<html><body></body></html>');
    expect(projects).toEqual([]);
  });

  it('falls back to xref links when no select element present', () => {
    const html = `
      <html><body>
        <a href="/xref/my-project/">My Project</a>
        <a href="/xref/another-project/">Another</a>
      </body></html>
    `;
    const projects = parseProjectsPage(html);
    expect(projects.map(p => p.name)).toContain('my-project');
    expect(projects.map(p => p.name)).toContain('another-project');
  });

  it('deduplicates projects in fallback mode', () => {
    const html = `
      <html><body>
        <a href="/xref/my-project/">Link 1</a>
        <a href="/xref/my-project/">Link 2</a>
      </body></html>
    `;
    const projects = parseProjectsPage(html);
    const myProjects = projects.filter(p => p.name === 'my-project');
    expect(myProjects).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// parseDirectoryListing
// ---------------------------------------------------------------------------

describe('parseDirectoryListing', () => {
  it('parses directories and files from table', () => {
    const entries = parseDirectoryListing(DIRECTORY_LISTING_HTML, 'release-2.x', '');
    expect(entries).toHaveLength(2);

    const dir = entries.find(e => e.name === 'pandora');
    expect(dir?.isDirectory).toBe(true);
    expect(dir?.lastModified).toBe('2024-01-01');

    const file = entries.find(e => e.name === 'README.md');
    expect(file?.isDirectory).toBe(false);
    expect(file?.size).toBe(1234);
  });

  it('returns empty array for empty HTML', () => {
    const entries = parseDirectoryListing('<html><body></body></html>', 'proj', '');
    expect(entries).toEqual([]);
  });

  it('parses real OpenGrok 1.7.x directory listing with icon cells and relative hrefs', () => {
    const entries = parseDirectoryListing(DIRECTORY_LISTING_REAL_HTML, 'release-2.x', 'pandora/source/NetEngine/MySql');
    expect(entries.length).toBeGreaterThanOrEqual(2);

    const dir = entries.find(e => e.name === 'SignalRouter');
    expect(dir).toBeDefined();
    expect(dir?.isDirectory).toBe(true);
    expect(dir?.path).toBe('pandora/source/NetEngine/MySql/SignalRouter');

    const file = entries.find(e => e.name === 'ShaderPipelineUtils.cpp');
    expect(file).toBeDefined();
    expect(file?.isDirectory).toBe(false);
    expect(file?.size).toBe(5678);
  });
});

// ---------------------------------------------------------------------------
// parseFileHistory
// ---------------------------------------------------------------------------

describe('parseFileHistory', () => {
  it('parses revisions, dates, authors, and messages', () => {
    const history = parseFileHistory(FILE_HISTORY_HTML, 'release-2.x', 'path/to/file.cpp');
    expect(history.project).toBe('release-2.x');
    expect(history.path).toBe('path/to/file.cpp');
    expect(history.entries).toHaveLength(2);

    const first = history.entries[0];
    expect(first.revision).toBe('abc12345');
    expect(first.date).toBe('2024-01-15');
    expect(first.author).toBe('john.doe');
    expect(first.message).toContain('Fix memory leak');
    expect(first.updateForm).toBe('58321');
    expect(first.mergeRequest).toBe('78502');
  });

  it('extracts Update Form and MR from message', () => {
    const history = parseFileHistory(FILE_HISTORY_HTML, 'proj', 'file.cpp');
    expect(history.entries[0].updateForm).toBe('58321');
    expect(history.entries[0].mergeRequest).toBe('78502');
    expect(history.entries[1].updateForm).toBeUndefined();
  });

  it('returns empty entries for no table', () => {
    const history = parseFileHistory('<html><body></body></html>', 'proj', 'file.cpp');
    expect(history.entries).toEqual([]);
  });

  it('parses real OpenGrok 1.7.x history with two <a> tags per revision cell', () => {
    const history = parseFileHistory(FILE_HISTORY_REAL_HTML, 'release-2.x', 'path/file.cpp');
    expect(history.entries).toHaveLength(2);

    const first = history.entries[0];
    expect(first.revision).toBe('851c8156');
    expect(first.date).toBe('07-Mar-2026');
    expect(first.author).toBe('Alice Developer <adev@example.com>');
    expect(first.message).toContain('GPU Signal Router Pipeline');
    expect(first.updateForm).toBe('61204');
    expect(first.mergeRequest).toBe('79133');

    const second = history.entries[1];
    expect(second.revision).toBe('7a2b3c4d');
    expect(second.author).toBe('John Doe <jdoe@example.com>');
  });
});

// ---------------------------------------------------------------------------
// parseAnnotate
// ---------------------------------------------------------------------------

describe('parseAnnotate', () => {
  it('parses blame spans with revision, author, date', () => {
    const annotated = parseAnnotate(ANNOTATE_HTML, 'release-2.x', 'path/to/file.cpp');
    expect(annotated.project).toBe('release-2.x');
    expect(annotated.path).toBe('path/to/file.cpp');
    expect(annotated.lines).toHaveLength(2);

    const firstLine = annotated.lines[0];
    expect(firstLine.lineNumber).toBe(1);
    expect(firstLine.revision).toBe('abc12345');
    expect(firstLine.author).toBe('john.doe');
    expect(firstLine.date).toBe('2024-01-15');
  });

  it('returns empty lines for empty HTML', () => {
    const annotated = parseAnnotate('<html><body></body></html>', 'proj', 'file.cpp');
    expect(annotated.lines).toEqual([]);
  });

  it('parses OpenGrok 1.7.x annotate (title on child <a>, changeset/user fields)', () => {
    const annotated = parseAnnotate(ANNOTATE_HTML_17X, 'release-2.x', 'path/to/file.cpp');
    expect(annotated.lines).toHaveLength(2);

    const first = annotated.lines[0];
    expect(first.lineNumber).toBe(1);
    expect(first.revision).toBe('851c8156');
    expect(first.author).toBe('Alice Developer');
    expect(first.date).toBe('Tue Dec 23 15:43:42 EST 2025');
    expect(first.content).toBe('// $CVSHeader$');

    const second = annotated.lines[1];
    expect(second.revision).toBe('aabb1122');
    expect(second.author).toBe('Jane Smith');
    expect(second.date).toBe('Mon Jan 06 10:00:00 EST 2025');
    expect(second.content).toBe('#include "library.h"');
  });
});

// ---------------------------------------------------------------------------
// parseWebSearchResults
// ---------------------------------------------------------------------------

describe('parseWebSearchResults', () => {
  it('parses web search HTML with file paths and line numbers', () => {
    const results = parseWebSearchResults(WEB_SEARCH_RESULTS_HTML, 'defs', 'PixelBufferRenderer');
    expect(results.query).toBe('PixelBufferRenderer');
    expect(results.searchType).toBe('defs');
    expect(results.totalCount).toBe(2);
    expect(results.results).toHaveLength(2);

    const header = results.results[0];
    expect(header.project).toBe('release-2.x');
    expect(header.path).toContain('PixelBufferRenderer.h');
    expect(header.matches).toHaveLength(1);
    expect(header.matches[0].lineNumber).toBe(48);

    const cpp = results.results[1];
    expect(cpp.path).toContain('PixelBufferRenderer.cpp');
    expect(cpp.matches[0].lineNumber).toBe(41);
  });

  it('returns empty results for no matches HTML', () => {
    const results = parseWebSearchResults(
      '<html><body><div id="results"><p class="pagetitle">No hits</p></div></body></html>',
      'defs',
      'nonexistent'
    );
    expect(results.results).toEqual([]);
    expect(results.totalCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// parseFileSymbols
// ---------------------------------------------------------------------------

describe('parseFileSymbols', () => {
  it('extracts macros, classes, enums, and functions from xref HTML', () => {
    const symbols = parseFileSymbols(XREF_FILE_SYMBOLS_HTML);
    const names = symbols.map(s => s.symbol);
    expect(names).toContain('MAX_BUFFER_SIZE');
    expect(names).toContain('APP_NAME');
    expect(names).toContain('MyController');
    expect(names).toContain('ErrorCode');
    expect(names).toContain('Initialize');
    expect(names).toContain('Cleanup');
    expect(names).toContain('ProcessItems');
  });

  it('maps CSS classes to correct symbol types', () => {
    const symbols = parseFileSymbols(XREF_FILE_SYMBOLS_HTML);
    const byName = (n: string) => symbols.find(s => s.symbol === n);
    expect(byName('MAX_BUFFER_SIZE')?.type).toBe('macro');
    expect(byName('APP_NAME')?.type).toBe('macro');
    expect(byName('MyController')?.type).toBe('class');
    expect(byName('ErrorCode')?.type).toBe('enum');
    expect(byName('Initialize')?.type).toBe('function');
    expect(byName('Cleanup')?.type).toBe('function');
    expect(byName('ProcessItems')?.type).toBe('function');
  });

  it('extracts correct line numbers from line anchors', () => {
    const symbols = parseFileSymbols(XREF_FILE_SYMBOLS_HTML);
    const byName = (n: string) => symbols.find(s => s.symbol === n);
    expect(byName('MAX_BUFFER_SIZE')?.line).toBe(10);
    expect(byName('APP_NAME')?.line).toBe(11);
    expect(byName('MyController')?.line).toBe(20);
    expect(byName('ErrorCode')?.line).toBe(30);
    expect(byName('Initialize')?.line).toBe(40);
    expect(byName('Cleanup')?.line).toBe(70);
    expect(byName('ProcessItems')?.line).toBe(80);
  });

  it('extracts scope-signature for functions', () => {
    const symbols = parseFileSymbols(XREF_FILE_SYMBOLS_HTML);
    const byName = (n: string) => symbols.find(s => s.symbol === n);
    expect(byName('Initialize')?.signature).toBe('Initialize(const char * config,int timeout)');
    expect(byName('Cleanup')?.signature).toBe('Cleanup()');
    expect(byName('ProcessItems')?.signature).toBe('ProcessItems(vector<string> & items)');
  });

  it('decodes HTML entities in scope-signatures', () => {
    const symbols = parseFileSymbols(XREF_FILE_SYMBOLS_HTML);
    const processItems = symbols.find(s => s.symbol === 'ProcessItems');
    // &lt; → <, &gt; → >, &amp; → &
    expect(processItems?.signature).toContain('<');
    expect(processItems?.signature).toContain('>');
    expect(processItems?.signature).toContain('&');
  });

  it('excludes local variables (xl) and arguments (xa)', () => {
    const symbols = parseFileSymbols(XREF_FILE_SYMBOLS_HTML);
    const names = symbols.map(s => s.symbol);
    // Locals
    expect(names).not.toContain('function');
    expect(names).not.toContain('retCode');
    expect(names).not.toContain('oError');
    // Arguments
    expect(names).not.toContain('config');
    expect(names).not.toContain('timeout');
    expect(names).not.toContain('items');
  });

  it('sets signature to null for non-function symbols', () => {
    const symbols = parseFileSymbols(XREF_FILE_SYMBOLS_HTML);
    const byName = (n: string) => symbols.find(s => s.symbol === n);
    expect(byName('MAX_BUFFER_SIZE')?.signature).toBeNull();
    expect(byName('MyController')?.signature).toBeNull();
    expect(byName('ErrorCode')?.signature).toBeNull();
  });

  it('returns empty array for HTML with no symbols', () => {
    const symbols = parseFileSymbols('<html><body><div id="src"></div></body></html>');
    expect(symbols).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    const symbols = parseFileSymbols('');
    expect(symbols).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseFileDiff — parses unified HTML from OpenGrok format=u
// ---------------------------------------------------------------------------

describe('parseFileDiff', () => {
  it('returns project, path, rev1, rev2 metadata', () => {
    const result = parseFileDiff(DIFF_UNIFIED_HTML, 'myproj', 'src/foo.cpp', 'abc123', 'def456');
    expect(result.project).toBe('myproj');
    expect(result.path).toBe('src/foo.cpp');
    expect(result.rev1).toBe('abc123');
    expect(result.rev2).toBe('def456');
  });

  it('splits changes into separate hunks at line-number gaps', () => {
    const result = parseFileDiff(DIFF_UNIFIED_HTML, 'p', 'f.cpp', 'r1', 'r2');
    // Hunk 1: context(5,6) + del(7) + add(7) + context(8,9)
    // [gap: 98 hidden lines]
    // Hunk 2: context(108,109) + add(110,111) + context(112)
    expect(result.hunks.length).toBe(2);
  });

  it('includes context lines in hunks (critical for AI comprehension)', () => {
    const result = parseFileDiff(DIFF_UNIFIED_HTML, 'p', 'f.cpp', 'r1', 'r2');
    const ctx = result.hunks[0].lines.filter(l => l.type === 'context');
    expect(ctx.length).toBeGreaterThan(0);
    expect(ctx.map(l => l.content)).toContain('void init() {');
    expect(ctx.map(l => l.content)).toContain('    doSomething(x);');
  });

  it('captures content of deleted line from <del class="d">', () => {
    const result = parseFileDiff(DIFF_UNIFIED_HTML, 'p', 'f.cpp', 'r1', 'r2');
    const removed = result.hunks.flatMap(h => h.lines).filter(l => l.type === 'removed');
    expect(removed).toHaveLength(1);
    expect(removed[0].content).toBe('    int x = 0;');
  });

  it('captures content of added lines from <span class="a it">', () => {
    const result = parseFileDiff(DIFF_UNIFIED_HTML, 'p', 'f.cpp', 'r1', 'r2');
    const added = result.hunks.flatMap(h => h.lines).filter(l => l.type === 'added');
    expect(added).toHaveLength(3);
    expect(added[0].content).toBe('    int x = 42;');
    expect(added[1].content).toBe('void newFunction() {}');
    expect(added[2].content).toBe('// end of addition');
  });

  it('records old line number on deleted lines', () => {
    const result = parseFileDiff(DIFF_UNIFIED_HTML, 'p', 'f.cpp', 'r1', 'r2');
    const removed = result.hunks.flatMap(h => h.lines).filter(l => l.type === 'removed');
    expect(removed[0].oldLineNumber).toBe(7);
    expect(removed[0].newLineNumber).toBeUndefined();
  });

  it('records new line numbers on added lines', () => {
    const result = parseFileDiff(DIFF_UNIFIED_HTML, 'p', 'f.cpp', 'r1', 'r2');
    const added = result.hunks.flatMap(h => h.lines).filter(l => l.type === 'added');
    expect(added[0].newLineNumber).toBe(7);
    expect(added[0].oldLineNumber).toBeUndefined();
    expect(added[1].newLineNumber).toBe(110);
  });

  it('records new line numbers on context lines', () => {
    const result = parseFileDiff(DIFF_UNIFIED_HTML, 'p', 'f.cpp', 'r1', 'r2');
    const ctx = result.hunks[0].lines.filter(l => l.type === 'context');
    expect(ctx[0].newLineNumber).toBe(5);
  });

  it('computes correct added/removed stats (context excluded)', () => {
    const result = parseFileDiff(DIFF_UNIFIED_HTML, 'p', 'f.cpp', 'r1', 'r2');
    expect(result.stats.removed).toBe(1);
    expect(result.stats.added).toBe(3);
  });

  it('produces a unified diff string with @@ headers, context, and +/- lines', () => {
    const result = parseFileDiff(DIFF_UNIFIED_HTML, 'p', 'f.cpp', 'r1', 'r2');
    expect(result.unifiedDiff).toContain('@@');
    expect(result.unifiedDiff).toContain('-    int x = 0;');
    expect(result.unifiedDiff).toContain('+    int x = 42;');
    expect(result.unifiedDiff).toContain('+void newFunction() {}');
    // Context lines should be present with space prefix
    expect(result.unifiedDiff).toContain(' void init() {');
    expect(result.unifiedDiff).toContain(' }');
  });

  it('decodes HTML entities in content (e.g. &quot; → ")', () => {
    const result = parseFileDiff(DIFF_UNIFIED_HTML, 'p', 'f.cpp', 'r1', 'r2');
    const ctx = result.hunks[0].lines.filter(l => l.type === 'context');
    expect(ctx[0].content).toBe('#include "other.h"');
  });

  it('sets correct newStart on first hunk from first context line', () => {
    const result = parseFileDiff(DIFF_UNIFIED_HTML, 'p', 'f.cpp', 'r1', 'r2');
    expect(result.hunks[0].newStart).toBe(5);
  });

  it('returns empty hunks for HTML with no diff table', () => {
    const result = parseFileDiff('<html><body></body></html>', 'p', 'f.cpp', 'r1', 'r2');
    expect(result.hunks).toEqual([]);
    expect(result.stats.added).toBe(0);
    expect(result.stats.removed).toBe(0);
    expect(result.unifiedDiff).toBe('');
  });

  it('returns empty hunks for empty string', () => {
    const result = parseFileDiff('', 'p', 'f.cpp', 'r1', 'r2');
    expect(result.hunks).toEqual([]);
  });
});
