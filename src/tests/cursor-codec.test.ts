import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor, isOffsetCursorFor, CURSOR_EXPIRED } from '../server/pagination/cursor-codec.js';

describe('cursor-codec', () => {
  it('round-trips offset cursors', () => {
    const c = encodeCursor({ t: 'offset', v: 25, m: 'search' });
    expect(decodeCursor(c)).toEqual({ t: 'offset', v: 25, m: 'search' });
  });

  it('round-trips page and raw cursors', () => {
    expect(decodeCursor(encodeCursor({ t: 'page', p: 3 }))).toEqual({ t: 'page', p: 3 });
    expect(decodeCursor(encodeCursor({ t: 'raw', v: 'abc' }))).toEqual({ t: 'raw', v: 'abc' });
  });

  it('rejects oversized cursors', () => {
    expect(decodeCursor('x'.repeat(4097))).toBeNull();
  });

  it('rejects malformed base64/JSON', () => {
    expect(decodeCursor('!!!not-base64!!!')).toBeNull();
    expect(decodeCursor(Buffer.from('42').toString('base64url'))).toBeNull();
  });

  it('rejects out-of-range offsets and pages', () => {
    const badOffset = (v: unknown) =>
      decodeCursor(Buffer.from(JSON.stringify({ t: 'offset', v })).toString('base64url'));
    expect(badOffset(1.5)).toBeNull();
    expect(badOffset(-1)).toBeNull();
    expect(badOffset(10_000_001)).toBeNull();
    expect(badOffset('25')).toBeNull();
    const badPage = (p: unknown) =>
      decodeCursor(Buffer.from(JSON.stringify({ t: 'page', p })).toString('base64url'));
    expect(badPage(-1)).toBeNull();
    expect(badPage(2.5)).toBeNull();
  });

  it('rejects unknown shapes and oversized raw values', () => {
    const shape = (o: unknown) =>
      decodeCursor(Buffer.from(JSON.stringify(o)).toString('base64url'));
    expect(shape({ t: 'nope' })).toBeNull();
    expect(shape({ t: 'raw', v: 'x'.repeat(1025) })).toBeNull();
    expect(shape({ t: 'raw', v: 42 })).toBeNull();
  });

  it('accepts legacy untagged offset cursors', () => {
    const c = encodeCursor({ t: 'offset', v: 10 });
    expect(decodeCursor(c)).toEqual({ t: 'offset', v: 10 });
    expect(isOffsetCursorFor(decodeCursor(c), 'search')).toBe(true);
  });

  it('isOffsetCursorFor enforces method tags', () => {
    expect(isOffsetCursorFor(null, 'search')).toBe(false);
    expect(isOffsetCursorFor({ t: 'page', p: 1 }, 'search')).toBe(false);
    expect(isOffsetCursorFor({ t: 'offset', v: 1, m: 'history' }, 'search')).toBe(false);
    expect(isOffsetCursorFor({ t: 'offset', v: 1, m: 'search' }, 'search')).toBe(true);
  });

  it('CURSOR_EXPIRED shape is stable', () => {
    expect(CURSOR_EXPIRED._cursorExpired).toBe(true);
    expect(CURSOR_EXPIRED.message).toMatch(/reissue without cursor/);
  });
});
