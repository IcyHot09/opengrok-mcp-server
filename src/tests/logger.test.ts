/**
 * Tests for logger.ts — ensure all log methods work as expected.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger } from '../server/utils/logger.js';

describe('logger', () => {
  const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  afterEach(() => {
    stderrSpy.mockClear();
  });

  it('logs info messages to stderr', () => {
    logger.info('test info message');
    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(stderrSpy.mock.calls[0][0]).toContain('[INFO]');
    expect(stderrSpy.mock.calls[0][0]).toContain('test info message');
  });

  it('logs info with meta', () => {
    logger.info('with meta', { key: 'value' });
    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(stderrSpy.mock.calls[0][1]).toEqual({ key: 'value' });
  });

  it('logs error messages to stderr', () => {
    logger.error('test error');
    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(stderrSpy.mock.calls[0][0]).toContain('[ERROR]');
  });

  it('logs error with Error object', () => {
    const err = new Error('boom');
    logger.error('failed', err);
    expect(stderrSpy.mock.calls[0][1]).toBe(err);
  });

  it('logs warning messages to stderr', () => {
    logger.warn('test warning');
    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(stderrSpy.mock.calls[0][0]).toContain('[WARN]');
  });

  it('logs warning with meta', () => {
    logger.warn('caution', 42);
    expect(stderrSpy.mock.calls[0][1]).toBe(42);
  });

  it('uses empty string when no meta provided', () => {
    logger.info('no meta');
    expect(stderrSpy.mock.calls[0][1]).toBe('');
  });

  it('redacts sensitive keys in meta objects', () => {
    logger.info('auth attempt', { password: 'secret123', username: 'alice' });
    const sanitized = stderrSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(sanitized.password).toBe('[REDACTED]');
    expect(sanitized.username).toBe('alice');
  });
});
