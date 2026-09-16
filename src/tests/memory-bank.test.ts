import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MemoryBank, ALLOWED_FILES } from '../server/memory/memory-bank.js';

let tmpDir: string;
let bank: MemoryBank;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opengrok-mb-test-'));
  bank = new MemoryBank(tmpDir);
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ensureDir
// ---------------------------------------------------------------------------

describe('MemoryBank.ensureDir', () => {
  it('creates directory and stub files', async () => {
    const newDir = path.join(tmpDir, 'sub', 'bank');
    const newBank = new MemoryBank(newDir);
    await newBank.ensureDir();
    expect(fs.existsSync(newDir)).toBe(true);
    for (const file of ALLOWED_FILES) {
      expect(fs.existsSync(path.join(newDir, file))).toBe(true);
    }
  });

  it('does not overwrite existing files', async () => {
    await bank.ensureDir();
    await bank.write('active-task.md', 'real content');
    await bank.ensureDir(); // call again
    const content = await fsp.readFile(path.join(tmpDir, 'active-task.md'), 'utf8');
    expect(content).toBe('real content');
  });
});

// ---------------------------------------------------------------------------
// read — stub detection
// ---------------------------------------------------------------------------

describe('MemoryBank.read', () => {
  it('returns undefined for stub files (contains sentinel)', async () => {
    await bank.ensureDir();
    // All stubs should return undefined
    for (const file of ALLOWED_FILES) {
      const result = await bank.read(file);
      expect(result).toBeUndefined();
    }
  });

  it('returns content for real (non-stub) files', async () => {
    await fsp.writeFile(path.join(tmpDir, 'active-task.md'), 'Real content here');
    const result = await bank.read('active-task.md');
    expect(result).toBe('Real content here');
  });

  it('returns undefined when file does not exist', async () => {
    const result = await bank.read('active-task.md');
    expect(result).toBeUndefined();
  });

  it('throws for files not in allow-list', async () => {
    await expect(bank.read('../../etc/passwd')).rejects.toThrow('allow-list');
    await expect(bank.read('unknown.md')).rejects.toThrow('allow-list');
  });
});

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

