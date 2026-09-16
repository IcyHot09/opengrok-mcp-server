/**
 * Unit tests for server.ts utility functions:
 *   - capCodeModeResult: truncation logic for code-mode responses
 *   - deduplicateAcrossQueries: dedup across multi-query batch results
 */
import { describe, it, expect } from 'vitest';
import {
  _capCodeModeResult as capCodeModeResult,
  _deduplicateAcrossQueries as deduplicateAcrossQueries,
} from '../server/server.js';
import type { SearchResults } from '../server/models.js';

// -----------------------------------------------------------------------
// capCodeModeResult
// -----------------------------------------------------------------------

describe('capCodeModeResult', () => {
  it('returns string as-is when it is shorter than the byte limit', () => {
    const s = 'hello world';
    expect(capCodeModeResult(s, 1000)).toBe(s);
  });

  it('truncates a JSON array at element boundaries and produces valid JSON', () => {
    const arr = Array.from({ length: 10 }, (_, i) => ({ id: i, value: 'x'.repeat(100) }));
    const full = JSON.stringify(arr);
    // Allow only ~3 elements worth of bytes + room for the truncation marker
    const limit = Buffer.byteLength(JSON.stringify(arr.slice(0, 3)), 'utf8') + 100;

    const result = capCodeModeResult(full, limit);

    // Must be valid JSON
    const parsed = JSON.parse(result) as unknown[];
    expect(parsed.length).toBeGreaterThanOrEqual(2); // at least 1 element + marker
    expect(parsed.length).toBeLessThanOrEqual(10);
    // Last element is the truncation marker
    const marker = parsed[parsed.length - 1] as Record<string, unknown>;
    expect(marker._truncated).toBe(true);
    expect(marker._droppedCount).toBeGreaterThan(0);
  });

  it('falls back to byte truncation for non-JSON strings', () => {
    const s = 'a'.repeat(500);
    const limit = 100;
    const result = capCodeModeResult(s, limit);
    // capResponse truncates at limit bytes then appends a trailer;
    // the result will be shorter than the original but the trailer may exceed limit
    expect(result.length).toBeLessThan(s.length);
    expect(result).toContain('[Response truncated');
  });

  it('falls back to byte truncation when JSON array first element alone exceeds limit', () => {
    // Single huge element — no truncation point inside the array
    const arr = [{ data: 'x'.repeat(500) }];
    const full = JSON.stringify(arr);
    const limit = 50; // smaller than one element

    const result = capCodeModeResult(full, limit);
    // Should fall back to capResponse (byte truncation), not crash
    expect(result.length).toBeLessThan(full.length);
    expect(result).toContain('[Response truncated');
  });
});

// -----------------------------------------------------------------------
// deduplicateAcrossQueries
// -----------------------------------------------------------------------

function makeSearchResults(hits: Array<{ path: string; line: number }>): SearchResults {
  return {
    query: 'test',
    searchType: 'full',
    totalCount: hits.length,
    timeMs: 1,
    startIndex: 0,
    endIndex: hits.length,
    results: hits.map(({ path, line }) => ({
      path,
      matches: [{ lineNumber: line, line: `match at ${line}`, tags: [] }],
    })),
  };
}

type QueryResult = Parameters<typeof deduplicateAcrossQueries>[0][number];

function makeQueryResult(query: string, hits: Array<{ path: string; line: number }>): QueryResult {
  return { query, searchType: 'full', results: makeSearchResults(hits) };
}

describe('deduplicateAcrossQueries', () => {
  it('returns empty results when all hits share the same path+line across queries', () => {
    const input = [
      makeQueryResult('q1', [{ path: 'src/foo.cpp', line: 10 }]),
      makeQueryResult('q2', [{ path: 'src/foo.cpp', line: 10 }]),
    ];

    const output = deduplicateAcrossQueries(input);

    // q1 keeps the hit; q2 should have it removed (hits empty → file removed)
    const q1Hits = output[0].results.results;
    const q2Hits = output[1].results.results;
    expect(q1Hits).toHaveLength(1);
    expect(q2Hits).toHaveLength(0);
  });

  it('deduplicates across different queries, keeping first occurrence', () => {
    const input = [
      makeQueryResult('q1', [
        { path: 'a.cpp', line: 1 },
        { path: 'b.cpp', line: 2 },
      ]),
      makeQueryResult('q2', [
        { path: 'b.cpp', line: 2 }, // duplicate of q1
        { path: 'c.cpp', line: 3 }, // new
      ]),
    ];

    const output = deduplicateAcrossQueries(input);

    const q1Paths = output[0].results.results.map((r) => r.path);
    const q2Paths = output[1].results.results.map((r) => r.path);

    expect(q1Paths).toEqual(['a.cpp', 'b.cpp']);
    expect(q2Paths).toEqual(['c.cpp']); // b.cpp deduplicated away
  });

  it('keeps unique hits untouched when there are no duplicates', () => {
    const input = [
      makeQueryResult('q1', [{ path: 'x.cpp', line: 5 }]),
      makeQueryResult('q2', [{ path: 'y.cpp', line: 6 }]),
    ];

    const output = deduplicateAcrossQueries(input);

    expect(output[0].results.results).toHaveLength(1);
    expect(output[1].results.results).toHaveLength(1);
  });

  it('returns empty array unchanged', () => {
    expect(deduplicateAcrossQueries([])).toEqual([]);
  });
});
