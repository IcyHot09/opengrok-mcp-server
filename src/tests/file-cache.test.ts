import { describe, it, expect, beforeEach } from 'vitest';
import { FileReferenceCache, simpleHash } from '../server/utils/file-cache.js';

describe('FileReferenceCache', () => {
  let cache: FileReferenceCache;

  beforeEach(() => {
    cache = new FileReferenceCache();
  });

  it('isUnchanged returns false for never-seen filename', () => {
    expect(cache.isUnchanged('file.md', 'some content')).toBe(false);
  });

  it('isUnchanged returns true after register with same content', () => {
    cache.register('file.md', 'content A');
    expect(cache.isUnchanged('file.md', 'content A')).toBe(true);
  });

  it('isUnchanged returns false when content changes after register', () => {
    cache.register('file.md', 'content A');
    expect(cache.isUnchanged('file.md', 'content B')).toBe(false);
  });

  it('register returns a non-empty hash string', () => {
    const hash = cache.register('file.md', 'content');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
  });

  it('register returns consistent hash for same content', () => {
    const h1 = cache.register('file1.md', 'same content');
    const h2 = cache.register('file2.md', 'same content');
    expect(h1).toBe(h2);
  });

  it('register returns different hash for different content', () => {
    const h1 = cache.register('file.md', 'content A');
    const h2 = cache.register('file.md', 'content B');
    expect(h1).not.toBe(h2);
  });

  it('clear() resets all cached entries', () => {
    cache.register('file.md', 'content A');
    cache.clear();
    expect(cache.isUnchanged('file.md', 'content A')).toBe(false);
  });

  it('clear() resets multiple files', () => {
    cache.register('file1.md', 'content 1');
    cache.register('file2.md', 'content 2');
    cache.clear();
    expect(cache.isUnchanged('file1.md', 'content 1')).toBe(false);
    expect(cache.isUnchanged('file2.md', 'content 2')).toBe(false);
  });

  it('handles multiple files independently', () => {
    cache.register('file1.md', 'content 1');
    cache.register('file2.md', 'content 2');
    expect(cache.isUnchanged('file1.md', 'content 1')).toBe(true);
    expect(cache.isUnchanged('file2.md', 'content 2')).toBe(true);
    expect(cache.isUnchanged('file1.md', 'content 2')).toBe(false);
    expect(cache.isUnchanged('file2.md', 'content 1')).toBe(false);
  });

  it('re-registering with new content updates the cache', () => {
    cache.register('file.md', 'content A');
    cache.register('file.md', 'content B');
    expect(cache.isUnchanged('file.md', 'content B')).toBe(true);
    expect(cache.isUnchanged('file.md', 'content A')).toBe(false);
  });

  it('handles empty string content', () => {
    cache.register('empty.md', '');
    expect(cache.isUnchanged('empty.md', '')).toBe(true);
    expect(cache.isUnchanged('empty.md', 'not empty')).toBe(false);
  });

  it('handles large content', () => {
    const large = 'x'.repeat(100_000);
    cache.register('large.md', large);
    expect(cache.isUnchanged('large.md', large)).toBe(true);
    expect(cache.isUnchanged('large.md', large + 'y')).toBe(false);
  });

  it('handles unicode content', () => {
    const unicode = '你好世界 🌍 こんにちは';
    cache.register('unicode.md', unicode);
    expect(cache.isUnchanged('unicode.md', unicode)).toBe(true);
    expect(cache.isUnchanged('unicode.md', unicode + ' extra')).toBe(false);
  });

  it('isUnchanged does not modify the cache state', () => {
    // Calling isUnchanged for unknown file should not register it
    cache.isUnchanged('unknown.md', 'content');
    // Still should return false on next call
    expect(cache.isUnchanged('unknown.md', 'content')).toBe(false);
  });
});

describe('simpleHash', () => {
  it('returns a 16-character hex string', () => {
    const hash = simpleHash('hello');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for same input', () => {
    expect(simpleHash('same')).toBe(simpleHash('same'));
  });

  it('produces different hashes for different inputs', () => {
    expect(simpleHash('a')).not.toBe(simpleHash('b'));
  });

  it('handles empty string', () => {
    const hash = simpleHash('');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});