describe('MemoryBank.write', () => {
  it('overwrites file in overwrite mode', async () => {
    await bank.write('active-task.md', 'initial');
    await bank.write('active-task.md', 'updated');
    const content = await fsp.readFile(path.join(tmpDir, 'active-task.md'), 'utf8');
    expect(content).toBe('updated');
  });

  it('appends to file in append mode', async () => {
    await bank.write('active-task.md', 'line1');
    await bank.write('active-task.md', 'line2', 'append');
    const content = await fsp.readFile(path.join(tmpDir, 'active-task.md'), 'utf8');
    expect(content).toContain('line1');
    expect(content).toContain('line2');
  });

  it('strips stub sentinel when appending', async () => {
    await bank.ensureDir();
    await bank.write('active-task.md', 'new content', 'append');
    const result = await bank.read('active-task.md');
    expect(result).not.toBeUndefined();
    expect(result).not.toContain('<!-- OPENGROK_STUB');
    expect(result).toContain('new content');
  });

  it('throws for files not in allow-list', async () => {
    await expect(bank.write('evil.md', 'bad')).rejects.toThrow('allow-list');
  });

  it('creates directory if it does not exist', async () => {
    const deepDir = path.join(tmpDir, 'deep', 'bank');
    const deepBank = new MemoryBank(deepDir);
    await deepBank.write('active-task.md', 'hello');
    expect(fs.existsSync(path.join(deepDir, 'active-task.md'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// write — size limit for non-log files
// ---------------------------------------------------------------------------

describe('MemoryBank.write — size truncation', () => {
  it('hard-truncates non-log files at limit', async () => {
    // active-task.md limit is 4096 bytes — write > 4096
    const bigContent = 'x'.repeat(6000);
    await bank.write('active-task.md', bigContent);
    const content = await fsp.readFile(path.join(tmpDir, 'active-task.md'), 'utf8');
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(4096 + 200);
    expect(content).toContain('Truncated');
  });
});

// ---------------------------------------------------------------------------
// investigation-log.md trimming
// ---------------------------------------------------------------------------

describe('MemoryBank — investigation-log.md trimming', () => {
  it('trims oldest heading entries when over MAX_FILE_BYTES', async () => {
    // investigation-log.md limit is 32768 bytes
    // Write many entries to exceed the limit
    const entries: string[] = [];
    for (let i = 0; i < 50; i++) {
      entries.push(`## 2025-01-${String(i + 1).padStart(2, '0')}: Entry ${i + 1}\n${'x'.repeat(700)}`);
    }
    const bigContent = entries.join('\n');
    await bank.write('investigation-log.md', bigContent);
    const content = await fsp.readFile(path.join(tmpDir, 'investigation-log.md'), 'utf8');
    // Should be trimmed to fit within 32768 bytes
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(32768 + 200);
    // Should contain trim note
    expect(content).toContain('Older entries trimmed');
    // Should NOT contain the very first entry (it was trimmed)
    expect(content).not.toContain('2025-01-01: Entry 1');
  });

  it('does not trim content that fits within limit', async () => {
    const content = '## 2025-01-01: Brief entry\nShort content.';
    await bank.write('investigation-log.md', content);
    const result = await fsp.readFile(path.join(tmpDir, 'investigation-log.md'), 'utf8');
    expect(result).toBe(content);
  });

  it('handles single-section content that is too large (truncates by bytes)', async () => {
    // No H2 headings → single section → byte-truncate path
    const bigNoHeadings = 'x'.repeat(40000); // > 32768 bytes
    await bank.write('investigation-log.md', bigNoHeadings);
    const content = await fsp.readFile(path.join(tmpDir, 'investigation-log.md'), 'utf8');
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(32768 + 200);
    expect(content).toContain('Older entries trimmed');
  });
});

// ---------------------------------------------------------------------------
// ALLOWED_FILES structure tests (migration removed — new product, no backward compat)
// ---------------------------------------------------------------------------

describe('MemoryBank ALLOWED_FILES', () => {
  it('ALLOWED_FILES contains exactly 2 entries', () => {
    expect(ALLOWED_FILES).toHaveLength(2);
    expect(ALLOWED_FILES).toContain('active-task.md');
    expect(ALLOWED_FILES).toContain('investigation-log.md');
  });

  it('ensureDir is idempotent (safe to run twice)', async () => {
    await bank.ensureDir();
    await bank.ensureDir(); // second call
    // Should still have exactly the 2 allowed files as stubs
    for (const file of ALLOWED_FILES) {
      expect(fs.existsSync(path.join(tmpDir, file))).toBe(true);
    }
    // active-task content should be stub (undefined)
    const content = await bank.read('active-task.md');
    expect(content).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// readWithDelta tests
// ---------------------------------------------------------------------------

describe('MemoryBank readWithDelta', () => {
  it('first read returns full content', async () => {
    await bank.write('active-task.md', 'task: investigate EventLoop');
    const result = await bank.readWithDelta('active-task.md');
    expect(result).toBe('task: investigate EventLoop');
  });

  it('second read with same content returns [unchanged]', async () => {
    await bank.write('active-task.md', 'task: investigate EventLoop');
    await bank.readWithDelta('active-task.md'); // first read
    const result = await bank.readWithDelta('active-task.md'); // second read
    expect(result).toBe('[unchanged]');
  });

  it('returns full content after write invalidates hash', async () => {
    await bank.write('active-task.md', 'task: investigate EventLoop');
    await bank.readWithDelta('active-task.md'); // first read
    await bank.write('active-task.md', 'task: fixed EventLoop'); // write new content
    const result = await bank.readWithDelta('active-task.md'); // should get full content
    expect(result).toBe('task: fixed EventLoop');
    expect(result).not.toBe('[unchanged]');
  });

  it('returns undefined for empty/stub file', async () => {
    await bank.ensureDir();
    // Stub files return undefined from read(), so readWithDelta should also return undefined
    const result = await bank.readWithDelta('active-task.md');
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Auto-timestamp tests
// ---------------------------------------------------------------------------

describe('MemoryBank auto-timestamp on append', () => {
  it('adds a ## heading when appending to investigation-log.md without one', async () => {
    await bank.ensureDir();
    await bank.write('investigation-log.md', 'Found the bug!', 'append');
    const content = await bank.read('investigation-log.md');
    expect(content).toMatch(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2}: Session Update/m);
    expect(content).toContain('Found the bug!');
  });

  it('preserves existing ## heading when one is provided', async () => {
    await bank.ensureDir();
    await bank.write('investigation-log.md', '## 2026-01-01 10:00: Custom\nMy finding', 'append');
    const content = await bank.read('investigation-log.md');
    // Should not add another heading
    const headings = (content ?? '').match(/^## /gm);
    expect(headings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Richness scoring tests
// ---------------------------------------------------------------------------

describe('MemoryBank richness scoring', () => {
  it('entry with conclusion markers scores higher than dead-end entry', () => {
    const localBank = new MemoryBank(tmpDir);
    const conclusionEntry = '## 2026-01-01\nfound the root cause — EventLoop was null';
    const deadEndEntry = '## 2026-01-02\ndead end — no results for this approach';
    const conclusionScore = (localBank as any).scoreLogEntry(conclusionEntry);
    const deadEndScore = (localBank as any).scoreLogEntry(deadEndEntry);
    expect(conclusionScore).toBeGreaterThan(deadEndScore);
  });
});

// ---------------------------------------------------------------------------
// readCompressed tests
// ---------------------------------------------------------------------------

describe('MemoryBank readCompressed', () => {
  it('returns full content when under threshold', async () => {
    const smallContent = '## 2026-01-01 10:00: Entry\nShort content.';
    await bank.write('investigation-log.md', smallContent);
    const result = await bank.readCompressed('investigation-log.md');
    expect(result).toBe(smallContent);
  });

  it('returns last 3 sections with omitted count when over 8KB', async () => {
    // Build 6 sections, each ~2KB, totalling ~12KB
    const sections: string[] = [];
    for (let i = 1; i <= 6; i++) {
      sections.push(`## 2026-01-0${i} 10:00: Entry ${i}\n${'x'.repeat(1800)}`);
    }
    const bigContent = sections.join('\n');
    await bank.write('investigation-log.md', bigContent);
    const result = await bank.readCompressed('investigation-log.md');
    expect(result).toMatch(/^\[\d+ older entries omitted\]/);
    expect(result).toContain('Entry 4');
    expect(result).toContain('Entry 5');
    expect(result).toContain('Entry 6');
    // Earliest entries should be omitted
    expect(result).not.toContain('Entry 1');
  });
});

// ---------------------------------------------------------------------------
// write — graceful trim when combined content exceeds limit
// ---------------------------------------------------------------------------

describe('MemoryBank.write — graceful trim when combined content exceeds limit', () => {
  it('trims existing log to make room and writes without throwing', async () => {
    // Write a large existing log (~30KB) then append another ~30KB
    // Combined ~60KB > 32768 → should trim existing to fit new content
    const existing = '## Entry 1\n' + 'x'.repeat(30000);
    await bank.write('investigation-log.md', existing);

    const hugeAppend = '## Entry 2\n' + 'y'.repeat(30000);
    // Should succeed: existing is trimmed to make room for the new entry
    await expect(bank.write('investigation-log.md', hugeAppend, 'append')).resolves.toBeUndefined();

    const result = await bank.read('investigation-log.md') ?? '';
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(32768);
    // New entry must be present
    expect(result).toContain('## Entry 2');
  });

  it('truncates existing non-log content when append would exceed limit', async () => {
    // active-task.md limit is 4096 bytes
    // existing 3000 + new 2000 = 5000 > 4096 → truncateUtf8 else-branch (non-log path)
    await bank.write('active-task.md', 'x'.repeat(3000));
    await bank.write('active-task.md', 'y'.repeat(2000), 'append');
    const result = await bank.read('active-task.md') ?? '';
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(4096 + 50);
    expect(result).toContain('y');
  });
});

// ---------------------------------------------------------------------------
// write — writeFile error catch (lines 201-203)
// ---------------------------------------------------------------------------

describe('MemoryBank.write — writeFile error', () => {
  it('throws MemoryBank error when bank dir path is unresolvable (ENOTDIR)', async () => {
    // Place a regular FILE where the bank's parent directory would be.
    // mkdir(..., { recursive: true }) on a path whose parent is a file
    // throws ENOTDIR — this is an OS-level error that root cannot bypass.
    const parentFile = path.join(tmpDir, 'notadir');
    await fsp.writeFile(parentFile, 'i am a file');
    const badBank = new MemoryBank(path.join(parentFile, 'subdir'));
    await expect(badBank.write('active-task.md', 'hello')).rejects.toThrow('Failed to write memory bank file');
  });
});

// ---------------------------------------------------------------------------
// trimLogFromTop — last-resort byte truncate (lines 292-298)
// When even the 2 most recent entries exceed maxBytes, byte-truncate them.
// ---------------------------------------------------------------------------

describe('MemoryBank trimLogFromTop — last resort truncation', () => {
  it('byte-truncates when 2 recent entries still exceed limit', async () => {
    // Create exactly 2 sections each ~20KB → total ~40KB > 32768 limit
    const section1 = `## 2026-01-01 10:00: Entry 1\n${'a'.repeat(20000)}`;
    const section2 = `## 2026-01-02 10:00: Entry 2\n${'b'.repeat(20000)}`;
    const content = section1 + '\n' + section2;
    await bank.write('investigation-log.md', content);
    const result = await fsp.readFile(path.join(tmpDir, 'investigation-log.md'), 'utf8');
    // Should be trimmed to <= 32768 bytes
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(32768 + 200);
    // The trim note should appear
    expect(result).toContain('Older entries trimmed');
  });
});

// ---------------------------------------------------------------------------
// getStatusLine — age > 60 minutes (line 331) and catch block (line 344)
// ---------------------------------------------------------------------------

describe('MemoryBank.getStatusLine — age and error paths', () => {
  it('formats age in hours when file is older than 60 minutes', async () => {
    await bank.write('active-task.md', 'task: test task');
    // Backdate the file modification time by 2 hours
    const filePath = path.join(tmpDir, 'active-task.md');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fsp.utimes(filePath, twoHoursAgo, twoHoursAgo);

    const status = await bank.getStatusLine();
    // Should contain "2h ago" or similar
    expect(status).toMatch(/\d+h ago/);
  });

  it('silently skips entry in getStatusLine when path is a directory (EISDIR)', async () => {
    // Replace the file path with a directory — fsp.readFile on a directory throws
    // EISDIR regardless of user privileges (OS-level structural error, not permissions).
    const filePath = path.join(tmpDir, 'active-task.md');
    await fsp.mkdir(filePath, { recursive: true });
    const status = await bank.getStatusLine();
    // Both files skipped → no prior context
    expect(status).toBe('[Memory] No prior context.');
  });
});

// ---------------------------------------------------------------------------
// FileReferenceCache
// ---------------------------------------------------------------------------

import { FileReferenceCache } from '../server/utils/file-cache.js';

describe('FileReferenceCache', () => {
  let cache: FileReferenceCache;

  beforeEach(() => {
    cache = new FileReferenceCache();
  });

  it('isUnchanged returns false on first call (not yet registered)', () => {
    expect(cache.isUnchanged('investigation-log.md', 'some content')).toBe(false);
  });

  it('isUnchanged returns true after register with same content', () => {
    cache.register('investigation-log.md', 'some content');
    expect(cache.isUnchanged('investigation-log.md', 'some content')).toBe(true);
  });

  it('isUnchanged returns false when content changes after register', () => {
    cache.register('investigation-log.md', 'original content');
    expect(cache.isUnchanged('investigation-log.md', 'updated content')).toBe(false);
  });

  it('clear resets cache so isUnchanged returns false again', () => {
    cache.register('investigation-log.md', 'some content');
    cache.clear();
    expect(cache.isUnchanged('investigation-log.md', 'some content')).toBe(false);
  });

  it('register returns a consistent hash for the same content', () => {
    const h1 = cache.register('a.md', 'hello');
    cache.clear();
    const h2 = cache.register('a.md', 'hello');
    expect(h1).toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// MemoryBank.getFileReference
// ---------------------------------------------------------------------------

describe('MemoryBank.getFileReference', () => {
  it('returns null for a stub file (not yet populated)', async () => {
    await bank.ensureDir();
    const ref = await bank.getFileReference('investigation-log.md');
    expect(ref).toBeNull();
  });

  it('returns a hash string on first call with real content', async () => {
    await bank.ensureDir();
    await bank.write('investigation-log.md', '## 2026-01-01 10:00: Test\nsome finding');
    const ref = await bank.getFileReference('investigation-log.md');
    expect(typeof ref).toBe('string');
    expect(ref).not.toBeNull();
  });

  it('returns null on second call with unchanged content (cached)', async () => {
    await bank.ensureDir();
    await bank.write('investigation-log.md', '## 2026-01-01 10:00: Test\nsome finding');
    await bank.getFileReference('investigation-log.md'); // first call registers
    const ref2 = await bank.getFileReference('investigation-log.md');
    expect(ref2).toBeNull();
  });

  it('returns a new hash after content changes', async () => {
    await bank.ensureDir();
    await bank.write('investigation-log.md', '## 2026-01-01 10:00: Test\noriginal');
    const ref1 = await bank.getFileReference('investigation-log.md');
    await bank.write('investigation-log.md', '## 2026-01-01 10:00: Test\noriginal\n## 2026-01-02 12:00: Update\nnew entry', 'append');
    const ref2 = await bank.getFileReference('investigation-log.md');
    expect(ref2).not.toBeNull();
    expect(ref2).not.toBe(ref1);
  });
});
