import { describe, it, expect } from 'vitest';
import {
  parseUnifiedDiff,
  parseStructuredDiff,
  computeHunkPageStats,
  reassembleUnifiedDiff,
} from '../server/parsers/unified-diff.js';

const DIFF = [
  '--- a/foo.ts',
  '+++ b/foo.ts',
  '@@ -1,4 +1,5 @@',
  ' line1',
  '-old2',
  '+new2a',
  '++i;',
  '+new2b',
  ' line3',
  '@@ -10,3 +11,2 @@',
  ' ctx',
  '-gone',
  ' end',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('splits header from hunks', () => {
    const { fileHeader, hunks } = parseUnifiedDiff(DIFF);
    expect(fileHeader).toBe('--- a/foo.ts\n+++ b/foo.ts');
    expect(hunks).toHaveLength(2);
  });

  it('counts ++i; content lines as added, not headers', () => {
    const { hunks } = parseUnifiedDiff(DIFF);
    expect(hunks[0].added).toBe(3);
    expect(hunks[0].removed).toBe(1);
    expect(hunks[1].added).toBe(0);
    expect(hunks[1].removed).toBe(1);
  });

  it('returns empty hunks for empty diffs', () => {
    expect(parseUnifiedDiff('')).toEqual({ fileHeader: '', hunks: [] });
  });
});

describe('parseStructuredDiff', () => {
  it('produces typed lines with line numbers', () => {
    const hunks = parseStructuredDiff(DIFF);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].oldStart).toBe(1);
    expect(hunks[0].newStart).toBe(1);
    const types = hunks[0].lines.map((l) => l.type);
    expect(types).toEqual(['context', 'removed', 'added', 'added', 'added', 'context']);
    expect(hunks[0].lines[1]).toMatchObject({ oldLineNumber: 2 });
    expect(hunks[0].lines[2]).toMatchObject({ newLineNumber: 2 });
  });

  it('returns empty array for empty diffs', () => {
    expect(parseStructuredDiff('')).toEqual([]);
  });
});

describe('computeHunkPageStats + reassembleUnifiedDiff', () => {
  it('sums hunk stats', () => {
    const { hunks } = parseUnifiedDiff(DIFF);
    expect(computeHunkPageStats(hunks)).toEqual({ added: 3, removed: 2 });
    expect(computeHunkPageStats([])).toEqual({ added: 0, removed: 0 });
  });

  it('reassembles the original diff', () => {
    const { fileHeader, hunks } = parseUnifiedDiff(DIFF);
    expect(reassembleUnifiedDiff(fileHeader, hunks)).toBe(DIFF);
  });

  it('reassembles without header', () => {
    const { hunks } = parseUnifiedDiff(DIFF);
    expect(reassembleUnifiedDiff('', hunks)).toBe(hunks.map((h) => h.raw).join('\n'));
  });
});
