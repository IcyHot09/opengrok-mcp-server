/**
 * Tests filling coverage gaps in formatters.ts, parsers.ts, config.ts, and compile-info.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
  formatSearchResults,
  formatFileContent,
  formatDirectoryListing,
  formatAnnotate,
  formatFileHistory,
} from '../server/formatters/index.js';
import {
  parseProjectsPage,
  parseDirectoryListing,
  parseWebSearchResults,
} from '../server/parsers/index.js';
import {
  discoverCompileCommands,
  parseCompileCommands,
  loadCompileCommandsJson,
  inferBuildRoot,
  resolveAllowedRoots,
} from '../server/local/compile-info.js';
import { loadConfig, resetConfig } from '../server/config.js';
import type {
  SearchResults,
  FileContent,
  DirectoryEntry,
  AnnotatedFile,
  FileHistory,
} from '../server/models.js';

// -----------------------------------------------------------------------
// formatSearchResults gaps
// -----------------------------------------------------------------------

describe('formatSearchResults', () => {
  it('shows "more" message when a result has > 5 matches', () => {
    const results: SearchResults = {
      query: 'test',
      searchType: 'full',
      totalCount: 1,
      timeMs: 50,
      results: [{
        project: 'proj',
        path: '/file.cpp',
        matches: Array.from({ length: 8 }, (_, i) => ({
          lineNumber: i + 1,
          lineContent: `line ${i + 1}`,
        })),
      }],
      startIndex: 0,
      endIndex: 1,
    };
    const output = formatSearchResults(results);
    expect(output).toContain('+3 more');
  });

  it('shows pagination message when endIndex < totalCount', () => {
    const results: SearchResults = {
      query: 'test',
      searchType: 'full',
      totalCount: 100,
      timeMs: 50,
      results: [{
        project: 'p', path: '/f.cpp',
        matches: [{ lineNumber: 1, lineContent: 'x' }],
      }],
      startIndex: 0,
      endIndex: 10,
    };
    const output = formatSearchResults(results);
    expect(output).toContain('Showing 1 of 100 results');
  });
});

// -----------------------------------------------------------------------
// formatFileContent gaps
// -----------------------------------------------------------------------

describe('formatFileContent', () => {
  it('truncates content when > MAX_INLINE_LINES', () => {
    const manyLines = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    const content: FileContent = {
      project: 'proj',
      path: 'big.cpp',
      content: manyLines,
      lineCount: 300,
      sizeBytes: Buffer.byteLength(manyLines),
    };
    const output = formatFileContent(content);
    expect(output).toContain('Showing first');
    expect(output).toContain('Use start_line/end_line');
  });

  it('does not show line numbers when showLineNumbers is false', () => {
    const content: FileContent = {
      project: 'proj',
      path: 'test.cpp',
      content: 'hello\nworld',
      lineCount: 2,
      sizeBytes: 11,
    };
    const output = formatFileContent(content, false);
    expect(output).toContain('hello\nworld');
    // Should not have "1 | " prefix
    expect(output).not.toMatch(/\d+ \| hello/);
  });
});

// -----------------------------------------------------------------------
// formatDirectoryListing gaps
// -----------------------------------------------------------------------

describe('formatDirectoryListing', () => {
  it('shows (empty) for empty directory', () => {
    const output = formatDirectoryListing([], 'proj', 'src');
    expect(output).toContain('(empty)');
  });

  it('shows file size when available', () => {
    const entries: DirectoryEntry[] = [
      { name: 'large.cpp', isDirectory: false, path: 'large.cpp', size: 1024 },
    ];
    const output = formatDirectoryListing(entries, 'proj', '');
    expect(output).toContain('1,024 bytes');
  });
});

// -----------------------------------------------------------------------
// formatAnnotate gaps
// -----------------------------------------------------------------------

describe('formatAnnotate', () => {
  it('shows "No lines in specified range" for out-of-range filter', () => {
    const annotate: AnnotatedFile = {
      project: 'proj',
      path: 'file.cpp',
      lines: [
        { lineNumber: 1, content: 'x', revision: 'abc', author: 'bob' },
      ],
    };
    const output = formatAnnotate(annotate, 100, 200);
    expect(output).toContain('No lines in specified range');
  });

  it('caps full-file view at 50 lines', () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({
      lineNumber: i + 1,
      content: `line${i}`,
      revision: 'r' + i,
      author: 'author',
    }));
    const annotate: AnnotatedFile = { project: 'p', path: 'f.cpp', lines };
    const output = formatAnnotate(annotate);
    // Should only show ~50 lines in the default view
    const codeBlock = output.split('```')[1] ?? '';
    const codeLines = codeBlock.split('\n').filter(l => l.trim());
    expect(codeLines.length).toBeLessThanOrEqual(51);
  });
});

// -----------------------------------------------------------------------
// parseProjectsPage gaps (optgroup vs bare option)
// -----------------------------------------------------------------------

describe('parseProjectsPage', () => {
  it('parses options within optgroup as categorized', () => {
    const html = `<html><body>
      <select id="project">
        <optgroup label="Platforms">
          <option value="release-2.x">release-2.x</option>
          <option value="v3.1-beta">v3.1-beta</option>
        </optgroup>
        <option value="standalone">standalone</option>
      </select>
    </body></html>`;
    const projects = parseProjectsPage(html);
    expect(projects.length).toBe(3);
    const platformProj = projects.find(p => p.name === 'release-2.x');
    expect(platformProj?.category).toBe('Platforms');
    const standalone = projects.find(p => p.name === 'standalone');
    expect(standalone).toBeDefined();
  });

  it('handles nested children of various types', () => {
    const html = `<html><body>
      <select id="project">
        <option value="proj1">proj1</option>
      </select>
    </body></html>`;
    const projects = parseProjectsPage(html);
    expect(projects.length).toBe(1);
    expect(projects[0].name).toBe('proj1');
  });
});

// -----------------------------------------------------------------------
// parseDirectoryListing gaps (no-table fallback)
// -----------------------------------------------------------------------

describe('parseDirectoryListing', () => {
  it('falls back to link-based parsing when no table found', () => {
    const html = `<html><body>
      <a href="/xref/proj/src/sub/">sub</a>
      <a href="/xref/proj/src/file.cpp">file.cpp</a>
    </body></html>`;
    const entries = parseDirectoryListing(html, 'proj', 'src');
    // Should parse at least one entry from the links
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });
});

// -----------------------------------------------------------------------
// parseWebSearchResults gaps
// -----------------------------------------------------------------------

describe('parseWebSearchResults (branches)', () => {
  it('handles result links with various formats', () => {
    const html = `<html><body>
      <div id="results">
        <div class="dir">
          <a href="/xref/proj/src/file.cpp">file.cpp</a>
        </div>
        <pre class="result">
          <span class="l">10</span><a href="/xref/proj/src/file.cpp#10">content here</a>
        </pre>
      </div>
    </body></html>`;
    const result = parseWebSearchResults(html, 'full', 'test');
    expect(result).toBeDefined();
    expect(result.searchType).toBe('full');
  });
});

// -----------------------------------------------------------------------
// discoverCompileCommands
// -----------------------------------------------------------------------

describe('discoverCompileCommands', () => {
  it('finds compile_commands.json recursively', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-discover-'));
    const subDir = path.join(tmpDir, 'build');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'compile_commands.json'), '[]');

    try {
      const results = discoverCompileCommands(tmpDir);
      expect(results.length).toBe(1);
      expect(results[0]).toContain('compile_commands.json');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns empty array for non-existent path', () => {
    const results = discoverCompileCommands('/nonexistent/path');
    expect(results).toEqual([]);
  });

  (process.platform === 'win32' ? it.skip : it)('skips symlinked directories', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-discover-'));
    const realDir = path.join(tmpDir, 'real');
    const linkDir = path.join(tmpDir, 'link');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'compile_commands.json'), '[]');
    fs.symlinkSync(realDir, linkDir);

    try {
      const results = discoverCompileCommands(tmpDir);
      // Should find only 1 from real dir, not from symlink
      expect(results.length).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------
// parseCompileCommands additional coverage
// -----------------------------------------------------------------------

describe('parseCompileCommands', () => {
  it('handles command string instead of arguments array', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-compile-'));
    const srcFile = path.join(tmpDir, 'test.cpp');
    fs.writeFileSync(srcFile, 'int x;');
    const ccJson = path.join(tmpDir, 'compile_commands.json');
    fs.writeFileSync(ccJson, JSON.stringify([
      { directory: tmpDir, file: 'test.cpp', command: 'g++ -c test.cpp -o test.o' },
    ]));

    try {
      const index = parseCompileCommands([ccJson], [tmpDir]);
      expect(index.size).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('handles arguments array', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-compile-'));
    const srcFile = path.join(tmpDir, 'main.cpp');
    fs.writeFileSync(srcFile, 'void f() {}');
    const ccJson = path.join(tmpDir, 'compile_commands.json');
    fs.writeFileSync(ccJson, JSON.stringify([
      { directory: tmpDir, file: 'main.cpp', arguments: ['g++', '-c', '-std=c++20', 'main.cpp'] },
    ]));

    try {
      const index = parseCompileCommands([ccJson], [tmpDir]);
      expect(index.size).toBe(1);
      const info = [...index.values()][0];
      expect(info.standard).toBe('c++20');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips entries with no file field', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-compile-'));
    const ccJson = path.join(tmpDir, 'compile_commands.json');
    fs.writeFileSync(ccJson, JSON.stringify([
      { directory: tmpDir, command: 'g++ -c missing.cpp' },
    ]));

    try {
      const index = parseCompileCommands([ccJson], [tmpDir]);
      expect(index.size).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips entries outside allowed roots', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-compile-'));
    const ccJson = path.join(tmpDir, 'compile_commands.json');
    fs.writeFileSync(ccJson, JSON.stringify([
      { directory: '/tmp', file: '/etc/passwd', command: 'gcc -c /etc/passwd' },
    ]));

    try {
      const index = parseCompileCommands([ccJson], [tmpDir]);
      expect(index.size).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns empty when no allowed roots', () => {
    const index = parseCompileCommands([], []);
    expect(index.size).toBe(0);
  });

  it('handles -I flag with separate value', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-compile-'));
    const srcFile = path.join(tmpDir, 'test.cpp');
    const incDir = path.join(tmpDir, 'include');
    fs.writeFileSync(srcFile, '');
    fs.mkdirSync(incDir, { recursive: true });
    const ccJson = path.join(tmpDir, 'compile_commands.json');
    fs.writeFileSync(ccJson, JSON.stringify([
      { directory: tmpDir, file: 'test.cpp', arguments: ['g++', '-I', incDir, '-isystem', incDir, '-DFOO=1', '-D', 'BAR=2', '-c', 'test.cpp'] },
    ]));

    try {
      const index = parseCompileCommands([ccJson], [tmpDir]);
      const info = [...index.values()][0];
      expect(info.defines).toContain('FOO=1');
      expect(info.defines).toContain('BAR=2');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips entries with neither arguments nor command', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-compile-'));
    const srcFile = path.join(tmpDir, 'empty.cpp');
    fs.writeFileSync(srcFile, '');
    const ccJson = path.join(tmpDir, 'compile_commands.json');
    fs.writeFileSync(ccJson, JSON.stringify([
      { directory: tmpDir, file: 'empty.cpp' },
    ]));

    try {
      const index = parseCompileCommands([ccJson], [tmpDir]);
      expect(index.size).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------
// loadCompileCommandsJson
// -----------------------------------------------------------------------

describe('loadCompileCommandsJson', () => {
  it('loads from directory containing compile_commands.json', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-load-'));
    fs.writeFileSync(path.join(tmpDir, 'compile_commands.json'), JSON.stringify([
      { directory: tmpDir, file: 'test.cpp', command: 'g++ -c test.cpp' },
    ]));

    try {
      const loaded = loadCompileCommandsJson([tmpDir]);
      expect(loaded.size).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips non-existent paths', () => {
    const loaded = loadCompileCommandsJson(['/nonexistent/path']);
    expect(loaded.size).toBe(0);
  });

  it('skips non-array JSON files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-load-'));
    fs.writeFileSync(path.join(tmpDir, 'compile_commands.json'), '{"not": "array"}');

    try {
      const loaded = loadCompileCommandsJson([tmpDir]);
      expect(loaded.size).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips invalid JSON files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-load-'));
    fs.writeFileSync(path.join(tmpDir, 'compile_commands.json'), 'not json at all');

    try {
      const loaded = loadCompileCommandsJson([tmpDir]);
      expect(loaded.size).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('deduplicates when same path provided twice', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-load-'));
    fs.writeFileSync(path.join(tmpDir, 'compile_commands.json'), '[]');

    try {
      const loaded = loadCompileCommandsJson([tmpDir, tmpDir]);
      expect(loaded.size).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------
// inferBuildRoot
// -----------------------------------------------------------------------

describe('inferBuildRoot', () => {
  it('returns empty string when no entries have directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-infer-'));
    fs.writeFileSync(path.join(tmpDir, 'compile_commands.json'), JSON.stringify([
      { file: 'test.cpp', command: 'g++ -c test.cpp' },
    ]));

    try {
      const root = inferBuildRoot([path.join(tmpDir, 'compile_commands.json')]);
      expect(root).toBe('');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns the single directory when only one unique dir', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-infer-'));
    fs.writeFileSync(path.join(tmpDir, 'compile_commands.json'), JSON.stringify([
      { directory: tmpDir, file: 'a.cpp', command: 'g++ -c a.cpp' },
      { directory: tmpDir, file: 'b.cpp', command: 'g++ -c b.cpp' },
    ]));

    try {
      const root = inferBuildRoot([path.join(tmpDir, 'compile_commands.json')]);
      const resolved = fs.realpathSync(tmpDir);
      expect(root).toBe(resolved);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('computes common ancestor for multiple directories', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-infer-'));
    const subA = path.join(tmpDir, 'a');
    const subB = path.join(tmpDir, 'b');
    fs.mkdirSync(subA, { recursive: true });
    fs.mkdirSync(subB, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'compile_commands.json'), JSON.stringify([
      { directory: subA, file: '../test.cpp', command: 'g++ -c test.cpp' },
      { directory: subB, file: '../test.cpp', command: 'g++ -c test.cpp' },
    ]));

    try {
      const root = inferBuildRoot([path.join(tmpDir, 'compile_commands.json')]);
      const resolved = fs.realpathSync(tmpDir);
      expect(root).toBe(resolved);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------
// resolveAllowedRoots
// -----------------------------------------------------------------------

describe('resolveAllowedRoots', () => {
  it('returns parent dirs of compile_commands.json files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-roots-'));
    const ccJson = path.join(tmpDir, 'compile_commands.json');
    fs.writeFileSync(ccJson, '[]');

    try {
      const roots = resolveAllowedRoots([ccJson]);
      expect(roots.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('config.ts edge cases', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    resetConfig();
  });

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    resetConfig();
  });

  it('handles encrypted file with no colon separator (invalid format)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-config-'));
    const credFile = path.join(tmpDir, 'cred.enc');
    // Write content without colon separator — invalid format
    fs.writeFileSync(credFile, 'invalidbase64nocole');
    const key = crypto.randomBytes(32).toString('base64');

    process.env.OPENGROK_BASE_URL = 'https://example.com/source/';
    process.env.OPENGROK_PASSWORD = 'fallback';
    process.env.OPENGROK_PASSWORD_FILE = credFile;
    process.env.OPENGROK_PASSWORD_KEY = key;

    try {
      const config = loadConfig();
      // Should fall back to env password since decryption fails
      expect(config.OPENGROK_PASSWORD).toBe('fallback');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('handles non-existent credential file gracefully', () => {
    process.env.OPENGROK_BASE_URL = 'https://example.com/source/';
    process.env.OPENGROK_PASSWORD = 'env-pass';
    process.env.OPENGROK_PASSWORD_FILE = '/nonexistent/file.enc';
    process.env.OPENGROK_PASSWORD_KEY = crypto.randomBytes(32).toString('base64');

    const config = loadConfig();
    expect(config.OPENGROK_PASSWORD).toBe('env-pass');
  });

  it('handles legacy plaintext credential file that fails to read', () => {
    process.env.OPENGROK_BASE_URL = 'https://example.com/source/';
    process.env.OPENGROK_PASSWORD = 'env-pass';
    process.env.OPENGROK_PASSWORD_FILE = '/nonexistent/plain.txt';
    // No key = legacy mode

    const config = loadConfig();
    expect(config.OPENGROK_PASSWORD).toBe('env-pass');
  });
});

// ---------------------------------------------------------------------------
// models.ts — BlameArgs superRefine branch (line_end < line_start)
// ---------------------------------------------------------------------------
import { BlameArgs } from '../server/models.js';

describe('BlameArgs superRefine validation', () => {
  it('rejects when line_end is less than line_start', () => {
    const result = BlameArgs.safeParse({
      project: 'proj',
      path: 'src/file.cpp',
      line_start: 10,
      line_end: 5,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.includes('line_end'))).toBe(true);
    }
  });

  it('accepts when line_end equals line_start', () => {
    const result = BlameArgs.safeParse({
      project: 'proj',
      path: 'src/file.cpp',
      line_start: 5,
      line_end: 5,
    });
    expect(result.success).toBe(true);
  });

  it('accepts when line_end is greater than line_start', () => {
    const result = BlameArgs.safeParse({
      project: 'proj',
      path: 'src/file.cpp',
      line_start: 1,
      line_end: 100,
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// audit.ts — appendFileSync error fallback branch (lines 69-72)
// ---------------------------------------------------------------------------
import { auditLog, configureAuditLog, getAuditWriteQueue } from '../server/transport/audit.js';

describe('auditLog file write error fallback', () => {
  afterEach(() => {
    configureAuditLog(undefined);
    vi.restoreAllMocks();
  });

  it('writes fallback error to stderr when audit file path is unwritable', async () => {
    // Use a path whose parent directory does not exist — fsp.appendFile will throw ENOENT
    configureAuditLog('/nonexistent_dir_xyz/audit.log');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    auditLog({ type: 'config_load' });

    // Wait for the async write queue to flush (including the error-fallback write)
    await getAuditWriteQueue();

    // Should have written twice: once for the event (sync), once for the fallback error (async)
    expect(stderrSpy).toHaveBeenCalledTimes(2);
    const secondCall = stderrSpy.mock.calls[1][0] as string;
    const parsed = JSON.parse(secondCall.trim());
    expect(parsed.error).toBe('Failed to write audit log file');
  });
});
